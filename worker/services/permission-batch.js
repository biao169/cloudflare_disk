// RC11: bounded authorization snapshots for list/search operations.
// Never cache across HTTP requests: membership and folder ACL revocations must
// take effect at the next request. D1 Free limits 50 queries per invocation
// and 100 bound parameters per SQL statement.
import {many} from './database.js';
import {isAdmin} from './spaces.js';

export const ACL_BATCH_SIZE=40;
const chunks=(ids)=>{const out=[];for(let i=0;i<ids.length;i+=ACL_BATCH_SIZE)out.push(ids.slice(i,i+ACL_BATCH_SIZE));return out;};
const unique=ids=>[...new Set(ids.filter(x=>typeof x==='string'&&x.length>0))];
const inClause=n=>Array(n).fill('?').join(',');

export async function spaceAccessBatch(db,user,spaceIds){
 const result=new Map();const ids=unique(spaceIds);
 if(!user||user.status==='disabled')return result;
 for(const group of chunks(ids)){
  const rows=await many(db,`SELECT s.id,s.owner_id,m.role AS member_role FROM spaces s
    LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=?
    WHERE s.id IN (${inClause(group.length)})`,[user.id,...group]);
  for(const row of rows){
   const role=isAdmin(user)||row.owner_id===user.id?'admin':row.member_role;
   if(role)result.set(row.id,{role});
  }
 }
 return result;
}

export async function folderAccessBatch(db,user,folderIds){
 const result=new Map(),ids=unique(folderIds);
 if(!user||user.status==='disabled')return result;
 for(const group of chunks(ids)){
  // Walk all requested folders with one recursive SQL statement, joining the
  // requesting user's membership and both (user/role) ACL principals.
  const rows=await many(db,`WITH RECURSIVE chain(requested_id,ancestor_id,depth,space_id) AS (
     SELECT id,id,0,space_id FROM folders WHERE id IN (${inClause(group.length)}) AND deleted_at IS NULL
     UNION ALL
     SELECT c.requested_id,p.id,c.depth+1,c.space_id
       FROM chain c JOIN folders child ON child.id=c.ancestor_id
       JOIN folders p ON p.id=child.parent_id AND p.space_id=c.space_id AND p.deleted_at IS NULL
       WHERE c.depth<100
   ) SELECT c.requested_id,c.depth,f.id,f.parent_id,f.space_id,s.owner_id,
       m.role AS member_role,ug.permission_mask AS user_mask,rg.permission_mask AS role_mask
     FROM chain c JOIN folders f ON f.id=c.ancestor_id
     JOIN spaces s ON s.id=f.space_id
     LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=?
     LEFT JOIN folder_permissions ug ON ug.folder_id=f.id AND ug.principal_type='user' AND ug.principal_id=?
     LEFT JOIN folder_permissions rg ON rg.folder_id=f.id AND rg.principal_type='role' AND rg.principal_id=m.role
     ORDER BY c.requested_id,c.depth`,[...group,user.id,user.id]);
  const grouped=new Map();for(const row of rows){if(!grouped.has(row.requested_id))grouped.set(row.requested_id,[]);grouped.get(row.requested_id).push(row);}
  for(const [id,path] of grouped){
   const root=path[0],role=isAdmin(user)||root.owner_id===user.id?'admin':root.member_role;
   if(!role)continue;
   // Refuse broken/cyclic/deleted ancestor chains, including depth cutoff.
   if(role!=='admin'&&(path.at(-1).parent_id!==null||path.some((p,i)=>i>0&&(path[i-1].parent_id!==p.id||p.space_id!==root.space_id))))continue;
   let mask=role==='admin'?31:role==='editor'?15:1;
   if(role!=='admin')for(const step of path){
    if(step.user_mask!==null){mask=step.user_mask;break;}
    if(step.role_mask!==null){mask=step.role_mask;break;}
   }
   result.set(id,{folder:{id:root.id,space_id:root.space_id,parent_id:root.parent_id},mask,role});
  }
 }
 return result;
}
