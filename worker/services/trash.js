import {one,many,execute,dbFromEnv} from './database.js';
import {spaceAccess,folderAccess,canFolder,canSpace,uuid,permissions} from './spaces.js';
import {ok,error} from '../utils/response.js';
import {settings} from './admin.js';
import {finishStorageCleanup} from './cleanup.js';
import {revokePublication} from './sharing.js';
const invalid=()=>error('NOT_FOUND','回收站项目不存在',404);
export const safeId=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v);
async function permitted(db,user,spaceId,folderId,action){const a=await spaceAccess(db,user,spaceId);if(!a)return false;return folderId?canFolder(await folderAccess(db,user,folderId),action):canSpace(a,action)}
async function folderTree(db,id){return many(db,`WITH RECURSIVE subtree(id,depth) AS (SELECT id,0 FROM folders WHERE id=? UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE s.depth<100) SELECT id,depth FROM subtree ORDER BY depth DESC`,[id]);}
async function fileTree(db,id){return many(db,`WITH RECURSIVE subtree(id,depth) AS (SELECT id,0 FROM folders WHERE id=? UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE s.depth<100) SELECT f.id,f.object_id,f.space_id,f.folder_id FROM files f JOIN subtree s ON f.folder_id=s.id`,[id]);}
// Limit a single free-tier Worker mutation to a manageable number of descendants.
export const MAX_TRASH_ITEMS=200;
async function activeFolderTree(db,id){return many(db,`WITH RECURSIVE subtree(id,depth) AS (
 SELECT id,0 FROM folders WHERE id=? AND deleted_at IS NULL
 UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.deleted_at IS NULL AND s.depth<100
) SELECT s.id,f.parent_id,s.depth FROM subtree s JOIN folders f ON f.id=s.id ORDER BY s.depth ASC LIMIT 202`,[id]);}
async function activeFileTree(db,id){return many(db,`WITH RECURSIVE subtree(id,depth) AS (
 SELECT id,0 FROM folders WHERE id=? AND deleted_at IS NULL
 UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.deleted_at IS NULL AND s.depth<100
) SELECT f.id,f.object_id,f.space_id,f.folder_id FROM files f JOIN subtree s ON f.folder_id=s.id
 WHERE f.deleted_at IS NULL AND f.status='ready' LIMIT 202`,[id]);}
const placeholders=n=>Array(n).fill('?').join(',');
// One ACL query for the whole active subtree. This avoids a D1 read for every
// descendant, which can exceed the free-tier request query budget.
async function subtreeDeleteAllowed(db,user,spaceId,folders){
 const space=await spaceAccess(db,user,spaceId);if(!space)return false;
 if(space.role==='admin')return true;
 if(!folders.length)return false;
 const root=await folderAccess(db,user,folders[0].id);
 if(!canFolder(root,'delete'))return false;
 const ids=folders.map(f=>f.id);
 const grants=await many(db,`SELECT folder_id,principal_type,permission_mask FROM folder_permissions
 WHERE folder_id IN (${placeholders(ids.length)}) AND
 ((principal_type='user' AND principal_id=?) OR (principal_type='role' AND principal_id=?))`,[...ids,user.id,space.role]);
 const byFolder=new Map();for(const row of grants){if(!byFolder.has(row.folder_id))byFolder.set(row.folder_id,[]);byFolder.get(row.folder_id).push(row);}
 const masks=new Map([[folders[0].id,root.mask]]);
 for(const f of folders.slice(1)){
  const entries=byFolder.get(f.id)||[];
  const own=entries.find(x=>x.principal_type==='user')||entries.find(x=>x.principal_type==='role');
  const inherited=masks.get(f.parent_id);
  if(inherited===undefined)return false;
  const mask=own?own.permission_mask:inherited;
  if(!(mask&permissions.delete))return false;
  masks.set(f.id,mask);
 }
 return true;
}
async function nestedTrashConflict(db,t){
 if(t.target_type!=='folder')return false;
 const conflicts=await one(db,`WITH RECURSIVE subtree(id) AS (
 SELECT id FROM folders WHERE id=? UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id
 ) SELECT id FROM trash_entries WHERE id!=? AND ((target_type='folder' AND target_id IN (SELECT id FROM subtree))
 OR (target_type='file' AND target_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM subtree)))) LIMIT 1`,[t.target_id,t.id]);
 return Boolean(conflicts);
}
async function canSeeTrash(db,user,t){
 const a=await spaceAccess(db,user,t.space_id);
 if(!a)return false;
 if(a.role==='admin')return true;
 return t.deleted_by===user.id&&await permitted(db,user,t.space_id,t.original_parent_id,'write');
}
export async function trashItem(env,user,type,id){const db=dbFromEnv(env);if(!['file','folder'].includes(type)||!safeId(id))return invalid();
 const table=type==='file'?'files':'folders',item=await one(db,`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`,[id]);if(!item)return invalid();
 const parent=type==='file'?item.folder_id:item.parent_id;if(!await permitted(db,user,item.space_id,parent,'delete'))return error('FORBIDDEN','没有删除权限',403);
 if(type==='folder'&&!await permitted(db,user,item.space_id,id,'delete'))return error('FORBIDDEN','没有目录删除权限',403);
 const retention=(await settings(db)).trash_retention_days;
 const trashId=uuid(),purgeAt=new Date(Date.now()+retention*86400000).toISOString().replace('T',' ').slice(0,19);
 const files=type==='file'?[item]:await activeFileTree(db,id),folders=type==='folder'?await activeFolderTree(db,id):[];
 if(folders.some(f=>f.depth>=100))return error('DIRECTORY_TOO_DEEP','目录层级过深，不能执行不完整删除',409);
 if(files.length+folders.length>MAX_TRASH_ITEMS)return error('TRASH_BATCH_LIMIT','该文件夹项目过多，请分批整理后删除',409);
 // A caller with permission at the parent may still be explicitly denied in a descendant.
 if(type==='folder'&&!await subtreeDeleteAllowed(db,user,item.space_id,folders))return error('FORBIDDEN','子目录存在无权删除的内容',403);
 // Revoke published copies before marking a private file as trashed.
 for(const f of files){const pubs=await many(db,"SELECT p.id,p.public_object_id,o.object_key FROM publications p JOIN storage_objects o ON o.id=p.public_object_id WHERE p.source_file_id=? AND p.status='ready'",[f.id]);for(const pub of pubs){try{if(!env.PUBLIC_BUCKET)throw new Error('PUBLIC_BUCKET binding missing');await revokePublication(env,db,pub);}catch(e){console.error('Failed revoking public object',e);return error('PUBLIC_REVOKE_FAILED','公开副本撤销失败，未继续执行删除',503)}}}
 const fileIds=files.map(f=>f.id),folderIds=folders.map(f=>f.id);
 const commands=[db.prepare('INSERT INTO trash_entries(id,target_type,target_id,space_id,original_parent_id,deleted_by,purge_at) VALUES(?,?,?,?,?,?,?)').bind(trashId,type,id,item.space_id,parent,user.id,purgeAt)];
 if(fileIds.length){
  const ph=placeholders(fileIds.length);
  commands.push(db.prepare(`INSERT INTO trash_entry_items(trash_id,item_type,item_id) SELECT ?, 'file',id FROM files WHERE id IN (${ph}) AND deleted_at IS NULL`).bind(trashId,...fileIds));
  commands.push(db.prepare(`UPDATE files SET status='trashed',deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id IN (${ph}) AND deleted_at IS NULL`).bind(...fileIds));
  commands.push(db.prepare(`UPDATE shares SET revoked_at=CURRENT_TIMESTAMP WHERE target_type='file' AND target_id IN (${ph}) AND revoked_at IS NULL`).bind(...fileIds));
 }
 if(folderIds.length){
  const ph=placeholders(folderIds.length);
  commands.push(db.prepare(`INSERT INTO trash_entry_items(trash_id,item_type,item_id) SELECT ?, 'folder',id FROM folders WHERE id IN (${ph}) AND deleted_at IS NULL`).bind(trashId,...folderIds));
  commands.push(db.prepare(`UPDATE folders SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id IN (${ph}) AND deleted_at IS NULL`).bind(...folderIds));
  commands.push(db.prepare(`UPDATE shares SET revoked_at=CURRENT_TIMESTAMP WHERE target_type='folder' AND target_id IN (${ph}) AND revoked_at IS NULL`).bind(...folderIds));
 }
 await db.batch(commands);
 return ok({trash_id:trashId,type,id,purge_at:purgeAt});
}
export async function listTrash(env,user,spaceId){const db=dbFromEnv(env);if(!safeId(spaceId)||!await spaceAccess(db,user,spaceId))return error('NOT_FOUND','空间不存在',404);
 const entries=await many(db,`SELECT t.id,t.target_type,t.target_id,t.space_id,t.deleted_at,t.purge_at,t.original_parent_id,t.deleted_by,
 CASE WHEN t.target_type='file' THEN (SELECT name FROM files WHERE id=t.target_id) ELSE (SELECT name FROM folders WHERE id=t.target_id) END AS name
 FROM trash_entries t WHERE t.space_id=? ORDER BY t.deleted_at DESC LIMIT 30`,[spaceId]);
 const allowed=[];for(const t of entries)if(await canSeeTrash(db,user,t))allowed.push(t);
 return ok({entries:allowed});}
async function entryFor(db,user,id){const t=await one(db,'SELECT * FROM trash_entries WHERE id=?',[id]);return t&&await canSeeTrash(db,user,t)?t:null;}
export async function restoreItem(env,user,id,targetId){const db=dbFromEnv(env),t=await entryFor(db,user,id);if(!t)return invalid();const table=t.target_type==='file'?'files':'folders';const item=await one(db,`SELECT * FROM ${table} WHERE id=?`,[t.target_id]);if(!item)return invalid();
 let parent=targetId===undefined?t.original_parent_id:targetId;if(parent&&!safeId(parent))return error('INVALID_INPUT','目标目录无效',400);
 if(parent){const p=await one(db,'SELECT * FROM folders WHERE id=? AND deleted_at IS NULL',[parent]);if(!p||p.space_id!==t.space_id)return error('RESTORE_PARENT_MISSING','原目录不可用，请指定其他目录',409);}
 if(!await permitted(db,user,t.space_id,parent,'write'))return error('FORBIDDEN','没有恢复权限',403);
 const same=await one(db,`SELECT id FROM ${table} WHERE space_id=? AND ${t.target_type==='file'?'folder_id':'parent_id'} IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1`,[t.space_id,parent,item.name]);if(same)return error('NAME_CONFLICT','目标位置存在同名项目',409);
 const snapshot=await many(db,'SELECT item_type,item_id FROM trash_entry_items WHERE trash_id=?',[id]);
 if(t.target_type==='folder'&&snapshot.length===0&&await nestedTrashConflict(db,t))return error('CHILD_TRASH_CONFLICT','旧版回收站存在独立删除的子项目，请先分别处理',409);
 const fileIds=snapshot.length?snapshot.filter(x=>x.item_type==='file').map(x=>x.item_id):(t.target_type==='file'?[item.id]:(await fileTree(db,item.id)).filter(f=>true).map(f=>f.id));
 const folderIds=snapshot.length?snapshot.filter(x=>x.item_type==='folder').map(x=>x.item_id):(t.target_type==='folder'?(await folderTree(db,item.id)).map(f=>f.id):[]);
 const batch=[];
 if(t.target_type==='file')batch.push(db.prepare("UPDATE files SET folder_id=?,status='ready',deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='trashed'").bind(parent,item.id));
 else{
  batch.push(db.prepare('UPDATE folders SET parent_id=? WHERE id=?').bind(parent,item.id));
  if(folderIds.length)batch.push(db.prepare(`UPDATE folders SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id IN (${placeholders(folderIds.length)})`).bind(...folderIds));
  if(fileIds.length)batch.push(db.prepare(`UPDATE files SET status='ready',deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id IN (${placeholders(fileIds.length)}) AND status='trashed'`).bind(...fileIds));
 }
 batch.push(db.prepare('DELETE FROM trash_entries WHERE id=?').bind(id));
 await db.batch(batch);
 return ok({restored:true,target_id:t.target_id,parent_id:parent});}
async function purgeFile(env,db,file){
 // Revoke all copies and share grants before removing this logical reference.
 const pubs=await many(db,"SELECT p.id,p.public_object_id,o.object_key FROM publications p JOIN storage_objects o ON o.id=p.public_object_id WHERE p.source_file_id=? AND p.status='ready'",[file.id]);
 for(const p of pubs){
  if(!env.PUBLIC_BUCKET?.delete)throw new Error('PUBLIC_BUCKET missing');
  await env.PUBLIC_BUCKET.delete(p.object_key);
  await execute(db,"UPDATE publications SET status='revoked' WHERE id=?",[p.id]);
  await execute(db,"UPDATE storage_objects SET status='deleted' WHERE id=?",[p.public_object_id]);
 }
 await execute(db,"DELETE FROM shares WHERE target_type='file' AND target_id=?",[file.id]);
 await execute(db,'DELETE FROM publications WHERE source_file_id=?',[file.id]);
 const other=await one(db,'SELECT id FROM files WHERE object_id=? AND id!=? LIMIT 1',[file.object_id,file.id]);
 if(other){
  // Another active or trashed logical copy still refers to the same bytes.
  await execute(db,'DELETE FROM files WHERE id=?',[file.id]);
  return;
 }
 const object=await one(db,'SELECT * FROM storage_objects WHERE id=?',[file.object_id]);
 if(!object){await execute(db,'DELETE FROM files WHERE id=?',[file.id]);return;}
 // Atomically remove the last file reference and commit a durable cleanup job.
 // If R2 is down, the outbox remains available to the scheduled worker.
 const jobId=uuid();
 await db.batch([
  db.prepare('INSERT OR IGNORE INTO storage_cleanup_jobs(id,object_id,object_key,bucket_type,space_id,size_bytes) VALUES(?,?,?,?,?,?)').bind(jobId,object.id,object.object_key,object.bucket_type,file.space_id,object.size_bytes),
  db.prepare('DELETE FROM files WHERE id=?').bind(file.id)
 ]);
 const job=await one(db,'SELECT * FROM storage_cleanup_jobs WHERE object_id=?',[object.id]);
 if(job){try{await finishStorageCleanup(env,job);}catch(e){console.warn('R2 removal queued for retry',object.id,e?.message||e);}}
}
// One Cloudflare Free invocation can process a few object deletes safely; a large
// directory is resumed by the next Cron event. The trash entry persists until
// every last file and folder has been removed.
export const PURGE_FILE_BATCH=2;
export const PURGE_FOLDER_BATCH=3;
export async function purgeItem(env,user,id,{automatic=false}={}){
 const db=dbFromEnv(env),t=automatic?await one(db,'SELECT * FROM trash_entries WHERE id=?',[id]):await entryFor(db,user,id);
 if(!t)return invalid();
 if(!automatic){const access=await spaceAccess(db,user,t.space_id);if(access?.role!=='admin'&&user.role!=='super_admin')return error('FORBIDDEN','只有空间管理员可以永久删除',403);}
 if(t.target_type==='folder'&&await nestedTrashConflict(db,t))return error('CHILD_TRASH_CONFLICT','子目录存在独立回收站记录，请先分别清理',409);
 // Fail closed before deleting any descendant when an upload holds a folder FK.
 if(t.target_type==='folder'){
  const pending=await one(db,`WITH RECURSIVE subtree(id,depth) AS (
   SELECT id,0 FROM folders WHERE id=? UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE s.depth<100)
   SELECT u.id FROM upload_sessions u JOIN subtree s ON u.target_folder_id=s.id
   WHERE u.status IN ('pending','uploading','verifying','failed') LIMIT 1`,[t.target_id]);
  if(pending)return error('UPLOADS_PENDING','目录仍有上传会话，请先取消或处理后再清理',409);
 }
 const maxFiles=PURGE_FILE_BATCH;
 try{
  let files;
  if(t.target_type==='file')files=await many(db,"SELECT * FROM files WHERE id=? AND status='trashed'",[t.target_id]);
  else{
   const hasSnapshot=await one(db,'SELECT 1 AS present FROM trash_entry_items WHERE trash_id=? LIMIT 1',[t.id]);
   if(hasSnapshot){
    files=await many(db,`SELECT f.* FROM files f JOIN trash_entry_items i ON i.item_id=f.id AND i.item_type='file'
     WHERE i.trash_id=? AND f.status='trashed' ORDER BY f.id LIMIT ?`,[t.id,maxFiles]);
   }else{
    files=await many(db,`WITH RECURSIVE subtree(id,depth) AS (
     SELECT id,0 FROM folders WHERE id=? UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE s.depth<100)
     SELECT f.* FROM files f JOIN subtree s ON f.folder_id=s.id WHERE f.status='trashed' ORDER BY f.id LIMIT ?`,[t.target_id,maxFiles]);
   }
  }
  for(const f of files)await purgeFile(env,db,f);
  if(t.target_type==='folder'){
   // Keep the tree intact until all underlying references are gone. An active
   // upload in ANY descendant pauses purging rather than breaking FK relations.
   const rest=await one(db,`WITH RECURSIVE subtree(id,depth) AS (
    SELECT id,0 FROM folders WHERE id=? UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE s.depth<100)
    SELECT f.id FROM files f JOIN subtree s ON f.folder_id=s.id LIMIT 1`,[t.target_id]);
   if(rest)return ok({purged:false,partial:true,files_removed:files.length},202);
   const remaining=await folderTree(db,t.target_id);
   if(remaining.some(f=>f.depth>=100))return error('DIRECTORY_TOO_DEEP','目录过深，清理已停止',409);
   for(const f of remaining.slice(0,PURGE_FOLDER_BATCH)){
    await execute(db,"DELETE FROM shares WHERE target_type='folder' AND target_id=?",[f.id]);
    await execute(db,'DELETE FROM folder_permissions WHERE folder_id=?',[f.id]);
    await execute(db,'DELETE FROM folders WHERE id=?',[f.id]);
   }
   if(remaining.length>PURGE_FOLDER_BATCH)return ok({purged:false,partial:true,folders_removed:PURGE_FOLDER_BATCH},202);
  }
  await execute(db,'DELETE FROM trash_entries WHERE id=?',[t.id]);
  return ok({purged:true,files_removed:files.length});
 }catch(e){console.error('Purge retryable error',e);return error('PURGE_RETRY','永久删除未完成，稍后重试',503)}
}
export async function cleanupTrash(env,{limit=10}={}){
 const db=dbFromEnv(env),entries=await many(db,'SELECT id FROM trash_entries WHERE purge_at <= CURRENT_TIMESTAMP ORDER BY purge_at LIMIT ?',[Math.max(1,Math.min(limit,3))]);
 let done=0,partial=0,failed=0;
 for(const t of entries){const result=await purgeItem(env,null,t.id,{automatic:true});if(result.status===200)done++;else if(result.status===202)partial++;else failed++;}
 return {attempted:entries.length,done,partial,failed};
}
