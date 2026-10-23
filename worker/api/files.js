import {one,many,execute,dbFromEnv} from '../services/database.js';
import {resolveUser,jsonBody} from '../services/auth.js';
import {spaceAccess,folderAccess,canFolder,canSpace,validName,uuid} from '../services/spaces.js';
import {ok,error} from '../utils/response.js';
const idOK=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v);
const deny=()=>error('UNAUTHORIZED','请先登录',401);
const invisible=()=>error('NOT_FOUND','文件或文件夹不存在',404);
const forbidden=()=>error('FORBIDDEN','没有操作权限',403);
async function parentRight(db,user,spaceId,parentId,action){
 const s=await spaceAccess(db,user,spaceId);if(!s)return null;
 if(!parentId)return canSpace(s,action);
 const f=await folderAccess(db,user,parentId);if(!f||f.folder.space_id!==spaceId)return null;
 return canFolder(f,action);
}
async function fileRight(db,user,file,action){return parentRight(db,user,file.space_id,file.folder_id,action)}
async function folderTarget(db,user,folder,action){const f=await folderAccess(db,user,folder.id);return f&&canFolder(f,action)}
async function targetValid(db,user,spaceId,folderId){return parentRight(db,user,spaceId,folderId,'write')}
async function existsName(db,spaceId,parentId,name,skipId=null,kind='folder'){
 const table=kind==='folder'?'folders':'files';const column=kind==='folder'?'parent_id':'folder_id';
 return Boolean(await one(db,`SELECT id FROM ${table} WHERE space_id=? AND ${column} IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL AND id!=? LIMIT 1`,[spaceId,parentId,name,skipId||'']));
}
export async function fileManagementRoute(req,env,path){
 const user=await resolveUser(req,env);if(!user)return deny();const db=dbFromEnv(env),method=req.method,url=new URL(req.url),q=url.searchParams;
 const contents=path.match(/^\/api\/v1\/spaces\/([0-9a-f-]{36})\/contents$/);
 if(contents&&method==='GET'){
  const spaceId=contents[1],parent=q.get('parent_id')||null;
  if(parent&&!idOK(parent))return error('INVALID_INPUT','目录 ID 无效',400);
  if(!(await parentRight(db,user,spaceId,parent,'read')))return invisible();
  const limit=Math.min(100,Math.max(1,Number(q.get('limit'))||50));const offset=Math.min(10000,Math.max(0,Number(q.get('offset'))||0));
  const folders=await many(db,'SELECT id,name,parent_id,created_at,updated_at FROM folders WHERE space_id=? AND parent_id IS ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?',[spaceId,parent,limit,offset]);
  const accessible=[];for(const f of folders){const a=await folderAccess(db,user,f.id);if(canFolder(a,'read'))accessible.push(f)}
  const files=await many(db,"SELECT id,name,folder_id,size_bytes,mime_type,status,created_at,updated_at FROM files WHERE space_id=? AND folder_id IS ? AND deleted_at IS NULL AND status='ready' ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?",[spaceId,parent,limit,offset]);
  return ok({folders:accessible,files,parent_id:parent,limit,offset,has_more:folders.length===limit||files.length===limit});
 }
 if(path==='/api/v1/search'&&method==='GET'){
  const sid=q.get('space_id'),term=(q.get('q')||'').trim();if(!idOK(sid)||term.length<1||term.length>100)return error('INVALID_INPUT','搜索参数无效',400);
  if(!await spaceAccess(db,user,sid))return invisible();const pattern='%'+term.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%';
  const fs=await many(db,"SELECT id,name,folder_id,size_bytes,mime_type,updated_at FROM files WHERE space_id=? AND status='ready' AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 100",[sid,pattern]);
  const folders=await many(db,"SELECT id,name,parent_id FROM folders WHERE space_id=? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 100",[sid,pattern]);
  const checkedFiles=[];for(const f of fs){if(await parentRight(db,user,sid,f.folder_id,'read'))checkedFiles.push(f)}
  const checkedFolders=[];for(const f of folders){if(await folderTarget(db,user,f,'read'))checkedFolders.push(f)}
  return ok({files:checkedFiles,folders:checkedFolders});
 }
 if(path==='/api/v1/folders'&&method==='POST'){
  const b=await jsonBody(req);if(!idOK(b?.space_id)||!validName(b?.name)||b.parent_id&&!idOK(b.parent_id))return error('INVALID_INPUT','文件夹参数无效',400);
  const parent=b.parent_id||null;if(!await parentRight(db,user,b.space_id,parent,'write'))return forbidden();
  if(await existsName(db,b.space_id,parent,b.name.trim()))return error('NAME_CONFLICT','目标目录已有同名文件夹',409);
  const id=uuid();await execute(db,'INSERT INTO folders(id,space_id,parent_id,name) VALUES(?,?,?,?)',[id,b.space_id,parent,b.name.trim()]);return ok({id,name:b.name.trim()},201);
 }
 const folder=path.match(/^\/api\/v1\/folders\/([0-9a-f-]{36})$/);
 if(folder&&method==='PATCH'){
  const f=await one(db,'SELECT * FROM folders WHERE id=? AND deleted_at IS NULL',[folder[1]]);if(!f)return invisible();
  if(!await folderTarget(db,user,f,'write'))return forbidden();const b=await jsonBody(req);
  const name=b?.name===undefined?f.name:b.name;const target=b?.parent_id===undefined?f.parent_id:(b.parent_id||null);
  if(!validName(name)||target&&!idOK(target))return error('INVALID_INPUT','参数无效',400);
  if(!await targetValid(db,user,f.space_id,target))return forbidden();
  let cur=target;const visited=new Set();while(cur){if(cur===f.id)return error('DIRECTORY_CYCLE','不能把目录移入自身或子目录',409);if(visited.has(cur))return error('DIRECTORY_CYCLE','目录结构异常',409);visited.add(cur);const p=await one(db,'SELECT parent_id,space_id FROM folders WHERE id=? AND deleted_at IS NULL',[cur]);if(!p||p.space_id!==f.space_id)return invisible();cur=p.parent_id}
  if(await existsName(db,f.space_id,target,name.trim(),f.id))return error('NAME_CONFLICT','目标目录已有同名文件夹',409);
  await execute(db,'UPDATE folders SET name=?,parent_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[name.trim(),target,f.id]);return ok({id:f.id,name:name.trim(),parent_id:target});
 }
 const file=path.match(/^\/api\/v1\/files\/([0-9a-f-]{36})(?:\/(copy|move))?$/);
 if(file&&['GET','PATCH','POST'].includes(method)){
  const f=await one(db,"SELECT * FROM files WHERE id=? AND deleted_at IS NULL AND status='ready'",[file[1]]);if(!f)return invisible();
  const op=file[2];if(!op&&method==='GET'){if(!await fileRight(db,user,f,'read'))return invisible();return ok({file:{id:f.id,name:f.name,folder_id:f.folder_id,space_id:f.space_id,size_bytes:f.size_bytes,mime_type:f.mime_type,status:f.status,created_at:f.created_at,updated_at:f.updated_at}})}
  if(!await fileRight(db,user,f,'write'))return forbidden();const b=await jsonBody(req);
  if((!op&&method==='PATCH')||(op&&method==='POST')){
   const name=b?.name===undefined?f.name:b.name;const target=b?.target_folder_id===undefined?f.folder_id:(b.target_folder_id||null);
   if(!validName(name)||target&&!idOK(target))return error('INVALID_INPUT','参数无效',400);
   if(!await targetValid(db,user,f.space_id,target))return forbidden();
   if(await existsName(db,f.space_id,target,name.trim(),op==='copy'?null:f.id,'file'))return error('NAME_CONFLICT','同名文件已存在',409);
   if(op==='copy'){
    // Metadata shares the immutable storage object; R2 duplication/refcounting arrives in stage 6.
    const id=uuid();await execute(db,"INSERT INTO files(id,space_id,folder_id,name,object_id,size_bytes,mime_type,status,created_by) VALUES(?,?,?,?,?,?,?,'ready',?)",[id,f.space_id,target,name.trim(),f.object_id,f.size_bytes,f.mime_type,user.id]);return ok({id,name:name.trim(),metadata_only:true},201);
   }
   await execute(db,'UPDATE files SET folder_id=?,name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[target,name.trim(),f.id]);return ok({id:f.id,name:name.trim(),folder_id:target});
  }
 }
 if(path==='/api/v1/files/batch'&&method==='POST'){
  const b=await jsonBody(req);if(!['move','copy'].includes(b?.operation)||!Array.isArray(b?.file_ids)||b.file_ids.length<1||b.file_ids.length>100||!b.file_ids.every(idOK))return error('INVALID_INPUT','批量参数无效',400);
  if(new Set(b.file_ids).size!==b.file_ids.length)return error('INVALID_INPUT','存在重复文件 ID',400);
  const results=[];for(const id of b.file_ids){const sub=b.operation==='rename'?'':`/${b.operation}`;const fake=new Request(req.url,{method:sub?'POST':'PATCH',headers:{'content-type':'application/json',cookie:req.headers.get('cookie')||'',origin:new URL(req.url).origin},body:JSON.stringify({target_folder_id:b.target_folder_id,...(b.operation==='rename'?{name:b.name}:{})})});
   // Reuse the individual-file ACL checks; no implicit cross-space moves.
   const r=await fileManagementRoute(fake,env,`/api/v1/files/${id}${sub}`);results.push({id,status:r.status,success:r.status<300});}
  return ok({results,partial_failure:results.some(x=>!x.success)});
 }
 return error('NOT_FOUND','接口不存在',404);
}
