// RC14.10: public, explicit OneDrive folder snapshots / custom collections.
// All file identifiers are verified via the administrator's Graph authorization BEFORE publication.
// A group is a static snapshot, not a public Graph proxy or an automatic directory mirror.
import {dbFromEnv,one,many,batch,execute} from './database.js';
import {getAccessToken} from './onedrive-oauth.js';
import {validGraphNextLink} from './onedrive-browser.js';
import {publishDriveFile} from './onedrive-drive-files.js';
import {ok,error} from '../utils/response.js';
import {resolveUser,jsonBody} from './auth.js';
import {authorizeShare,countView} from './onedrive-share-policy.js';

const GRAPH='https://graph.microsoft.com/v1.0';
const ITEM_ID=/^[A-Za-z0-9_!.-]{1,220}$/;
export const GROUP_ID=/^odg_[a-f0-9]{32}$/;
const ENTRY_ID=/^ode_[a-f0-9]{32}$/;
const MAX_INPUT=30,MAX_ENTRIES=180,MAX_DEPTH=8,MAX_PAGES=20;
const HEADERS={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const rand=prefix=>prefix+Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
const validText=(text,max)=>typeof text==='string'&&text.trim().length>0&&text.length<=max&&!/[\u0000-\u001f\u007f]/.test(text);
const validDesc=text=>text===undefined||text===null||(typeof text==='string'&&text.length<=1200&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text));
export function validateGroupRequest(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_INPUT');
 if(body.confirm_public!==true)throw Error('CONFIRM_REQUIRED');
 if(!['folder','collection'].includes(body.kind)||!validText(body.title,140)||!validDesc(body.description))throw Error('INVALID_INPUT');
 if(!Array.isArray(body.item_ids)||body.item_ids.length<1||body.item_ids.length>MAX_INPUT||body.item_ids.some(x=>typeof x!=='string'||!ITEM_ID.test(x)))throw Error('INVALID_INPUT');
 if(new Set(body.item_ids).size!==body.item_ids.length)throw Error('DUPLICATE_ITEM');
 if(body.kind==='folder'&&body.item_ids.length!==1)throw Error('FOLDER_SELECTION_REQUIRED');
 if(body.sync_mode&&body.sync_mode!=='snapshot')throw Error('AUTOMATIC_SYNC_NOT_SUPPORTED');
 return {kind:body.kind,title:body.title.trim(),description:(body.description||'').trim()||null,item_ids:body.item_ids};
}
function graphError(response){const e=new Error(response.status===429||response.status===503?'MICROSOFT_THROTTLED':response.status===401?'MICROSOFT_REAUTHORIZE':response.status===403?'MICROSOFT_ACCESS_DENIED':response.status===404?'MICROSOFT_NOT_FOUND':'MICROSOFT_GRAPH_FAILED');e.status=response.status;const value=response.headers.get('Retry-After');e.retryAfter=/^\d{1,4}$/.test(value||'')?Math.min(3600,Number(value)):60;return e;}
export function validateGroupNextLink(next){
 // Only follow the signed-in user's children listing, and never arbitrary URLs from Graph responses.
 return validGraphNextLink(next)&&/\/children$/.test(new URL(next).pathname);
}
async function client(env){const token=await getAccessToken(env);let pages=0;
 return async function read(url){
  if(!url.startsWith(GRAPH+'/me/drive/')&&!validateGroupNextLink(url))throw Error('UNSAFE_GRAPH_URL');
  if(++pages>MAX_PAGES+MAX_INPUT)throw Error('GRAPH_PAGE_LIMIT');
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw graphError(r);
  const j=await r.json();if(!j||typeof j!=='object')throw Error('INVALID_GRAPH_RESPONSE');return j;
 };
}
function graphFile(item){return !!item?.file&&!item?.folder&&!item?.remoteItem&&ITEM_ID.test(item?.id)&&ITEM_ID.test(item?.parentReference?.driveId)&&typeof item.name==='string'&&item.name.length<=255;}
function graphFolder(item){return !!item?.folder&&!item?.remoteItem&&ITEM_ID.test(item?.id)&&typeof item.name==='string'&&item.name.length<=255;}
function fileNode(item,parent){return {id:rand('ode_'),parent_id:parent,name:item.name,type:'file',publication_id:rand('odf_'),drive_id:item.parentReference.driveId,item_id:item.id,size:Number.isSafeInteger(item.size)&&item.size>=0?item.size:null,mime:item.file.mimeType||null,modified:item.lastModifiedDateTime||null};}
function folderNode(item,parent){return {id:rand('ode_'),parent_id:parent,name:item.name,type:'folder',publication_id:null};}
function checkSize(items){if(items.length>MAX_ENTRIES)throw Error('SNAPSHOT_TOO_LARGE');}
export async function collectSnapshot(read,{kind,item_ids}){
 const items=[];let pages=0;
 async function walkFolder(folder,parent,depth){
  if(depth>MAX_DEPTH)throw Error('FOLDER_DEPTH_LIMIT');
  const directory=folderNode(folder,parent);items.push(directory);checkSize(items);
  let next=`${GRAPH}/me/drive/items/${encodeURIComponent(folder.id)}/children?$top=100&$select=id,name,size,folder,file,remoteItem,parentReference,lastModifiedDateTime`;
  while(next){
   if(++pages>MAX_PAGES)throw Error('GRAPH_PAGE_LIMIT');
   if(!validateGroupNextLink(next))throw Error('UNSAFE_GRAPH_URL');
   const data=await read(next);if(!Array.isArray(data.value))throw Error('INVALID_GRAPH_RESPONSE');
   for(const item of data.value){
    if(graphFolder(item))await walkFolder(item,directory.id,depth+1);
    else if(graphFile(item)){items.push(fileNode(item,directory.id));checkSize(items);}
    else throw Error('UNSUPPORTED_DRIVE_ITEM');
   }
   next=data['@odata.nextLink']||null;
  }
 }
 for(const id of item_ids){
  const item=await read(`${GRAPH}/me/drive/items/${encodeURIComponent(id)}?$select=id,name,size,folder,file,remoteItem,parentReference,lastModifiedDateTime`);
  if(graphFile(item)&&kind==='collection'){items.push(fileNode(item,null));checkSize(items);}
  else if(graphFolder(item))await walkFolder(item,null,1);
  else throw Error(kind==='folder'?'FOLDER_SELECTION_REQUIRED':'UNSUPPORTED_DRIVE_ITEM');
 }
 // Preserve separate folder paths; two selections may have overlapping contents.
 // Empty folders are still valid static snapshots; they expose no file permissions.
 return items;
}
function bulk(db,table,columns,rows){const statements=[];for(let i=0;i<rows.length;i+=20){const part=rows.slice(i,i+20);const sql=`INSERT INTO ${table}(${columns.join(',')}) VALUES ${part.map(()=>'('+columns.map(()=>'?').join(',')+')').join(',')}`;statements.push(db.prepare(sql).bind(...part.flatMap(r=>columns.map(c=>r[c]??null))));}return statements;}
export async function createGroup(env,body){
 const data=validateGroupRequest(body),read=await client(env);
 const entries=await collectSnapshot(read,data);const id=rand('odg_'),db=dbFromEnv(env);
 const files=entries.filter(x=>x.type==='file');const folders=entries.length-files.length;
 const group=db.prepare('INSERT INTO onedrive_share_groups(id,kind,title,description,source_item_id,item_count,folder_count) VALUES(?,?,?,?,?,?,?)').bind(id,data.kind,data.title,data.description,data.kind==='folder'?data.item_ids[0]:null,files.length,folders);
 const pubs=files.map(x=>({id:x.publication_id,drive_id:x.drive_id,item_id:x.item_id,file_name:x.name,file_size:x.size,file_mime:x.mime,file_modified_at:x.modified,group_id:id}));
 const snapshots=entries.map((x,position)=>({id:x.id,group_id:id,parent_id:x.parent_id,name:x.name,entry_type:x.type,publication_id:x.publication_id,file_size:x.size??null,mime_type:x.mime??null,modified_at:x.modified??null,position}));
 await batch(db,[group,
  ...bulk(db,'onedrive_drive_publications',['id','drive_id','item_id','file_name','file_size','file_mime','file_modified_at','group_id'],pubs),
  ...bulk(db,'onedrive_share_group_entries',['id','group_id','parent_id','name','entry_type','publication_id','file_size','mime_type','modified_at','position'],snapshots)]);
 return {id,kind:data.kind,title:data.title,item_count:files.length,folder_count:folders,share_url:`/s/${id}`,sync_mode:'snapshot',warning:'已创建静态快照；OneDrive 后续新增的文件不会自动公开。群组撤销后其文件直链同步失效。'};
}
export async function batchPublish(env,body){
 if(!body||body.confirm_public!==true)throw Error('CONFIRM_REQUIRED');
 const ids=body.item_ids;
 if(!Array.isArray(ids)||ids.length<1||ids.length>25||ids.some(x=>typeof x!=='string'||!ITEM_ID.test(x))||new Set(ids).size!==ids.length)throw Error('INVALID_INPUT');
 const results=[];let throttled=false;
 for(const item_id of ids){
  if(throttled){results.push({item_id,success:false,error:'SKIPPED_MICROSOFT_THROTTLE'});continue;}
  try{const item=await publishDriveFile(env,item_id);results.push({item_id,success:true,...item});}
  catch(e){if(e.message==='MICROSOFT_THROTTLED')throttled=true;results.push({item_id,success:false,error:e.message==='FILE_REQUIRED'?'FILE_REQUIRED':e.message?.startsWith('MICROSOFT_')?e.message:'PUBLISH_FAILED'});}
 }
 return {total:results.length,succeeded:results.filter(r=>r.success).length,failed:results.filter(r=>!r.success).length,results,partial:results.some(r=>!r.success),throttled};
}
export async function listGroups(env){const rows=await many(dbFromEnv(env),`SELECT id,kind,title,description,status,is_paused,access_mode,expires_at,max_views,max_downloads,view_count,download_count,password_hash IS NOT NULL AS password_protected,item_count,folder_count,created_at,revoked_at FROM onedrive_share_groups ORDER BY created_at DESC,id DESC LIMIT 100`);
 return {items:rows.map(x=>({...x,share_url:`/s/${x.id}`,sync_mode:'snapshot'}))};}
export async function revokeGroup(env,id){if(!GROUP_ID.test(id))throw Error('INVALID_GROUP_ID');const db=dbFromEnv(env);
 const result=await batch(db,[db.prepare("UPDATE onedrive_share_groups SET status='revoked',revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").bind(id),db.prepare("UPDATE onedrive_drive_publications SET status='revoked',updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND status='active'").bind(id)]);
 return {revoked:!!result[0]?.meta?.changes};
}
export async function updateGroup(env,id,body){if(!GROUP_ID.test(id))throw Error('INVALID_GROUP_ID');
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['title','description'].includes(k))||!Object.keys(body).length)throw Error('INVALID_INPUT');
 if(body.title!==undefined&&!validText(body.title,140)||!validDesc(body.description))throw Error('INVALID_INPUT');
 const sql=[];const args=[];if(body.title!==undefined){sql.push('title=?');args.push(body.title.trim());}if(body.description!==undefined){sql.push('description=?');args.push(body.description?.trim()||null);}
 const res=await execute(dbFromEnv(env),`UPDATE onedrive_share_groups SET ${sql.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`,[...args,id]);if(!res.meta?.changes)throw Error('NOT_FOUND');return {updated:true};
}
export async function publicGroup(env,id){if(!GROUP_ID.test(id))throw Error('INVALID_GROUP_ID');const db=dbFromEnv(env);
 const group=await one(db,'SELECT * FROM onedrive_share_groups WHERE id=?',[id]);
 if(!group)return {status:404};if(group.status!=='active')return {status:410};
 // D1-only metadata; never expose access tokens, OneDrive item/drive IDs, or temporary downloads.
 const rows=await many(db,`SELECT e.id,e.parent_id,e.name,e.entry_type,e.publication_id,e.file_size,e.mime_type,e.modified_at,p.status AS file_status
  FROM onedrive_share_group_entries e LEFT JOIN onedrive_drive_publications p ON p.id=e.publication_id
  WHERE e.group_id=? ORDER BY e.position ASC`,[id]);
 return {status:200,data:{id:group.id,kind:group.kind,title:group.title,description:group.description||'',created_at:group.created_at,item_count:group.item_count,folder_count:group.folder_count,sync_mode:'snapshot',show_direct_link:group.show_direct_link!==0,
  entries:rows.filter(x=>x.entry_type==='folder'||x.file_status==='active').map(x=>({id:x.id,parent_id:x.parent_id,name:x.name,type:x.entry_type,size:x.file_size??null,mime_type:x.mime_type,updated_at:x.modified_at,share_url:x.entry_type==='file'?`/s/${x.publication_id}`:null,download_url:x.entry_type==='file'?`/r/${x.publication_id}`:null}))}};
}
export async function adminGroupRoute(req,env,path){const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);if(user.role!=='super_admin')return error('FORBIDDEN','仅超级管理员可操作',403);
 try{
  if(path==='/api/v1/admin/onedrive/drive/batch-publish'&&req.method==='POST'){const result=await batchPublish(env,await jsonBody(req));return ok(result,result.failed?207:200);}
  if(path==='/api/v1/admin/onedrive/groups'&&req.method==='POST')return ok(await createGroup(env,await jsonBody(req)),201);
  if(path==='/api/v1/admin/onedrive/groups'&&req.method==='GET')return ok(await listGroups(env));
  const m=/^\/api\/v1\/admin\/onedrive\/groups\/(odg_[a-f0-9]{32})$/.exec(path);
  if(m&&req.method==='DELETE')return ok(await revokeGroup(env,m[1]));
  if(m&&req.method==='PATCH')return ok(await updateGroup(env,m[1],await jsonBody(req)));
  return error('NOT_FOUND','接口不存在',404);
 }catch(e){const code=e.message||'ONEDRIVE_GROUP_FAILED';const status=code==='MICROSOFT_THROTTLED'?429:code==='MICROSOFT_REAUTHORIZE'?401:code==='MICROSOFT_ACCESS_DENIED'?403:code==='MICROSOFT_NOT_FOUND'?404:code==='SNAPSHOT_TOO_LARGE'||code==='GRAPH_PAGE_LIMIT'||code==='FOLDER_DEPTH_LIMIT'?413:code==='MICROSOFT_GRAPH_FAILED'?502:400;
  return new Response(JSON.stringify({success:false,error:{code,message:{SNAPSHOT_TOO_LARGE:'文件夹超过本版本 180 项上限，请拆分分享。',GRAPH_PAGE_LIMIT:'目录页数超过当前安全限制。',FOLDER_DEPTH_LIMIT:'目录嵌套层级超过 8 层。',CONFIRM_REQUIRED:'请确认该分享将对持有链接的访客开放。'}[code]||'OneDrive 分享操作失败：'+code}}),{status,headers:{...HEADERS,'Content-Type':'application/json; charset=utf-8',...(status===429?{'Retry-After':String(e.retryAfter||60)}:{})}});
 }
}
export async function publicGroupRoute(req,env,path){if(!['GET','HEAD'].includes(req.method))return error('METHOD_NOT_ALLOWED','请求方法不支持',405);
 const match=/^\/api\/v1\/public\/onedrive\/groups\/(odg_[a-f0-9]{32})$/.exec(path);if(!match)return error('NOT_FOUND','链接不存在',404);
 const group=await one(dbFromEnv(env),'SELECT * FROM onedrive_share_groups WHERE id=?',[match[1]]);
 const allowed=await authorizeShare(req,env,group,{checkViewLimit:true});if(!allowed.allowed)return allowed.response;
 if(req.method==='GET'&&!(await countView(env,group)))return error('VIEW_LIMIT_REACHED','页面浏览次数已达上限',429);
 const result=await publicGroup(env,match[1]);if(result.status===404)return error('NOT_FOUND','分享不存在',404);if(result.status===410)return error('GONE','分享已撤销',410);
 return req.method==='HEAD'?new Response(null,{status:200,headers:HEADERS}):ok(result.data);
}
