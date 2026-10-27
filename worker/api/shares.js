import {stablePublicUrl,publicationDetails,runLegacySync,publishCurrentRevision,PublicationUpdateError} from '../services/public-versions.js';
import {settings} from '../services/admin.js';
import {resolveUser,jsonBody,randomToken,sha256,checkPassword} from '../services/auth.js';
import {one,many,execute,dbFromEnv} from '../services/database.js';
import {createShare,resolveShare,shareSummary,validatedAccess,serveSharedFile,publishFile,revokePublication,shareHeaders,shareCreatorCanReadFolder,publicationUrl,cdnBaseUrl,purgePublicationCache} from '../services/sharing.js';
import {ownedShare,summarized,summarizedOwnedBatch,recoverOwnedShare,rotateOwnedShare,editOwnedShare} from '../services/share-management.js';
import {linkKeyStatus} from '../services/share-links.js';
import {ok,error} from '../utils/response.js';
import {folderAccessBatch} from '../services/permission-batch.js';
import {canFolder} from '../services/spaces.js';
const codePattern='([a-f0-9]{48,64})';
export async function sharesRoute(req,env,path){
 const db=dbFromEnv(env);
 if(path.startsWith('/api/v1/public/shares/')){
  const match=new RegExp('^/api/v1/public/shares/'+codePattern+'(?:/(verify|contents|files/([0-9a-f-]{36})/(preview|content)))?$').exec(path);
  if(!match)return error('NOT_FOUND','无效链接',404);
  const [,code,action,fileId,mode]=match,s=await resolveShare(db,code);
  if(!s||s.type!=='page')return error('NOT_FOUND','分享不存在或已过期',404);
  if(action==='verify'&&req.method==='POST'){
   const body=await jsonBody(req);if(typeof body?.password!=='string')return error('INVALID_PASSWORD','需要访问密码',400);
   const ip=(req.headers.get('cf-connecting-ip')||'unknown').slice(0,96),rateKey=await sha256(`${s.id}:${ip}`);
   const failure=await one(db,'SELECT failures,blocked_until FROM share_password_attempts WHERE id=?',[rateKey]);
   if(failure?.blocked_until&&failure.blocked_until>new Date().toISOString().replace('T',' ').slice(0,19))return error('TOO_MANY_ATTEMPTS','尝试次数过多',429);
   if(!s.password_hash||!await checkPassword(body.password,s.password_hash)){
    await execute(db,"INSERT INTO share_password_attempts(id,failures,blocked_until) VALUES(?,1,NULL) ON CONFLICT(id) DO UPDATE SET failures=CASE WHEN share_password_attempts.updated_at<datetime('now','-15 minutes') THEN 1 ELSE failures+1 END,blocked_until=CASE WHEN share_password_attempts.updated_at>=datetime('now','-15 minutes') AND failures>=4 THEN datetime('now','+15 minutes') ELSE NULL END,updated_at=CURRENT_TIMESTAMP",[rateKey]);
    return error('INVALID_PASSWORD','访问密码错误',403);
   }
   await execute(db,'DELETE FROM share_password_attempts WHERE id=?',[rateKey]);
   const token=randomToken(),hash=await sha256(token);await execute(db,"INSERT INTO share_access(id,share_id,session_hash,expires_at) VALUES(?,?,?,datetime('now','+30 minutes'))",[crypto.randomUUID(),s.id,hash]);
   return new Response(JSON.stringify({success:true,data:{verified:true}}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':`cd_share_access=${token}; Path=/api/v1/public/shares/${code}; HttpOnly; SameSite=Strict; Max-Age=1800${new URL(req.url).protocol==='https:'?'; Secure':''}`}});
  }
  if(!(await validatedAccess(req,db,s)))return error('PASSWORD_REQUIRED','分享需要密码',401);
  if(action?.startsWith('files/')&&['GET','HEAD'].includes(req.method))return serveSharedFile(req,env,s,fileId,{preview:mode==='preview'});
  if(req.method!=='GET')return error('METHOD_NOT_ALLOWED','请求方式错误',405);
  if(action==='contents'){
   if(s.target_type==='file'){const f=await one(db,"SELECT id,name,size_bytes,mime_type FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL",[s.target_id]);return ok({files:f?[f]:[],folders:[]});}
   const folderId=new URL(req.url).searchParams.get('folder_id')||s.target_id;
   let cursor=folderId,valid=false,seen=new Set();while(cursor&&!seen.has(cursor)){seen.add(cursor);if(cursor===s.target_id){valid=true;break;}const parent=await one(db,'SELECT parent_id FROM folders WHERE id=? AND deleted_at IS NULL',[cursor]);cursor=parent?.parent_id;}
   if(!valid||!await shareCreatorCanReadFolder(db,s,folderId))return error('FORBIDDEN','不属于分享目录或已撤销权限',403);
   const [folders,files]=await Promise.all([many(db,'SELECT id,name FROM folders WHERE parent_id=? AND deleted_at IS NULL ORDER BY name LIMIT 200',[folderId]),many(db,"SELECT id,name,size_bytes,mime_type FROM files WHERE folder_id=? AND deleted_at IS NULL AND status='ready' ORDER BY name LIMIT 200",[folderId])]);
   const creator=await one(db,'SELECT id,role,status FROM users WHERE id=?',[s.created_by]);
   const visibleFolders=[],rights=await folderAccessBatch(db,creator,folders.map(f=>f.id));
   for(const folder of folders)if(canFolder(rights.get(folder.id),'read'))visibleFolders.push(folder);
   return ok({folders:visibleFolders,files,folder_id:folderId});
  }
  return ok({type:s.type,target_type:s.target_type,has_password:Boolean(s.password_hash),allow_download:Boolean(s.allow_download),expires_at:s.expires_at});
 }
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 if(path==='/api/v1/shares'&&req.method==='POST'){if(!(await settings(db)).public_shares_enabled)return error('SHARING_DISABLED','管理员已暂停创建新分享',403);return createShare(req,env,user,await jsonBody(req)||{});}
 if(path==='/api/v1/shares'&&req.method==='GET'){
  const params=new URL(req.url).searchParams,t=params.get('target_type'),id=params.get('target_id');
  if((t||id)&&(!['file','folder'].includes(t)||!/^[a-f0-9-]{36}$/i.test(id||'')))return error('INVALID_FILTER','无效的分享筛选',400);
  const sql=`SELECT s.*,COALESCE(f.name,fo.name) AS target_name FROM shares s LEFT JOIN files f ON s.target_type='file' AND s.target_id=f.id LEFT JOIN folders fo ON s.target_type='folder' AND s.target_id=fo.id WHERE s.created_by=? ${t?'AND s.target_type=? AND s.target_id=?':''} ORDER BY s.created_at DESC,s.id DESC LIMIT 100`;
  const found=await many(db,sql,t?[user.id,t,id]:[user.id]);
  const summaries=await summarizedOwnedBatch(db,found,user);
  return ok({shares:summaries,link_key_status:linkKeyStatus(env)});
 }
 let m=/^\/api\/v1\/shares\/([0-9a-f-]{36})(?:\/(link|rotate))?$/.exec(path);
 if(m){
  const [,id,action]=m,share=await ownedShare(db,id,user);
  if(!share)return error('NOT_FOUND','分享不存在',404);
  if(action==='link'&&req.method==='GET')return recoverOwnedShare(req,env,db,user,share);
  if(action==='rotate'&&req.method==='POST')return rotateOwnedShare(req,env,db,user,share);
  if(!action&&req.method==='GET')return ok({share:await summarized(db,share)});
  if(!action&&req.method==='PATCH')return editOwnedShare(env,db,user,share,await jsonBody(req));
  if(!action&&req.method==='DELETE'){
   const changed=await execute(db,'UPDATE shares SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND created_by=? AND revoked_at IS NULL',[id,user.id]);
   return changed.meta?.changes?ok({revoked:true}):error('SHARE_REVOKED','已撤销或不存在',409);
  }
  return error('METHOD_NOT_ALLOWED','方法不支持',405);
 }
 if(path==='/api/v1/publications'&&req.method==='POST'){if(!(await settings(db)).public_shares_enabled)return error('SHARING_DISABLED','管理员已暂停创建新分享',403);const body=await jsonBody(req);return publishFile(req,env,user,body?.file_id);}
 if(path==='/api/v1/publications'&&req.method==='GET'){
  if(user.role!=='super_admin')return error('FORBIDDEN','无权限',403);
  const fileId=new URL(req.url).searchParams.get('file_id');
  if(fileId&&!/^[0-9a-f-]{36}$/i.test(fileId))return error('INVALID_FILTER','文件标识无效',400);
  const sql=`SELECT p.id,p.source_file_id,f.name,f.status AS file_status,f.deleted_at,p.public_path,p.status,p.created_at,p.published_revision,p.sync_state,p.auto_sync FROM publications p LEFT JOIN files f ON f.id=p.source_file_id ${fileId?'WHERE p.source_file_id=?':''} ORDER BY p.created_at DESC LIMIT 100`;
  const items=await many(db,sql,fileId?[fileId]:[]);
  return ok({publications:items.map(p=>({id:p.id,source_file_id:p.source_file_id,name:p.name||'源文件已删除',public_path:p.public_path,
   status:p.status==='ready'&&(!p.name||p.deleted_at||p.file_status!=='ready')?'source_unavailable':p.status,
   published_revision:p.published_revision,sync_state:p.sync_state,auto_sync:Boolean(p.auto_sync),smart_url:p.status==='ready'&&p.name&&!p.deleted_at&&p.file_status==='ready'?stablePublicUrl(req,p.id):null,
   created_at:p.created_at,url:p.status==='ready'&&p.name&&!p.deleted_at&&p.file_status==='ready'?stablePublicUrl(req,p.id):null,
   legacy_url:p.status==='ready'&&p.name&&!p.deleted_at&&p.file_status==='ready'?publicationUrl(req,env,p):null,
   delivery:cdnBaseUrl(env.PUBLIC_BASE_URL)?'cdn':'worker'})),cdn_base_url:cdnBaseUrl(env.PUBLIC_BASE_URL),
   cdn_configured:Boolean(cdnBaseUrl(env.PUBLIC_BASE_URL)),purge_configured:Boolean(env.CDN_ZONE_ID&&env.CDN_PURGE_TOKEN)});
 }
 m=/^\/api\/v1\/publications\/([0-9a-f-]{36})\/(status|versions|sync|publish-latest)$/.exec(path);
 if(m){
  if(user.role!=='super_admin')return error('FORBIDDEN','无权限',403);
  const [_,id,action]=m,p=await publicationDetails(db,id);
  if(!p)return error('NOT_FOUND','公开发布不存在',404);
  if(action==='status'&&req.method==='GET')return ok({id,status:p.status,sync_state:p.sync_state,
   revision:p.published_revision,source_revision:p.source_revision,auto_sync:Boolean(p.auto_sync),smart_url:p.status==='ready'?stablePublicUrl(req,id):null,
   public_object_key:null,cdn_configured:Boolean(cdnBaseUrl(env.PUBLIC_BASE_URL))});
  if(action==='versions'&&req.method==='GET'){
   const versions=await many(db,`SELECT v.file_revision,v.created_at,o.size_bytes FROM publication_versions v JOIN storage_objects o ON o.id=v.object_id WHERE v.publication_id=? ORDER BY v.file_revision DESC LIMIT 30`,[id]);
   return ok({id,versions,current_revision:p.published_revision});
  }
  if(action==='publish-latest'&&req.method==='POST'){
   try{
    const result=await publishCurrentRevision(env,id);
    return result.status==='conflict'?error('VERSION_CONFLICT','源文件或公开版本已变化，请刷新后重试',409):result.status==='commit_outcome_unknown'?error('COMMIT_OUTCOME_UNKNOWN','数据库提交状态无法确认，已保留公开对象，请管理员检查发布状态后再操作',503):ok(result);
   }catch(e){if(e instanceof PublicationUpdateError)return error(e.code,e.message,e.status);throw e;}
  }
  if(action==='sync'&&req.method==='POST'){
   const j=await one(db,`SELECT id FROM publication_sync_jobs WHERE publication_id=? AND status IN ('pending','failed','purge_pending') ORDER BY file_revision DESC LIMIT 1`,[id]);
   if(!j){
    if(p.sync_state==='cache_unverified'){
     const alias=await one(db,'SELECT o.object_key FROM publications pub JOIN storage_objects o ON o.id=pub.legacy_object_id WHERE pub.id=?',[id]);
     const cache=alias?await purgePublicationCache(env,{public_path:alias.object_key}):{purged:false,reason:'ALIAS_MISSING'};
     if(cache.purged)await execute(db,"UPDATE publications SET sync_state='ready' WHERE id=? AND sync_state='cache_unverified'",[id]);
     return ok({status:cache.purged?'cache_refreshed':'cache_not_verified',cache});
    }
    return ok({status:'already_synchronized',sync_state:p.sync_state});
   }
   const result=await runLegacySync(env,j.id);return ok({status:result.status,sync_state:result.sync_state||null,cache:result.cache||null});
  }
  return error('METHOD_NOT_ALLOWED','方法不支持',405);
 }
 m=/^\/api\/v1\/publications\/([0-9a-f-]{36})$/.exec(path);
 if(m&&req.method==='PATCH'){
  if(user.role!=='super_admin')return error('FORBIDDEN','无权限',403);
  const data=await jsonBody(req);
  if(typeof data?.auto_sync!=='boolean')return error('INVALID_SETTINGS','auto_sync 必须为布尔值',400);
  const changed=await execute(db,"UPDATE publications SET auto_sync=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='ready'",[Number(data.auto_sync),m[1]]);
  return changed.meta?.changes?ok({id:m[1],auto_sync:data.auto_sync}):error('NOT_FOUND','有效公开发布不存在',404);
 }
 if(m&&req.method==='DELETE'){
  if(user.role!=='super_admin')return error('FORBIDDEN','无权限',403);
  const p=await one(db,"SELECT p.*,o.object_key FROM publications p JOIN storage_objects o ON o.id=p.public_object_id WHERE p.id=? AND p.status='ready'",[m[1]]);if(!p)return error('NOT_FOUND','公开资源不存在',404);
  const cache=await revokePublication(env,db,p);
  return ok({revoked:true,cache,warning:!cdnBaseUrl(env.PUBLIC_BASE_URL)?'已撤销 Worker 公开直链；已下载文件仍无法收回':cache?.purged?'已请求清理 Cloudflare CDN 缓存，浏览器已下载的文件仍无法收回':'CDN 缓存尚未确认清除，请在 Cloudflare 中按 URL 清理缓存'});
 }
 return error('NOT_FOUND','接口不存在',404);
}
export async function temporaryLink(req,env,path){
 const m=new RegExp('^/t/'+codePattern+'$').exec(path);if(!m)return error('NOT_FOUND','链接不存在',404);
 const db=dbFromEnv(env),s=await resolveShare(db,m[1]);if(!s||s.type!=='temporary'||s.target_type!=='file')return error('NOT_FOUND','链接不存在或已过期',404);
 return serveSharedFile(req,env,s,s.target_id);
}

// On a newly deployed account a custom R2 CDN domain is optional. Until it is
// configured, permanent public links can stream directly from the PUBLIC_BUCKET
// through a publicly readable Worker route. The route checks publication state
// on every request, which makes revocation independent of CDN cache expiry.
export async function publicPublishedFile(request, env, path) {
 const match=/^\/p\/([0-9a-f-]{36})$/.exec(path);
 if(!match)return error('NOT_FOUND','公开文件不存在',404);
 if(!['GET','HEAD'].includes(request.method))return error('METHOD_NOT_ALLOWED','不支持此请求方式',405);
 const db=env.DB?.withSession?.('first-primary')||dbFromEnv(env);
 const p=await one(db,`SELECT p.id,p.public_path,o.object_key,o.size_bytes,
   f.mime_type,f.name FROM publications p
   JOIN storage_objects o ON o.id=p.public_object_id
   JOIN files f ON f.id=p.source_file_id
   WHERE p.id=? AND p.status='ready' AND o.status='ready' AND o.bucket_type='public'
   AND f.deleted_at IS NULL AND f.status='ready'`,[match[1]]);
 if(!p||!env.PUBLIC_BUCKET?.get)return error('NOT_FOUND','公开文件不存在或已撤销',404);
 const h=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
   'Referrer-Policy':'no-referrer','Accept-Ranges':'bytes'});
 let range;const rawRange=request.headers.get('Range');
 if(rawRange){
  const m=/^bytes=(\d*)-(\d*)$/.exec(rawRange);
  const n=p.size_bytes;let a,b;
  if(m&&(m[1]||m[2])){
   if(m[1]){a=Number(m[1]);b=m[2]?Number(m[2]):n-1;}
   else{const count=Number(m[2]);a=Math.max(0,n-count);b=n-1;}
  }
  if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<a||a>=n||(!m[1]&&Number(m[2])===0)){
   h.set('Content-Range',`bytes */${p.size_bytes}`);return new Response(null,{status:416,headers:h});
  }
  range={offset:a,length:Math.min(b,n-1)-a+1};
 }
 const obj=await env.PUBLIC_BUCKET.get(p.object_key,range?{range}:undefined);
 if(!obj)return error('NOT_FOUND','公开文件不存在',404);
 const inlineTypes=new Set(['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf']);
 const mime=inlineTypes.has(p.mime_type)?p.mime_type:'application/octet-stream';
 h.set('Content-Type',publicMimeFromObject(obj,mime));h.set('Content-Disposition',`${inlineTypes.has(p.mime_type)?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(p.name)}`);
 h.set('Content-Length',String(range?range.length:p.size_bytes));
 if(range)h.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${p.size_bytes}`);
 return new Response(request.method==='HEAD'?null:obj.body,{status:range?206:200,headers:h});
}

function publicMimeFromObject(obj,fallback){const m=obj?.httpMetadata?.contentType;return ['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf'].includes(m)?m:fallback;}

// RC13.2 stable Worker entry. Redirects are explicitly uncacheable; versioned
// R2 keys are immutable and may be cached for a long time. If no custom CDN
// domain is configured, stream through the same safe /p route instead.
export async function smartPublishedFile(request,env,path){
 const match=/^\/r\/([0-9a-f-]{36})$/.exec(path);
 if(!match)return error('NOT_FOUND','公开链接不存在',404);
 if(!['GET','HEAD'].includes(request.method))return error('METHOD_NOT_ALLOWED','请求方式不允许',405);
 const base=cdnBaseUrl(env.PUBLIC_BASE_URL);
 if(!base)return publicPublishedFile(request,env,`/p/${match[1]}`);
 const db=env.DB?.withSession?.('first-primary')||dbFromEnv(env),p=await publicationDetails(db,match[1]);
 if(!p||p.status!=='ready'||p.file_status!=='ready'||p.deleted_at||!p.object_key||!/^(?:versions|published)\/[a-zA-Z0-9/_-]+$/.test(p.object_key))
  return new Response('Not Found',{status:404,headers:{'Cache-Control':'no-store','CDN-Cache-Control':'no-store'}});
 const location=`${base}/${p.object_key}`;
 return new Response(null,{status:302,headers:{
  'Location':location,'Cache-Control':'private, no-store, max-age=0',
  'CDN-Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store',
  'Pragma':'no-cache','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex'
 }});
}
