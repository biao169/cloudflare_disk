import {preparePublicVersions,abandonPreparedPublic,synchronizePublicationOnCommit,MAX_PUBLIC_COPY_BYTES} from './public-versions.js';
import {RESERVE_SQL,settings} from './admin.js';
import {one,many,execute,dbFromEnv} from './database.js';
import {destinationAllowed,storageBinding,DEFAULT_QUOTA_BYTES} from './storage.js';
import {validName,uuid} from './spaces.js';
import {ok,error} from '../utils/response.js';
import {targetForReplace,commitReplacement} from './replacements.js';

export const MiB=1024*1024;
export const MIN_PART=5*MiB;
export const DEFAULT_PART=8*MiB;
export const MAX_PART=64*MiB; // safely below Free Worker request-size limit
export const MAX_TOTAL=8*1024*MiB; // application-wide, free-tier-friendly safety ceiling
export const MAX_PARTS=10000;
const STATUS={uploading:'uploading',completed:'completed',aborted:'aborted'};
export function choosePartSize(bytes){return Math.max(DEFAULT_PART,Math.ceil(bytes/MAX_PARTS/MiB)*MiB);}
export function validPartLayout(total,part){return Number.isSafeInteger(total)&&total>0&&total<=MAX_TOTAL&&Number.isSafeInteger(part)&&part>=MIN_PART&&part<=MAX_PART&&Math.ceil(total/part)<=MAX_PARTS;}
function sessionPublic(s,parts=[]){return {id:s.id,file_name:s.file_name,space_id:s.space_id,target_folder_id:s.target_folder_id,total_bytes:s.total_bytes,part_size:s.part_size,status:s.status,expires_at:s.expires_at,recovery_error:s.recovery_error||null,recovery_attempts:s.recovery_attempts||0,replace_file_id:s.replace_file_id||null,expected_revision:s.expected_revision??null,parts:parts.map(p=>({part_number:p.part_number,size_bytes:p.size_bytes}))};}
async function session(db,id,user){return one(db,'SELECT * FROM upload_sessions WHERE id=? AND user_id=?',[id,user.id]);}
async function getParts(db,id){return many(db,'SELECT part_number,etag,size_bytes FROM upload_parts WHERE upload_session_id=? ORDER BY part_number',[id]);}
function active(s){return s.status===STATUS.uploading&&Date.parse(s.expires_at.replace(' ','T')+'Z')>Date.now();}
const STALE_SECONDS=120;
function stale(s){return (Date.now()-Date.parse(s.updated_at.replace(' ','T')+'Z'))>=STALE_SECONDS*1000;}
async function markAborted(db,s){
 await db.batch([
  db.prepare("UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?").bind(s.reserved_bytes,s.space_id),
  db.prepare("UPDATE upload_sessions SET status='aborted',reserved_bytes=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='completed'").bind(s.id)
 ]);
}
async function abortUncompleted(env,db,s){
 // Never release reservation when R2 abort has failed: retry is safer than
 // silently leaving storage occupied without accounting for it.
 try{await storageBinding(env).resumeMultipartUpload(s.object_key,s.r2_upload_id).abort();}
 catch(e){
  // R2 automatically aborts incomplete multipart uploads after seven days.
  // Only after an additional safety day AND confirming no completed object may
  // we release a reservation even when the original upload ID no longer exists.
  const age=Date.now()-Date.parse(s.created_at.replace(' ','T')+'Z');
  if(age>8*86400000){
   try{if(!await storageBinding(env).head(s.object_key)){await markAborted(db,s);return true;}}catch{}
  }
  console.warn('Multipart abort deferred',s.id,e);return false;
 }
 await markAborted(db,s);return true;
}
async function queueOrphan(env,db,s,reason){
 // A completed orphan is physical R2 storage. Keep reserved bytes charged until
 // durable cleanup confirms that the object is actually deleted.
 await db.batch([
  db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs
   (id,object_id,object_key,bucket_type,space_id,size_bytes,reserved_release_bytes,upload_session_id)
   VALUES(?,?,?,'private',?,0,?,?)`).bind(uuid(),`upload-${s.id}`,s.object_key,s.space_id,s.reserved_bytes,s.id),
  db.prepare("UPDATE upload_sessions SET status='aborted',recovery_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='completed'").bind(reason.slice(0,300),s.id)
 ]);
}
async function finalizeCompletedObject(env,db,s,obj,userId){
 if(obj.size!==s.total_bytes)throw new Error('Completed R2 object size mismatch');
 // The logical destination and account permissions must still be valid.
 const uploader=await one(db,'SELECT id,role,status FROM users WHERE id=?',[userId]);
 if(!uploader||uploader.status!=='active'||!await destinationAllowed(db,uploader,s.space_id,s.target_folder_id))throw new Error('UPLOAD_PERMISSION_REVOKED');
 const collision=await one(db,"SELECT id FROM files WHERE space_id=? AND folder_id IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL AND status!='deleted'",[s.space_id,s.target_folder_id,s.file_name]);
 if(collision&&collision.id!==s.replace_file_id)throw new Error('UPLOAD_NAME_CONFLICT');
 if(s.replace_file_id){
  const lookup=await targetForReplace(db,uploader,s.replace_file_id,{spaceId:s.space_id,folderId:s.target_folder_id,name:s.file_name,revision:s.expected_revision});
  if(lookup.error)throw new Error(lookup.error);
  const objectId=uuid();
  const prepared=await preparePublicVersions(env,db,{file:lookup.file,newPrivateKey:s.object_key,size:s.total_bytes,mime:s.mime_type,revision:lookup.file.revision+1});
  let committed=false;
  try{
   const changed=await commitReplacement(db,{file:lookup.file,newObjectId:objectId,key:s.object_key,etag:obj.etag||null,size:s.total_bytes,mime:s.mime_type,userId,reservedBytes:s.reserved_bytes,preparedPublic:prepared});
   if(changed.conflict)throw new Error('VERSION_CONFLICT');
   committed=true;
   await execute(db,"UPDATE upload_sessions SET status='completed',reserved_bytes=0,recovery_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",[s.id]);
   try{await synchronizePublicationOnCommit(env,prepared)}catch(e){console.warn('RC13.2 deferred public alias sync',e);}
   return lookup.file.id;
  }catch(e){
   if(!committed){
    // If D1 committed but its response failed, do not delete published R2 bytes.
    try{
     const winner=await one(db,"SELECT f.id FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE f.id=? AND o.object_key=?",[lookup.file.id,s.object_key]);
     if(winner){
      try{await synchronizePublicationOnCommit(env,prepared)}catch{}
      return lookup.file.id;
     }
    }catch(queryError){console.error('CRITICAL: unknown multipart commit outcome; retaining staged public bytes',queryError);throw e;}
    await abandonPreparedPublic(env,db,prepared);
   }
   throw e;
  }
 }
 const objectId=uuid(),fileId=uuid();
 await db.batch([
  db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,etag,status) VALUES(?,'private',?,?,?,'ready')").bind(objectId,s.object_key,s.total_bytes,obj.etag||null),
  db.prepare("INSERT INTO files(id,space_id,folder_id,name,object_id,size_bytes,mime_type,status,created_by) VALUES(?,?,?,?,?,?,?,'ready',?)").bind(fileId,s.space_id,s.target_folder_id,s.file_name,objectId,s.total_bytes,s.mime_type,userId),
  db.prepare('UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?),used_bytes=used_bytes+? WHERE id=?').bind(s.reserved_bytes,s.total_bytes,s.space_id),
  db.prepare("UPDATE upload_sessions SET status='completed',reserved_bytes=0,recovery_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('verifying','failed')").bind(s.id)
 ]);
 return fileId;
}
function completeParts(s,parts){
 const count=Math.ceil(s.total_bytes/s.part_size);
 if(parts.length!==count||parts.some((p,i)=>p.part_number!==i+1||p.size_bytes!==(i===count-1?s.total_bytes-s.part_size*i:s.part_size)))return null;
 return parts.map(p=>({partNumber:p.part_number,etag:p.etag}));
}
async function storedFileForUpload(db,s){
 return one(db,'SELECT f.id FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE o.object_key=? LIMIT 1',[s.object_key]);
}
export async function recoverSession(env,s,{retryComplete=true}={}){
 const db=dbFromEnv(env),bucket=storageBinding(env);
 if(s.status==='completed')return {status:'completed',file_id:(await storedFileForUpload(db,s))?.id||null};
 if(!['verifying','failed'].includes(s.status))return {status:s.status};
 if(s.status==='verifying'&&!stale(s))return {status:'verifying',waiting:true};
 const previous=await storedFileForUpload(db,s);
 if(previous){
  // Partial database failure is highly unlikely because D1.batch is atomic,
  // but never create another logical file for an object that already has one.
  await db.batch([
   db.prepare('UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?').bind(s.reserved_bytes,s.space_id),
   db.prepare("UPDATE upload_sessions SET status='completed',reserved_bytes=0,recovery_error=NULL WHERE id=?").bind(s.id)
  ]);
  return {status:'completed',file_id:previous.id};
 }
 const expired=Date.parse(s.expires_at.replace(' ','T')+'Z')<=Date.now();
 let obj=await bucket.head(s.object_key); // A head failure must NOT be treated as missing bytes.
 if(!obj&&retryComplete&&!expired){
  const parts=await getParts(db,s.id),completion=completeParts(s,parts);
  if(completion){
   try{obj=await bucket.resumeMultipartUpload(s.object_key,s.r2_upload_id).complete(completion);}
   catch(e){console.warn('R2 multipart retry deferred',s.id,e?.message||e);}
  }
 }
 if(obj){
  try{const fileId=await finalizeCompletedObject(env,db,s,obj,s.user_id);return {status:'completed',file_id:fileId};}
  catch(e){
   const reason=String(e?.message||e).slice(0,300);
   await execute(db,"UPDATE upload_sessions SET status='failed',recovery_error=?,recovery_attempts=recovery_attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('verifying','failed')",[reason,s.id]);
   if(expired&&['UPLOAD_PERMISSION_REVOKED','UPLOAD_NAME_CONFLICT','Completed R2 object size mismatch'].includes(reason)){
    await queueOrphan(env,db,s,reason);
    return {status:'aborted',cleanup_queued:true};
   }
   return {status:'failed',reason};
  }
 }
 if(expired){
  const aborted=await abortUncompleted(env,db,s);
  return {status:aborted?'aborted':s.status,retry_needed:!aborted};
 }
 await execute(db,"UPDATE upload_sessions SET status='failed',recovery_attempts=recovery_attempts+1,recovery_error='R2 multipart object not completed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('verifying','failed')",[s.id]);
 return {status:'failed',retry_needed:true};
}
export async function initiate(req,env,user){
 const data=await req.json().catch(()=>null),db=dbFromEnv(env),bucket=storageBinding(env);
 const {name,space_id:spaceId,folder_id:folderId=null,size_bytes:size,mime_type:mime='application/octet-stream',replace_file_id:replaceId=null,expected_revision:expectedRevision=null}=data||{};
 if(!validName(name)||!Number.isSafeInteger(size)||!validPartLayout(size,choosePartSize(size))||typeof spaceId!=='string'||!/^[0-9a-f-]{36}$/.test(spaceId)||folderId!==null&&!/^[0-9a-f-]{36}$/.test(folderId)||typeof mime!=='string'||mime.length>120)return error('INVALID_UPLOAD','文件名称、大小或目标无效',400);
 if(!await destinationAllowed(db,user,spaceId,folderId))return error('FORBIDDEN','没有目标目录写入权限',403);
 const collision=await one(db,"SELECT id FROM files WHERE space_id=? AND folder_id IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL AND status!='deleted'",[spaceId,folderId,name]);
 if(replaceId){const lookup=await targetForReplace(db,user,replaceId,{spaceId,folderId,name,revision:expectedRevision});if(lookup.error)return error(lookup.error,'替换目标已变更或权限不足',lookup.status);if(collision?.id!==replaceId)return error('NAME_CONFLICT','指定目标与同名文件不匹配',409);
  if(size>MAX_PUBLIC_COPY_BYTES){
   const publication=await one(db,"SELECT id FROM publications WHERE source_file_id=? AND status='ready' AND auto_sync=1 LIMIT 1",[replaceId]);
   if(publication)return error('PUBLIC_COPY_TOO_LARGE','已公开文件的新版本超过单次 R2 复制上限，不能开始自动同步替换',413);
  }
 }
 else if(collision)return error('NAME_CONFLICT','目标目录有同名文件',409);
 if(!(await settings(db)).uploads_enabled)return error('UPLOAD_DISABLED','管理员已暂停上传',403);
 const reservation=await execute(db,RESERVE_SQL,[size,spaceId,size,DEFAULT_QUOTA_BYTES,size,DEFAULT_QUOTA_BYTES]);
 if(!reservation.meta?.changes)return error('QUOTA_EXCEEDED','空间剩余容量不足',413);
 const id=uuid(),key=`private/${spaceId}/${uuid()}`,partSize=choosePartSize(size);
 let upload;
 try{
  upload=await bucket.createMultipartUpload(key,{httpMetadata:{contentType:mime}});
  await execute(db,"INSERT INTO upload_sessions(id,user_id,space_id,target_folder_id,object_key,r2_upload_id,file_name,total_bytes,reserved_bytes,status,expires_at,part_size,mime_type,replace_file_id,expected_revision) VALUES(?,?,?,?,?,?,?,?,?,'uploading',datetime('now','+24 hours'),?,?,?,?)",[id,user.id,spaceId,folderId,key,upload.uploadId,name,size,size,partSize,mime,replaceId,expectedRevision]);
  return ok({upload_id:id,part_size:partSize,total_parts:Math.ceil(size/partSize),expires_in_seconds:86400},201);
 }catch(e){console.error('initiate multipart',e);if(upload)await upload.abort().catch(()=>{});await execute(db,'UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?',[size,spaceId]);return error('UPLOAD_FAILED','无法创建上传会话',503)}
}
export async function status(env,user,id){const db=dbFromEnv(env),s=await session(db,id,user);if(!s)return error('NOT_FOUND','任务不存在',404);return ok(sessionPublic(s,await getParts(db,id)));}
export async function list(env,user){const db=dbFromEnv(env);const rows=await many(db,"SELECT * FROM upload_sessions WHERE user_id=? AND status IN ('uploading','verifying','failed') ORDER BY created_at DESC LIMIT 50",[user.id]);return ok({items:rows.map(s=>sessionPublic(s))});}
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
 if(s.status==='completed')return ok({file_id:(await storedFileForUpload(db,s))?.id,status:'completed'});
 if(s.status==='failed')return recover(env,user,id);
 if(!active(s))return error('UPLOAD_EXPIRED','上传任务过期或已结束',409);
 if(!await destinationAllowed(db,user,s.space_id,s.target_folder_id))return error('FORBIDDEN','上传权限已撤销',403);
 const parts=await getParts(db,id),completeList=completeParts(s,parts);
 if(!completeList)return error('INCOMPLETE','仍有未完成分片',409);
 const collision=await one(db,"SELECT id FROM files WHERE space_id=? AND folder_id IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL AND status!='deleted'",[s.space_id,s.target_folder_id,s.file_name]);
 if(collision&&collision.id!==s.replace_file_id)return error('NAME_CONFLICT','存在同名文件，请先处理',409);
 const claimed=await execute(db,"UPDATE upload_sessions SET status='verifying',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='uploading'",[id]);
 if(!claimed.meta?.changes)return error('BUSY','合并已经开始，请查询状态',409);
 try{
  const object=await bucket.resumeMultipartUpload(s.object_key,s.r2_upload_id).complete(completeList);
  const fileId=await finalizeCompletedObject(env,db,s,object,user.id);
  return ok({file_id:fileId,status:'completed'},201);
 }catch(e){
  console.error('Multipart completion needs recovery',id,e?.message||e);
  await execute(db,"UPDATE upload_sessions SET status='failed',recovery_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='verifying'",[String(e?.message||e).slice(0,300),id]).catch(()=>{});
  return error('COMPLETE_FAILED','完成过程被中断：文件可能已写入 R2，可使用恢复功能核对，切勿重复上传',503);
 }
}
export async function recover(env,user,id){
 const db=dbFromEnv(env),s=await session(db,id,user);
 if(!s)return error('NOT_FOUND','任务不存在',404);
 if(!['failed','verifying','completed'].includes(s.status))return error('INVALID_STATE','该任务无需恢复',409);
 const result=await recoverSession(env,s);
 if(result.waiting)return error('RECOVERY_BUSY','正在合并，请稍后再试',409);
 if(result.status==='completed')return ok(result);
 if(result.status==='aborted')return ok(result);
 return error('RECOVERY_PENDING','服务器尚未完成恢复，将由定时任务继续处理；请勿重新上传此任务',503);
}
export async function cancel(env,user,id){
 const db=dbFromEnv(env),s=await session(db,id,user);if(!s)return error('NOT_FOUND','任务不存在',404);
 if(s.status==='aborted')return ok({status:'aborted'});
 if(s.status==='completed')return error('INVALID_STATE','文件已经完成上传，无法取消',409);
 if(s.status==='verifying'&&!stale(s))return error('BUSY','文件仍在合并，暂时不能取消',409);
 const bucket=storageBinding(env);
 // Completed objects are possible even when the session is marked failed.
 const obj=await bucket.head(s.object_key);
 if(obj){await queueOrphan(env,db,s,'Cancelled completed orphan');return ok({status:'aborted',cleanup_queued:true});}
 const aborted=await abortUncompleted(env,db,s);
 return aborted?ok({status:'aborted'}):error('ABORT_RETRY','取消请求已收到，R2 暂时不可用，将自动重试',503);
}
export async function cleanupExpired(env,{limit=8}={}){
 const db=dbFromEnv(env);
 const rows=await many(db,"SELECT * FROM upload_sessions WHERE (status='uploading' AND expires_at<CURRENT_TIMESTAMP) OR (status IN ('verifying','failed') AND (expires_at<CURRENT_TIMESTAMP OR updated_at<datetime('now','-2 minutes'))) ORDER BY updated_at LIMIT ?",[Math.max(1,Math.min(8,limit))]);
 let cleaned=0,pending=0;
 for(const s of rows){
  try{
   const result=s.status==='uploading'?(await storageBinding(env).head(s.object_key)?
    (await queueOrphan(env,db,s,'Expired upload has an unexpected completed R2 object'),{status:'aborted'}):
    {status:await abortUncompleted(env,db,s)?'aborted':'uploading'}):await recoverSession(env,s);
   if(['aborted','completed'].includes(result.status))cleaned++;else pending++;
  }catch(e){pending++;console.warn('Upload recovery deferred',s.id,e?.message||e);}
 }
 return {attempted:rows.length,cleaned,pending};
}
