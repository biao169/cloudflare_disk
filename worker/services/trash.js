import {one,many,execute,dbFromEnv} from './database.js';
import {spaceAccess,folderAccess,canFolder,canSpace,uuid} from './spaces.js';
import {ok,error} from '../utils/response.js';
import {settings} from './admin.js';
import {finishStorageCleanup} from './cleanup.js';
import {revokePublication} from './sharing.js';
const invalid=()=>error('NOT_FOUND','回收站项目不存在',404);
export const safeId=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v);
async function permitted(db,user,spaceId,folderId,action){const a=await spaceAccess(db,user,spaceId);if(!a)return false;return folderId?canFolder(await folderAccess(db,user,folderId),action):canSpace(a,action)}
async function folderTree(db,id){return many(db,`WITH RECURSIVE subtree(id,depth) AS (SELECT id,0 FROM folders WHERE id=? UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE s.depth<100) SELECT id,depth FROM subtree ORDER BY depth DESC`,[id]);}
async function fileTree(db,id){return many(db,`WITH RECURSIVE subtree(id,depth) AS (SELECT id,0 FROM folders WHERE id=? UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE s.depth<100) SELECT f.id,f.object_id,f.space_id,f.folder_id FROM files f JOIN subtree s ON f.folder_id=s.id`,[id]);}
async function revokeForFiles(db,ids){for(const id of ids){await execute(db,"UPDATE shares SET revoked_at=CURRENT_TIMESTAMP WHERE target_type='file' AND target_id=? AND revoked_at IS NULL",[id]);}}
export async function trashItem(env,user,type,id){const db=dbFromEnv(env);if(!['file','folder'].includes(type)||!safeId(id))return invalid();
 const table=type==='file'?'files':'folders',item=await one(db,`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`,[id]);if(!item)return invalid();
 const parent=type==='file'?item.folder_id:item.parent_id;if(!await permitted(db,user,item.space_id,parent,'delete'))return error('FORBIDDEN','没有删除权限',403);
 if(type==='folder'&&!await permitted(db,user,item.space_id,id,'delete'))return error('FORBIDDEN','没有目录删除权限',403);
 const retention=(await settings(db)).trash_retention_days;
 const trashId=uuid(),purgeAt=new Date(Date.now()+retention*86400000).toISOString().replace('T',' ').slice(0,19);
 const files=type==='file'?[item]:await fileTree(db,id),folders=type==='folder'?await folderTree(db,id):[];
 if(folders.some(f=>f.depth>=100))return error('DIRECTORY_TOO_DEEP','目录层级过深，不能执行不完整删除',409);
 // Revoke published copies before marking a private file as trashed.
 for(const f of files){const pubs=await many(db,"SELECT p.id,p.public_object_id,o.object_key FROM publications p JOIN storage_objects o ON o.id=p.public_object_id WHERE p.source_file_id=? AND p.status='ready'",[f.id]);for(const pub of pubs){try{if(!env.PUBLIC_BUCKET)throw new Error('PUBLIC_BUCKET binding missing');await revokePublication(env,db,pub);}catch(e){console.error('Failed revoking public object',e);return error('PUBLIC_REVOKE_FAILED','公开副本撤销失败，未继续执行删除',503)}}}
 // No R2 objects are deleted on soft-delete. Sharing must stop immediately.
 for(const f of files){await execute(db,"UPDATE files SET status='trashed',deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL",[f.id]);}
 for(const f of folders){await execute(db,'UPDATE folders SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL',[f.id]);}
 await execute(db,'INSERT INTO trash_entries(id,target_type,target_id,space_id,original_parent_id,deleted_by,purge_at) VALUES(?,?,?,?,?,?,?)',[trashId,type,id,item.space_id,parent,user.id,purgeAt]);
 await revokeForFiles(db,files.map(f=>f.id));for(const f of folders)await execute(db,"UPDATE shares SET revoked_at=CURRENT_TIMESTAMP WHERE target_type='folder' AND target_id=? AND revoked_at IS NULL",[f.id]);
 return ok({trash_id:trashId,type,id,purge_at:purgeAt});
}
export async function listTrash(env,user,spaceId){const db=dbFromEnv(env);if(!safeId(spaceId)||!await spaceAccess(db,user,spaceId))return error('NOT_FOUND','空间不存在',404);
 const entries=await many(db,`SELECT t.id,t.target_type,t.target_id,t.space_id,t.deleted_at,t.purge_at,t.original_parent_id,CASE WHEN t.target_type='file' THEN (SELECT name FROM files WHERE id=t.target_id) ELSE (SELECT name FROM folders WHERE id=t.target_id) END AS name FROM trash_entries t WHERE t.space_id=? ORDER BY t.deleted_at DESC LIMIT 200`,[spaceId]);
 return ok({entries});}
async function entryFor(db,user,id){const t=await one(db,'SELECT * FROM trash_entries WHERE id=?',[id]);if(!t||!await spaceAccess(db,user,t.space_id))return null;return t;}
export async function restoreItem(env,user,id,targetId){const db=dbFromEnv(env),t=await entryFor(db,user,id);if(!t)return invalid();const table=t.target_type==='file'?'files':'folders';const item=await one(db,`SELECT * FROM ${table} WHERE id=?`,[t.target_id]);if(!item)return invalid();
 let parent=targetId===undefined?t.original_parent_id:targetId;if(parent&&!safeId(parent))return error('INVALID_INPUT','目标目录无效',400);
 if(parent){const p=await one(db,'SELECT * FROM folders WHERE id=? AND deleted_at IS NULL',[parent]);if(!p||p.space_id!==t.space_id)return error('RESTORE_PARENT_MISSING','原目录不可用，请指定其他目录',409);}
 if(!await permitted(db,user,t.space_id,parent,'write'))return error('FORBIDDEN','没有恢复权限',403);
 const same=await one(db,`SELECT id FROM ${table} WHERE space_id=? AND ${t.target_type==='file'?'folder_id':'parent_id'} IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1`,[t.space_id,parent,item.name]);if(same)return error('NAME_CONFLICT','目标位置存在同名项目',409);
 if(t.target_type==='file')await execute(db,"UPDATE files SET folder_id=?,status='ready',deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",[parent,item.id]);
 else {const folders=await folderTree(db,item.id);await execute(db,'UPDATE folders SET parent_id=? WHERE id=?',[parent,item.id]);for(const f of folders)await execute(db,'UPDATE folders SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?',[f.id]);const files=await fileTree(db,item.id);for(const f of files)await execute(db,"UPDATE files SET status='ready',deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='trashed'",[f.id]);}
 await execute(db,'DELETE FROM trash_entries WHERE id=?',[id]);return ok({restored:true,target_id:t.target_id,parent_id:parent});}
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
export async function purgeItem(env,user,id,{automatic=false}={}){const db=dbFromEnv(env);const t=automatic?await one(db,'SELECT * FROM trash_entries WHERE id=?',[id]):await entryFor(db,user,id);if(!t)return invalid();
 if(!automatic){const access=await spaceAccess(db,user,t.space_id);if(access?.role!=='admin'&&user.role!=='super_admin')return error('FORBIDDEN','只有空间管理员可以永久删除',403);}
 const files=t.target_type==='file'?await many(db,'SELECT * FROM files WHERE id=?',[t.target_id]):await fileTree(db,t.target_id);
 if(t.target_type==='folder'){const folders=await folderTree(db,t.target_id);if(folders.some(f=>f.depth>=100))return error('DIRECTORY_TOO_DEEP','目录过深，清理已停止',409);
  for(const f of folders){const upload=await one(db,"SELECT id FROM upload_sessions WHERE target_folder_id=? AND status IN ('pending','uploading','verifying','failed') LIMIT 1",[f.id]);if(upload)return error('UPLOADS_PENDING','目录仍有上传会话，请先取消或处理后再清理',409);}}
 try{for(const f of files)await purgeFile(env,db,f);if(t.target_type==='folder'){const folders=await folderTree(db,t.target_id);for(const f of folders){await execute(db,"DELETE FROM shares WHERE target_type='folder' AND target_id=?",[f.id]);await execute(db,'DELETE FROM folder_permissions WHERE folder_id=?',[f.id]);await execute(db,'DELETE FROM folders WHERE id=?',[f.id]);}}
 await execute(db,'DELETE FROM trash_entries WHERE id=?',[t.id]);return ok({purged:true,files_removed:files.length});}catch(e){console.error('Purge retryable error',e);return error('PURGE_RETRY','永久删除未完成，稍后重试',503)}
}
export async function cleanupTrash(env,{limit=10}={}){const db=dbFromEnv(env),entries=await many(db,'SELECT id FROM trash_entries WHERE purge_at <= CURRENT_TIMESTAMP ORDER BY purge_at LIMIT ?',[limit]);let done=0;for(const t of entries){const result=await purgeItem(env,null,t.id,{automatic:true});if(result.status<300)done++;}return {attempted:entries.length,done};}
