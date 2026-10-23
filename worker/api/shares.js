import {settings} from '../services/admin.js';
import {resolveUser,jsonBody,randomToken,sha256,checkPassword} from '../services/auth.js';
import {one,many,execute,dbFromEnv} from '../services/database.js';
import {createShare,resolveShare,shareSummary,validatedAccess,serveSharedFile,publishFile,revokePublication,shareHeaders} from '../services/sharing.js';
import {ok,error} from '../utils/response.js';
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
    await execute(db,"INSERT INTO share_password_attempts(id,failures,blocked_until) VALUES(?,1,NULL) ON CONFLICT(id) DO UPDATE SET failures=failures+1,blocked_until=CASE WHEN failures>=4 THEN datetime('now','+15 minutes') ELSE NULL END",[rateKey]);
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
   if(!valid)return error('FORBIDDEN','不属于分享目录',403);
   const [folders,files]=await Promise.all([many(db,'SELECT id,name FROM folders WHERE parent_id=? AND deleted_at IS NULL ORDER BY name LIMIT 200',[folderId]),many(db,"SELECT id,name,size_bytes,mime_type FROM files WHERE folder_id=? AND deleted_at IS NULL AND status='ready' ORDER BY name LIMIT 200",[folderId])]);return ok({folders,files,folder_id:folderId});
  }
  return ok({type:s.type,target_type:s.target_type,has_password:Boolean(s.password_hash),allow_download:Boolean(s.allow_download),expires_at:s.expires_at});
 }
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 if(path==='/api/v1/shares'&&req.method==='POST'){if(!(await settings(db)).public_shares_enabled)return error('SHARING_DISABLED','管理员已暂停创建新分享',403);return createShare(req,env,user,await jsonBody(req)||{});}
 if(path==='/api/v1/shares'&&req.method==='GET'){const r=await many(db,'SELECT * FROM shares WHERE created_by=? ORDER BY created_at DESC LIMIT 100',[user.id]);return ok({shares:r.map(shareSummary)});}
 let m=/^\/api\/v1\/shares\/([0-9a-f-]{36})$/.exec(path);
 if(m&&req.method==='DELETE'){const changed=await execute(db,'UPDATE shares SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND created_by=? AND revoked_at IS NULL',[m[1],user.id]);return changed.meta?.changes?ok({revoked:true}):error('NOT_FOUND','分享不存在',404);}
 if(path==='/api/v1/publications'&&req.method==='POST'){if(!(await settings(db)).public_shares_enabled)return error('SHARING_DISABLED','管理员已暂停创建新分享',403);const body=await jsonBody(req);return publishFile(req,env,user,body?.file_id);}
 if(path==='/api/v1/publications'&&req.method==='GET'){if(user.role!=='super_admin')return error('FORBIDDEN','无权限',403);return ok({publications:await many(db,"SELECT p.id,p.source_file_id,p.public_path,p.status,p.created_at FROM publications p WHERE status='ready' ORDER BY created_at DESC LIMIT 100")});}
 m=/^\/api\/v1\/publications\/([0-9a-f-]{36})$/.exec(path);
 if(m&&req.method==='DELETE'){
  if(user.role!=='super_admin')return error('FORBIDDEN','无权限',403);
  const p=await one(db,"SELECT p.*,o.object_key FROM publications p JOIN storage_objects o ON o.id=p.public_object_id WHERE p.id=? AND p.status='ready'",[m[1]]);if(!p)return error('NOT_FOUND','公开资源不存在',404);
  await revokePublication(env,db,p);
  return ok({revoked:true,warning:'CDN 和浏览器中已缓存的文件可能仍然可访问，请在 Cloudflare 中清理该路径缓存'});
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
 const db=dbFromEnv(env);
 const p=await one(db,`SELECT p.id,p.public_path,o.object_key,o.size_bytes,
   f.mime_type,f.name FROM publications p
   JOIN storage_objects o ON o.id=p.public_object_id
   JOIN files f ON f.id=p.source_file_id
   WHERE p.id=? AND p.status='ready' AND o.status='ready'
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
 h.set('Content-Type',mime);h.set('Content-Disposition',`${inlineTypes.has(p.mime_type)?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(p.name)}`);
 h.set('Content-Length',String(range?range.length:p.size_bytes));
 if(range)h.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${p.size_bytes}`);
 return new Response(request.method==='HEAD'?null:obj.body,{status:range?206:200,headers:h});
}
