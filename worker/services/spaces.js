import {one,many,execute} from './database.js';
export const uuid=()=>crypto.randomUUID();
export const isAdmin=u=>u?.role==='super_admin';
export const validName=n=>typeof n==='string'&&n.trim().length>=1&&n.trim().length<=100&&!/[\x00-\x1f/\\]/.test(n);
export const permissions={read:1,write:2,delete:4,share:8,manage:16};
export async function ensurePersonal(db,user){
 let s=await one(db,"SELECT * FROM spaces WHERE owner_id=? AND type='personal'",[user.id]);if(s)return s;
 const id=uuid();await execute(db,"INSERT OR IGNORE INTO spaces(id,name,type,owner_id) VALUES(?,'个人空间','personal',?)",[id,user.id]);
 return one(db,"SELECT * FROM spaces WHERE owner_id=? AND type='personal'",[user.id]);
}
export async function visibleSpaces(db,user){
 await ensurePersonal(db,user);
 return many(db,`SELECT s.id,s.name,s.type,s.owner_id,s.quota_bytes,s.used_bytes,s.created_at,
 CASE WHEN s.owner_id=? THEN 'owner' ELSE m.role END AS membership_role
 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=?
 WHERE s.owner_id=? OR m.user_id=? OR ?=1 ORDER BY CASE s.type WHEN 'personal' THEN 0 ELSE 1 END,s.name`,[user.id,user.id,user.id,user.id,isAdmin(user)?1:0]);
}
export async function spaceAccess(db,user,spaceId){
 if(!user||user.status==='disabled')return null;
 const space=await one(db,'SELECT * FROM spaces WHERE id=?',[spaceId]);if(!space)return null;
 if(isAdmin(user)||space.owner_id===user.id)return {space,role:'admin'};
 const member=await one(db,'SELECT role FROM space_members WHERE space_id=? AND user_id=?',[spaceId,user.id]);return member?{space,role:member.role}:null;
}
export async function folderAccess(db,user,folderId){
 const folder=await one(db,'SELECT * FROM folders WHERE id=? AND deleted_at IS NULL',[folderId]);if(!folder)return null;
 const access=await spaceAccess(db,user,folder.space_id);if(!access)return null;
 if(access.role==='admin')return {folder,mask:31};
 let mask=access.role==='editor'?15:1;let cursor=folder;const seen=new Set();
 while(cursor){
  if(seen.has(cursor.id))return null;seen.add(cursor.id);
  // Nearest matching ACL entry overrides inherited mask; user ACL wins over role ACL.
  const grants=await many(db,`SELECT principal_type,principal_id,permission_mask FROM folder_permissions WHERE folder_id=? AND ((principal_type='user' AND principal_id=?) OR (principal_type='role' AND principal_id=?))`,[cursor.id,user.id,access.role]);
  const own=grants.find(g=>g.principal_type==='user');const group=grants.find(g=>g.principal_type==='role');
  if(own||group){mask=(own||group).permission_mask;break;}
  if(cursor.parent_id){const parent=await one(db,'SELECT * FROM folders WHERE id=? AND space_id=? AND deleted_at IS NULL',[cursor.parent_id,folder.space_id]);if(!parent)return null;cursor=parent;}else cursor=null;
 }
 return {folder,mask};
}
export function canSpace(access,perm){return Boolean(access&&(access.role==='admin'||(access.role==='editor'&&perm!=='manage')||(access.role==='viewer'&&perm==='read')));}
export function canFolder(access,perm){return Boolean(access&&(access.mask&permissions[perm]));}
