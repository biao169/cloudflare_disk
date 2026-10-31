import {dbFromEnv,one,execute} from './database.js';
import {parseOneDriveUrl} from './onedrive.js';
import {requireMicrosoftConfig,microsoftConfigStatus} from './microsoft-config.js';

const ENDPOINT='https://login.microsoftonline.com';
const SCOPE='offline_access User.Read Files.ReadWrite';
const CALLBACK_PATH='/api/v1/admin/onedrive/oauth/callback';
const enc=new TextEncoder();
const to64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const OAUTH_HELP={
 MICROSOFT_CONSENT_DENIED:'Microsoft 授权已取消或被拒绝。请重新发起授权并允许应用所需权限；如被组织策略阻止，请联系租户管理员。',
 MICROSOFT_REDIRECT_URI_MISMATCH:'Microsoft 拒绝了回调地址。请在 Entra → 应用注册 → 身份验证 → Web 中填写与当前 CloudDrive 授权请求完全一致的 HTTPS 回调 URL。',
 MICROSOFT_APP_NOT_FOUND:'Microsoft 找不到此应用。请检查 MS_CLIENT_ID 是否来自当前 Entra 应用注册，以及 MS_TENANT 和应用支持的账户类型。',
 MICROSOFT_INVALID_CLIENT_SECRET:'Microsoft 拒绝了应用密钥。请填写客户端密码的 Value（不是 Secret ID），并检查是否已过期。',
 MICROSOFT_ACCOUNT_TYPE_MISMATCH:'Microsoft 账户或租户不被该应用允许。若使用个人 OneDrive，应用支持的账户类型必须包含个人 Microsoft 账户，可将 MS_TENANT 设为 common 或 consumers。',
 MICROSOFT_ADMIN_CONSENT_REQUIRED:'Microsoft 要求管理员同意或组织阻止了授权。请在 Entra 检查 API 权限和组织的用户同意策略。',
 MICROSOFT_INVALID_SCOPE:'微软不接受当前申请的 Graph 权限。请检查 Entra 应用的委托权限及账户类型。',
 MICROSOFT_SIGNIN_FAILED:'Microsoft 没有颁发授权码。请检查 Microsoft 返回的 AADSTS 代码、应用账户类型、API 权限和授权回调地址。',
 OAUTH_STATE_MISSING:'Microsoft 回调没有 state 参数。请从 CloudDrive 重新点击连接 Microsoft 账户，不要直接打开回调 URL。',
 OAUTH_CODE_MISSING:'Microsoft 回调没有授权码 code。请重新发起授权，并检查浏览器是否拦截或修改了回调地址。',
 OAUTH_STATE_INVALID:'OAuth 授权会话无效、已使用或超过 10 分钟。请在当前 CloudDrive 域名重新发起授权，并在同一浏览器完成。',
 OAUTH_SESSION_LOST:'返回 CloudDrive 时管理员登录会话不可用。请确认始终使用同一个域名、浏览器和 HTTPS 地址，并重新登录。',
 MICROSOFT_TOKEN_EXCHANGE_FAILED:'Microsoft 授权码换取令牌失败，请核对客户端密码 Value、回调 URL 和 PKCE 配置。',
 MICROSOFT_TOKEN_TIMEOUT:'微软令牌接口请求超时，请稍后重新连接。',
 MICROSOFT_TOKEN_BAD_RESPONSE:'微软令牌接口返回无法识别的响应，请稍后重试。',
 OFFLINE_ACCESS_NOT_GRANTED:'Microsoft 未返回刷新令牌。请确认请求包含 offline_access，重新授予权限并重试。',
 MS_REDIRECT_URI_INVALID:'MS_REDIRECT_URI 配置无效：必须是完整 HTTPS 地址，路径固定为 /api/v1/admin/onedrive/oauth/callback，且不能包含查询参数。',
 MS_REDIRECT_ORIGIN_MISMATCH:'当前访问的 CloudDrive 域名与 MS_REDIRECT_URI 不一致。请从该变量配置的域名打开网站后重新连接，避免 OAuth Cookie 丢失。',
 OAUTH_CALLBACK_ERROR:'Microsoft OAuth 回调失败。请核对应用注册、账户类型、授权权限及回调域名。'
};
const AADSTS_HINT={
 AADSTS50011:'MICROSOFT_REDIRECT_URI_MISMATCH',AADSTS500113:'MICROSOFT_REDIRECT_URI_MISMATCH',AADSTS70004:'MICROSOFT_REDIRECT_URI_MISMATCH',
 AADSTS700016:'MICROSOFT_APP_NOT_FOUND',AADSTS7000215:'MICROSOFT_INVALID_CLIENT_SECRET',AADSTS7000218:'MICROSOFT_INVALID_CLIENT_SECRET',AADSTS7000222:'MICROSOFT_INVALID_CLIENT_SECRET',
 AADSTS50020:'MICROSOFT_ACCOUNT_TYPE_MISMATCH',AADSTS50194:'MICROSOFT_ACCOUNT_TYPE_MISMATCH',
 AADSTS65001:'MICROSOFT_ADMIN_CONSENT_REQUIRED',AADSTS90094:'MICROSOFT_ADMIN_CONSENT_REQUIRED',AADSTS65004:'MICROSOFT_CONSENT_DENIED',
 AADSTS70011:'MICROSOFT_INVALID_SCOPE'
};

export class MicrosoftOAuthError extends Error{
 constructor(code,{aadsts=null,microsoftError=null}={}){
  super(code);this.name='MicrosoftOAuthError';this.code=code;this.aadsts=aadsts;this.microsoftError=microsoftError;
 }
}
export function oauthErrorDetails(err){
 const code=typeof err?.code==='string'&&/^[A-Z_]{4,75}$/.test(err.code)?err.code:
  (typeof err?.message==='string'&&/^[A-Z_]{4,75}$/.test(err.message)?err.message:'OAUTH_CALLBACK_ERROR');
 const aadsts=/^AADSTS\d{4,8}$/.test(err?.aadsts||'')?err.aadsts:null;
 const microsoftError=/^[a-z_]{1,50}$/.test(err?.microsoftError||'')?err.microsoftError:null;
 return {code,message:OAUTH_HELP[code]||OAUTH_HELP.OAUTH_CALLBACK_ERROR,aadsts,microsoftError};
}
export function microsoftAuthorizationError(error,errorDescription=''){
 const microsoftError=typeof error==='string'&&/^[a-z_]{1,50}$/.test(error)?error:null;
 // Microsoft may return tenant IDs or user-related information in descriptions. Never echo the raw description.
 const aadsts=typeof errorDescription==='string'?(errorDescription.match(/\bAADSTS\d{4,8}\b/i)?.[0].toUpperCase()||null):null;
 const code=AADSTS_HINT[aadsts]||(microsoftError==='access_denied'?'MICROSOFT_CONSENT_DENIED':
  microsoftError==='invalid_scope'?'MICROSOFT_INVALID_SCOPE':'MICROSOFT_SIGNIN_FAILED');
 return new MicrosoftOAuthError(code,{aadsts,microsoftError});
}
export function callbackUri(req,env,{enforceOrigin=false}={}){
 const raw=typeof env?.MS_REDIRECT_URI==='string'?env.MS_REDIRECT_URI.trim():'';
 if(!raw)return new URL(CALLBACK_PATH,req.url).href;
 let u;
 try{u=new URL(raw);}catch{throw new MicrosoftOAuthError('MS_REDIRECT_URI_INVALID');}
 if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.search||u.hash||u.pathname!==CALLBACK_PATH)
  throw new MicrosoftOAuthError('MS_REDIRECT_URI_INVALID');
 if(enforceOrigin&&u.origin!==new URL(req.url).origin)throw new MicrosoftOAuthError('MS_REDIRECT_ORIGIN_MISMATCH');
 return u.href;
}
function requireConfig(env){return requireMicrosoftConfig(env);}
function tenant(env){return /^[a-z0-9-]{1,64}$/i.test(env.MS_TENANT||'')?env.MS_TENANT:'common';}
function oauthUrl(env,route){return `${ENDPOINT}/${tenant(env)}/oauth2/v2.0/${route}`;}
async function key(env){return crypto.subtle.importKey('raw',requireConfig(env).tokenKey,{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function encrypt(env,data){const iv=crypto.getRandomValues(new Uint8Array(12));const bytes=enc.encode(JSON.stringify(data));const payload=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),bytes);return `${hex(iv)}:${to64(payload)}`;}
async function decrypt(env,value){const [iv,b64]=value.split(':');if(!/^[a-f0-9]{24}$/.test(iv)||!b64)throw Error('CORRUPT_CREDENTIAL');const raw=Uint8Array.from(atob(b64.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:Uint8Array.from(iv.match(/../g),h=>parseInt(h,16))},await key(env),raw);return JSON.parse(new TextDecoder().decode(data));}
async function exchange(env,params){
 const config=requireConfig(env);
 const form=new URLSearchParams(params);
 form.set('client_id',config.clientId);form.set('client_secret',config.clientSecret);
 let resp;
 try{resp=await fetch(oauthUrl(env,'token'),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(15000)});}
 catch{throw new MicrosoftOAuthError('MICROSOFT_TOKEN_TIMEOUT');}
 let data;
 try{data=await resp.json();}catch{throw new MicrosoftOAuthError('MICROSOFT_TOKEN_BAD_RESPONSE');}
 if(!resp.ok||!data?.access_token){
  const detail=microsoftAuthorizationError(data?.error,data?.error_description);
  // Token errors such as invalid_grant are not necessarily caused by the user declining consent.
  if(detail.code==='MICROSOFT_SIGNIN_FAILED')detail.code='MICROSOFT_TOKEN_EXCHANGE_FAILED';
  detail.message=detail.code;
  throw detail;
 }
 return data;
}
async function upsert(db,env,token){const encrypted=await encrypt(env,token);await execute(db,"INSERT INTO onedrive_oauth_account(id,encrypted_tokens,updated_at) VALUES('admin',?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,updated_at=CURRENT_TIMESTAMP",[encrypted]);}
export async function startOAuth(req,env,userId){
 const config=requireConfig(env);
 const redirect_uri=callbackUri(req,env,{enforceOrigin:true});
 const state=to64(crypto.getRandomValues(new Uint8Array(32)));
 const verifier=to64(crypto.getRandomValues(new Uint8Array(32)));
 const challenge=to64(await crypto.subtle.digest('SHA-256',enc.encode(verifier)));
 const db=dbFromEnv(env);
 await execute(db,'INSERT INTO onedrive_oauth_states(state,owner_id,verifier,expires_at) VALUES(?,?,?,?)',[state,userId,verifier,Math.floor(Date.now()/1000)+600]);
 const p=new URLSearchParams({client_id:config.clientId,response_type:'code',redirect_uri,response_mode:'query',scope:SCOPE,state,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'});
 return `${oauthUrl(env,'authorize')}?${p}`;
}
export async function finishOAuth(req,env,userId){
 requireConfig(env);
 const p=new URL(req.url).searchParams;
 if(p.has('error'))throw microsoftAuthorizationError(p.get('error'),p.get('error_description'));
 const state=p.get('state');const code=p.get('code');
 if(!state)throw new MicrosoftOAuthError('OAUTH_STATE_MISSING');
 if(!code)throw new MicrosoftOAuthError('OAUTH_CODE_MISSING');
 const db=dbFromEnv(env);
 const row=await one(db,'SELECT * FROM onedrive_oauth_states WHERE state=? AND owner_id=?',[state,userId]);
 if(!row||row.expires_at<Math.floor(Date.now()/1000))throw new MicrosoftOAuthError('OAUTH_STATE_INVALID');
 await execute(db,'DELETE FROM onedrive_oauth_states WHERE state=?',[state]);
 const token=await exchange(env,{grant_type:'authorization_code',code,redirect_uri:callbackUri(req,env),code_verifier:row.verifier,scope:SCOPE});
 if(!token.refresh_token)throw new MicrosoftOAuthError('OFFLINE_ACCESS_NOT_GRANTED');
 await upsert(db,env,{access_token:token.access_token,refresh_token:token.refresh_token,expires_at:Date.now()+token.expires_in*1000});
 return true;
}
export async function getAccessToken(env){
 requireConfig(env);const db=dbFromEnv(env);
 const row=await one(db,"SELECT encrypted_tokens FROM onedrive_oauth_account WHERE id='admin'");
 if(!row)throw Error('ONEDRIVE_NOT_CONNECTED');
 let token=await decrypt(env,row.encrypted_tokens);
 if(token.expires_at>Date.now()+120000)return token.access_token;
 const next=await exchange(env,{grant_type:'refresh_token',refresh_token:token.refresh_token,scope:SCOPE});
 token={access_token:next.access_token,refresh_token:next.refresh_token||token.refresh_token,expires_at:Date.now()+next.expires_in*1000};
 await upsert(db,env,token);return token.access_token;
}
export async function connectionStatus(env,req=null){
 const configuration=microsoftConfigStatus(env);
 const row=await one(dbFromEnv(env),"SELECT updated_at FROM onedrive_oauth_account WHERE id='admin'");
 let redirect_uri=null,redirect_error=null;
 if(req){try{redirect_uri=callbackUri(req,env,{enforceOrigin:true});}catch(e){redirect_error=oauthErrorDetails(e).message;}}
 return {connected:!!row,updated_at:row?.updated_at||null,configured:configuration.ready&&!redirect_error,configuration,redirect_uri,redirect_error};
}
export async function disconnect(env){await execute(dbFromEnv(env),"DELETE FROM onedrive_oauth_account WHERE id='admin'");}
export async function graphResolve(env,url){const parsed=parseOneDriveUrl(url);const token=await getAccessToken(env);const r=await fetch(`https://graph.microsoft.com/v1.0/shares/${encodeURIComponent(parsed.share_token)}/driveItem`,{headers:{Authorization:`Bearer ${token}`,Prefer:'redeemSharingLinkIfNecessary'},redirect:'manual',signal:AbortSignal.timeout(12000)});if(!r.ok){if(r.status===429||r.status===503)throw Error('MICROSOFT_THROTTLED');if(r.status===401)throw Error('MICROSOFT_REAUTHORIZE');if(r.status===403)throw Error('MICROSOFT_ACCESS_DENIED');if(r.status===404)throw Error('MICROSOFT_NOT_FOUND');throw Error('MICROSOFT_GRAPH_FAILED');}const j=await r.json();const download=j['@microsoft.graph.downloadUrl'];return {name:j.name||null,size:j.size??null,mime_type:j.file?.mimeType||null,drive_id:j.parentReference?.driveId||null,item_id:j.id||null,etag:j.eTag||null,download_url:validMicrosoftDownloadUrl(download)?download:null,download_verified:validMicrosoftDownloadUrl(download),is_folder:!!j.folder,shared_scope:j.shared?.scope||null};}
// Only allow Microsoft-hosted temporary delivery destinations; never treat a caller URL as a proxy target.
export function validMicrosoftDownloadUrl(value){
 if(typeof value!=='string'||value.length>8192)return false;
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return false;
 const h=u.hostname.toLowerCase();return h==='public.dm.files.1drv.com'||h.endsWith('.files.1drv.com')||h.endsWith('.sharepoint.com')||h.endsWith('.sharepointonline.com')||h.endsWith('.1drv.com');
 }catch{return false;}
}
