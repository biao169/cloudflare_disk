import {dbFromEnv,one,many,execute} from './database.js';
import {getAccessToken,validMicrosoftDownloadUrl} from './onedrive-oauth.js';
import {ok,error} from '../utils/response.js';
import {resolveUser} from './auth.js';
const API='https://graph.microsoft.com/v1.0';
const ID=/^[A-Za-z0-9_!.-]{1,220}$/;
const FIXED=/^odf_[a-f0-9]{32}$/;
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
const randomId=()=>`odf_${[...crypto.getRandomValues(new Uint8Array(16))].map(x=>x.toString(16).padStart(2,'0')).join('')}`;
const esc=s=>encodeURIComponent(s);
async function graph(env,path){const token=await getAccessToken(env);const resp=await fetch(`${API}${path}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(!resp.ok){const e=new Error(resp.status===429?'MICROSOFT_THROTTLED':resp.status===401?'MICROSOFT_REAUTHORIZE':resp.status===403?'MICROSOFT_ACCESS_DENIED':resp.status===404?'MICROSOFT_NOT_FOUND':'MICROSOFT_GRAPH_FAILED');e.status=resp.status;throw e;}return resp.json();}
function itemPath(id){if(id==='root')return '/me/drive/root';if(!ID.test(id))throw Error('INVALID_ITEM_ID');return `/me/drive/items/${esc(id)}`;}
export async function browseDrive(env,id='root'){
 const path=`${itemPath(id)}/children?$top=100&$select=id,name,size,file,folder,parentReference,lastModifiedDateTime,webUrl`;
 const j=await graph(env,path);
 return {items:(j.value||[]).map(x=>({id:x.id,name:x.name,size:x.size||0,folder:!!x.folder,mime_type:x.file?.mimeType||null,updated_at:x.lastModifiedDateTime||null})),truncated:!!j['@odata.nextLink'],message:j['@odata.nextLink']?'仅显示前100项。文件较多时请进入子文件夹或整理目录。':null};
}
export async function publishDriveFile(env,id){if(!ID.test(id))throw Error('INVALID_ITEM_ID');const j=await graph(env,itemPath(id)+'?$select=id,name,size,file,folder,parentReference,eTag');if(!j.file||j.folder||!j.id||!j.parentReference?.driveId)throw Error('FILE_REQUIRED');
 const linkId=randomId();await execute(dbFromEnv(env),`INSERT INTO onedrive_drive_publications(id,drive_id,item_id,file_name,created_at,status) VALUES(?,?,?,?,CURRENT_TIMESTAMP,'active')`,[linkId,j.parentReference.driveId,j.id,j.name||'file']);
 return {id:linkId,url:`/r/${linkId}`,name:j.name,size:j.size||0,warning:'此链接允许任何持有者使用管理员授权下载该文件。撤销后失效；不得用于不应公开的资料。'};
}
export async function listPublications(env){const rows=await many(dbFromEnv(env),`SELECT id,file_name,created_at,status,access_count,last_error FROM onedrive_drive_publications ORDER BY created_at DESC LIMIT 100`);return {items:rows.map(r=>({...r,url:`/r/${r.id}`}))};}
export async function revokePublication(env,id){if(!FIXED.test(id))throw Error('INVALID_PUBLICATION_ID');const r=await execute(dbFromEnv(env),`UPDATE onedrive_drive_publications SET status='revoked',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`,[id]);return {revoked:!!r.meta?.changes};}
export async function driveFileAdminRoute(req,env,path){const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);if(user.role!=='super_admin')return error('FORBIDDEN','仅超级管理员可操作',403);
 try{
 if(path==='/api/v1/admin/onedrive/drive/items'&&req.method==='GET'){const id=new URL(req.url).searchParams.get('parent')||'root';return ok(await browseDrive(env,id));}
 if(path==='/api/v1/admin/onedrive/drive/publish'&&req.method==='POST'){let j;try{j=await req.json();}catch{return error('INVALID_JSON','JSON 格式错误',400);}if(j?.confirm_public!==true)return error('CONFIRM_REQUIRED','必须明确确认公开分享权限',400);return ok(await publishDriveFile(env,j.item_id),201);}
 if(path==='/api/v1/admin/onedrive/drive/publications'&&req.method==='GET')return ok(await listPublications(env));
 const m=/^\/api\/v1\/admin\/onedrive\/drive\/publications\/(odf_[a-f0-9]{32})$/.exec(path);
 if(m&&req.method==='DELETE')return ok(await revokePublication(env,m[1]));
 return error('NOT_FOUND','接口不存在',404);
 }catch(e){const code=e.message||'ONEDRIVE_FAILED';return error(code,'OneDrive 请求失败：'+code,code==='MICROSOFT_THROTTLED'?429:code==='MICROSOFT_REAUTHORIZE'?401:code==='MICROSOFT_NOT_FOUND'?404:400);}
}
export async function redirectAuthorizedDriveFile(req,env,id){if(!['GET','HEAD'].includes(req.method))return new Response('Method Not Allowed',{status:405,headers});if(!FIXED.test(id))return new Response('Not Found',{status:404,headers});
 const db=dbFromEnv(env);const row=await one(db,'SELECT * FROM onedrive_drive_publications WHERE id=?',[id]);if(!row)return new Response('Not Found',{status:404,headers});if(row.status!=='active')return new Response('Gone',{status:410,headers});
 if(!ID.test(row.drive_id)||!ID.test(row.item_id))return new Response('Invalid record',{status:502,headers});
 try{const j=await graph(env,`/drives/${esc(row.drive_id)}/items/${esc(row.item_id)}`);if(!j.file||j.folder)return new Response('Source unavailable',{status:404,headers});
 const url=j['@microsoft.graph.downloadUrl'];if(!validMicrosoftDownloadUrl(url))return new Response('Download address unavailable',{status:503,headers:{...headers,'Retry-After':'60'}});
 if(req.method==='GET')await execute(db,`UPDATE onedrive_drive_publications SET access_count=access_count+1,last_accessed_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=? AND status='active'`,[id]);
 return new Response(null,{status:302,headers:{...headers,Location:url}});
 }catch(e){const status=e.status===404?404:e.status===429?503:e.status===401?503:e.status===403?403:502;return new Response('Source temporarily unavailable',{status,headers:{...headers,...(status===503?{'Retry-After':'60'}:{})}});}
}
