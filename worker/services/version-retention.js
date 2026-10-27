// RC13.5: bounded, non-destructive retention. Only prunes history references
// after a grace period; physical R2 bytes remain accounted for until cleanup.
import {dbFromEnv,many,one} from './database.js';
import {finishStorageCleanup} from './cleanup.js';
const clamp=(x,min,max)=>Math.min(max,Math.max(min,Number(x)||min));
export async function prunePrivateVersions(env,{limit=1,keep=1,graceDays=7}={}){
 const db=dbFromEnv(env);const batch=clamp(limit,1,3),retain=clamp(keep,1,10),days=clamp(graceDays,1,90);
 const rows=await many(db,`SELECT v.id,v.file_id,v.revision,v.object_id,o.object_key,o.size_bytes,f.space_id
 FROM file_versions v JOIN files f ON f.id=v.file_id
 JOIN storage_objects o ON o.id=v.object_id AND o.bucket_type='private' AND o.status='ready'
 WHERE f.object_id!=v.object_id AND v.created_at<datetime('now',?)
 AND (SELECT COUNT(*) FROM file_versions newer WHERE newer.file_id=v.file_id AND newer.revision>v.revision)>=?
 AND NOT EXISTS(SELECT 1 FROM files current WHERE current.object_id=v.object_id)
 AND NOT EXISTS(SELECT 1 FROM upload_sessions u WHERE u.object_key=o.object_key AND u.status IN ('uploading','verifying'))
 AND NOT EXISTS(SELECT 1 FROM storage_cleanup_jobs q WHERE q.object_id=v.object_id)
 ORDER BY v.created_at,v.id LIMIT ?`,[`-${days} days`,retain,batch]);
 let queued=0,deleted=0;
 for(const v of rows){
  const outcome=await db.batch([
   db.prepare(`DELETE FROM file_versions WHERE id=? AND object_id=? AND NOT EXISTS
    (SELECT 1 FROM files f WHERE f.object_id=?)`).bind(v.id,v.object_id,v.object_id),
   db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs
    (id,object_id,object_key,bucket_type,space_id,size_bytes)
    SELECT ?,o.id,o.object_key,'private',?,o.size_bytes FROM storage_objects o WHERE o.id=?
    AND NOT EXISTS(SELECT 1 FROM file_versions WHERE object_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM files WHERE object_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM storage_cleanup_jobs WHERE object_id=o.id)`)
    .bind(crypto.randomUUID(),v.space_id,v.object_id)
  ]);
  if(outcome[0]?.meta?.changes)queued++;
  if(outcome[1]?.meta?.changes){const task=await one(db,'SELECT * FROM storage_cleanup_jobs WHERE object_id=?',[v.object_id]);
   try{if(task&&await finishStorageCleanup(env,task))deleted++;}catch(e){console.warn('RC13.5 private history deletion deferred',e?.name||'Error');}}
 }
 return {considered:rows.length,queued,deleted,retained_minimum:retain,grace_days:days};
}
