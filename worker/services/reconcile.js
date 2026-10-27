// Production-safe, read-only quota/physical-object reconciliation.
// It never deletes objects or silently changes accounting balances.
import {many,one} from './database.js';

export async function reconcileLedger(db){
 const spaces=await many(db,`SELECT s.id,s.name,s.used_bytes,s.reserved_bytes,
  COALESCE((SELECT SUM(o.size_bytes) FROM storage_objects o
   WHERE o.bucket_type='private' AND o.status='ready'
   AND (EXISTS (SELECT 1 FROM files f WHERE f.object_id=o.id AND f.space_id=s.id) OR EXISTS (SELECT 1 FROM file_versions v JOIN files f ON f.id=v.file_id WHERE v.object_id=o.id AND f.space_id=s.id))),0) AS private_bytes,
  COALESCE((SELECT SUM(o.size_bytes) FROM storage_objects o
   WHERE o.bucket_type='public' AND o.status='ready' AND EXISTS(
    SELECT 1 FROM publications p JOIN files f ON f.id=p.source_file_id
    WHERE f.space_id=s.id AND p.status='ready' AND
    (p.public_object_id=o.id OR p.legacy_object_id=o.id OR EXISTS(
      SELECT 1 FROM publication_versions v WHERE v.publication_id=p.id AND v.object_id=o.id)))),0) AS public_bytes,
  COALESCE((SELECT SUM(j.size_bytes) FROM storage_cleanup_jobs j
   WHERE j.space_id=s.id),0) AS cleanup_charged_bytes,
  COALESCE((SELECT SUM(u.reserved_bytes) FROM upload_sessions u
   WHERE u.space_id=s.id AND u.reserved_bytes>0),0) AS upload_reserved_bytes
  FROM spaces s ORDER BY s.type,s.name LIMIT 100`);
 const results=spaces.map(s=>{
  const expectedUsed=s.private_bytes+s.public_bytes+s.cleanup_charged_bytes;
  return {...s,expected_used_bytes:expectedUsed,used_delta_bytes:s.used_bytes-expectedUsed,
   reservation_delta_bytes:s.reserved_bytes-s.upload_reserved_bytes};
 });
 const [pending,stalled,issues,pendingAliases]=await Promise.all([
  one(db,'SELECT COUNT(*) jobs,COALESCE(SUM(size_bytes),0) pending_used_bytes,COALESCE(SUM(reserved_release_bytes),0) pending_reserved_release_bytes FROM storage_cleanup_jobs'),
  one(db,"SELECT COUNT(*) sessions,COALESCE(SUM(reserved_bytes),0) reserved_bytes FROM upload_sessions WHERE status IN ('verifying','failed')"),
  one(db,`SELECT COUNT(*) unreferenced_ready_objects FROM storage_objects o
   WHERE o.status='ready' AND NOT EXISTS(SELECT 1 FROM files f WHERE f.object_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM file_versions v WHERE v.object_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.status='ready' AND (p.public_object_id=o.id OR p.legacy_object_id=o.id))
   AND NOT EXISTS(SELECT 1 FROM publication_versions v JOIN publications p ON p.id=v.publication_id WHERE v.object_id=o.id AND p.status='ready')
   AND NOT EXISTS(SELECT 1 FROM storage_cleanup_jobs j WHERE j.object_id=o.id)`),
  one(db,"SELECT COALESCE(SUM(reserved_alias_bytes),0) AS bytes FROM publication_sync_jobs WHERE status NOT IN ('completed','superseded')")
 ]);
 return {mode:'read_only',page_limit:100,spaces:results,cleanup_pending:pending,stalled_uploads:stalled,pending_legacy_alias_reservation:pendingAliases?.bytes||0,issues,
  note:'D1 业务账本快照，不是 Cloudflare R2 GB-month 账单。普通上传/公开发布过程中可能短暂有额外预留；跨空间共享对象需单独确定容量归属。不会自动修改数据。'};
}

export async function scanR2Bucket(db,bucket,{cursor='',limit=50}={}){
 if(!bucket?.list)throw new Error('R2 list binding unavailable');
 const result=await bucket.list({limit,cursor:cursor||undefined});
 const objects=result.objects||[];
 const keys=objects.map(o=>o.key);
 const rows=keys.length?await many(db,`SELECT object_key,size_bytes,bucket_type,status FROM storage_objects WHERE object_key IN (${keys.map(()=>'?').join(',')})`,keys):[];
 const saved=new Map(rows.map(r=>[r.object_key,r]));
 const now=Date.now();
 const items=objects.map(o=>{
  const known=saved.get(o.key);
  return {key:o.key,size_bytes:o.size,recorded_bytes:known?.size_bytes??null,metadata_status:known?.status||null,
   status:!known?(o.uploaded&&now-Date.parse(o.uploaded)<3600000?'recent_untracked':'untracked'):
    known.size_bytes!==o.size?'size_mismatch':known.status!=='ready'?'nonready_record':'matched'};
 });
 return {mode:'read_only',items,cursor:result.truncated?result.cursor||null:null,truncated:Boolean(result.truncated),
  sampled_bytes:objects.reduce((sum,o)=>sum+o.size,0),
  warning:'此页最多扫描指定数量的已完成 R2 对象；Multipart 未完成分片不可通过 list 统计。untracked 可能是正在完成的上传，请勿直接删除。'};
}
