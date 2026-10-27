// RC13.2 — immutable public versions and compatibility aliases.
// A file update is prepared in R2 first; D1 decides which version is current.
// Old direct-CDN URLs remain tied to their original key and are refreshed by an
// idempotent outbox. The stable /r/:publicationId entry is never cached.
import {one,many,execute,dbFromEnv} from './database.js';
import {RESERVE_SQL} from './admin.js';
import {DEFAULT_QUOTA_BYTES} from './storage.js';
import {cdnBaseUrl,purgePublicationCache} from './sharing.js';

const GiB=1024**3;
export const MAX_PUBLIC_COPY_BYTES=5*GiB-5*1024**2; // R2 single PUT ceiling (multipart public copy is a later enhancement).
const UUID=/^[0-9a-f-]{36}$/i;
const PUBLIC_KEY=/^(?:published|versions)\/[a-zA-Z0-9\-_/]+$/;
export class PublicationUpdateError extends Error {
 constructor(code,message,status=503){super(message);this.name='PublicationUpdateError';this.code=code;this.status=status;}
}
export function immutableVersionKey(publicationId,revision,id=crypto.randomUUID()){
 if(!UUID.test(publicationId)||!Number.isSafeInteger(revision)||revision<1||!UUID.test(id))throw new Error('Invalid public version key');
 return `versions/${publicationId}/v${revision}/${id}`;
}
export const stablePublicUrl=(req,id)=>`${new URL(req.url).origin}/r/${id}`;
export function publicMime(mime){return ['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf'].includes(mime)?mime:'application/octet-stream';}
function metadata(mime,name,{immutable=false}={}){
 const type=publicMime(mime);
 return {contentType:type,contentDisposition:`${type==='application/octet-stream'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  cacheControl:immutable?'public, max-age=31536000, immutable':'public, max-age=0, must-revalidate'};
}
function failure(code,message,status=503){throw new PublicationUpdateError(code,message,status);}

// Stores at most one active publication per logical file (legacy DB rows are
// checked and not silently chosen). New copies require additional physical quota.
export async function preparePublicVersions(env,db,{file,newPrivateKey,size,mime,revision,force=false}){
 const items=await many(db,`SELECT p.id,p.public_object_id,p.published_revision,p.legacy_object_id,p.auto_sync,
  l.object_key AS legacy_key,l.size_bytes AS legacy_size
  FROM publications p
  LEFT JOIN storage_objects l ON l.id=p.legacy_object_id
  WHERE p.source_file_id=? AND p.status='ready'`,[file.id]);
 if(items.length>1)failure('MULTIPLE_PUBLICATIONS','检测到多个公开发布记录，请管理员处理后重试',409);
 if(!items.length||(items[0].auto_sync===0&&!force))return {items:[],publicReservation:0,aliasReservation:0,spaceId:file.space_id};
 if(!Number.isSafeInteger(size)||size<0||size>MAX_PUBLIC_COPY_BYTES)failure('PUBLIC_COPY_TOO_LARGE','已公开文件的同步更新暂不支持超过 R2 单次复制上限；原版本未修改',413);
 if(!env.PRIVATE_BUCKET?.get||!env.PUBLIC_BUCKET?.put)failure('PUBLIC_BINDING_MISSING','公开或私有 R2 Binding 缺失');
 const p=items[0];
 if(!p.legacy_object_id||!p.legacy_key||!PUBLIC_KEY.test(p.legacy_key))failure('PUBLIC_ALIAS_INVALID','旧版公开对象缺失，无法安全同步',409);
 const aliasGrowth=Math.max(0,size-p.legacy_size);
 const total=size+aliasGrowth;
 const quota=await execute(db,RESERVE_SQL,[total,file.space_id,total,DEFAULT_QUOTA_BYTES,total,DEFAULT_QUOTA_BYTES]);
 if(!quota.meta?.changes)failure('PUBLIC_QUOTA_EXCEEDED','公开新版本和原地址更新需要额外 R2 空间，容量不足',413);
 const id=crypto.randomUUID(),key=immutableVersionKey(p.id,revision),entry={publicationId:p.id,oldObjectId:p.public_object_id,
  legacyObjectId:p.legacy_object_id,legacyKey:p.legacy_key,revision,objectId:id,key,size,aliasGrowth,mime,name:file.name,etag:null};
 const prepared={items:[entry],publicReservation:size,aliasReservation:aliasGrowth,spaceId:file.space_id};
 try{
  const source=await env.PRIVATE_BUCKET.get(newPrivateKey);
  if(!source?.body||source.size!==size)failure('PUBLIC_SOURCE_MISSING','新的私有 R2 对象不存在或大小不符');
  const result=await env.PUBLIC_BUCKET.put(key,source.body,{httpMetadata:metadata(mime,file.name,{immutable:true})});
  if(!result||result.size!==size)failure('PUBLIC_COPY_MISMATCH','公开副本未完成或大小不匹配');
  entry.etag=result.etag||null;
  return prepared;
 }catch(e){await abandonPreparedPublic(env,db,prepared);throw e;}
}

// Releases quota only after the R2 object is deleted; if delete fails a durable
// cleanup job keeps the physical bytes accounted for until retry succeeds.
export async function abandonPreparedPublic(env,db,prepared){
 if(!prepared?.publicReservation&&!prepared?.aliasReservation)return;
 let kept=0;
 for(const entry of prepared.items||[]){
  let uncertain=true;
  try{await env.PUBLIC_BUCKET.delete(entry.key);uncertain=false;}catch(e){console.error('RC13.2: public staged object could not be deleted',e);}
  if(uncertain){
   try{await execute(db,`INSERT OR IGNORE INTO storage_cleanup_jobs(id,object_id,object_key,bucket_type,space_id,size_bytes,reserved_release_bytes)
    VALUES(?,?,?,'public',?,0,?)`,[crypto.randomUUID(),entry.objectId,entry.key,prepared.spaceId,entry.size]);kept+=entry.size;}
   catch(e){kept+=entry.size;console.error('CRITICAL: public orphan requires manual reconciliation',e);}
  }
 }
 const release=(prepared.publicReservation||0)+(prepared.aliasReservation||0)-kept;
 if(release>0)try{await execute(db,'UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?',[release,prepared.spaceId]);}catch(e){console.error('RC13.2: quota release deferred',e);}
}

// Additional D1 statements added to the *same* transaction that moves files.object_id.
// Guarded on the updated revision and new private object pointer so a stale
// competing upload does not publish its prepared public version.
export function publicationCommitStatements(db,{file,newObjectId,revision,prepared}){
 const list=[];
 for(const p of prepared?.items||[]){
  const guard=`EXISTS (SELECT 1 FROM files WHERE id=? AND object_id=? AND revision=?)`;
  const common=[file.id,newObjectId,revision];
  list.push(db.prepare(`INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,etag,status)
   SELECT ?,'public',?,?,?,'ready' WHERE ${guard}`).bind(p.objectId,p.key,p.size,p.etag,...common));
  list.push(db.prepare(`INSERT OR IGNORE INTO publication_versions(id,publication_id,file_revision,object_id)
   SELECT ?,p.id,p.published_revision,p.public_object_id FROM publications p
   WHERE p.id=? AND p.public_object_id=? AND ${guard}`)
   .bind(crypto.randomUUID(),p.publicationId,p.oldObjectId,...common));
  list.push(db.prepare(`INSERT OR IGNORE INTO publication_versions(id,publication_id,file_revision,object_id)
   SELECT ?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),p.publicationId,revision,p.objectId,...common));
  list.push(db.prepare(`UPDATE publications SET public_object_id=?,published_revision=?,sync_state='alias_pending',updated_at=CURRENT_TIMESTAMP
   WHERE id=? AND status='ready' AND public_object_id=? AND ${guard}`)
   .bind(p.objectId,revision,p.publicationId,p.oldObjectId,...common));
  list.push(db.prepare(`INSERT OR IGNORE INTO publication_sync_jobs(id,publication_id,space_id,file_revision,version_object_id,
   legacy_object_id,reserved_alias_bytes,status)
   SELECT ?,?,?,?,?,?,?,'pending' WHERE ${guard}`).bind(crypto.randomUUID(),p.publicationId,file.space_id,revision,p.objectId,p.legacyObjectId,p.aliasGrowth,...common));
 }
 return list;
}
export function publicationPrecondition(prepared){
 const entries=prepared?.items||[];
 if(!entries.length)return {sql:`AND NOT EXISTS(SELECT 1 FROM publications WHERE source_file_id=files.id AND status='ready' AND auto_sync=1)`,bindings:[]};
 const p=entries[0];
 return {sql:`AND (SELECT COUNT(*) FROM publications WHERE source_file_id=files.id AND status='ready')=1
  AND EXISTS(SELECT 1 FROM publications WHERE id=? AND source_file_id=files.id AND public_object_id=?
  AND status='ready' AND auto_sync=1)`,bindings:[p.publicationId,p.oldObjectId]};
}

// Each job maintains a historical CDN path. A newer version supersedes older
// pending jobs; /r never uses that mutable alias and is immediately consistent.
export async function runLegacySync(env,jobId){
 const db=dbFromEnv(env);
 let job=await one(db,'SELECT * FROM publication_sync_jobs WHERE id=?',[jobId]);
 if(!job)return {status:'missing'};
 if(['completed','superseded'].includes(job.status))return {status:job.status};
 const p=await one(db,`SELECT p.*,v.object_key AS version_key,v.size_bytes AS new_size,
  l.object_key AS alias_key,l.size_bytes AS alias_size,f.name,f.mime_type,f.space_id
  FROM publications p JOIN files f ON f.id=p.source_file_id
  JOIN storage_objects v ON v.id=? JOIN storage_objects l ON l.id=? WHERE p.id=?`,
  [job.version_object_id,job.legacy_object_id,job.publication_id]);
 if(!p||p.status!=='ready'||p.published_revision!==job.file_revision||p.public_object_id!==job.version_object_id){
  await db.batch([
   db.prepare("UPDATE publication_sync_jobs SET status='superseded',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status NOT IN ('completed','superseded')").bind(job.id),
   db.prepare('UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?').bind(job.reserved_alias_bytes,job.space_id)
  ]);
  return {status:'superseded'};
 }
 if(!PUBLIC_KEY.test(p.alias_key)||!PUBLIC_KEY.test(p.version_key))failure('INVALID_PUBLIC_OBJECT','公开对象 Key 无效');
 if(job.status!=='purge_pending'){
  const lease=await execute(db,`UPDATE publication_sync_jobs SET status='copying',attempts=attempts+1,
   lease_until=datetime('now','+3 minutes'),updated_at=CURRENT_TIMESTAMP WHERE id=?
   AND (status IN ('pending','failed') OR (status='copying' AND lease_until<CURRENT_TIMESTAMP))`,[job.id]);
  if(!lease.meta?.changes)return {status:'busy'};
  try{
   const source=await env.PUBLIC_BUCKET.get(p.version_key);
   if(!source?.body||source.size!==p.new_size)throw new Error('Published version source is missing');
   const saved=await env.PUBLIC_BUCKET.put(p.alias_key,source.body,{httpMetadata:metadata(p.mime_type,p.name)});
   if(!saved||saved.size!==p.new_size)throw new Error('Legacy alias copy size mismatch');
   // A newer publication may have overtaken this copy. Its job will be retried.
   const current=await one(db,'SELECT published_revision,public_object_id,status FROM publications WHERE id=?',[p.id]);
   if(!current||current.status!=='ready'||current.published_revision!==job.file_revision||current.public_object_id!==job.version_object_id){
    // A concurrent revoke or a later file revision can overtake a large R2
    // copy while it is in flight. A stale write MUST NOT resurrect a revoked
    // public alias or permanently replace a newer alias with older bytes.
    if(!current||current.status!=='ready'){
     try{await env.PUBLIC_BUCKET.delete(p.alias_key);}
     catch(e){
      // Revocation may already have deleted/tombstoned this storage_objects
      // row. Requeue the physical key without releasing quota a second time.
      try{await execute(db,`INSERT OR IGNORE INTO storage_cleanup_jobs
       (id,object_id,object_key,bucket_type,space_id,size_bytes)
       VALUES(?,?,?,'public',?,0)`,[crypto.randomUUID(),p.legacy_object_id,p.alias_key,p.space_id]);}
      catch(ledgerError){console.error('CRITICAL: resurrected public alias requires manual cleanup',ledgerError);}
     }
     try{await purgePublicationCache(env,{public_path:p.alias_key});}catch{}
    }
    const updates=[
     db.prepare("UPDATE publication_sync_jobs SET status='superseded',reserved_alias_bytes=0,lease_until=NULL,last_error='SUPERSEDED_AFTER_COPY',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(job.id),
     db.prepare('UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?').bind(job.reserved_alias_bytes,job.space_id)
    ];
    if(current?.status==='ready'){
     // The latest job may already have completed before this stale R2 PUT.
     // Request a fresh alias copy and invalidate its former completion state.
     updates.push(db.prepare("UPDATE publication_sync_jobs SET status='pending',lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE publication_id=? AND file_revision=? AND status IN ('completed','purge_pending','superseded')").bind(p.id,current.published_revision));
     updates.push(db.prepare("UPDATE publications SET sync_state='alias_pending' WHERE id=? AND status='ready' AND published_revision=?").bind(p.id,current.published_revision));
    }
    await db.batch(updates);
    return {status:'superseded',reason:'superseded_after_copy'};
   }
   await db.batch([
    db.prepare('UPDATE storage_objects SET size_bytes=?,etag=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(p.new_size,saved.etag||null,p.legacy_object_id),
    db.prepare('UPDATE spaces SET used_bytes=MAX(0,used_bytes+?),reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?').bind(p.new_size-p.alias_size,job.reserved_alias_bytes,p.space_id),
    db.prepare("UPDATE publication_sync_jobs SET status='purge_pending',reserved_alias_bytes=0,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(job.id),
    db.prepare("UPDATE publications SET sync_state='purge_pending' WHERE id=? AND published_revision=?").bind(p.id,job.file_revision)
   ]);
  }catch(e){
   console.error('RC13.2 legacy URL update deferred',job.id,e?.message||e);
   await execute(db,"UPDATE publication_sync_jobs SET status='failed',lease_until=NULL,next_retry_at=datetime('now', '+' || MIN(3600, 30 * (1 << MIN(attempts,7))) || ' seconds'),last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[String(e?.message||e).slice(0,200),job.id]);
   return {status:'failed'};
  }
 }
 // This purges the *original* URL; /r never needs cache purge because redirects
 // are uncacheable and point to a new immutable key for each revision.
 const cache=await purgePublicationCache(env,{public_path:p.alias_key});
 if(cache.purged||cache.reason==='CDN_PURGE_NOT_CONFIGURED'){
  const finalState=cache.purged||!cdnBaseUrl(env.PUBLIC_BASE_URL)?'ready':'cache_unverified';
  await db.batch([
   db.prepare("UPDATE publication_sync_jobs SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(job.id),
   db.prepare("UPDATE publications SET sync_state=? WHERE id=? AND published_revision=?").bind(finalState,p.id,job.file_revision)
  ]);
  return {status:'completed',sync_state:finalState,cache};
 }
 await execute(db,"UPDATE publication_sync_jobs SET status='purge_pending',next_retry_at=datetime('now','+5 minutes'),last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[cache.reason,job.id]);
 return {status:'purge_pending',cache};
}
export async function syncPendingPublications(env,{limit=1}={}){
 const db=dbFromEnv(env);
 const rows=await many(db,`SELECT id FROM publication_sync_jobs WHERE (status IN ('pending','failed','purge_pending')
 OR (status='copying' AND lease_until<CURRENT_TIMESTAMP)) AND (next_retry_at IS NULL OR next_retry_at<=CURRENT_TIMESTAMP) ORDER BY created_at,id LIMIT ?`,[Math.min(3,Math.max(1,limit))]);
 const outcomes=[];for(const r of rows){try{outcomes.push(await runLegacySync(env,r.id));}catch(e){console.warn('RC13.2 background alias sync deferred',e);outcomes.push({status:'failed'});}}
 return {attempted:rows.length,completed:outcomes.filter(x=>x.status==='completed').length,remaining:outcomes.filter(x=>x.status!=='completed'&&x.status!=='superseded').length};
}
export async function synchronizePublicationOnCommit(env,prepared){
 const outcomes=[];
 for(const entry of prepared?.items||[]){
  const db=dbFromEnv(env);
  const job=await one(db,'SELECT id FROM publication_sync_jobs WHERE publication_id=? AND file_revision=?',[entry.publicationId,entry.revision]);
  if(job)try{outcomes.push(await runLegacySync(env,job.id));}catch(e){console.error('RC13.2 alias sync queued',e);outcomes.push({status:'pending'});}
 }
 return outcomes;
}

export async function publicationDetails(db,id){
 const p=await one(db,`SELECT p.id,p.status,p.published_revision,p.sync_state,p.auto_sync,
  o.object_key,o.size_bytes,o.etag,f.name,f.mime_type,f.revision AS source_revision,f.deleted_at,f.status AS file_status
  FROM publications p JOIN storage_objects o ON o.id=p.public_object_id AND o.status='ready' AND o.bucket_type='public'
  JOIN files f ON f.id=p.source_file_id WHERE p.id=?`,[id]);
 return p;
}

// Keep current public revision and the immediately preceding immutable revision.
// Older immutable objects receive a 48-hour grace period, then are queued for
// durable physical deletion. Existing stable legacy aliases are never pruned.
export async function pruneOldPublicVersions(env,{limit=1}={}){
 const db=dbFromEnv(env);
 const candidates=await many(db,`SELECT v.id AS version_id,v.object_id,o.object_key,o.size_bytes,
   p.id AS publication_id,f.space_id
   FROM publication_versions v
   JOIN publications p ON p.id=v.publication_id AND p.status='ready'
   JOIN files f ON f.id=p.source_file_id
   JOIN storage_objects o ON o.id=v.object_id AND o.status='ready' AND o.bucket_type='public'
   WHERE v.object_id!=p.public_object_id AND v.object_id!=p.legacy_object_id
   AND v.created_at<datetime('now','-2 days')
   AND (SELECT COUNT(*) FROM publication_versions newer
      WHERE newer.publication_id=v.publication_id AND newer.file_revision>v.file_revision)>=2
   ORDER BY v.created_at,v.id LIMIT ?`,[Math.max(1,Math.min(2,limit))]);
 let queued=0,cleaned=0;
 for(const v of candidates){
  // The deleted history reference and cleanup outbox entry are atomic.
  await db.batch([
   db.prepare('DELETE FROM publication_versions WHERE id=? AND object_id=?').bind(v.version_id,v.object_id),
   db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs(id,object_id,object_key,bucket_type,space_id,size_bytes)
    VALUES(?,?,?,'public',?,?)`).bind(crypto.randomUUID(),v.object_id,v.object_key,v.space_id,v.size_bytes)
  ]);
  queued++;
  try{
   const {finishStorageCleanup}=await import('./cleanup.js');
   const job=await one(db,'SELECT * FROM storage_cleanup_jobs WHERE object_id=?',[v.object_id]);
   if(job&&await finishStorageCleanup(env,job))cleaned++;
  }catch(e){console.warn('RC13.2 public history cleanup queued',e?.message||e);}
 }
 return {queued,cleaned};
}

// RC13.4 explicit publish of the current private revision. Used when an admin
// paused automatic publication while editing. The existing stable /r/ ID stays
// unchanged, and R2 is staged before the guarded D1 pointer switch.
export async function publishCurrentRevision(env,publicationId){
 const db=dbFromEnv(env);
 const row=await one(db,`SELECT p.id,p.public_object_id,p.published_revision,p.status AS publication_status,
  f.id AS file_id,f.revision,f.object_id,f.space_id,f.name,f.size_bytes,f.mime_type,f.status AS file_status,f.deleted_at,
  o.object_key FROM publications p JOIN files f ON f.id=p.source_file_id
  JOIN storage_objects o ON o.id=f.object_id AND o.bucket_type='private' AND o.status='ready'
  WHERE p.id=?`,[publicationId]);
 if(!row||row.publication_status!=='ready'||row.file_status!=='ready'||row.deleted_at)failure('PUBLICATION_UNAVAILABLE','公开发布或源文件不可用',404);
 if(row.published_revision===row.revision)return {status:'already_current',revision:row.revision};
 if(row.published_revision>row.revision)failure('PUBLICATION_CONFLICT','公开修订超前，请管理员核对',409);
 const file={id:row.file_id,object_id:row.object_id,revision:row.revision,space_id:row.space_id,name:row.name,size_bytes:row.size_bytes,mime_type:row.mime_type};
 let prepared;
 try{prepared=await preparePublicVersions(env,db,{file,newPrivateKey:row.object_key,size:row.size_bytes,mime:row.mime_type,revision:row.revision,force:true});}
 catch(err){if(err instanceof PublicationUpdateError)throw err;console.error('RC13.4 manual public R2 preparation failed',err);failure('PUBLIC_COPY_FAILED','公开副本写入失败；原公开链接继续有效，请稍后重试',503);}
 if(prepared.items.length!==1)failure('PUBLICATION_UNAVAILABLE','无法准备公开版本',503);
 const e=prepared.items[0];let committed=false,attempted=false,uncertain=false;
 try{
  // Every statement shares the expected current file revision + original
  // publication pointer. D1 batch serializes concurrent writes atomically.
  const guard=`EXISTS(SELECT 1 FROM files f JOIN publications p ON p.source_file_id=f.id
   WHERE f.id=? AND f.revision=? AND f.object_id=? AND f.status='ready' AND f.deleted_at IS NULL
   AND p.id=? AND p.status='ready' AND p.public_object_id=? AND p.published_revision=?)`;
  const args=[file.id,file.revision,file.object_id,e.publicationId,e.oldObjectId,row.published_revision];
  const current=`EXISTS(SELECT 1 FROM publications WHERE id=? AND public_object_id=? AND published_revision=? AND status='ready')`;
  const currArgs=[e.publicationId,e.objectId,e.revision];
  attempted=true;
  const out=await db.batch([
   db.prepare(`INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,etag,status)
    SELECT ?,'public',?,?,?,'ready' WHERE ${guard}`).bind(e.objectId,e.key,e.size,e.etag,...args),
   db.prepare(`INSERT OR IGNORE INTO publication_versions(id,publication_id,file_revision,object_id)
    SELECT ?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),e.publicationId,row.published_revision,e.oldObjectId,...args),
   db.prepare(`INSERT OR IGNORE INTO publication_versions(id,publication_id,file_revision,object_id)
    SELECT ?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),e.publicationId,e.revision,e.objectId,...args),
   db.prepare(`UPDATE publications SET public_object_id=?,published_revision=?,sync_state='alias_pending',updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND public_object_id=? AND published_revision=? AND status='ready'
    AND EXISTS(SELECT 1 FROM files WHERE id=? AND object_id=? AND revision=? AND status='ready' AND deleted_at IS NULL)`)
    .bind(e.objectId,e.revision,e.publicationId,e.oldObjectId,row.published_revision,file.id,file.object_id,file.revision),
   db.prepare(`INSERT OR IGNORE INTO publication_sync_jobs(id,publication_id,space_id,file_revision,version_object_id,
    legacy_object_id,reserved_alias_bytes,status) SELECT ?,?,?,?,?,?,?,'pending' WHERE ${current}`)
    .bind(crypto.randomUUID(),e.publicationId,file.space_id,e.revision,e.objectId,e.legacyObjectId,e.aliasGrowth,...currArgs),
   db.prepare(`UPDATE spaces SET used_bytes=used_bytes+?,reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=? AND ${current}`)
    .bind(e.size,e.size,file.space_id,...currArgs)
  ]);
  if(out[3]?.meta?.changes!==1)return {status:'conflict'};
  committed=true;
  try{await synchronizePublicationOnCommit(env,prepared)}catch(err){console.warn('Manual public alias sync deferred',err);}
  return {status:'published',revision:e.revision,smart_link_unchanged:true};
 }catch(err){
  if(attempted&&!committed){
   // A lost D1 success response is not proof of rollback. Never delete a live
   // public object until its pointer has been conclusively checked.
   let current;try{current=await one(db,'SELECT public_object_id FROM publications WHERE id=?',[e.publicationId]);}
   catch{uncertain=true;return {status:'commit_outcome_unknown',revision:e.revision};}
   if(current?.public_object_id===e.objectId){committed=true;return {status:'published',revision:e.revision,warning:'COMMIT_RESPONSE_INTERRUPTED'};}
  }
  throw err;
 }finally{if(!committed&&!uncertain)await abandonPreparedPublic(env,db,prepared);}
}
