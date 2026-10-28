import {execute,one} from './database.js';
// Bounded housekeeping, independent of API call volume. Never removes live links.
export async function pruneOneDriveRecords(db,{batchSize=100}={}) {
 const limit=Math.max(1,Math.min(200,Math.trunc(Number(batchSize))||100));
 const jobs=[
  ['oauth_states',`DELETE FROM onedrive_oauth_states WHERE state IN (SELECT state FROM onedrive_oauth_states WHERE expires_at < CAST(strftime('%s','now') AS INTEGER) ORDER BY expires_at LIMIT ?)`],
  ['quota_counters',`DELETE FROM onedrive_quota_counters WHERE rowid IN (SELECT rowid FROM onedrive_quota_counters WHERE (window_name='minute' AND window_slot < CAST(strftime('%s','now') AS INTEGER)/60-3) OR (window_name='hour' AND window_slot < CAST(strftime('%s','now') AS INTEGER)/3600-2) OR (window_name='day' AND window_slot < CAST(strftime('%s','now') AS INTEGER)/86400-2) LIMIT ?)`]
 ];
 const result={};for(const [name,sql] of jobs){const r=await execute(db,sql,[limit]);result[name]=r.meta?.changes||0;}
 return result;
}
export async function oneDriveOperationalStatus(db){
 const [pending,links,counters]=await Promise.all([
  one(db,"SELECT COUNT(*) count FROM onedrive_oauth_states WHERE expires_at < CAST(strftime('%s','now') AS INTEGER)"),
  one(db,"SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) active FROM onedrive_fixed_links"),
  one(db,"SELECT COUNT(*) total FROM onedrive_quota_counters")
 ]);
 return {expired_oauth_states:pending?.count||0,fixed_links:links?.total||0,active_fixed_links:links?.active||0,quota_counter_rows:counters?.total||0,download_delivery:'source_page_redirect',graph_anonymous_delivery_enabled:false};
}
