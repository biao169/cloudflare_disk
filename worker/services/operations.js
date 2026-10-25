// Error summaries are intentionally redacted. Never store request bodies, secrets,
// object keys, stack traces, tokens, URLs or usernames in operational_events.
import {dbFromEnv,execute,one,many} from './database.js';
import {settings} from './admin.js';
import {cleanupExpired} from './multipart.js';
import {cleanupTrash} from './trash.js';
import {cleanupPendingStorage} from './cleanup.js';

const SAFE_ID=/^[A-Z][A-Z0-9_]{2,63}$/;
const SOURCE=/^[a-z][a-z0-9_.-]{1,39}$/;
export function safeEventCode(value){const s=String(value||'SERVER_ERROR').toUpperCase();return SAFE_ID.test(s)?s:'SERVER_ERROR';}
export function safeEventSource(value){const s=String(value||'worker').toLowerCase();return SOURCE.test(s)?s:'worker';}
export async function recordIncident(env,{source='worker',code='SERVER_ERROR',level='error'}={}){
 const db=env?.DB;if(!db?.prepare)return false;
 const severity=level==='warning'?'warning':'error';
 const name=safeEventCode(code),component=safeEventSource(source),hour=new Date().toISOString().slice(0,13);
 try{
  await execute(db,`INSERT INTO operational_events(id,hour_bucket,source,code,level,message)
    VALUES(?,?,?,?,?,?) ON CONFLICT(hour_bucket,source,code) DO UPDATE SET
    occurrences=occurrences+1,last_seen_at=CURRENT_TIMESTAMP,acknowledged_at=NULL,acknowledged_by=NULL`,
    [crypto.randomUUID(),hour,component,name,severity,severity==='error'?'服务端操作异常，详见 Cloudflare Workers Logs':'需要管理员关注的运行状态']);
  return true;
 }catch(e){console.warn('RC9 incident persistence unavailable',e?.name||'Error');return false;}
}

// A single lease prevents an admin click and a Cron Trigger from both cleaning
// the same objects. Bounded units keep work within Workers Free CPU/D1 budgets.
export async function runMaintenance(env,{source='cron',actorId=null,tasks=['uploads','storage','trash']}={}){
 const db=dbFromEnv(env);
 const preferences=await settings(db);
 if(source==='cron'&&preferences.maintenance_paused)return {status:'skipped',reason:'MAINTENANCE_PAUSED'};
 const token=crypto.randomUUID();
 const claimed=await execute(db,`UPDATE maintenance_lock SET lease_token=?,lease_until=datetime('now','+5 minutes')
  WHERE id=1 AND (lease_token IS NULL OR lease_until<CURRENT_TIMESTAMP)`,[token]);
 if(!claimed.meta?.changes)return {status:'skipped',reason:'MAINTENANCE_BUSY'};
 const id=crypto.randomUUID(),summary={},failures=[];
 try{
  await execute(db,"INSERT INTO maintenance_runs(id,source,actor_id,status) VALUES(?,?,?,'running')",[id,source,actorId]);
  for(const [name,fn] of [
   ['uploads',()=>cleanupExpired(env,{limit:2})],
   ['storage',()=>cleanupPendingStorage(env,{limit:2})],
   ['trash',()=>cleanupTrash(env,{limit:1})]
  ].filter(([name])=>tasks.includes(name))){
   try{summary[name]=await fn();
    const pending=Number(summary[name]?.failed||0) > 0 || (name==='storage'&&Number(summary[name]?.attempted)>Number(summary[name]?.cleaned)) ||
     (name==='uploads'&&Number(summary[name]?.pending)>0);
    if(pending){failures.push(name);await recordIncident(env,{source:'maintenance.'+name,code:'MAINTENANCE_BATCH_PARTIAL',level:'warning'});}
   }
   catch(e){summary[name]={failed:true};failures.push(name);console.error('RC9 maintenance task failed',name,e);await recordIncident(env,{source:'maintenance.'+name,code:'MAINTENANCE_STEP_FAILED'});}
  }
  // Bounded retention. No deletion of user data or backup records.
  try{
   const days=Math.max(7,Math.min(90,Number(preferences.incident_retention_days)||30));
   const eventIds=await many(db,"SELECT id FROM operational_events WHERE last_seen_at<datetime('now',?) ORDER BY last_seen_at LIMIT 30",[`-${days} days`]);
   if(eventIds.length)await execute(db,`DELETE FROM operational_events WHERE id IN (${eventIds.map(()=>'?').join(',')})`,eventIds.map(x=>x.id));
   const history=await many(db,"SELECT id FROM maintenance_runs WHERE status!='running' AND started_at<datetime('now','-90 days') ORDER BY started_at LIMIT 20");
   if(history.length)await execute(db,`DELETE FROM maintenance_runs WHERE id IN (${history.map(()=>'?').join(',')})`,history.map(x=>x.id));
   summary.history_pruned={events:eventIds.length,runs:history.length};
  }catch(e){failures.push('history');console.error('RC9 maintenance history pruning failed',e);await recordIncident(env,{source:'maintenance.history',code:'HISTORY_PRUNE_FAILED'});}
  const status=failures.length?'partial':'completed';
  await execute(db,'UPDATE maintenance_runs SET status=?,finished_at=CURRENT_TIMESTAMP,result_json=?,error_count=?,error_code=? WHERE id=?',
    [status,JSON.stringify(summary).slice(0,3000),failures.length,failures.length?'PARTIAL_MAINTENANCE':null,id]);
  return {run_id:id,status,results:summary,error_count:failures.length};
 }catch(e){
  console.error('RC9 maintenance execution failed',e);
  try{await execute(db,"UPDATE maintenance_runs SET status='failed',finished_at=CURRENT_TIMESTAMP,error_count=1,error_code='MAINTENANCE_FAILED' WHERE id=?",[id]);}catch{}
  await recordIncident(env,{source:'maintenance',code:'MAINTENANCE_FAILED'});
  return {run_id:id,status:'failed',error_count:1};
 }finally{
  try{await execute(db,'UPDATE maintenance_lock SET lease_token=NULL,lease_until=NULL WHERE id=1 AND lease_token=?',[token]);}catch(e){console.error('RC9 lease release failed',e);}
 }
}
export async function operationsSummary(db){
 const [events,runs,backups,stalled,cleanup]=await Promise.all([
  one(db,"SELECT COUNT(*) AS count,COALESCE(SUM(occurrences),0) AS occurrences FROM operational_events WHERE acknowledged_at IS NULL AND last_seen_at>datetime('now','-7 days')"),
  one(db,'SELECT id,status,started_at,finished_at,error_count,result_json FROM maintenance_runs ORDER BY started_at DESC,id DESC LIMIT 1'),
  one(db,'SELECT backup_type,created_at,destination_label FROM backup_records ORDER BY created_at DESC,id DESC LIMIT 1'),
  one(db,"SELECT COUNT(*) AS count,COALESCE(SUM(reserved_bytes),0) AS reserved_bytes FROM upload_sessions WHERE status IN ('failed','verifying')"),
  one(db,'SELECT COUNT(*) AS count FROM storage_cleanup_jobs')
 ]);
 return {unacknowledged_events:events?.count||0,event_occurrences:events?.occurrences||0,
  latest_maintenance:runs||null,last_backup_record:backups||null,stalled_uploads:stalled||{count:0,reserved_bytes:0},cleanup_jobs:cleanup?.count||0,
  backup_record_is_manual:true};
}
export function buildQuotaAlerts(metrics,preferences,ops){
 const threshold=Math.max(50,Math.min(99,Number(preferences.quota_warn_percent)||85)),alerts=[];
 const ratio=(used,capacity)=>Number(capacity)>0?Math.round((Number(used)||0)*100/Number(capacity)):0;
 const total=ratio((metrics.totals.used_bytes||0)+(metrics.totals.reserved_bytes||0),preferences.max_storage_bytes);
 if(total>=threshold)alerts.push({code:'GLOBAL_QUOTA',severity:total>=100?'critical':'warning',message:`全局应用配额已使用 ${total}%（含上传预留）`});
 for(const space of metrics.spaces){if(Number(space.quota_bytes)<=0)continue;const pct=ratio(Number(space.used_bytes)+Number(space.reserved_bytes),space.quota_bytes);
  if(pct>=threshold)alerts.push({code:'SPACE_QUOTA',severity:pct>=100?'critical':'warning',message:`空间 ${space.name} 已使用 ${pct}%`,space_id:space.id});}
 if(ops.unacknowledged_events)alerts.push({code:'UNACKNOWLEDGED_INCIDENTS',severity:'warning',message:`有 ${ops.unacknowledged_events} 类尚未确认的异常记录`});
 if(ops.cleanup_jobs)alerts.push({code:'CLEANUP_BACKLOG',severity:'warning',message:`有 ${ops.cleanup_jobs} 个对象等待安全清理`});
 if(ops.stalled_uploads.count)alerts.push({code:'STALLED_UPLOADS',severity:'warning',message:`有 ${ops.stalled_uploads.count} 个分片任务需要恢复或清理`});
 if(!ops.last_backup_record)alerts.push({code:'BACKUP_NOT_RECORDED',severity:'info',message:'没有登记过完整备份；D1 Time Travel 无法恢复 R2 文件'});
 else if(Date.now()-Date.parse(ops.last_backup_record.created_at.replace(' ','T')+'Z')>preferences.backup_reminder_days*86400000)alerts.push({code:'BACKUP_RECORD_OUTDATED',severity:'warning',message:'上次登记的备份已超过提醒天数（记录不代表实际验证）'});
 if(preferences.maintenance_paused)alerts.push({code:'MAINTENANCE_PAUSED',severity:'warning',message:'自动清理目前已暂停'});
 return alerts;
}
