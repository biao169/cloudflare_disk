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
async function graph(env,path){const token=await getAccessToken(env);const resp=await fetch(`${API}${path}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(!resp.ok){const e=new Error(resp.status===429?'MICROSOFT_THROTTLED':resp.status===401?'MICROSOFT_REAUTHORIZE':resp.status===403?'MICROSOFT_ACCESS_DENIED':resp.status===404?'MICROSOFT_NOT_FOUND':'MICROSOFT_GRAPH_FAILED');e.status=resp.status;e.retryAfter=resp.headers.get('Retry-After');throw e;}return resp.json();}
// If Microsoft no longer issues preauthorized links, stream Graph /content with the Graph token only to Graph.
// Never follow the redirect automatically with an Authorization header (credential leak risk).
export async function graphContentResponse(env,row,range=null){
 const token=await getAccessToken(env),path=`${API}/drives/${esc(row.drive_id)}/items/${esc(row.item_id)}/content`;
 const requestHeaders={Authorization:`Bearer ${token}`};
 if(range){if(!/^bytes=\d{0,15}-\d{0,15}$/.test(range)||range==='bytes=-')throw Error('INVALID_RANGE');requestHeaders.Range=range;}
 return fetch(path,{method:'GET',headers:requestHeaders,redirect:'manual',signal:AbortSignal.timeout(20000)});
}
export async function streamGraphDownload(env,row,{range=null}={}){
 const response=await graphContentResponse(env,row,range);
 if(response.status===302||response.status===307){
  const loc=response.headers.get('Location');if(!validMicrosoftDownloadUrl(loc))return new Response('Download address unavailable',{status:503,headers});
  return {location:loc};
 }
 if([200,206].includes(response.status)&&/^(text\/html|application\/json|application\/problem\+json)(?:;|$)/i.test(response.headers.get('Content-Type')||''))throw Error('GRAPH_CONTENT_NOT_BINARY');
 if(![200,206].includes(response.status)){
  const e=new Error(response.status===429?'MICROSOFT_THROTTLED':'MICROSOFT_GRAPH_FAILED');e.status=response.status;e.retryAfter=response.headers.get('Retry-After');throw e;
 }
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
export async function redirectAuthorizedDriveFile(req,env,id){if(!['GET','HEAD'].includes(req.method))return new Response('Method Not Allowed',{status:405,headers});if(!FIXED.test(id))return new Response('Not Found',{status:404,headers});
 const db=dbFromEnv(env);const row=await one(db,'SELECT * FROM onedrive_drive_publications WHERE id=?',[id]);if(!row)return new Response('Not Found',{status:404,headers});if(row.status!=='active')return new Response('Gone',{status:410,headers});
 const permitted=await authorizeShare(req,env,row,{checkDownloadLimit:true});if(!permitted.allowed)return permitted.response;
 if(req.method==='HEAD')return new Response(null,{status:204,headers}); // HEAD never exposes a free preauthorized Microsoft download URL.
 if(!ID.test(row.drive_id)||!ID.test(row.item_id))return new Response('Invalid record',{status:502,headers});
 try{const j=await graph(env,`/drives/${esc(row.drive_id)}/items/${esc(row.item_id)}`);if(!j.file||j.folder)return new Response('Source unavailable',{status:404,headers});
 const url=j['@microsoft.graph.downloadUrl'];
 // Current Graph behaviour: valid short-lived preauthenticated URLs are redirected immediately (never cached in D1).
 if(validMicrosoftDownloadUrl(url)){
  if(!(await countDownload(env,row)))return new Response('Download limit reached or share unavailable',{status:429,headers:{...headers,'Retry-After':'3600'}});
  return new Response(null,{status:302,headers:{...headers,Location:url}});
 }
 // Compatibility for newer tenant behaviour returning bytes from Graph /content instead of a temporary URL.
 // Streaming is bounded-memory; Range may depend on upstream Graph support. This route is already policy gated.
 const range=req.headers.get('Range');
 if(range&&(!/^bytes=\d{0,15}-\d{0,15}$/.test(range)||range==='bytes=-'))return new Response('Invalid Range',{status:416,headers});
 const delivered=await streamGraphDownload(env,row,{range});
 if(!(await countDownload(env,row))){await delivered.response?.body?.cancel().catch(()=>{});return new Response('Download limit reached or share unavailable',{status:429,headers:{...headers,'Retry-After':'3600'}});}
 if(delivered.location)return new Response(null,{status:302,headers:{...headers,Location:delivered.location}});
 return new Response(delivered.response.body,{status:delivered.response.status,headers:streamHeaders(delivered.response,row)});
 }catch(e){await recordDaily(db,row.id,'upstream_error');if(row.group_id)await recordDaily(db,row.group_id,'upstream_error');const status=e.status===404?404:e.status===429?503:e.status===401?503:e.status===403?403:502;const retry=typeof e.retryAfter==='string'&&/^\d{1,4}$/.test(e.retryAfter)?Math.min(3600,Math.max(1,Number(e.retryAfter))):60;return new Response('Source temporarily unavailable',{status,headers:{...headers,...(status===503?{'Retry-After':String(retry)}:{})}});}
}
