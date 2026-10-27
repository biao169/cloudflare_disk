import {finishStorageCleanup} from './cleanup.js';
import {one,many,execute,dbFromEnv} from './database.js';
import {spaceAccess,folderAccess,canFolder,canSpace,uuid} from './spaces.js';
import {randomToken,sha256,passwordHash,checkPassword} from './auth.js';
import {ok,error} from '../utils/response.js';
import {matchesPreviewSignature,DEFAULT_QUOTA_BYTES} from './storage.js';
import {RESERVE_SQL,settings} from './admin.js';
import {encryptShareCode,linkKeyStatus,sharePath} from './share-links.js';

export const SHARE_CODE=/^[a-f0-9]{48,64}$/;
export function validShareCode(code){return SHARE_CODE.test(code||'');}
export function validExpiry(value){return value===null||(typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)>Date.now()&&Date.parse(value)<Date.now()+366*86400000);}
export function shareIsActive(s){return !!s&&!s.revoked_at&&(!s.expires_at||Date.parse(s.expires_at)>Date.now());}
export async function target(db,user,type,id){
 if(type==='file'){
  const f=await one(db,"SELECT * FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL",[id]);if(!f)return null;
  const a=await spaceAccess(db,user,f.space_id);if(!a)return null;
  const rights=f.folder_id?await folderAccess(db,user,f.folder_id):null;
  const permitted=f.folder_id?(canFolder(rights,'share')&&canFolder(rights,'read')):(canSpace(a,'share')&&canSpace(a,'read'));
  return permitted?{...f,type}:null;
 }
 if(type==='folder'){
  const f=await one(db,'SELECT * FROM folders WHERE id=? AND deleted_at IS NULL',[id]);if(!f)return null;
  const rights=await folderAccess(db,user,f.id);
  return canFolder(rights,'share')&&canFolder(rights,'read')?{...f,type}:null;
 }
 return null;
}
export async function resolveShare(db,code){
 if(!validShareCode(code))return null;
 const s=await one(db,'SELECT * FROM shares WHERE share_code_hash=?',[await sha256(code)]);
 if(!shareIsActive(s)||(s.max_downloads&&s.download_count>=s.max_downloads))return null;
  // Revocation is checked at request time as well as at membership-change time.
  // This also handles disabled accounts, revoked folder ACLs and file moves,
  // without ever exposing an old public token if a D1 write was interrupted.
  const creator=await one(db,"SELECT id,role,status FROM users WHERE id=?",[s.created_by]);
  if(!creator||creator.status!=='active')return null;
  return await target(db,creator,s.target_type,s.target_id)?s:null;
}
// A folder share must not make subfolders newly denied to its creator visible.
export async function shareCreatorCanReadFolder(db,share,folderId){
 const creator=await one(db,"SELECT id,role,status FROM users WHERE id=?",[share.created_by]);
 if(!creator||creator.status!=='active')return false;
 return canFolder(await folderAccess(db,creator,folderId),'read');
}
export function shareSummary(s){return {id:s.id,type:s.type,target_type:s.target_type,target_id:s.target_id,expires_at:s.expires_at,has_password:Boolean(s.password_hash),allow_download:Boolean(s.allow_download),max_downloads:s.max_downloads,download_count:s.download_count,revoked_at:s.revoked_at,created_at:s.created_at,target_name:s.target_name??null,link_recoverable:Boolean(s.link_ciphertext),status:s.status??(s.revoked_at?'revoked':s.expires_at&&Date.parse(s.expires_at)<=Date.now()?'expired':s.max_downloads&&s.download_count>=s.max_downloads?'download_limit':'active')};}
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
 if(type==='temporary'&&expiresAt===null)return error('INVALID_EXPIRY','临时直链必须设置有效期，永久分享请使用分享页面或公开直链',400);
 if(data.password&&type!=='page')return error('INVALID_SHARE','临时直链不支持密码，请使用分享页面',400);
 if(data.password&&(typeof data.password!=='string'||data.password.length<12||data.password.length>128))return error('INVALID_PASSWORD','分享密码至少 12 个字符',400);
 if(typeof data.allow_download!=='undefined'&&typeof data.allow_download!=='boolean')return error('INVALID_SHARE','下载权限必须为布尔值',400);
 if(data.max_downloads!==undefined&&data.max_downloads!==null&&(!Number.isSafeInteger(data.max_downloads)||data.max_downloads<1||data.max_downloads>100000))return error('INVALID_SHARE','下载次数应在 1–100000 范围',400);
 if(type==='temporary'&&data.allow_download===false)return error('INVALID_SHARE','直链必须允许下载',400);
 if(linkKeyStatus(env)==='invalid')return error('LINK_KEY_INVALID','SHARE_LINK_KEY 格式必须为 64 位十六进制',503);
 // The browser's Share dialog opts into guaranteed recoverability. Existing
 // API clients retain legacy behavior unless they explicitly opt in.
 if(data.require_recoverable!==undefined&&typeof data.require_recoverable!=='boolean')return error('INVALID_SHARE','require_recoverable 必须是布尔值',400);
 if(data.require_recoverable&&linkKeyStatus(env)!=='ready')return error('SHARE_LINK_KEY_REQUIRED','请先在 Worker 运行时 Secrets 配置 SHARE_LINK_KEY，才能创建以后可重新获取的分享链接',503);
 if(!await target(db,user,targetType,id))return error('FORBIDDEN','没有分享权限或资源不可用',403);
 const token=randomToken(32),sid=uuid(),codeHash=await sha256(token),pw=data.password?await passwordHash(data.password):null;
 const encrypted=await encryptShareCode(env,sid,token),max=data.max_downloads??null;
 const url=new URL(req.url);
 await execute(db,'INSERT INTO shares(id,type,target_type,target_id,share_code_hash,link_ciphertext,password_hash,expires_at,allow_download,max_downloads,created_by,link_origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[sid,type,targetType,id,codeHash,encrypted,pw,expiresAt,type==='page'&&data.allow_download===false?0:1,max,user.id,url.origin]);return ok({share:shareSummary({id:sid,type,target_type:targetType,target_id:id,expires_at:expiresAt,password_hash:pw,allow_download:type==='page'&&data.allow_download===false?0:1,max_downloads:max,download_count:0,link_ciphertext:encrypted,created_at:new Date().toISOString()}),url:sharePath(url.origin,type,token),link_recovery:encrypted?'recoverable':'rotation_only'},201);
}
export async function listOwnedShares(db,user){return many(db,'SELECT * FROM shares WHERE created_by=? ORDER BY created_at DESC LIMIT 100',[user.id]);}
export function shareHeaders(){return {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};}
export async function serveSharedFile(req,env,s,fileId,{preview=false}={}){
 const db=dbFromEnv(env);
 // Exhausted download grants deny both previews and content; previews still
 // do not count as downloads while a grant remains usable.
 if(!shareIsActive(s)||(s.max_downloads&&s.download_count>=s.max_downloads))return error('SHARE_LIMIT','分享已失效或下载次数已用完',403);
 if(s.target_type==='file'&&s.target_id!==fileId)return error('NOT_FOUND','文件不存在',404);
 const f=await one(db,"SELECT f.*,o.object_key,o.status AS object_status,o.bucket_type FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE f.id=? AND f.deleted_at IS NULL AND f.status='ready'",[fileId]);
 if(!f||f.object_status!=='ready'||f.bucket_type!=='private')return error('NOT_FOUND','文件不存在',404);
 if(s.target_type==='folder'){
  let folder=f.folder_id,found=false;const seen=new Set();
  while(folder&&!seen.has(folder)){seen.add(folder);if(folder===s.target_id){found=true;break;}const parent=await one(db,'SELECT parent_id FROM folders WHERE id=? AND deleted_at IS NULL',[folder]);folder=parent?.parent_id;}
  if(!found||!await shareCreatorCanReadFolder(db,s,f.folder_id))return error('NOT_FOUND','文件不存在',404);
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
// A public R2 custom domain must point to PUBLIC_BUCKET, not to the private bucket.
export function cdnBaseUrl(value){
 if(!value)return null;
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash?u.origin:null;}catch{return null;}
}
export function publicationUrl(req,env,p){const domain=cdnBaseUrl(env.PUBLIC_BASE_URL);return domain?`${domain}/${p.public_path}`:`${new URL(req.url).origin}/p/${p.id}`;}
export async function purgePublicationCache(env,p,{extraPaths=[]}={}){
 const domain=cdnBaseUrl(env.PUBLIC_BASE_URL);
 if(!domain||!env.CDN_ZONE_ID||!env.CDN_PURGE_TOKEN)return {purged:false,reason:'CDN_PURGE_NOT_CONFIGURED'};
 if(!/^[a-f0-9]{32}$/i.test(env.CDN_ZONE_ID))return {purged:false,reason:'CDN_ZONE_ID_INVALID'};
 const paths=[p.public_path,...extraPaths].filter(x=>/^(?:published|versions)\/[A-Za-z0-9/_-]+$/.test(x));
 const unique=[...new Set(paths)];
 if(!unique.length)return {purged:false,reason:'NO_PUBLIC_PATHS'};
 // Per-URL purge (not Purge Everything). Bound API calls per request, and
 // surface any remaining version URLs that could still be CDN-cached.
 let purged=0;
 try{
  for(let i=0;i<Math.min(unique.length,90);i+=25){
   const files=unique.slice(i,i+25).map(x=>`${domain}/${x}`);
   const response=await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CDN_ZONE_ID}/purge_cache`,{
    method:'POST',headers:{Authorization:`Bearer ${env.CDN_PURGE_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({files})
   });
   const result=await response.json();
   if(!response.ok||!result.success)return {purged:false,reason:'CDN_PURGE_FAILED',purged_urls:purged};
   purged+=files.length;
  }
  return {purged:purged===unique.length,reason:purged===unique.length?null:'CDN_PURGE_PARTIAL',purged_urls:purged,remaining:unique.length-purged};
 }catch(err){console.warn('CloudDrive cache purge failed',err?.message||err);return {purged:false,reason:'CDN_PURGE_FAILED',purged_urls:purged};}
}
// A public copy consumes physical storage and must be included in application
// quotas. Revocation is idempotent even if R2 delete succeeded but D1 failed.
export async function revokePublication(env,db,publication){
 const p=await one(db,"SELECT * FROM publications WHERE id=? AND status='ready'",[publication.id]);
 if(!p)throw new Error('Publication already revoked or missing');
 const f=await one(db,'SELECT space_id FROM files WHERE id=?',[p.source_file_id]);
 if(!f)throw new Error('Publication owner space unavailable');
 if(!env.PUBLIC_BUCKET?.delete)throw new Error('PUBLIC_BUCKET missing');
 const pending=await one(db,"SELECT COALESCE(SUM(reserved_alias_bytes),0) AS bytes FROM publication_sync_jobs WHERE publication_id=? AND status NOT IN ('completed','superseded')",[p.id]);
 // A single bounded D1 transaction revokes access and queues EVERY public
 // version/alias for deletion. It does not issue one D1 statement per version.
 await db.batch([
  db.prepare("UPDATE publications SET status='revoked',sync_state='ready',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='ready'").bind(p.id),
  db.prepare("UPDATE publication_sync_jobs SET status='superseded',reserved_alias_bytes=0,updated_at=CURRENT_TIMESTAMP WHERE publication_id=? AND status NOT IN ('completed','superseded')").bind(p.id),
  db.prepare('UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?').bind(pending?.bytes||0,f.space_id),
  db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs(id,object_id,object_key,bucket_type,space_id,size_bytes)
   SELECT lower(hex(randomblob(16))),o.id,o.object_key,'public',?,o.size_bytes
   FROM storage_objects o WHERE o.bucket_type='public' AND o.status='ready' AND o.id IN (
    SELECT object_id FROM publication_versions WHERE publication_id=?
    UNION SELECT public_object_id FROM publications WHERE id=?
    UNION SELECT legacy_object_id FROM publications WHERE id=? AND legacy_object_id IS NOT NULL)`)
   .bind(f.space_id,p.id,p.id,p.id)
 ]);
 // Bounded best-effort immediate deletion; the durable queue is retried by Cron.
 const jobs=await many(db,"SELECT * FROM storage_cleanup_jobs WHERE bucket_type='public' AND object_id IN (SELECT object_id FROM publication_versions WHERE publication_id=? UNION SELECT public_object_id FROM publications WHERE id=? UNION SELECT legacy_object_id FROM publications WHERE id=?) LIMIT 5",[p.id,p.id,p.id]);
 let pendingCount=0;
 for(const job of jobs)try{await finishStorageCleanup(env,job);}catch(e){pendingCount++;console.warn('Public revocation cleanup deferred',e?.message||e);}
 const keys=await many(db,`SELECT DISTINCT o.object_key FROM publication_versions v JOIN storage_objects o ON o.id=v.object_id
  WHERE v.publication_id=?`,[p.id]);
 const cache=await purgePublicationCache(env,{...p,public_path:p.public_path||publication.public_path},
  {extraPaths:keys.map(x=>x.object_key)});
 return {...cache,cleanup_pending:pendingCount};
}
export async function publishFile(req,env,user,fileId){
 const db=dbFromEnv(env);const f=await target(db,user,'file',fileId);if(!f)return error('FORBIDDEN','没有发布权限',403);
 if(user.role!=='super_admin')return error('FORBIDDEN','只有超级管理员可以发布永久公开文件',403);
 if(f.size_bytes>5*1024**3-5*1024**2)return error('PUBLIC_COPY_TOO_LARGE','目前公开发布需小于 R2 单次复制上限',413);
 if(env.PUBLIC_BASE_URL && !cdnBaseUrl(env.PUBLIC_BASE_URL))return error('PUBLIC_URL_INVALID','公开域名必须是 HTTPS 主机名（不可包含路径或查询参数）',503);
 if(!env.PUBLIC_BUCKET?.put)return error('PUBLIC_BUCKET_UNSET','公开 R2 Binding 未配置',503);
 const source=await one(db,"SELECT o.object_key FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE f.id=? AND o.status='ready'",[fileId]);if(!source)return error('NOT_FOUND','文件不可用',404);
 const previous=await one(db,"SELECT id FROM publications WHERE source_file_id=? AND status='ready'",[fileId]);if(previous)return error('ALREADY_PUBLISHED','文件已经公开发布',409);
 const reservation=await execute(db,RESERVE_SQL,[f.size_bytes,f.space_id,f.size_bytes,DEFAULT_QUOTA_BYTES,f.size_bytes,DEFAULT_QUOTA_BYTES]);
 if(!reservation.meta?.changes)return error('QUOTA_EXCEEDED','公开副本会超过可用存储容量',413);
 const publicId=uuid(),pid=uuid(),key=`published/${publicId}`,url=publicationUrl(req,env,{id:pid,public_path:key});
 let created=false;
 try{
  const object=await env.PRIVATE_BUCKET.get(source.object_key);if(!object)throw new Error('Private source missing');
  const mime=['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf'].includes(f.mime_type)?f.mime_type:'application/octet-stream';
  const disposition=`${mime==='application/octet-stream'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  const saved=await env.PUBLIC_BUCKET.put(key,object.body,{httpMetadata:{contentType:mime,contentDisposition:disposition,cacheControl:'public, max-age=0, must-revalidate'}});created=true;
  if(saved.size!==f.size_bytes)throw new Error('Published file size mismatch');
  await db.batch([
   db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,etag,status) VALUES(?,'public',?,?,?,'ready')").bind(publicId,key,f.size_bytes,saved.etag||null),
   db.prepare("INSERT INTO publications(id,source_file_id,public_object_id,public_path,status,created_by,published_revision,legacy_object_id) VALUES(?,?,?,?,'ready',?,?,?)").bind(pid,fileId,publicId,key,user.id,f.revision||1,publicId),
   db.prepare('INSERT INTO publication_versions(id,publication_id,file_revision,object_id) VALUES(?,?,?,?)').bind(uuid(),pid,f.revision||1,publicId),
   db.prepare('UPDATE spaces SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+? WHERE id=?').bind(f.size_bytes,f.size_bytes,f.space_id)
  ]);
  return ok({id:pid,url:`${new URL(req.url).origin}/r/${pid}`,smart_url:`${new URL(req.url).origin}/r/${pid}`,legacy_url:url,delivery:cdnBaseUrl(env.PUBLIC_BASE_URL)?'cdn':'worker',warning:cdnBaseUrl(env.PUBLIC_BASE_URL)?'CDN 可能缓存已撤销文件；建议配置按 URL 清理缓存':'尚未绑定公开 R2 自定义域名，当前文件经 Worker /p/ 下载'},201);
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
