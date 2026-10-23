import {RESERVE_SQL,settings} from './admin.js';
import {one,many,execute,dbFromEnv} from './database.js';
import {destinationAllowed,storageBinding,DEFAULT_QUOTA_BYTES} from './storage.js';
import {validName,uuid} from './spaces.js';
import {ok,error} from '../utils/response.js';

export const MiB=1024*1024;
export const MIN_PART=5*MiB;
export const DEFAULT_PART=8*MiB;
export const MAX_PART=64*MiB; // safely below Free Worker request-size limit
export const MAX_TOTAL=8*1024*MiB; // application-wide, free-tier-friendly safety ceiling
export const MAX_PARTS=10000;
const STATUS={uploading:'uploading',completed:'completed',aborted:'aborted'};
export function choosePartSize(bytes){return Math.max(DEFAULT_PART,Math.ceil(bytes/MAX_PARTS/MiB)*MiB);}
export function validPartLayout(total,part){return Number.isSafeInteger(total)&&total>0&&total<=MAX_TOTAL&&Number.isSafeInteger(part)&&part>=MIN_PART&&part<=MAX_PART&&Math.ceil(total/part)<=MAX_PARTS;}
function sessionPublic(s,parts=[]){return {id:s.id,file_name:s.file_name,space_id:s.space_id,target_folder_id:s.target_folder_id,total_bytes:s.total_bytes,part_size:s.part_size,status:s.status,expires_at:s.expires_at,parts:parts.map(p=>({part_number:p.part_number,size_bytes:p.size_bytes}))};}
async function session(db,id,user){return one(db,'SELECT * FROM upload_sessions WHERE id=? AND user_id=?',[id,user.id]);}
async function getParts(db,id){return many(db,'SELECT part_number,etag,size_bytes FROM upload_parts WHERE upload_session_id=? ORDER BY part_number',[id]);}
function active(s){return s.status===STATUS.uploading&&Date.parse(s.expires_at.replace(' ','T')+'Z')>Date.now();}
async function release(db,s){await execute(db,'UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?',[s.reserved_bytes,s.space_id]);}
async function expire(db,bucket,s){try{await bucket.resumeMultipartUpload(s.object_key,s.r2_upload_id).abort();}catch(e){console.warn('Multipart abort failed',s.id,e)}await execute(db,"UPDATE upload_sessions SET status='aborted',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='uploading'",[s.id]);await release(db,s);}
export async function initiate(req,env,user){
 const data=await req.json().catch(()=>null),db=dbFromEnv(env),bucket=storageBinding(env);
 const {name,space_id:spaceId,folder_id:folderId=null,size_bytes:size,mime_type:mime='application/octet-stream'}=data||{};
 if(!validName(name)||!Number.isSafeInteger(size)||!validPartLayout(size,choosePartSize(size))||typeof spaceId!=='string'||!/^[0-9a-f-]{36}$/.test(spaceId)||folderId!==null&&!/^[0-9a-f-]{36}$/.test(folderId)||typeof mime!=='string'||mime.length>120)return error('INVALID_UPLOAD','文件名称、大小或目标无效',400);
 if(!await destinationAllowed(db,user,spaceId,folderId))return error('FORBIDDEN','没有目标目录写入权限',403);
 if(await one(db,"SELECT id FROM files WHERE space_id=? AND folder_id IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL AND status!='deleted'",[spaceId,folderId,name]))return error('NAME_CONFLICT','目标目录有同名文件',409);
 if(!(await settings(db)).uploads_enabled)return error('UPLOAD_DISABLED','管理员已暂停上传',403);
 const reservation=await execute(db,RESERVE_SQL,[size,spaceId,size,DEFAULT_QUOTA_BYTES,size,DEFAULT_QUOTA_BYTES]);
 if(!reservation.meta?.changes)return error('QUOTA_EXCEEDED','空间剩余容量不足',413);
 const id=uuid(),key=`private/${spaceId}/${uuid()}`,partSize=choosePartSize(size);
 let upload;
 try{
  upload=await bucket.createMultipartUpload(key,{httpMetadata:{contentType:mime}});
  await execute(db,"INSERT INTO upload_sessions(id,user_id,space_id,target_folder_id,object_key,r2_upload_id,file_name,total_bytes,reserved_bytes,status,expires_at,part_size,mime_type) VALUES(?,?,?,?,?,?,?,?,?,'uploading',datetime('now','+24 hours'),?,?)",[id,user.id,spaceId,folderId,key,upload.uploadId,name,size,size,partSize,mime]);
  return ok({upload_id:id,part_size:partSize,total_parts:Math.ceil(size/partSize),expires_in_seconds:86400},201);
 }catch(e){console.error('initiate multipart',e);if(upload)await upload.abort().catch(()=>{});await execute(db,'UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?',[size,spaceId]);return error('UPLOAD_FAILED','无法创建上传会话',503)}
}
export async function status(env,user,id){const db=dbFromEnv(env),s=await session(db,id,user);if(!s)return error('NOT_FOUND','任务不存在',404);return ok(sessionPublic(s,await getParts(db,id)));}
export async function list(env,user){const db=dbFromEnv(env);const rows=await many(db,"SELECT * FROM upload_sessions WHERE user_id=? AND status='uploading' ORDER BY created_at DESC LIMIT 50",[user.id]);return ok({items:rows.map(s=>sessionPublic(s))});}
export async function part(req,env,user,id,n){
 const db=dbFromEnv(env),bucket=storageBinding(env),s=await session(db,id,user),number=Number(n);
 if(!s)return error('NOT_FOUND','任务不存在',404);if(!active(s))return error('UPLOAD_EXPIRED','上传任务过期或已结束',409);
 if(!await destinationAllowed(db,user,s.space_id,s.target_folder_id))return error('FORBIDDEN','上传权限已撤销',403);
 const count=Math.ceil(s.total_bytes/s.part_size),expected=number===count?s.total_bytes-s.part_size*(count-1):s.part_size;
 const declared=Number(req.headers.get('content-length'));
 if(!Number.isInteger(number)||number<1||number>count||!Number.isSafeInteger(declared)||declared!==expected)return error('INVALID_PART','分片序号或长度不符',400);
 const prior=await one(db,'SELECT part_number,size_bytes FROM upload_parts WHERE upload_session_id=? AND part_number=?',[id,number]);if(prior)return error('PART_EXISTS','分片已记录，请刷新上传状态',409);
 try{
  const result=await bucket.resumeMultipartUpload(s.object_key,s.r2_upload_id).uploadPart(number,req.body);
  await execute(db,'INSERT INTO upload_parts(upload_session_id,part_number,etag,size_bytes) VALUES(?,?,?,?)',[id,number,result.etag,declared]);
  return ok({part_number:number,size_bytes:declared});
 }catch(e){console.error('multipart part error',e);return error('PART_FAILED','分片上传失败，可重试',503)}
}
export async function complete(env,user,id){
 const db=dbFromEnv(env),bucket=storageBinding(env),s=await session(db,id,user);
 if(!s)return error('NOT_FOUND','任务不存在',404);
 if(s.status==='completed'){const file=await one(db,'SELECT id FROM files WHERE object_id=(SELECT id FROM storage_objects WHERE object_key=?)',[s.object_key]);return ok({file_id:file?.id,status:'completed'});}
 if(!active(s))return error('UPLOAD_EXPIRED','上传任务过期或已结束',409);
 if(!await destinationAllowed(db,user,s.space_id,s.target_folder_id))return error('FORBIDDEN','上传权限已撤销',403);
 const parts=await getParts(db,id),count=Math.ceil(s.total_bytes/s.part_size);
 if(parts.length!==count||parts.some((p,i)=>p.part_number!==i+1||p.size_bytes!==(i===count-1?s.total_bytes-s.part_size*i:s.part_size)))return error('INCOMPLETE','仍有未完成分片',409);
 if(await one(db,"SELECT id FROM files WHERE space_id=? AND folder_id IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL AND status!='deleted'",[s.space_id,s.target_folder_id,s.file_name]))return error('NAME_CONFLICT','存在同名文件，请先处理',409);
 // Claim completion; avoid two concurrent completes of the same upload.
 const claimed=await execute(db,"UPDATE upload_sessions SET status='verifying',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='uploading'",[id]);
 if(!claimed.meta?.changes)return error('BUSY','合并已经开始，请查询状态',409);
 try{
  const object=await bucket.resumeMultipartUpload(s.object_key,s.r2_upload_id).complete(parts.map(p=>({partNumber:p.part_number,etag:p.etag})));
  if(object.size!==s.total_bytes)throw new Error('Multipart object size mismatch');
  const objectId=uuid(),fileId=uuid();
  await db.batch([
   db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,etag,status) VALUES(?,'private',?,?,?,'ready')").bind(objectId,s.object_key,s.total_bytes,object.etag||null),
   db.prepare("INSERT INTO files(id,space_id,folder_id,name,object_id,size_bytes,mime_type,status,created_by) VALUES(?,?,?,?,?,?,?,'ready',?)").bind(fileId,s.space_id,s.target_folder_id,s.file_name,objectId,s.total_bytes,s.mime_type,user.id),
   db.prepare('UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?),used_bytes=used_bytes+? WHERE id=?').bind(s.reserved_bytes,s.total_bytes,s.space_id),
   db.prepare("UPDATE upload_sessions SET status='completed',reserved_bytes=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id)
  ]);
  return ok({file_id:fileId,status:'completed'},201);
 }catch(e){console.error('multipart completion',e);
  // Storage may already have completed; never automatically return to uploading or remove reservation.
  await execute(db,"UPDATE upload_sessions SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='verifying'",[id]).catch(()=>{});
  return error('COMPLETE_FAILED','完成失败，请联系管理员核查存储状态，勿重新上传该任务',503);
 }
}
export async function cancel(env,user,id){const db=dbFromEnv(env),bucket=storageBinding(env),s=await session(db,id,user);if(!s)return error('NOT_FOUND','任务不存在',404);if(s.status==='aborted')return ok({status:'aborted'});if(s.status!=='uploading')return error('INVALID_STATE','此任务不能取消',409);
 const claimed=await execute(db,"UPDATE upload_sessions SET status='aborted',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='uploading'",[id]);if(!claimed.meta?.changes)return error('BUSY','任务状态已变化',409);
 await bucket.resumeMultipartUpload(s.object_key,s.r2_upload_id).abort().catch(e=>console.error('Multipart abort needs cleanup',e));
 await release(db,s);await execute(db,'UPDATE upload_sessions SET reserved_bytes=0 WHERE id=?',[id]);return ok({status:'aborted'});
}
export async function cleanupExpired(env){const db=dbFromEnv(env),bucket=storageBinding(env);const rows=await many(db,"SELECT * FROM upload_sessions WHERE status='uploading' AND expires_at<CURRENT_TIMESTAMP LIMIT 30");for(const s of rows)await expire(db,bucket,s);return rows.length;}
