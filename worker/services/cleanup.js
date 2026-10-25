import {one,many,execute,dbFromEnv} from './database.js';

// D1 is authoritative for queued cleanup. The pending job intentionally keeps
// used_bytes occupied until R2 deletion AND the D1 finalization succeed.
export async function finishStorageCleanup(env,job){
 const db=dbFromEnv(env);
 // Never remove an object that has acquired a new logical reference.
 const stillUsed=await one(db,'SELECT f.id FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE o.id=? OR o.object_key=? LIMIT 1',[job.object_id,job.object_key]);
 if(stillUsed)throw new Error('Cleanup object still referenced by a file');
 const bucket=job.bucket_type==='private'?env.PRIVATE_BUCKET:env.PUBLIC_BUCKET;
 if(!bucket?.delete)throw new Error('Cleanup R2 binding missing');
 try{
  // R2 delete is idempotent: if a previous attempt deleted it but D1 failed,
  // this operation can safely be repeated.
  await bucket.delete(job.object_key);
  await db.batch([
   db.prepare('DELETE FROM storage_objects WHERE id=? AND NOT EXISTS (SELECT 1 FROM files WHERE object_id=?) AND EXISTS (SELECT 1 FROM storage_cleanup_jobs WHERE id=?)').bind(job.object_id,job.object_id,job.id),
   db.prepare('UPDATE spaces SET used_bytes=MAX(0,used_bytes-?),reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=? AND EXISTS (SELECT 1 FROM storage_cleanup_jobs WHERE id=?)').bind(job.size_bytes,job.reserved_release_bytes||0,job.space_id,job.id),
   db.prepare("UPDATE upload_sessions SET reserved_bytes=0 WHERE id=? AND status='aborted' AND EXISTS (SELECT 1 FROM storage_cleanup_jobs WHERE id=?)").bind(job.upload_session_id||'',job.id),
   db.prepare('DELETE FROM storage_cleanup_jobs WHERE id=?').bind(job.id)
  ]);
  return true;
 }catch(e){
  try{await execute(db,'UPDATE storage_cleanup_jobs SET attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[String(e?.message||e).slice(0,300),job.id]);}catch{}
  throw e;
 }
}
export async function cleanupPendingStorage(env,{limit=10}={}){
 const db=dbFromEnv(env);
 const jobs=await many(db,'SELECT * FROM storage_cleanup_jobs ORDER BY created_at,id LIMIT ?',[Math.max(1,Math.min(30,limit))]);
 let cleaned=0;
 for(const job of jobs){try{if(await finishStorageCleanup(env,job))cleaned++;}catch(e){console.warn('Pending R2 cleanup deferred',job.id,e?.message||e);}}
 return {attempted:jobs.length,cleaned};
}
