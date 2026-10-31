import {dbFromEnv,one,many,execute} from './database.js';
import {getAccessToken,validMicrosoftDownloadUrl} from './onedrive-oauth.js';
import {ok,error,json} from '../utils/response.js';
import {resolveUser} from './auth.js';
import {browseDrivePage,driveThumbnail,validateBrowseParams} from './onedrive-browser.js';
import {updatePresentation,uploadCover,clearCover,cleanupRevokedCover} from './onedrive-presentation.js';
import {authorizeShare,countDownload,recordDaily} from './onedrive-share-policy.js';
const API='https://graph.microsoft.com/v1.0';
const ID=/^[A-Za-z0-9_!.-]{1,220}$/;
const FIXED=/^odf_[a-f0-9]{32}$/;
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
const randomId=()=>`odf_${[...crypto.getRandomValues(new Uint8Array(16))].map(x=>x.toString(16).padStart(2,'0')).join('')}`;
const esc=s=>encodeURIComponent(s);
// The browser only sees a stable CloudDrive /r/odf_* link. Graph credentials stay server-side.
// Upstream error codes are deliberately bounded: never echo token, private URL, Graph body or headers.
export class OneDriveDeliveryError extends Error {
 constructor(code, {status=502, upstreamStatus=null, retryAfter=null}={}) {
  super(code);this.name='OneDriveDeliveryError';this.code=code;this.status=status;
  this.upstreamStatus=upstreamStatus;this.retryAfter=retryAfter;
 }
}
const retrySeconds=value=>{
 const n=Number(value);if(Number.isInteger(n)&&n>=1)return Math.min(3600,n);
 const date=Date.parse(String(value||''));return Number.isFinite(date)?Math.max(1,Math.min(3600,Math.ceil((date-Date.now())/1000))):60;
};
function upstreamError(response){
 const status=response.status;
 const code=status===401?'MICROSOFT_REAUTHORIZE':status===403?'MICROSOFT_ACCESS_DENIED':
  status===404?'MICROSOFT_NOT_FOUND':status===429?'MICROSOFT_THROTTLED':
  status===503||status===502||status===504?'MICROSOFT_UPSTREAM_UNAVAILABLE':'MICROSOFT_GRAPH_FAILED';
 return new OneDriveDeliveryError(code,{status:status===401||status===429||status>=500?503:status===403?403:status===404?404:502,
  upstreamStatus:status,retryAfter:retrySeconds(response.headers.get('Retry-After'))});
}
function deliveryException(e){
 if(e instanceof OneDriveDeliveryError)return e;
 const code=String(e?.code||e?.message||'');
 if(code==='MICROSOFT_REAUTHORIZE'||code==='ONEDRIVE_NOT_CONNECTED'||code==='OFFLINE_ACCESS_NOT_GRANTED'||code==='MICROSOFT_TOKEN_EXCHANGE_FAILED'||code==='CORRUPT_CREDENTIAL'||code.startsWith('MICROSOFT_TOKEN_KEY_'))
  return new OneDriveDeliveryError('MICROSOFT_REAUTHORIZE',{status:503});
 if(code==='MICROSOFT_THROTTLED')return new OneDriveDeliveryError('MICROSOFT_THROTTLED',{status:503,retryAfter:60});
 if(e?.name==='TimeoutError'||e?.name==='AbortError')return new OneDriveDeliveryError('MICROSOFT_TIMEOUT',{status:503});
 return new OneDriveDeliveryError('MICROSOFT_NETWORK_OR_TOKEN_ERROR',{status:503});
}
export function downloadErrorDescription(code){
 return ({MICROSOFT_REAUTHORIZE:'Microsoft 账户授权已失效，请管理员在系统设置重新连接 OneDrive。',
  MICROSOFT_ACCESS_DENIED:'OneDrive 拒绝访问此文件，请管理员检查来源权限。',
  MICROSOFT_NOT_FOUND:'OneDrive 来源文件不存在或已被删除。',
  MICROSOFT_THROTTLED:'Microsoft 请求频率受限，请稍后重试。',
  MICROSOFT_UPSTREAM_UNAVAILABLE:'Microsoft 下载服务暂时不可用，请稍后重试。',
  MICROSOFT_TIMEOUT:'连接 Microsoft 超时，请稍后重试。',
  MICROSOFT_DOWNLOAD_REDIRECT_UNTRUSTED:'微软返回的下载目标未通过安全校验，请管理员检查诊断。',
  GRAPH_CONTENT_NOT_FILE:'Microsoft 返回的不是安全的文件数据。',
  GRAPH_CONTENT_NO_BODY:'Microsoft 未返回可下载的文件内容。',
  MICROSOFT_BAD_RESPONSE:'Microsoft 文件元数据响应异常。',
  MICROSOFT_GRAPH_FAILED:'Microsoft 文件接口请求失败，请管理员使用下载诊断查看状态。',
  MICROSOFT_NETWORK_OR_TOKEN_ERROR:'OneDrive 下载请求失败，请管理员检查授权或网络状态。'})[code]||'OneDrive 文件暂时无法下载，请稍后重试或联系管理员。';
}
async function graphResponse(env,path,{method='GET',timeout=12000}={}){
 let token;
 try{token=await getAccessToken(env);}catch(e){throw deliveryException(e);}
 try{return await fetch(`${API}${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:path.endsWith('/content')?'*/*':'application/json'},redirect:'manual',signal:AbortSignal.timeout(timeout)});}
 catch(e){throw deliveryException(e);}
}
async function graph(env,path){
 const resp=await graphResponse(env,path);
 if(!resp.ok)throw upstreamError(resp);
 try{return await resp.json();}catch{throw new OneDriveDeliveryError('MICROSOFT_BAD_RESPONSE');}
}
// Request the file annotation explicitly where supported; some accounts omit it on generic metadata GET.
// Older Graph accounts can reject that $select, in which case request ordinary metadata once.
export async function downloadMetadata(env,row){
 const base=`/drives/${esc(row.drive_id)}/items/${esc(row.item_id)}`;
 const selected=`${base}?$select=id,name,file,folder,size,@microsoft.graph.downloadUrl`;
 try{return await graph(env,selected);}
 catch(e){if(e.upstreamStatus!==400)throw e;return graph(env,base);}
}
// Graph /content normally 302s. Do NOT automatically follow with an Authorization header,
// and do NOT send Range to /content (Range belongs on the preauthorized URL itself).
export async function graphContentResponse(env,row){
 return graphResponse(env,`/drives/${esc(row.drive_id)}/items/${esc(row.item_id)}/content`,{timeout:20000});
}
export async function streamGraphDownload(env,row){
 const response=await graphContentResponse(env,row);
 if([301,302,303,307,308].includes(response.status)){
  const loc=response.headers.get('Location');
  if(!validMicrosoftDownloadUrl(loc))throw new OneDriveDeliveryError('MICROSOFT_DOWNLOAD_REDIRECT_UNTRUSTED');
  return {location:loc};
 }
 if(![200,206].includes(response.status))throw upstreamError(response);
 const type=(response.headers.get('Content-Type')||'').split(';',1)[0].toLowerCase().trim();
 if(type==='text/html'||type==='application/problem+json'||type==='application/json'&&row.file_mime!=='application/json'){
  await response.body?.cancel().catch(()=>{});
  throw new OneDriveDeliveryError('GRAPH_CONTENT_NOT_FILE');
 }
 if(!response.body)throw new OneDriveDeliveryError('GRAPH_CONTENT_NO_BODY');
 return {response};
}
function streamHeaders(response,row){
 const h=new Headers(headers);h.set('Content-Type','application/octet-stream');h.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(String(row.file_name||'download').slice(0,180))}`);
 for(const k of ['Content-Length','Content-Range','Accept-Ranges']){
  const v=response.headers.get(k);if(v&&v.length<120&&!/[\r\n]/.test(v))h.set(k,v);
 }
 return h;
}
function itemPath(id){if(id==='root')return '/me/drive/root';if(!ID.test(id))throw Error('INVALID_ITEM_ID');return `/me/drive/items/${esc(id)}`;}
export async function browseDrive(env,id='root'){
 const path=`${itemPath(id)}/children?$top=100&$select=id,name,size,file,folder,parentReference,lastModifiedDateTime,webUrl`;
 const j=await graph(env,path);
 return {items:(j.value||[]).map(x=>({id:x.id,name:x.name,size:x.size||0,folder:!!x.folder,mime_type:x.file?.mimeType||null,updated_at:x.lastModifiedDateTime||null})),truncated:!!j['@odata.nextLink'],message:j['@odata.nextLink']?'仅显示前100项。文件较多时请进入子文件夹或整理目录。':null};
}
export async function publishDriveFile(env,id){if(!ID.test(id))throw Error('INVALID_ITEM_ID');const j=await graph(env,itemPath(id)+'?$select=id,name,size,file,folder,parentReference,eTag,lastModifiedDateTime');if(!j.file||j.folder||!j.id||!j.parentReference?.driveId)throw Error('FILE_REQUIRED');
 const linkId=randomId();await execute(dbFromEnv(env),`INSERT INTO onedrive_drive_publications(id,drive_id,item_id,file_name,file_size,file_mime,file_modified_at,created_at,status) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP,'active')`,[linkId,j.parentReference.driveId,j.id,j.name||'file',Number.isSafeInteger(j.size)?j.size:null,j.file?.mimeType||null,j.lastModifiedDateTime||null]);
 return {id:linkId,url:`/r/${linkId}`,share_url:`/s/${linkId}`,name:j.name,size:j.size||0,warning:'此链接允许任何持有者使用管理员授权下载该文件。撤销后失效；不得用于不应公开的资料。'};
}
export async function listPublications(env){const rows=await many(dbFromEnv(env),`SELECT id,file_name,created_at,status,is_paused,access_mode,expires_at,max_views,max_downloads,view_count,download_count,password_hash IS NOT NULL AS password_protected,access_count,last_error,title,description,display_name,cover_style,cover_mime,preview_enabled,file_size,file_mime,file_modified_at,sync_status,last_checked_at,last_change_at,sync_error_code FROM onedrive_drive_publications WHERE group_id IS NULL ORDER BY created_at DESC LIMIT 100`);return {items:rows.map(r=>({...r,has_custom_cover:!!r.cover_mime,url:`/r/${r.id}`,share_url:`/s/${r.id}`}))};}
export async function revokePublication(env,id){if(!FIXED.test(id))throw Error('INVALID_PUBLICATION_ID');const r=await execute(dbFromEnv(env),`UPDATE onedrive_drive_publications SET status='revoked',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`,[id]);if(r.meta?.changes)await cleanupRevokedCover(env,id);return {revoked:!!r.meta?.changes};}
export async function driveFileAdminRoute(req,env,path){const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);if(user.role!=='super_admin')return error('FORBIDDEN','仅超级管理员可操作',403);
 try{
 if(path==='/api/v1/admin/onedrive/drive/browse'&&req.method==='GET'){
  const q=new URL(req.url).searchParams;
  const params=validateBrowseParams({parent:q.get('parent')||'root',query:q.get('q')||'',sort:q.get('sort')||'name_asc'});
  const cursor=q.get('cursor')||'';
  return ok(await browseDrivePage(env,{...params,cursor}));
 }
 if(path==='/api/v1/admin/onedrive/drive/thumbnail'&&req.method==='GET'){
  const itemId=new URL(req.url).searchParams.get('item')||'';
  return ok(await driveThumbnail(env,itemId));
 }
 if(path==='/api/v1/admin/onedrive/drive/items'&&req.method==='GET'){const id=new URL(req.url).searchParams.get('parent')||'root';return ok(await browseDrive(env,id));}
 if(path==='/api/v1/admin/onedrive/drive/publish'&&req.method==='POST'){let j;try{j=await req.json();}catch{return error('INVALID_JSON','JSON 格式错误',400);}if(j?.confirm_public!==true)return error('CONFIRM_REQUIRED','必须明确确认公开分享权限',400);return ok(await publishDriveFile(env,j.item_id),201);}
 if(path==='/api/v1/admin/onedrive/drive/publications'&&req.method==='GET')return ok(await listPublications(env));
 const diagnosing=/^\/api\/v1\/admin\/onedrive\/drive\/publications\/(odf_[a-f0-9]{32})\/download-diagnostic$/.exec(path);
 if(diagnosing&&req.method==='GET')return ok(await diagnoseDriveDownload(env,diagnosing[1]));
 const editing=/^\/api\/v1\/admin\/onedrive\/drive\/publications\/(odf_[a-f0-9]{32})(?:\/(cover))?$/.exec(path);
 if(editing&&editing[2]==='cover'&&req.method==='PUT')return ok(await uploadCover(env,editing[1],req));
 if(editing&&editing[2]==='cover'&&req.method==='DELETE')return ok(await clearCover(env,editing[1]));
 if(editing&&!editing[2]&&req.method==='PATCH'){
  let j;try{j=await req.json();}catch{return error('INVALID_JSON','JSON 格式错误',400);}
  return ok(await updatePresentation(env,editing[1],j));
 }

 const m=/^\/api\/v1\/admin\/onedrive\/drive\/publications\/(odf_[a-f0-9]{32})$/.exec(path);
 if(m&&req.method==='DELETE')return ok(await revokePublication(env,m[1]));
 return error('NOT_FOUND','接口不存在',404);
 }catch(e){const code=e.message||'ONEDRIVE_FAILED';
 if(code==='MICROSOFT_THROTTLED'){
  const delay=Number(e.retryAfter);
  return json({success:false,error:{code,message:'Microsoft 请求受限，请稍后重试'}},429,{'Retry-After':String(Number.isInteger(delay)&&delay>=1&&delay<=3600?delay:60)});
 }
 return error(code,'OneDrive 请求失败：'+code,code==='MICROSOFT_REAUTHORIZE'?401:code==='MICROSOFT_NOT_FOUND'?404:code==='MICROSOFT_GRAPH_FAILED'?502:code==='NOT_FOUND'?404:code==='COVER_TOO_LARGE'?413:code==='PRIVATE_BUCKET_REQUIRED'?503:400);
 }
}
// Public redirect and preview permissions are checked before accessing Microsoft.
// No raw Microsoft URL/token is persisted, logged, or placed in diagnostic responses.
export async function redirectAuthorizedDriveFile(req,env,id){
 if(!['GET','HEAD'].includes(req.method))return new Response('Method Not Allowed',{status:405,headers});
 if(!FIXED.test(id))return new Response('Not Found',{status:404,headers});
 const db=dbFromEnv(env);const row=await one(db,'SELECT * FROM onedrive_drive_publications WHERE id=?',[id]);
 if(!row)return new Response('Not Found',{status:404,headers});
 if(row.status!=='active')return new Response('Gone',{status:410,headers});
 const permitted=await authorizeShare(req,env,row,{checkDownloadLimit:true});if(!permitted.allowed)return permitted.response;
 if(req.method==='HEAD')return new Response(null,{status:204,headers});
 if(!ID.test(row.drive_id)||!ID.test(row.item_id))return new Response('Invalid record',{status:502,headers});
 try{
  const range=req.headers.get('Range');
  if(range&&(!/^bytes=\d{0,15}-\d{0,15}$/.test(range)||range==='bytes=-'))return new Response('Invalid Range',{status:416,headers});
  const item=await downloadMetadata(env,row);
  if(!item?.file||item.folder)throw new OneDriveDeliveryError('MICROSOFT_NOT_FOUND',{status:404});
  const direct=item['@microsoft.graph.downloadUrl'];
  const delivery=validMicrosoftDownloadUrl(direct)?{location:direct}:await streamGraphDownload(env,row);
  if(!(await countDownload(env,row))){await delivery.response?.body?.cancel().catch(()=>{});
   return new Response('Download limit reached or share unavailable',{status:429,headers:{...headers,'Retry-After':'3600'}});}
  if(delivery.location)return new Response(null,{status:302,headers:{...headers,Location:delivery.location}});
  return new Response(delivery.response.body,{status:delivery.response.status,headers:streamHeaders(delivery.response,row)});
 }catch(e){
  const safe=deliveryException(e);
  // Keep only the machine-readable cause in D1. Preserve the underlying failure if logging itself fails.
  try{await execute(db,'UPDATE onedrive_drive_publications SET last_error=? WHERE id=?',[safe.code,id]);}catch{}
  try{await recordDaily(db,id,'upstream_error');if(row.group_id)await recordDaily(db,row.group_id,'upstream_error');}catch{}
  const h=new Headers(headers);h.set('Content-Type','text/plain; charset=utf-8');h.set('X-CloudDrive-Error-Code',safe.code);
  if(safe.status===503)h.set('Retry-After',String(safe.retryAfter||60));
  return new Response(`${downloadErrorDescription(safe.code)}\n错误代码：${safe.code}`,{status:safe.status,headers:h});
 }
}
// Admin-only, does not create a temporary URL on the client or consume share download quotas.
export async function diagnoseDriveDownload(env,id){
 if(!FIXED.test(id))throw Error('INVALID_PUBLICATION_ID');
 const row=await one(dbFromEnv(env),'SELECT * FROM onedrive_drive_publications WHERE id=?',[id]);
 if(!row)throw Error('NOT_FOUND');
 if(!ID.test(row.drive_id)||!ID.test(row.item_id))return {available:false,code:'INVALID_STORED_ID'};
 try{
  const j=await downloadMetadata(env,row);
  if(!j?.file||j.folder)return {available:false,code:'MICROSOFT_NOT_FOUND',message:downloadErrorDescription('MICROSOFT_NOT_FOUND')};
  if(validMicrosoftDownloadUrl(j['@microsoft.graph.downloadUrl']))return {available:true,method:'temporary_download_url',code:'OK',note:'动态直链可用，微软临时地址不在诊断响应中暴露。'};
  const result=await streamGraphDownload(env,row);
  if(result.response?.body)await result.response.body.cancel().catch(()=>{});
  return {available:true,method:result.location?'content_redirect':'content_stream',code:'OK',note:'已验证微软下载接口响应，尚未实际传完整文件。'};
 }catch(e){const safe=deliveryException(e);return {available:false,code:safe.code,upstream_status:safe.upstreamStatus,message:downloadErrorDescription(safe.code),retry_after_seconds:safe.retryAfter||null};}
}
