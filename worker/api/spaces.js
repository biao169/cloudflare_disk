import {one,many,execute,dbFromEnv} from '../services/database.js';
import {resolveUser,jsonBody} from '../services/auth.js';
import {isAdmin,validName,uuid,ensurePersonal,visibleSpaces,spaceAccess,folderAccess,canSpace,canFolder} from '../services/spaces.js';
import {ok,error} from '../utils/response.js';
const deny=()=>error('UNAUTHORIZED','请先登录',401);
const no=()=>error('NOT_FOUND','空间或目录不存在，或无权访问',404);
const forbidden=()=>error('FORBIDDEN','没有操作权限',403);
const validId=id=>/^[0-9a-f-]{36}$/.test(id||'');
export async function spacesRoute(req,env,path){
 const user=await resolveUser(req,env);if(!user)return deny();
 const db=dbFromEnv(env), method=req.method;
 if(path==='/api/v1/spaces'&&method==='GET')return ok({items:await visibleSpaces(db,user)});
 if(path==='/api/v1/spaces'&&method==='POST'){
  if(!isAdmin(user))return forbidden();const b=await jsonBody(req);if(!validName(b?.name))return error('INVALID_INPUT','空间名称不合法',400);
  const id=uuid();await execute(db,"INSERT INTO spaces(id,name,type,owner_id) VALUES(?,?,'team',?)",[id,b.name.trim(),user.id]);
  await execute(db,"INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,'admin')",[id,user.id]);return ok({id,name:b.name.trim()},201);
 }
 const sid=path.match(/^\/api\/v1\/spaces\/([0-9a-f-]{36})(?:\/(members))?(?:\/([0-9a-f-]{36}))?$/);
 if(sid){
  const id=sid[1],sub=sid[2],uid=sid[3],access=await spaceAccess(db,user,id);if(!access)return no();
  if(!sub&&method==='GET')return ok({space:access.space,role:access.role});
  if(!sub&&method==='PATCH'){
   if(access.role!=='admin'||access.space.type!=='team')return forbidden();const b=await jsonBody(req);if(!validName(b?.name))return error('INVALID_INPUT','名称不合法',400);
   await execute(db,'UPDATE spaces SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[b.name.trim(),id]);return ok({id,name:b.name.trim()});
  }
  if(sub==='members'&&!uid&&method==='GET'){
   if(access.role!=='admin')return forbidden();
   return ok({items:await many(db,'SELECT u.id,u.username,u.status,m.role FROM space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? ORDER BY u.username',[id])});
  }
  if(sub==='members'&&uid&&method==='PUT'){
   if(access.role!=='admin'||access.space.type!=='team')return forbidden();const b=await jsonBody(req);
   if(!['admin','editor','viewer'].includes(b?.role))return error('INVALID_INPUT','成员角色不合法',400);
   const target=await one(db,"SELECT id,status FROM users WHERE id=?",[uid]);if(!target||target.status!=='active')return error('INVALID_USER','成员不存在或已停用',404);
   await execute(db,'INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,?) ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role',[id,uid,b.role]);return ok({user_id:uid,role:b.role});
  }
  if(sub==='members'&&uid&&method==='DELETE'){
   if(access.role!=='admin'||access.space.type!=='team')return forbidden();if(uid===access.space.owner_id)return error('OWNER_REQUIRED','不能移除空间所有者',409);
   await execute(db,'DELETE FROM space_members WHERE space_id=? AND user_id=?',[id,uid]);return ok({removed:true});
  }
 }
 if(path==='/api/v1/folders'&&method==='POST'){
  const b=await jsonBody(req);if(!validId(b?.space_id)||!validName(b?.name))return error('INVALID_INPUT','文件夹参数不合法',400);
  const a=await spaceAccess(db,user,b.space_id);if(!a)return no();if(!canSpace(a,'write'))return forbidden();
  if(b.parent_id){const parent=await folderAccess(db,user,b.parent_id);if(!parent||parent.folder.space_id!==b.space_id)return no();if(!canFolder(parent,'write'))return forbidden();}
  const id=uuid();await execute(db,'INSERT INTO folders(id,space_id,parent_id,name) VALUES(?,?,?,?)',[id,b.space_id,b.parent_id||null,b.name.trim()]);return ok({id,name:b.name.trim()},201);
 }
 const candidates=path.match(/^\/api\/v1\/spaces\/([0-9a-f-]{36})\/candidates$/);
 if(candidates&&method==='GET'){
  const access=await spaceAccess(db,user,candidates[1]);if(!access)return no();if(access.role!=='admin')return forbidden();
  const q=(new URL(req.url).searchParams.get('q')||'').trim();if(q.length<2||q.length>40)return error('INVALID_INPUT','搜索至少输入两个字符',400);
  return ok({items:await many(db,"SELECT id,username FROM users WHERE status='active' AND username LIKE ? ESCAPE '\\' LIMIT 15",['%'+q.replaceAll('%','\\%').replaceAll('_','\\_')+'%'])});
 }
 const content=path.match(/^\/api\/v1\/spaces\/([0-9a-f-]{36})\/contents$/);
 if(content&&method==='GET'){
  const a=await spaceAccess(db,user,content[1]);if(!a)return no();
  const parent=new URL(req.url).searchParams.get('parent_id');
  if(parent){const f=await folderAccess(db,user,parent);if(!f||f.folder.space_id!==content[1]||!canFolder(f,'read'))return no();}
  const folders=await many(db,'SELECT id,name,parent_id,created_at FROM folders WHERE space_id=? AND parent_id IS ? AND deleted_at IS NULL ORDER BY name LIMIT 200',[content[1],parent||null]);
  const allowed=[];for(const folder of folders){const fa=await folderAccess(db,user,folder.id);if(canFolder(fa,'read'))allowed.push(folder);}
  return ok({folders:allowed,files:[],parent_id:parent||null});
 }
 const perms=path.match(/^\/api\/v1\/folders\/([0-9a-f-]{36})\/permissions$/);
 if(perms&&(method==='GET'||method==='PUT')){
  const f=await folderAccess(db,user,perms[1]);if(!f)return no();const a=await spaceAccess(db,user,f.folder.space_id);if(a.role!=='admin')return forbidden();
  if(method==='GET')return ok({items:await many(db,'SELECT id,principal_type,principal_id,permission_mask FROM folder_permissions WHERE folder_id=?',[perms[1]])});
  const b=await jsonBody(req);if(!['user','role'].includes(b?.principal_type)||!Number.isInteger(b?.permission_mask)||b.permission_mask<0||b.permission_mask>31)return error('INVALID_INPUT','权限参数不合法',400);
  if(b.principal_type==='role'&&!['editor','viewer'].includes(b.principal_id))return error('INVALID_INPUT','角色不存在',400);
  if(b.principal_type==='user'&&!(await one(db,'SELECT id FROM space_members WHERE space_id=? AND user_id=?',[f.folder.space_id,b.principal_id])))return error('INVALID_INPUT','用户不是空间成员',400);
  await execute(db,'INSERT INTO folder_permissions(id,folder_id,principal_type,principal_id,permission_mask) VALUES(?,?,?,?,?) ON CONFLICT(folder_id,principal_type,principal_id) DO UPDATE SET permission_mask=excluded.permission_mask',[uuid(),perms[1],b.principal_type,b.principal_id,b.permission_mask]);return ok({updated:true});
 }
 return error('NOT_FOUND','接口不存在',404);
}
