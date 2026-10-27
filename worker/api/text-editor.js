// RC13.4: editable UTF-8 text only. Never evaluate or render the contents as HTML.
// The save path deliberately reuses the existing safe RC13.1 replacement engine,
// including CAS revision, quota, R2 staging, D1 batch and RC13.2 public syncing.
import {resolveUser} from '../services/auth.js';
import {one,dbFromEnv} from '../services/database.js';
import {targetForView,targetForReplace} from '../services/replacements.js';
import {storageBinding,uploadFile} from '../services/storage.js';
import {error,ok} from '../utils/response.js';

export const MAX_TEXT_BYTES=512*1024;
export const MAX_TEXT_REQUEST_BYTES=2*1024*1024;
export const textRoutePattern=/^\/api\/v1\/files\/([0-9a-f-]{36})\/(?:text|versions\/([1-9]\d{0,9})\/text)$/;
const MIME_BY_EXT=Object.freeze({
 txt:'text/plain',md:'text/markdown',markdown:'text/markdown',json:'application/json',
 jsonl:'application/x-ndjson',xml:'application/xml',csv:'text/csv',
 html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',
 yaml:'application/yaml',yml:'application/yaml',log:'text/plain',ini:'text/plain',
 svg:'image/svg+xml' // Deliberately NOT supported: active document, unsafe to serve inline.
});
const DISABLED=new Set(['svg']);
export function editableMime(name,mime=''){
 const ext=String(name||'').split('.').at(-1).toLowerCase();
 if(DISABLED.has(ext)||!Object.hasOwn(MIME_BY_EXT,ext))return null;
 // Refuse files already typed as binary/executable despite a text-like name.
 if(/^(?:image\/|video\/|audio\/|application\/(?:pdf|zip|octet-stream\+encrypted|x-msdownload))/.test(mime||''))return null;
 return MIME_BY_EXT[ext];
}
function validText(value){return typeof value==='string'&&!value.includes('\0')&&!/\uD800(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);}
function nonNegativeInt(v){return Number.isSafeInteger(v)&&v>=1;}
async function readLimitedJSON(request){
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return null;
 if(Number(request.headers.get('content-length')||0)>MAX_TEXT_REQUEST_BYTES)throw new RangeError('编辑请求内容太大');
 let size=0;const parts=[];
 if(!request.body)return null;
 const reader=request.body.getReader();
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>MAX_TEXT_REQUEST_BYTES)throw new RangeError('编辑请求内容太大');parts.push(value);}}finally{reader.releaseLock();}
 const buffer=new Uint8Array(size);let offset=0;for(const part of parts){buffer.set(part,offset);offset+=part.byteLength;}
 try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}
 catch{return null;}
}
export async function textEditorRoute(request,env,path){
 const m=textRoutePattern.exec(path);if(!m)return error('NOT_FOUND','文件不存在',404);
 const user=await resolveUser(request,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 const [,fileId,revisionString]=m;
 const editing=!revisionString&&request.method==='PUT';
 if(!editing&&request.method!=='GET')return error('METHOD_NOT_ALLOWED','不支持此操作',405);
 const db=dbFromEnv(env),access=editing?await targetForReplace(db,user,fileId):await targetForView(db,user,fileId);
 if(access.error)return error(access.error,'文件不存在或没有相应权限',access.status);
 const file=access.file;
 const mime=editableMime(file.name,file.mime_type);
 if(!mime)return error('TEXT_EDIT_UNSUPPORTED','此文件类型不支持文本编辑，请使用文件替换功能',415);
 if(editing){
  let data;try{data=await readLimitedJSON(request)}catch(e){if(e instanceof RangeError)return error('TEXT_TOO_LARGE','编辑内容超过上限',413);throw e;}
  if(!data||!validText(data.content)||!nonNegativeInt(data.expected_revision))return error('INVALID_TEXT_EDIT','需要有效 UTF-8 文本和预期修订号',400);
  if(data.expected_revision!==file.revision)return error('VERSION_CONFLICT','文件已经更新，请重新打开后再保存',409);
  const contentBytes=new TextEncoder().encode(data.content);
  if(contentBytes.byteLength>MAX_TEXT_BYTES)return error('TEXT_TOO_LARGE','在线编辑上限为 512 KiB',413);
  const url=new URL('/api/v1/storage/upload',request.url);
  url.searchParams.set('space_id',file.space_id);
  if(file.folder_id)url.searchParams.set('folder_id',file.folder_id);
  url.searchParams.set('name',file.name);
  url.searchParams.set('replace_file_id',file.id);
  url.searchParams.set('expected_revision',String(data.expected_revision));
  const internal=new Request(url,{method:'POST',headers:{'Content-Type':mime,'Content-Length':String(contentBytes.byteLength)},body:contentBytes});
  return uploadFile(internal,env,user);
 }
 let objectKey,size,mimeType,actualRevision;
 if(revisionString){
  const revision=Number(revisionString);
  if(!nonNegativeInt(revision))return error('INVALID_REVISION','修订号无效',400);
  const historical=await one(db,`SELECT v.revision,v.size_bytes,v.mime_type,o.object_key,o.status FROM file_versions v
   JOIN storage_objects o ON o.id=v.object_id AND o.bucket_type='private'
   WHERE v.file_id=? AND v.revision=?`,[file.id,revision]);
  if(!historical||historical.status!=='ready')return error('VERSION_NOT_FOUND','历史版本不可用',404);
  ({object_key:objectKey,size_bytes:size,mime_type:mimeType,revision:actualRevision}=historical);
 }else{
  const live=await one(db,"SELECT object_key,size_bytes,status FROM storage_objects WHERE id=? AND bucket_type='private'",[file.object_id]);
  if(!live||live.status!=='ready')return error('FILE_UNAVAILABLE','文件存储内容不可用',503);
  objectKey=live.object_key;size=file.size_bytes;mimeType=file.mime_type;actualRevision=file.revision;
 }
 if(size>MAX_TEXT_BYTES)return error('TEXT_TOO_LARGE','文件超过 512 KiB，请下载后修改并上传覆盖',413);
 const obj=await storageBinding(env).get(objectKey);
 if(!obj||!obj.body||obj.size!==size)return error('FILE_UNAVAILABLE','文件对象丢失或内容大小不符',503);
 // Enforce an additional bound even when R2 metadata is inconsistent.
 const bytes=new Uint8Array(await new Response(obj.body).arrayBuffer());
 if(bytes.byteLength!==size||bytes.byteLength>MAX_TEXT_BYTES)return error('FILE_UNAVAILABLE','文件内容校验失败',503);
 let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return error('TEXT_ENCODING_UNSUPPORTED','文本不是合法 UTF-8，请下载后转码',415);}
 if(!validText(content))return error('TEXT_ENCODING_UNSUPPORTED','文件包含不可编辑的字符',415);
 return ok({id:file.id,name:file.name,revision:actualRevision,size_bytes:size,mime_type:mimeType,text:content,editable:!revisionString,max_bytes:MAX_TEXT_BYTES});
}
