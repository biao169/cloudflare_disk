// RC14.11: unified authorization for OneDrive published files and snapshot groups.
// Group-owned file previews/downloads inherit the group policy even when visited directly.
// Password unlocks use HttpOnly signed, epoch-bound cookies. Never expose passwords or Graph URLs.
import {dbFromEnv,one,many,execute} from './database.js';
import {resolveUser} from './auth.js';
import {audit} from './admin.js';
import {ok,error} from '../utils/response.js';
const FILE=/^odf_[a-f0-9]{32}$/,GROUP=/^odg_[a-f0-9]{32}$/;
const text=new TextEncoder();
const STATS=new Set(['view','download','preview','unlock_failure','upstream_error']);
const PRIVATE={'Cache-Control':'no-store, private','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'};
const TABLE={file:'onedrive_drive_publications',group:'onedrive_share_groups'};
const COOKIE_AGE=8*3600,ROUNDS=160000;
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const un64=str=>Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-str.length%4)%4)),x=>x.charCodeAt(0));
const hex=bytes=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
const validId=id=>FILE.test(id)||GROUP.test(id);
const table=id=>FILE.test(id)?TABLE.file:GROUP.test(id)?TABLE.group:null;
const maxFor=x=>Number.isSafeInteger(x)&&x>=1&&x<=1_000_000;
const safeHeaders=PRIVATE;
function err(code,status,message){return error(code,message,status);}
export function policyPublic(row){return {id:row.id,status:row.status==='revoked'?'revoked':row.is_paused?'paused':isExpired(row)?'expired':'active',access_mode:row.access_mode||'anyone',password_protected:!!row.password_hash,expires_at:row.expires_at||null,max_views:row.max_views??null,max_downloads:row.max_downloads??null,view_count:row.view_count||0,download_count:row.download_count||0,show_direct_link:row.show_direct_link!==0};}
export function isExpired(row,now=Date.now()){return !!row.expires_at&&(!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<=now);}
export function validateSharePolicy(p){
 if(!p||typeof p!=='object'||Array.isArray(p))throw Error('INVALID_POLICY');
 const keys=Object.keys(p),allowed=new Set(['is_paused','access_mode','expires_at','max_views','max_downloads','password','clear_password','show_direct_link']);
 if(!keys.length||keys.some(k=>!allowed.has(k)))throw Error('INVALID_POLICY');
 const result={};
 if('is_paused'in p){if(typeof p.is_paused!=='boolean')throw Error('INVALID_POLICY');result.is_paused=p.is_paused?1:0;}
 if('show_direct_link'in p){if(typeof p.show_direct_link!=='boolean')throw Error('INVALID_POLICY');result.show_direct_link=p.show_direct_link?1:0;}
 if('access_mode'in p){if(!['anyone','member'].includes(p.access_mode))throw Error('INVALID_POLICY');result.access_mode=p.access_mode;}
 if('expires_at'in p){if(p.expires_at===null||p.expires_at==='')result.expires_at=null;
  else{if(typeof p.expires_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(p.expires_at))throw Error('INVALID_POLICY');const d=new Date(p.expires_at);if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==p.expires_at.slice(0,10)||d.getTime()<=Date.now()||d.getTime()>Date.now()+10*365*86400000)throw Error('INVALID_EXPIRY');result.expires_at=d.toISOString();}}
 for(const k of ['max_views','max_downloads'])if(k in p){if(p[k]!==null&&!maxFor(p[k]))throw Error('INVALID_POLICY');result[k]=p[k];}
 if('password'in p){if(typeof p.password!=='string'||[...p.password].length<6||[...p.password].length>128)throw Error('INVALID_PASSWORD');result.password=p.password;}
 if('clear_password'in p){if(p.clear_password!==true||'password'in p)throw Error('INVALID_POLICY');result.clear_password=true;}
 return result;
}
async function derivePassword(password,salt,rounds=ROUNDS){const key=await crypto.subtle.importKey('raw',text.encode(password),{name:'PBKDF2'},false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:rounds},key,256));}
function same(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;}
export async function makePasswordRecord(password){const salt=crypto.getRandomValues(new Uint8Array(16));return {password_salt:hex(salt),password_hash:hex(await derivePassword(password,salt)),password_iterations:ROUNDS};}
export async function verifyPassword(password,row){if(!row.password_hash||!/^[0-9a-f]{32}$/.test(row.password_salt||'')||!/^[0-9a-f]{64}$/.test(row.password_hash)||!Number.isInteger(row.password_iterations)||row.password_iterations<100000||row.password_iterations>300000)return false;const salt=Uint8Array.from(row.password_salt.match(/../g),h=>parseInt(h,16));return same(await derivePassword(password,salt,row.password_iterations),Uint8Array.from(row.password_hash.match(/../g),h=>parseInt(h,16)));}
async function signingKey(env){let secret=env.ONEDRIVE_SHARE_SESSION_KEY||env.MS_TOKEN_KEY||env.MICROSOFT_TOKEN_KEY||env.SHARE_LINK_KEY;if(typeof secret!=='string'||secret.trim().length<32)throw Error('SHARE_SESSION_KEY_UNAVAILABLE');const bytes=await crypto.subtle.digest('SHA-256',text.encode('CloudDrive-OneDrive-cookie-v1:'+secret));return crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
function cookieName(id){return `odunlock_${id}`;}
async function makeTicket(env,row){const payload=b64(text.encode(JSON.stringify({id:row.id,epoch:row.policy_epoch||0,exp:Math.floor(Date.now()/1000)+COOKIE_AGE})));const sig=b64(await crypto.subtle.sign('HMAC',await signingKey(env),text.encode(payload)));return `${payload}.${sig}`;}
async function validTicket(req,env,row){try{const raw=req.headers.get('Cookie')||'';const value=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName(row.id)+'='))?.slice(cookieName(row.id).length+1);if(!value||value.length>1024)return false;const [p,s]=value.split('.');if(!p||!s||!/^[A-Za-z0-9_-]+$/.test(p)||!/^[A-Za-z0-9_-]+$/.test(s))return false;const rawPayload=un64(p),rawSignature=un64(s);if(b64(rawPayload)!==p||b64(rawSignature)!==s)return false;const payload=JSON.parse(new TextDecoder().decode(rawPayload));if(payload.id!==row.id||payload.epoch!==(row.policy_epoch||0)||!Number.isInteger(payload.exp)||payload.exp<Math.floor(Date.now()/1000))return false;return crypto.subtle.verify('HMAC',await signingKey(env),rawSignature,text.encode(p));}catch{return false;}}
export async function scopeRow(env,id){const t=table(id);if(!t)return null;return one(dbFromEnv(env),`SELECT * FROM ${t} WHERE id=?`,[id]);}
export async function inheritedScope(env,row){if(!row)return null;if(!row.group_id)return row;return scopeRow(env,row.group_id);}
function closedReason(row){if(!row)return err('NOT_FOUND',404,'分享不存在');if(row.status!=='active')return err('GONE',410,'分享已撤销');if(row.is_paused)return err('SHARE_PAUSED',403,'分享已暂停');if(isExpired(row))return err('SHARE_EXPIRED',410,'分享已过期');return null;}
export async function authorizeShare(req,env,row,{checkViewLimit=false,checkDownloadLimit=false}={}){
 const scope=await inheritedScope(env,row);
 const failed=closedReason(row)||closedReason(scope);if(failed)return {allowed:false,response:failed};
 if(scope.access_mode==='member'&&!(await resolveUser(req,env)))return {allowed:false,response:err('LOGIN_REQUIRED',401,'此分享仅允许 CloudDrive 登录用户访问')};
 if(scope.password_hash&&!(await validTicket(req,env,scope)))return {allowed:false,response:err('PASSWORD_REQUIRED',401,'请输入分享访问密码')};
 if(checkViewLimit&&scope.max_views!==null&&scope.max_views!==undefined&&scope.view_count>=scope.max_views)return {allowed:false,response:err('VIEW_LIMIT_REACHED',429,'页面浏览次数已达上限')};
 if(checkDownloadLimit&&(scope.max_downloads!==null&&scope.max_downloads!==undefined&&scope.download_count>=scope.max_downloads||row!==scope&&row.max_downloads!==null&&row.max_downloads!==undefined&&row.download_count>=row.max_downloads))return {allowed:false,response:err('DOWNLOAD_LIMIT_REACHED',429,'下载跳转次数已达上限')};
 return {allowed:true,scope};
}
export async function recordDaily(db,id,metric){if(!STATS.has(metric))return;try{await execute(db,"INSERT INTO onedrive_share_daily_stats(scope_id,utc_day,metric,amount) VALUES(?,date('now'),?,1) ON CONFLICT(scope_id,utc_day,metric) DO UPDATE SET amount=amount+1",[id,metric]);}catch{console.warn('Share daily summary unavailable');}}
export async function countView(env,scope){const db=dbFromEnv(env),t=table(scope.id);
 const result=await execute(db,`UPDATE ${t} SET view_count=view_count+1 WHERE id=? AND status='active' AND is_paused=0 AND (expires_at IS NULL OR strftime('%s',expires_at)>strftime('%s','now')) AND (max_views IS NULL OR view_count<max_views)`,[scope.id]);
 if(!result.meta?.changes)return false;await recordDaily(db,scope.id,'view');return true;
}
export async function countDownload(env,row){const db=dbFromEnv(env);
 // trigger in migration atomically increments parent group counter (or aborts on cap/pause/expiry).
 try{const result=await execute(db,"UPDATE onedrive_drive_publications SET download_count=download_count+1,access_count=access_count+1,last_accessed_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=? AND status='active' AND is_paused=0 AND (expires_at IS NULL OR strftime('%s',expires_at)>strftime('%s','now')) AND (max_downloads IS NULL OR download_count<max_downloads)",[row.id]);if(!result.meta?.changes)return false;
  await recordDaily(db,row.id,'download');if(row.group_id)await recordDaily(db,row.group_id,'download');return true;
 }catch(e){if(/ONEDRIVE_GROUP_DOWNLOAD_BLOCKED/i.test(String(e.cause?.message||e.message)))return false;throw e;}
}
export async function unlockShare(req,env){let data;try{const raw=await req.text();if(raw.length>4096)throw Error();data=JSON.parse(raw);}catch{return err('INVALID_JSON',400,'请输入有效密码');}
 const id=data?.id,password=data?.password;if(!validId(id)||typeof password!=='string'||[...password].length>128)return err('INVALID_INPUT',400,'请输入有效分享密码');
 const target=await scopeRow(env,id);const scope=await inheritedScope(env,target);const closed=closedReason(scope);if(closed)return closed;
 if(scope.access_mode==='member'&&!(await resolveUser(req,env)))return err('LOGIN_REQUIRED',401,'请先登录 CloudDrive');
 if(!scope.password_hash)return err('PASSWORD_NOT_SET',400,'此分享未设置访问密码');
 // Atomic rate bucket; no plaintext IP. Shared with all sites on this D1 binding.
 const ip=req.headers.get('CF-Connecting-IP')||'unknown';const secret=String(env.ONEDRIVE_SHARE_SESSION_KEY||env.MS_TOKEN_KEY||env.MICROSOFT_TOKEN_KEY||env.SHARE_LINK_KEY||'');
 const visitor=b64(await crypto.subtle.digest('SHA-256',text.encode(`${secret}:${ip}:${id}`)));
 const db=dbFromEnv(env),window=Math.floor(Date.now()/900000);
 const result=await execute(db,'INSERT INTO onedrive_share_unlock_attempts(scope_id,visitor_hash,window_id,attempts) VALUES(?,?,?,1) ON CONFLICT(scope_id,visitor_hash,window_id) DO UPDATE SET attempts=attempts+1 WHERE attempts<8',[id,visitor,window]);
 if(!result.meta?.changes)return err('UNLOCK_RATE_LIMITED',429,'密码尝试次数过多，请15分钟后重试');
 if(!(await verifyPassword(password,scope))){await recordDaily(db,id,'unlock_failure');return err('INVALID_PASSWORD',403,'分享访问密码不正确');}
 let ticket;try{ticket=await makeTicket(env,scope);}catch{return err('SHARE_SESSION_UNAVAILABLE',503,'分享会话暂不可用，请联系管理员');}
 const secure=new URL(req.url).protocol==='https:'?'; Secure':'';
 const res=ok({unlocked:true,expires_in:COOKIE_AGE});const heads=new Headers(res.headers);heads.set('Set-Cookie',`${cookieName(scope.id)}=${ticket}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_AGE}${secure}`);heads.set('Cache-Control','no-store, private');return new Response(res.body,{status:200,headers:heads});
}
export async function adminPolicy(env,id){const row=await scopeRow(env,id);if(!row)return null;return {...policyPublic(row),kind:GROUP.test(id)?'group':'file',group_id:row.group_id||null,updated_at:row.updated_at||null};}
export async function setPolicy(env,id,body){const t=table(id);if(!t)throw Error('INVALID_SHARE_ID');const row=await scopeRow(env,id);if(!row)throw Error('NOT_FOUND');if(row.status!=='active')throw Error('SHARE_REVOKED');if(row.group_id)throw Error('GROUP_POLICY_INHERITED');
 const fields=validateSharePolicy(body);if(fields.password){const record=await makePasswordRecord(fields.password);Object.assign(fields,record);delete fields.password;}
 if(fields.clear_password){fields.password_salt=null;fields.password_hash=null;fields.password_iterations=null;delete fields.clear_password;}
 const keys=Object.keys(fields),set=keys.map(k=>`${k}=?`);
 set.push('policy_epoch=policy_epoch+1','updated_at=CURRENT_TIMESTAMP');
 if('is_paused'in fields)set.push(`paused_at=${fields.is_paused?"CURRENT_TIMESTAMP":"NULL"}`);
 await execute(dbFromEnv(env),`UPDATE ${t} SET ${set.join(',')} WHERE id=? AND status='active'`,[...keys.map(k=>fields[k]),id]);return adminPolicy(env,id);
}
export async function adminSharePolicyRoute(req,env,path,actorId=null){
 const base='/api/v1/admin/onedrive/shares';
 if(path===base&&req.method==='GET'){
  const db=dbFromEnv(env),search=new URL(req.url).searchParams;
  const source=search.get('source')||'all';if(!['all','file','group'].includes(source))return err('INVALID_INPUT',400,'筛选值无效');
  const q=search.get('q')||'';if(q.length>100)return err('INVALID_INPUT',400,'搜索词过长');
  const limit=Math.max(1,Math.min(100,Number(search.get('limit'))||50));
  const pubs=source==='group'?[]:await many(db,`SELECT id,file_name AS title,status,is_paused,expires_at,view_count,download_count,created_at,group_id FROM onedrive_drive_publications WHERE group_id IS NULL AND (?='' OR file_name LIKE '%'||?||'%') ORDER BY created_at DESC LIMIT ?`,[q,q,limit]);
  const groups=source==='file'?[]:await many(db,`SELECT id,title,status,is_paused,expires_at,view_count,download_count,created_at FROM onedrive_share_groups WHERE (?='' OR title LIKE '%'||?||'%') ORDER BY created_at DESC LIMIT ?`,[q,q,limit]);
  return ok({items:[...pubs.map(x=>({...x,kind:'file'})),...groups.map(x=>({...x,kind:'group'}))].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,limit)});
 }
 if(path===base+'/summary'&&req.method==='GET'){
  const db=dbFromEnv(env);const [files,groups,days]=await Promise.all([
   one(db,"SELECT COUNT(*) total,SUM(CASE WHEN status='active' AND is_paused=0 THEN 1 ELSE 0 END) active,COALESCE(SUM(view_count),0) views,COALESCE(SUM(download_count),0) downloads FROM onedrive_drive_publications WHERE group_id IS NULL"),
   one(db,"SELECT COUNT(*) total,SUM(CASE WHEN status='active' AND is_paused=0 THEN 1 ELSE 0 END) active,COALESCE(SUM(view_count),0) views,COALESCE(SUM(download_count),0) downloads FROM onedrive_share_groups"),
   many(db,"SELECT utc_day,metric,SUM(amount) amount FROM onedrive_share_daily_stats WHERE utc_day>=date('now','-29 days') GROUP BY utc_day,metric ORDER BY utc_day DESC LIMIT 150")
  ]);return ok({file:files,group:groups,daily:days,download_metric:'302 redirects initiated; not verified completed downloads',view_metric:'successful metadata page fetches',privacy:'aggregate counters only'});
 }
 const m=new RegExp(`^${base}/(od[fg]_[a-f0-9]{32})(?:/(stats|policy))?$`).exec(path);if(!m)return err('NOT_FOUND',404,'接口不存在');
 if(m[2]==='stats'&&req.method==='GET'){
  const row=await adminPolicy(env,m[1]);if(!row)return err('NOT_FOUND',404,'分享不存在');
  const days=await many(dbFromEnv(env),"SELECT utc_day,metric,amount FROM onedrive_share_daily_stats WHERE scope_id=? AND utc_day>=date('now','-29 days') ORDER BY utc_day DESC,metric",[m[1]]);
  return ok({policy:row,daily:days,download_metric:'跳转次数，并非实际完成下载次数'});
 }
 if((m[2]==='policy'||!m[2])&&req.method==='GET'){const data=await adminPolicy(env,m[1]);return data?ok(data):err('NOT_FOUND',404,'分享不存在');}
 if((m[2]==='policy'||!m[2])&&req.method==='PATCH'){
  let body;try{const raw=await req.text();if(raw.length>4096)throw Error();body=JSON.parse(raw);}catch{return err('INVALID_JSON',400,'配置格式错误');}
  try{const result=await setPolicy(env,m[1],body);if(actorId)await audit(dbFromEnv(env),actorId,'onedrive.share.policy.update','onedrive_share',m[1],{changed_fields:Object.keys(body).sort()});return ok(result);}catch(e){const code=e.message||'INVALID_POLICY';return err(code,code==='NOT_FOUND'?404:code==='GROUP_POLICY_INHERITED'?409:400,({GROUP_POLICY_INHERITED:'合集内文件继承合集权限，请编辑合集权限',SHARE_REVOKED:'已撤销的分享不能恢复，请重新发布'})[code]||'分享权限设置无效：'+code);}
 }
 return err('METHOD_NOT_ALLOWED',405,'不支持此请求方法');
}
export {PRIVATE as noStoreHeaders};
