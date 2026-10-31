// RC14.9: public presentation for files explicitly published by the super administrator.
// Never expose OAuth tokens, Graph preview links, Drive IDs or preauthorized download URLs in JSON.
import {dbFromEnv,one,execute} from './database.js';
import {getAccessToken,validMicrosoftDownloadUrl} from './onedrive-oauth.js';
import {validatedThumbnailUrl} from './onedrive-browser.js';
import {ok,error} from '../utils/response.js';
import {authorizeShare,countView,recordDaily} from './onedrive-share-policy.js';

export const PUBLISHED_ID=/^odf_[a-f0-9]{32}$/;
const ITEM_ID=/^[A-Za-z0-9_!.-]{1,220}$/;
const API='https://graph.microsoft.com/v1.0';
const COVER_MAX=2*1024*1024;
const PHOTO_MIMES=new Set(['image/jpeg','image/png','image/webp','image/gif']);
const UPLOAD_MIMES=new Set(['image/jpeg','image/png','image/webp']);
const INLINE_MIMES=new Set([...PHOTO_MIMES,'application/pdf','video/mp4','video/webm']);
const COVER_STYLES=new Set(['auto','icon','ocean','violet','forest']);
const PRIVATE_HEADERS={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const previewBytesLimit=mime=>mime==='application/pdf'?60*1024*1024:PHOTO_MIMES.has(mime)?25*1024*1024:1024*1024*1024;
const getRow=(env,id)=>one(dbFromEnv(env),'SELECT * FROM onedrive_drive_publications WHERE id=?',[id]);
function cleanHttpValue(value){return typeof value==='string'&&value.length<200&&!/[\r\n]/.test(value)?value:null;}

export function previewMime(value){const mime=String(value||'').split(';')[0].trim().toLowerCase();return INLINE_MIMES.has(mime)?mime:null;}
export function fallbackMime(filename){const ext=String(filename||'').split('.').pop()?.toLowerCase();return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',pdf:'application/pdf',mp4:'video/mp4',webm:'video/webm'})[ext]||null;}
export function publicPresentation(row){const mime=previewMime(row.file_mime)||fallbackMime(row.file_name);return {
 id:row.id,title:row.title||row.file_name,name:row.file_name,description:row.description||'',display_name:row.display_name||'',
 size:Number.isSafeInteger(row.file_size)?row.file_size:null,mime_type:mime||row.file_mime||null,
 updated_at:row.file_modified_at||null,created_at:row.created_at,preview_enabled:row.preview_enabled!==0&&!!mime,
 cover_style:COVER_STYLES.has(row.cover_style)?row.cover_style:'auto',has_custom_cover:!!row.cover_key,
 cover_url:`/api/v1/public/onedrive/${row.id}/cover`,preview_url:`/api/v1/public/onedrive/${row.id}/preview`,
 download_url:`/r/${row.id}`,share_url:`/s/${row.id}`
};}
export function validatePresentation(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_INPUT');
 const result={},allowed=['title','description','display_name','cover_style','preview_enabled'];
 if(Object.keys(input).some(k=>!allowed.includes(k)))throw Error('INVALID_INPUT');
 for(const [key,value] of Object.entries(input)){
  if(['title','description','display_name'].includes(key)){
   const cap={title:140,description:1200,display_name:80}[key];
   if(typeof value!=='string'||value.length>cap||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error('INVALID_INPUT');
   const v=value.trim();if(key==='description'&&v.split('\n').length>16)throw Error('INVALID_INPUT');result[key]=v||null;
  }else if(key==='cover_style'){
   if(!COVER_STYLES.has(value))throw Error('INVALID_INPUT');result[key]=value;
  }else if(key==='preview_enabled'){
   if(typeof value!=='boolean')throw Error('INVALID_INPUT');result[key]=value?1:0;
  }
 }
 if(!Object.keys(result).length)throw Error('INVALID_INPUT');
 return result;
}
export async function updatePresentation(env,id,input){
 if(!PUBLISHED_ID.test(id))throw Error('INVALID_PUBLICATION_ID');
 const fields=validatePresentation(input);const keys=Object.keys(fields);
 const r=await execute(dbFromEnv(env),`UPDATE onedrive_drive_publications SET ${keys.map(k=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`,[...keys.map(k=>fields[k]),id]);
 if(!r.meta?.changes)throw Error('NOT_FOUND');
 return publicPresentation(await getRow(env,id));
}
function detectImage(data){if(data.length<12)return null;
 if(data[0]===0xff&&data[1]===0xd8&&data[2]===0xff)return 'image/jpeg';
 if([137,80,78,71,13,10,26,10].every((x,i)=>data[i]===x))return 'image/png';
 if(String.fromCharCode(...data.slice(0,4))==='RIFF'&&String.fromCharCode(...data.slice(8,12))==='WEBP')return 'image/webp';
 if(String.fromCharCode(...data.slice(0,6))==='GIF89a'||String.fromCharCode(...data.slice(0,6))==='GIF87a')return 'image/gif';
 return null;
}
async function boundedBytes(stream,max){if(!stream)throw Error('INVALID_COVER');
 const reader=stream.getReader();const parts=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw Error('COVER_TOO_LARGE');parts.push(value);}}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 const out=new Uint8Array(total);let off=0;for(const part of parts){out.set(part,off);off+=part.length;}return out;
}
export async function uploadCover(env,id,req){
 if(!PUBLISHED_ID.test(id))throw Error('INVALID_PUBLICATION_ID');
 const row=await getRow(env,id);if(!row||row.status!=='active')throw Error('NOT_FOUND');
 if(!env.PRIVATE_BUCKET?.put)throw Error('PRIVATE_BUCKET_REQUIRED');
 const declared=Number(req.headers.get('Content-Length'));
 if(declared>COVER_MAX)throw Error('COVER_TOO_LARGE');
 const mime=String(req.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 if(!UPLOAD_MIMES.has(mime))throw Error('INVALID_COVER_TYPE');
 const bytes=await boundedBytes(req.body,COVER_MAX);
 if(bytes.length<16||detectImage(bytes)!==mime)throw Error('INVALID_COVER_TYPE');
 const key=`onedrive-presentation/covers/${id}/${crypto.randomUUID()}`;
 await env.PRIVATE_BUCKET.put(key,bytes,{httpMetadata:{contentType:mime}});
 try{
  const updated=await execute(dbFromEnv(env),"UPDATE onedrive_drive_publications SET cover_key=?,cover_mime=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'",[key,mime,id]);
  if(!updated.meta?.changes)throw Error('NOT_FOUND');
 }catch(e){await env.PRIVATE_BUCKET.delete(key).catch(()=>{});throw e;}
 if(row.cover_key)await env.PRIVATE_BUCKET.delete(row.cover_key).catch(()=>{});
 return {cover_url:`/api/v1/public/onedrive/${id}/cover`,has_custom_cover:true};
}
export async function clearCover(env,id){
 if(!PUBLISHED_ID.test(id))throw Error('INVALID_PUBLICATION_ID');
 const row=await getRow(env,id);if(!row||row.status!=='active')throw Error('NOT_FOUND');
 await execute(dbFromEnv(env),"UPDATE onedrive_drive_publications SET cover_key=NULL,cover_mime=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'",[id]);
 if(row.cover_key)await env.PRIVATE_BUCKET?.delete(row.cover_key).catch(()=>{});
 return {deleted:true};
}
export async function cleanupRevokedCover(env,id){const row=await getRow(env,id);if(!row?.cover_key)return;
 try{await env.PRIVATE_BUCKET?.delete(row.cover_key);await execute(dbFromEnv(env),'UPDATE onedrive_drive_publications SET cover_key=NULL,cover_mime=NULL WHERE id=?',[id]);}
 catch(e){console.warn('OneDrive cover cleanup pending',e?.message||'R2_UNAVAILABLE');}
}
function bad(status,text,extra={}){return new Response(text,{status,headers:{...PRIVATE_HEADERS,'Content-Type':'text/plain; charset=utf-8',...extra}});}
function validItem(row){return ITEM_ID.test(row.drive_id)&&ITEM_ID.test(row.item_id);}
async function graphDrive(env,row,path=''){
 if(!validItem(row))throw Error('INVALID_STORED_ID');
 const token=await getAccessToken(env);
 const u=`${API}/drives/${encodeURIComponent(row.drive_id)}/items/${encodeURIComponent(row.item_id)}${path}`;
 const response=await fetch(u,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(!response.ok){const e=new Error('GRAPH_UNAVAILABLE');e.status=response.status;throw e;}
 return response.json();
}
async function trustedMicrosoftFetch(url,request){let next=url;
 for(let i=0;i<3;i++){
  if(!validMicrosoftDownloadUrl(next)&&!validatedThumbnailUrl(next))throw Error('UNTRUSTED_MICROSOFT_URL');
  const response=await fetch(next,{method:request.method||'GET',headers:request.headers||{},redirect:'manual',signal:AbortSignal.timeout(25000)});
  if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)throw Error('UNTRUSTED_MICROSOFT_URL');next=new URL(location,next).href;continue;}
  return response;
 }
 throw Error('TOO_MANY_REDIRECTS');
}
function mediaHeaders(mime,upstream){const h=new Headers(PRIVATE_HEADERS);h.set('Content-Type',mime);
 h.set('Content-Disposition','inline');h.set('X-Frame-Options','SAMEORIGIN');h.set('Accept-Ranges','bytes');
 for(const k of ['Content-Range','Content-Length','ETag']){const v=cleanHttpValue(upstream.headers.get(k));if(v)h.set(k,v);}
 return h;
}
export async function publicOneDriveRoute(req,env,path){
 const match=/^\/api\/v1\/public\/onedrive\/(odf_[a-f0-9]{32})(?:\/(cover|preview))?$/.exec(path);
 if(!match)return error('NOT_FOUND','链接不存在',404);
 const id=match[1],mode=match[2]||'metadata';
 if(!['GET','HEAD'].includes(req.method))return error('METHOD_NOT_ALLOWED','请求方法不支持',405);
 const row=await getRow(env,id);
 if(!row)return error('NOT_FOUND','分享不存在',404);
 if(row.status!=='active')return error('GONE','分享已撤销',410);
 const allowed=await authorizeShare(req,env,row,{checkViewLimit:mode==='metadata'&&!row.group_id});
 if(!allowed.allowed)return allowed.response;
 if(mode==='metadata'){
  if(req.method==='GET'&&!(await countView(env,row)))return error('VIEW_LIMIT_REACHED','页面浏览次数已达上限',429);
  const presentation=publicPresentation(row);if(allowed.scope.show_direct_link===0)presentation.show_direct_link=false;else presentation.show_direct_link=true;
  return req.method==='HEAD'?new Response(null,{status:200,headers:PRIVATE_HEADERS}):ok(presentation);
 }
 if(mode==='cover'){
  try{
   if(row.cover_key){const obj=await env.PRIVATE_BUCKET?.get(row.cover_key);if(!obj)return bad(404,'封面不存在');
    const type=String(row.cover_mime||'');if(!UPLOAD_MIMES.has(type))return bad(415,'不支持该封面格式');
    return new Response(req.method==='HEAD'?null:obj.body,{headers:{...PRIVATE_HEADERS,'Content-Type':type,'Content-Length':String(obj.size),'X-Frame-Options':'SAMEORIGIN'}});
   }
   if(row.cover_style!=='auto')return bad(404,'未设置自动封面');
   const j=await graphDrive(env,row,'/thumbnails?$select=large');
   const t=Array.isArray(j.value)?j.value[0]:null;
   const thumb=validatedThumbnailUrl(t?.large?.url)||validatedThumbnailUrl(t?.medium?.url)||validatedThumbnailUrl(t?.small?.url);
   if(!thumb)return bad(404,'无可用缩略图');
   // Thumb is retrieved server-side; do not publish the potentially preauthorized Graph URL.
   const media=await trustedMicrosoftFetch(thumb,{method:'GET'});
   if(media.status!==200)return bad(404,'缩略图不可用');
   const len=Number(media.headers.get('content-length'));
   if(len>COVER_MAX)return bad(413,'缩略图过大');
   const bytes=await boundedBytes(media.body,COVER_MAX);
   const type=detectImage(bytes);if(!type)return bad(415,'缩略图格式不受支持');
   return new Response(req.method==='HEAD'?null:bytes,{headers:{...PRIVATE_HEADERS,'Content-Type':type,'Content-Length':String(bytes.length),'X-Frame-Options':'SAMEORIGIN'}});
  }catch{return bad(503,'封面暂时不可用',{'Retry-After':'60'});}
 }
 if(row.preview_enabled===0)return bad(403,'管理员已关闭文件预览');
 const mime=previewMime(row.file_mime)||fallbackMime(row.file_name);if(!mime)return bad(415,'当前文件类型不支持预览');
 try{
  const item=await graphDrive(env,row);
  if(!item.file||item.folder)return bad(404,'来源文件不存在');
  const liveMime=previewMime(item.file?.mimeType);
  if(!liveMime||liveMime!==mime)return bad(415,'文件类型变化，预览不可用');
  if(Number.isFinite(item.size)&&item.size>previewBytesLimit(mime))return bad(413,'文件超过预览大小限制');
  const url=item['@microsoft.graph.downloadUrl'];
  if(!validMicrosoftDownloadUrl(url))return bad(503,'文件预览地址暂时不可用',{'Retry-After':'60'});
  const range=req.headers.get('Range');
  if(range&&(!/^bytes=\d{0,15}-\d{0,15}$/.test(range)||range==='bytes=-'))return bad(416,'不支持该请求范围');
  const method=req.method;
  const upstream=await trustedMicrosoftFetch(url,{method,headers:range?{'Range':range}:{}});
  if(![200,206,416].includes(upstream.status))return bad(upstream.status===429?503:502,'微软预览请求失败');
  if(upstream.status===416)return bad(416,'请求超出文件范围');
  const upstreamType=(upstream.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(upstreamType&&upstreamType!=='application/octet-stream'&&upstreamType!==mime)return bad(415,'微软返回了不匹配的文件内容类型');
  const len=Number(upstream.headers.get('content-length'));
  if(len>previewBytesLimit(mime))return bad(413,'预览内容过大');
  if(method==='GET')await recordDaily(dbFromEnv(env),row.id,'preview');
  return new Response(method==='HEAD'?null:upstream.body,{status:upstream.status,headers:mediaHeaders(mime,upstream)});
 }catch{return bad(503,'文件预览暂时不可用',{'Retry-After':'60'});}
}
