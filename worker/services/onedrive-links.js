import {dbFromEnv,one,execute,many} from './database.js';
import {parseOneDriveUrl} from './onedrive.js';
import {settings} from './admin.js';
import {resolveUser} from './auth.js';
import {ok,error} from '../utils/response.js';

const ID=/^od_[a-f0-9]{32}$/;
const TOKEN=/^[a-f0-9]{64}$/;
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
async function digest(s){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));}
function randomHex(bytes){const b=new Uint8Array(bytes);crypto.getRandomValues(b);return hex(b);}
function safeMetadata(row){return {id:row.id,url:`/r/${row.id}`,delivery:'source_page_redirect',status:row.status,created_at:row.created_at,expires_at:row.expires_at,last_error:row.last_error??null,access_count:row.access_count};}
const responseHeaders={'Cache-Control':'no-store, private','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
export async function createOneDriveLink(req,env,body){
 const db=dbFromEnv(env),s=await settings(db);
 if(!s.onedrive_tool_enabled)return error('TOOL_DISABLED','OneDrive 工具已关闭',403);
 const user=await resolveUser(req,env);
 if(!user&&!s.onedrive_anonymous_enabled)return error('LOGIN_REQUIRED','游客创建已关闭',401);
 if(!user)return error('GUEST_LINK_CREATION_DISABLED','当前版本仅允许登录用户创建固定链接；游客仍可解析链接',403);
 let parsed;try{parsed=parseOneDriveUrl(body?.url);}catch{return error('INVALID_URL','不支持的 OneDrive 分享链接',400);}
 const id=`od_${randomHex(16)}`;
 await execute(db,`INSERT INTO onedrive_fixed_links(id,source_url,created_by,status,created_at,updated_at,expires_at) VALUES(?,?,?,'active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL)`,[id,parsed.url,user.id]);
 return ok({...safeMetadata({id,status:'active',created_at:new Date().toISOString(),expires_at:null,access_count:0}),url:`${new URL(req.url).origin}/r/${id}`,message:'固定入口已创建。当前下载方式是打开 OneDrive 原始分享页；并非微软文件直链。'},201);
}
export async function listOneDriveLinks(req,env){
 const user=await resolveUser(req,env);if(!user)return error('LOGIN_REQUIRED','请先登录',401);
 const rows=await many(dbFromEnv(env),`SELECT id,status,created_at,expires_at,last_error,access_count FROM onedrive_fixed_links WHERE created_by=? ORDER BY created_at DESC LIMIT 100`,[user.id]);return ok({links:rows.map(safeMetadata)});
}
export async function revokeOneDriveLink(req,env,id){
 const user=await resolveUser(req,env);if(!user)return error('LOGIN_REQUIRED','请先登录',401);
 if(!ID.test(id))return error('NOT_FOUND','链接不存在',404);
 const result=await execute(dbFromEnv(env),`UPDATE onedrive_fixed_links SET status='revoked',updated_at=CURRENT_TIMESTAMP WHERE id=? AND created_by=? AND status='active'`,[id,user.id]);
 if(!result.meta?.changes)return error('NOT_FOUND','链接不存在或已经撤销',404);return ok({revoked:true,id});
}
export async function redirectOneDriveLink(req,env,id){
 if(!['GET','HEAD'].includes(req.method))return new Response('Method Not Allowed',{status:405,headers:responseHeaders});
 if(!ID.test(id))return new Response('Not Found',{status:404,headers:responseHeaders});
 const db=dbFromEnv(env),row=await one(db,'SELECT * FROM onedrive_fixed_links WHERE id=?',[id]);
 if(!row)return new Response('Not Found',{status:404,headers:responseHeaders});
 if(row.status!=='active')return new Response('Link revoked',{status:410,headers:responseHeaders});
 if(row.expires_at&&Date.parse(row.expires_at)<=Date.now())return new Response('Link expired',{status:410,headers:responseHeaders});
 // Parse on EVERY access, preventing redirects to arbitrary domains if DB is altered.
 let parsed;try{parsed=parseOneDriveUrl(row.source_url);}catch{return new Response('Source invalid',{status:502,headers:responseHeaders});}
 if(req.method==='GET')await execute(db,`UPDATE onedrive_fixed_links SET access_count=access_count+1,last_accessed_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`,[id]);
 // No Graph credentials are configured in RC14.3: redirect only to original share page.
 return new Response(null,{status:302,headers:{...responseHeaders,Location:parsed.url}});
}
export async function oneDriveLinkApi(req,env,path){
 if(path==='/api/v1/tools/onedrive/links'){
  if(req.method==='GET')return listOneDriveLinks(req,env);
  if(req.method==='POST'){
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('Content-Type')||''))return error('INVALID_CONTENT_TYPE','请提交 JSON',415);
   let body;try{const raw=await req.text();if(raw.length>8192)return error('PAYLOAD_TOO_LARGE','请求过大',413);body=JSON.parse(raw);}catch{return error('INVALID_JSON','请求数据格式错误',400);}
   return createOneDriveLink(req,env,body);
  }
  return error('METHOD_NOT_ALLOWED','请求方法不支持',405);
 }
 const m=/^\/api\/v1\/tools\/onedrive\/links\/(od_[a-f0-9]{32})$/.exec(path);
 if(m&&req.method==='DELETE')return revokeOneDriveLink(req,env,m[1]);
 return error('NOT_FOUND','接口不存在',404);
}
