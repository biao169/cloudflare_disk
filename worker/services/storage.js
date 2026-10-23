import {one,execute,dbFromEnv} from './database.js';
import {RESERVE_SQL,settings} from './admin.js';
import {spaceAccess,folderAccess,canFolder,canSpace,uuid,validName} from './spaces.js';
import {ok,error} from '../utils/response.js';
export const MAX_UPLOAD_BYTES=8*1024*1024;
export const DEFAULT_QUOTA_BYTES=8*1024*1024*1024;
export function uploadPermission(access){return Boolean(access);}
export async function destinationAllowed(db,user,spaceId,folderId){
 const space=await spaceAccess(db,user,spaceId);if(!space)return false;
 if(!folderId)return canSpace(space,'write');
 const folder=await folderAccess(db,user,folderId);
 return Boolean(folder&&folder.folder.space_id===spaceId&&canFolder(folder,'write'));
}
export function storageBinding(env){if(!env.PRIVATE_BUCKET||typeof env.PRIVATE_BUCKET.put!=='function')throw new Error('PRIVATE_BUCKET binding is missing');return env.PRIVATE_BUCKET;}
export function uploadInputs(request,url){
 const size=Number(request.headers.get('content-length'));
 const name=url.searchParams.get('name');const spaceId=url.searchParams.get('space_id');const folderId=url.searchParams.get('folder_id')||null;
 if(request.headers.get('content-length')===null||!Number.isSafeInteger(size)||size<0||size>MAX_UPLOAD_BYTES||!validName(name)||!spaceId||!/^[0-9a-f-]{36}$/.test(spaceId)||folderId&&!/^[0-9a-f-]{36}$/.test(folderId))return null;
 return {size,name:name.trim(),spaceId,folderId};
}
export async function uploadFile(request,env,user){
 const db=dbFromEnv(env),bucket=storageBinding(env),input=uploadInputs(request,new URL(request.url));
 if(!input)return error('INVALID_UPLOAD',`需要有效的文件名称、空间 ID 和 Content-Length；单次最多 ${MAX_UPLOAD_BYTES} 字节`,400);
 const {size,name,spaceId,folderId}=input;
 if(!(await settings(db)).uploads_enabled)return error('UPLOAD_DISABLED','管理员已暂停上传',403);
 if(!await destinationAllowed(db,user,spaceId,folderId))return error('FORBIDDEN','没有上传权限',403);
 const existing=await one(db,"SELECT id FROM files WHERE space_id=? AND folder_id IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL AND status!='deleted'",[spaceId,folderId,name]);
 if(existing)return error('NAME_CONFLICT','存在同名文件',409);
 const reservation=await execute(db,RESERVE_SQL,[size,spaceId,size,DEFAULT_QUOTA_BYTES,size,DEFAULT_QUOTA_BYTES]);
 if(!reservation.meta?.changes)return error('QUOTA_EXCEEDED','空间剩余容量不足',413);
 const objectId=uuid(),fileId=uuid(),key=`private/${spaceId}/${objectId}`,mime=(request.headers.get('content-type')||'application/octet-stream').split(';')[0].slice(0,120);
 let stored=false;
 try{
  // Streaming upload; Worker never buffers the entire file.
  const obj=await bucket.put(key,request.body,{httpMetadata:{contentType:mime}});stored=true;
  if(obj.size!==size)throw new Error('Uploaded object size mismatch');
  // D1 batch acts atomically for metadata + accounting. R2 remains a separate service.
  await db.batch([
   db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,etag,status) VALUES(?,'private',?,?,?,'ready')").bind(objectId,key,size,obj.etag??null),
   db.prepare("INSERT INTO files(id,space_id,folder_id,name,object_id,size_bytes,mime_type,status,created_by) VALUES(?,?,?,?,?,?,?,'ready',?)").bind(fileId,spaceId,folderId,name,objectId,size,mime,user.id),
   db.prepare('UPDATE spaces SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+? WHERE id=?').bind(size,size,spaceId)
  ]);
  return ok({id:fileId,name,size_bytes:size,mime_type:mime},201);
 }catch(e){
  console.error('Upload failed',e);
  if(stored){try{await bucket.delete(key)}catch(cleanupError){console.error('Orphan R2 object requiring cleanup',key,cleanupError)}}
  try{await execute(db,'UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?',[size,spaceId])}catch(cleanupError){console.error('Reservation cleanup failed',cleanupError)}
  return error('UPLOAD_FAILED','文件上传失败，未建立可见文件记录',503);
 }
}
export const PREVIEW_MIME_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf']);
export function previewAllowed(mime){return PREVIEW_MIME_TYPES.has((mime||'').toLowerCase());}
export function matchesPreviewSignature(mime,bytes){
 const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
 const begins=(...x)=>b.length>=x.length&&x.every((v,i)=>b[i]===v);
 switch(mime){
 case 'image/jpeg': return begins(0xff,0xd8,0xff);
 case 'image/png': return begins(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a);
 case 'image/gif': return begins(0x47,0x49,0x46,0x38)&&(b[4]===0x37||b[4]===0x39)&&b[5]===0x61;
 case 'image/webp': return begins(0x52,0x49,0x46,0x46)&&b[8]===0x57&&b[9]===0x45&&b[10]===0x42&&b[11]===0x50;
 case 'video/mp4': return b.length>=12&&b[4]===0x66&&b[5]===0x74&&b[6]===0x79&&b[7]===0x70;
 case 'video/webm': return begins(0x1a,0x45,0xdf,0xa3);
 case 'application/pdf': return begins(0x25,0x50,0x44,0x46,0x2d);
 default: return false;
 }
}
async function validatePreviewObject(bucket,key,mime){
 const signature=await bucket.get(key,{range:{offset:0,length:32}});
 if(!signature?.body)return false;
 const prefix=new Uint8Array(await new Response(signature.body).arrayBuffer());
 return matchesPreviewSignature(mime,prefix);
}
export async function downloadFile(request,env,user,fileId,{preview=false}={}){
 const db=dbFromEnv(env),bucket=storageBinding(env);
 const file=await one(db,"SELECT f.*,o.object_key,o.bucket_type,o.status AS object_status FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE f.id=? AND f.status='ready' AND f.deleted_at IS NULL",[fileId]);
 if(!file||file.object_status!=='ready'||file.bucket_type!=='private')return error('NOT_FOUND','文件不存在',404);
 const access=await spaceAccess(db,user,file.space_id);
 if(!access)return error('NOT_FOUND','文件不存在',404);
 if(file.folder_id){const folder=await folderAccess(db,user,file.folder_id);if(!folder||!canFolder(folder,'read'))return error('NOT_FOUND','文件不存在',404)}
 else if(!canSpace(access,'read'))return error('NOT_FOUND','文件不存在',404);
 if(preview&&!previewAllowed(file.mime_type))return error('PREVIEW_UNSUPPORTED','不支持在线预览此类型文件',415);
 if(preview&&!(await validatePreviewObject(bucket,file.object_key,file.mime_type)))return error('PREVIEW_INVALID','文件内容与预览类型不符',415);
 const rangeHeader=request.headers.get('range');let range;
 if(rangeHeader){const match=/^bytes=(\d*)-(\d*)$/.exec(rangeHeader);if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size_bytes}`}});
  if(match[1]){const start=Number(match[1]),end=match[2]?Number(match[2]):file.size_bytes-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=file.size_bytes)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size_bytes}`}});range={offset:start,length:Math.min(end,file.size_bytes-1)-start+1};}
  else {const length=Number(match[2]);if(!Number.isSafeInteger(length)||length<=0)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size_bytes}`}});range={offset:Math.max(0,file.size_bytes-length),length:Math.min(length,file.size_bytes)};}
 }
 const object=await bucket.get(file.object_key,range?{range}:undefined);
 if(!object)return error('FILE_UNAVAILABLE','存储对象不存在',503);
 const headers=new Headers({'Content-Type':file.mime_type||'application/octet-stream','Content-Disposition':`${preview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Accept-Ranges':'bytes','Content-Length':String(range?range.length:object.size)});
 if(object.etag)headers.set('ETag',object.httpEtag||`"${object.etag}"`);
 if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${file.size_bytes}`);
 return new Response(request.method==='HEAD'?null:object.body,{status:range?206:200,headers});
}
