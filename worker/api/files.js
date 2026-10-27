import {one,many,execute,dbFromEnv} from '../services/database.js';
import {resolveUser,jsonBody} from '../services/auth.js';
import {spaceAccess,folderAccess,canFolder,canSpace,validName,uuid} from '../services/spaces.js';
import {folderAccessBatch} from '../services/permission-batch.js';
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
  // Sort expressions are constant allowlist entries: no user-supplied SQL identifiers.
  const sort=q.get('sort')||'name_asc',filter=q.get('filter')||'all';
  if(!['name_asc','name_desc','updated_desc','size_desc'].includes(sort)||!['all','images','videos','documents','other'].includes(filter))return error('INVALID_INPUT','排序或类型参数无效',400);
  const folderOrder=sort==='name_desc'?'name COLLATE NOCASE DESC,id DESC':sort==='updated_desc'?'updated_at DESC,id DESC':'name COLLATE NOCASE ASC,id ASC';
  const fileOrder={name_asc:'name COLLATE NOCASE ASC,id ASC',name_desc:'name COLLATE NOCASE DESC,id DESC',updated_desc:'updated_at DESC,id DESC',size_desc:'size_bytes DESC,id DESC'}[sort];
  let folders=[];
  if(filter==='all')folders=await many(db,`SELECT id,name,parent_id,created_at,updated_at FROM folders WHERE space_id=? AND parent_id IS ? AND deleted_at IS NULL ORDER BY ${folderOrder} LIMIT ? OFFSET ?`,[spaceId,parent,limit+1,offset]);
  const accessible=[],folderRights=await folderAccessBatch(db,user,folders.slice(0,limit).map(f=>f.id));
  for(const f of folders.slice(0,limit)){if(canFolder(folderRights.get(f.id),'read'))accessible.push(f)}
  const typeClause={all:'',images:" AND mime_type LIKE 'image/%'",videos:" AND mime_type LIKE 'video/%'",documents:" AND (mime_type='application/pdf' OR mime_type LIKE 'text/%' OR mime_type LIKE '%document%' OR mime_type LIKE '%spreadsheet%')",other:" AND mime_type NOT LIKE 'image/%' AND mime_type NOT LIKE 'video/%' AND mime_type!='application/pdf' AND mime_type NOT LIKE 'text/%' AND mime_type NOT LIKE '%document%' AND mime_type NOT LIKE '%spreadsheet%'"}[filter];
  const files=await many(db,`SELECT id,name,space_id,folder_id,size_bytes,mime_type,status,created_at,updated_at FROM files WHERE space_id=? AND folder_id IS ? AND deleted_at IS NULL AND status='ready' ${typeClause} ORDER BY ${fileOrder} LIMIT ? OFFSET ?`,[spaceId,parent,limit+1,offset]);
  return ok({folders:accessible,files:files.slice(0,limit),parent_id:parent,limit,offset,has_more:folders.length>limit||files.length>limit});
 }
 if(path==='/api/v1/search'&&method==='GET'){
  const sid=q.get('space_id'),term=(q.get('q')||'').trim();if(!idOK(sid)||term.length<1||new TextEncoder().encode(term).length>46)return error('INVALID_INPUT','搜索关键词需在 46 字节以内，以符合 D1 LIKE 限制',400);
  if(!await spaceAccess(db,user,sid))return invisible();const pattern='%'+term.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%';
  if(new TextEncoder().encode(pattern).length>50)return error('INVALID_INPUT','搜索关键词包含过多特殊字符',400);
  const fs=await many(db,"SELECT id,name,folder_id,size_bytes,mime_type,updated_at FROM files WHERE space_id=? AND status='ready' AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 100",[sid,pattern]);
  const folders=await many(db,"SELECT id,name,parent_id FROM folders WHERE space_id=? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 100",[sid,pattern]);
  const lookup=await folderAccessBatch(db,user,[...fs.map(f=>f.folder_id),...folders.map(f=>f.id)]);
  const checkedFiles=[];for(const f of fs){if(!f.folder_id||canFolder(lookup.get(f.folder_id),'read'))checkedFiles.push(f)}
  const checkedFolders=[];for(const f of folders){if(canFolder(lookup.get(f.id),'read'))checkedFolders.push(f)}
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
  const parentChanged=target!==f.parent_id;
  if(parentChanged){
   // Moving a directory changes inherited ACLs for the entire subtree.
   // Editors may rename directories but cannot silently expand access for
   // other members by moving a parent beneath a less restrictive folder.
   const role=await spaceAccess(db,user,f.space_id);
   if(role?.role!=='admin'||!await parentRight(db,user,f.space_id,f.parent_id,'delete'))return forbidden();
   if(b?.confirm_acl_change!==true)return error('ACL_CHANGE_CONFIRMATION_REQUIRED','移动文件夹将改变其子目录继承权限，请由空间管理员确认',409);
  }
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
   // A copy requires actual read rights. Moving between parents requires
   // delete rights at the old location, not only write rights at the target.
   if(op==='copy'&&!await fileRight(db,user,f,'read'))return forbidden();
   if(target!==f.folder_id&&!await fileRight(db,user,f,'delete'))return forbidden();
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
  const b=await jsonBody(req),files=b?.file_ids??[],folders=b?.folder_ids??[];
  if(!['move','copy'].includes(b?.operation)||!Array.isArray(files)||!Array.isArray(folders)||files.length+folders.length<1||files.length+folders.length>20||![...files,...folders].every(idOK)||new Set(files).size!==files.length||new Set(folders).size!==folders.length)return error('INVALID_INPUT','最多选择 20 个不同文件或文件夹',400);
  if(b.operation==='copy'&&folders.length)return error('UNSUPPORTED','批量复制目录暂不支持，请单独选择文件',400);
  if(b.target_folder_id!==null&&b.target_folder_id!==undefined&&!idOK(b.target_folder_id))return error('INVALID_INPUT','目标目录无效',400);
  const results=[];
  for(const [kind,ids] of [['file',files],['folder',folders]])for(const id of ids){
   const where=kind==='file'?`/api/v1/files/${id}/${b.operation}`:`/api/v1/folders/${id}`;
   const fake=new Request(req.url,{method:kind==='file'?'POST':'PATCH',headers:{'content-type':'application/json',cookie:req.headers.get('cookie')||'',origin:new URL(req.url).origin},body:JSON.stringify(kind==='file'?{target_folder_id:b.target_folder_id}: {parent_id:b.target_folder_id,confirm_acl_change:b.confirm_acl_change===true})});
   const res=await fileManagementRoute(fake,env,where);
   const parsed=await res.json();results.push({id,kind,status:res.status,success:res.ok,error:res.ok?null:parsed.error?.code});
  }
  return ok({results,partial_failure:results.some(x=>!x.success)});
 }
 return error('NOT_FOUND','接口不存在',404);
}
