import {one,many,execute,dbFromEnv} from './database.js';
import {spaceAccess,folderAccess,canFolder,canSpace,uuid} from './spaces.js';
import {randomToken,sha256,passwordHash,checkPassword} from './auth.js';
import {ok,error} from '../utils/response.js';
import {matchesPreviewSignature,DEFAULT_QUOTA_BYTES} from './storage.js';
import {RESERVE_SQL,settings} from './admin.js';

export const SHARE_CODE=/^[a-f0-9]{48,64}$/;
export function validShareCode(code){return SHARE_CODE.test(code||'');}
export function validExpiry(value){return value===null||(typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)>Date.now()&&Date.parse(value)<Date.now()+366*86400000);}
export function shareIsActive(s){return !!s&&!s.revoked_at&&(!s.expires_at||Date.parse(s.expires_at)>Date.now());}
export async function target(db,user,type,id){
 if(type==='file'){
  const f=await one(db,"SELECT * FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL",[id]);if(!f)return null;
  const a=await spaceAccess(db,user,f.space_id);if(!a)return null;
  const permitted=f.folder_id?canFolder(await folderAccess(db,user,f.folder_id),'share'):canSpace(a,'share');
  return permitted?{...f,type}:null;
 }
 if(type==='folder'){
  const f=await one(db,'SELECT * FROM folders WHERE id=? AND deleted_at IS NULL',[id]);if(!f)return null;
  return canFolder(await folderAccess(db,user,f.id),'share')?{...f,type}:null;
 }
 return null;
}
export async function resolveShare(db,code){
 if(!validShareCode(code))return null;
 const s=await one(db,'SELECT * FROM shares WHERE share_code_hash=?',[await sha256(code)]);
 if(!shareIsActive(s))return null;
 const found=await one(db,s.target_type==='file'?"SELECT id FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL":"SELECT id FROM folders WHERE id=? AND deleted_at IS NULL",[s.target_id]);
 return found?s:null;
}
export function shareSummary(s){return {id:s.id,type:s.type,target_type:s.target_type,target_id:s.target_id,expires_at:s.expires_at,has_password:Boolean(s.password_hash),allow_download:Boolean(s.allow_download),max_downloads:s.max_downloads,download_count:s.download_count,revoked_at:s.revoked_at,created_at:s.created_at};}
export async function validatedAccess(req,db,s){
 if(!s.password_hash)return true;
 const cookie=(req.headers.get('cookie')||'').match(/(?:^|;\s*)cd_share_access=([a-f0-9]{64})(?:;|$)/)?.[1];
 if(!cookie)return false;
 return Boolean(await one(db,"SELECT 1 FROM share_access WHERE share_id=? AND session_hash=? AND expires_at > CURRENT_TIMESTAMP",[s.id,await sha256(cookie)]));
}
export async function createShare(req,env,user,data){
 const db=dbFromEnv(env);const type=data.type,targetType=data.target_type,id=data.target_id;
 const expiresAt=data.expires_at===undefined?new Date(Date.now()+(await settings(db)).default_share_days*86400000).toISOString():data.expires_at;
 if(!['page','temporary'].includes(type)||!['file','folder'].includes(targetType)||typeof id!=='string'||!validExpiry(expiresAt))return error('INVALID_SHARE','分享参数无效',400);
 if(type==='temporary'&&targetType!=='file')return error('INVALID_SHARE','临时直链只支持单个文件',400);
 if(data.password&&type!=='page')return error('INVALID_SHARE','临时直链不支持密码，请使用分享页面',400);
 if(data.password&&(typeof data.password!=='string'||data.password.length<12||data.password.length>128))return error('INVALID_PASSWORD','分享密码至少 12 个字符',400);
 if(!await target(db,user,targetType,id))return error('FORBIDDEN','没有分享权限或资源不可用',403);
 const token=randomToken(32),sid=uuid(),codeHash=await sha256(token),pw=data.password?await passwordHash(data.password):null;
 await execute(db,'INSERT INTO shares(id,type,target_type,target_id,share_code_hash,password_hash,expires_at,allow_download,created_by) VALUES(?,?,?,?,?,?,?,?,?)',[sid,type,targetType,id,codeHash,pw,expiresAt,data.allow_download===false?0:1,user.id]);
 const url=new URL(req.url);return ok({share:shareSummary({id:sid,type,target_type:targetType,target_id:id,expires_at:expiresAt,password_hash:pw,allow_download:data.allow_download===false?0:1,download_count:0,created_at:new Date().toISOString()}),url:`${url.origin}/${type==='page'?'s':'t'}/${token}`},201);
}
export async function listOwnedShares(db,user){return many(db,'SELECT * FROM shares WHERE created_by=? ORDER BY created_at DESC LIMIT 100',[user.id]);}
export function shareHeaders(){return {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};}
export async function serveSharedFile(req,env,s,fileId,{preview=false}={}){
 const db=dbFromEnv(env);
 if(s.target_type==='file'&&s.target_id!==fileId)return error('NOT_FOUND','文件不存在',404);
 const f=await one(db,"SELECT f.*,o.object_key,o.status AS object_status,o.bucket_type FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE f.id=? AND f.deleted_at IS NULL AND f.status='ready'",[fileId]);
 if(!f||f.object_status!=='ready'||f.bucket_type!=='private')return error('NOT_FOUND','文件不存在',404);
 if(s.target_type==='folder'){
  let folder=f.folder_id,found=false;const seen=new Set();
  while(folder&&!seen.has(folder)){seen.add(folder);if(folder===s.target_id){found=true;break;}const parent=await one(db,'SELECT parent_id FROM folders WHERE id=? AND deleted_at IS NULL',[folder]);folder=parent?.parent_id;}
  if(!found)return error('NOT_FOUND','文件不存在',404);
 }
 if(!preview&&!s.allow_download)return error('DOWNLOAD_DISABLED','该分享不允许下载',403);
 if(preview&&!['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf'].includes(f.mime_type))return error('UNSUPPORTED','不支持预览',415);
 if(preview){const peek=await env.PRIVATE_BUCKET.get(f.object_key,{range:{offset:0,length:32}});if(!peek?.body||!matchesPreviewSignature(f.mime_type,new Uint8Array(await new Response(peek.body).arrayBuffer())))return error('PREVIEW_INVALID','文件内容与预览类型不符',415);}
 // A range request is only a fragment of one download and cannot safely consume
 // a download-count quota per fragment; reject limited-download ranges.
 if(s.max_downloads&&!preview&&req.headers.has('range'))return error('LIMITED_DOWNLOAD_RANGE','限次下载不支持断点范围请求',409);
 const range=req.headers.get('range');let r=null;
 if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${f.size_bytes}`,...shareHeaders()}});
 const start=m[1]?Number(m[1]):Math.max(0,f.size_bytes-Number(m[2]));const end=m[1]?(m[2]?Number(m[2]):f.size_bytes-1):f.size_bytes-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=f.size_bytes||end<start)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${f.size_bytes}`,...shareHeaders()}});
 r={offset:start,length:Math.min(end,f.size_bytes-1)-start+1};}
 const obj=await env.PRIVATE_BUCKET.get(f.object_key,r?{range:r}:undefined);if(!obj)return error('MISSING_OBJECT','对象不存在',503);
 // Only a real GET after range validation and an available R2 object counts.
 // HEAD and preview requests never consume a download slot.
 if(s.max_downloads&&!preview&&req.method==='GET'){const changed=await execute(db,'UPDATE shares SET download_count=download_count+1 WHERE id=? AND download_count<? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)',[s.id,s.max_downloads]);if(!changed.meta?.changes)return error('SHARE_LIMIT','下载次数已用完',403);}
 const headers=new Headers({...shareHeaders(),'Content-Type':f.mime_type||'application/octet-stream','Content-Disposition':`${preview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,'Content-Length':String(r?r.length:obj.size),'Accept-Ranges':'bytes'});
 if(r)headers.set('Content-Range',`bytes ${r.offset}-${r.offset+r.length-1}/${f.size_bytes}`);
 return new Response(req.method==='HEAD'?null:obj.body,{status:r?206:200,headers});
}
// A public copy consumes physical storage and must be included in application
// quotas. Revocation is idempotent even if R2 delete succeeded but D1 failed.
export async function revokePublication(env,db,publication){
 const p=publication;
 const source=await one(db,'SELECT space_id FROM files WHERE id=?',[p.source_file_id]);
 if(!source)throw Error('Publication source unavailable');
 const object=await one(db,'SELECT object_key,size_bytes FROM storage_objects WHERE id=?',[p.public_object_id]);
 if(!object)throw Error('Publication R2 metadata unavailable');
 if(!env.PUBLIC_BUCKET?.delete)throw Error('PUBLIC_BUCKET missing');
 await env.PUBLIC_BUCKET.delete(object.object_key);
 await db.batch([
  db.prepare("UPDATE spaces SET used_bytes=MAX(0,used_bytes-(SELECT CASE WHEN p.status='ready' THEN o.size_bytes ELSE 0 END FROM publications p JOIN storage_objects o ON o.id=p.public_object_id WHERE p.id=?)) WHERE id=?").bind(p.id,source.space_id),
  db.prepare("UPDATE publications SET status='revoked' WHERE id=? AND status='ready'").bind(p.id),
  db.prepare("UPDATE storage_objects SET status='deleted' WHERE id=?").bind(p.public_object_id)
 ]);
}
export async function publishFile(req,env,user,fileId){
 const db=dbFromEnv(env);const f=await target(db,user,'file',fileId);if(!f)return error('FORBIDDEN','没有发布权限',403);
 if(user.role!=='super_admin')return error('FORBIDDEN','只有超级管理员可以发布永久公开文件',403);
 if(env.PUBLIC_BASE_URL && !/^https:\/\/[^\s/]+/.test(env.PUBLIC_BASE_URL))return error('PUBLIC_URL_INVALID','公开域名必须为有效的 HTTPS 地址',503);
 if(!env.PUBLIC_BUCKET?.put)return error('PUBLIC_BUCKET_UNSET','公开 R2 Binding 未配置',503);
 const source=await one(db,"SELECT o.object_key FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE f.id=? AND o.status='ready'",[fileId]);if(!source)return error('NOT_FOUND','文件不可用',404);
 const previous=await one(db,"SELECT id FROM publications WHERE source_file_id=? AND status='ready'",[fileId]);if(previous)return error('ALREADY_PUBLISHED','文件已经公开发布',409);
 const reservation=await execute(db,RESERVE_SQL,[f.size_bytes,f.space_id,f.size_bytes,DEFAULT_QUOTA_BYTES,f.size_bytes,DEFAULT_QUOTA_BYTES]);
 if(!reservation.meta?.changes)return error('QUOTA_EXCEEDED','公开副本会超过可用存储容量',413);
 const publicId=uuid(),pid=uuid(),key=`published/${publicId}`,url=env.PUBLIC_BASE_URL?`${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/${key}`:`${new URL(req.url).origin}/p/${pid}`;
 let created=false;
 try{
  const object=await env.PRIVATE_BUCKET.get(source.object_key);if(!object)throw new Error('Private source missing');
  const saved=await env.PUBLIC_BUCKET.put(key,object.body,{httpMetadata:{contentType:f.mime_type}});created=true;
  if(saved.size!==f.size_bytes)throw new Error('Published file size mismatch');
  await db.batch([
   db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,etag,status) VALUES(?,'public',?,?,?,'ready')").bind(publicId,key,f.size_bytes,saved.etag||null),
   db.prepare("INSERT INTO publications(id,source_file_id,public_object_id,public_path,status,created_by) VALUES(?,?,?,?,'ready',?)").bind(pid,fileId,publicId,key,user.id),
   db.prepare('UPDATE spaces SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+? WHERE id=?').bind(f.size_bytes,f.size_bytes,f.space_id)
  ]);
  return ok({id:pid,url},201);
 }catch(e){
  console.error('Publication error',e);
  if(created){try{await env.PUBLIC_BUCKET.delete(key)}catch(cleanupError){
   // Keep a durable, uncharged job: the public copy may have been written even
   // though no D1 storage_objects row was committed.
   try{await execute(db,"INSERT OR IGNORE INTO storage_cleanup_jobs(id,object_id,object_key,bucket_type,space_id,size_bytes) VALUES(?,?,?,'public',?,0)",[uuid(),publicId,key,f.space_id])}catch(ledgerError){console.error('CRITICAL orphan public object',key,ledgerError)}
   console.warn('Published R2 object queued for cleanup',key,cleanupError);
  }}
  try{await execute(db,'UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?',[f.size_bytes,f.space_id])}catch(releaseError){console.error('Publication quota reservation requires recovery',releaseError)}
  return error('PUBLISH_FAILED','公开发布失败',503);
 }
}
