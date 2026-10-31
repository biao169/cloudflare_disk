import {driveFileAdminRoute} from '../services/onedrive-drive-files.js';
import {adminSharePolicyRoute} from '../services/onedrive-share-policy.js';
import {adminGroupRoute} from '../services/onedrive-groups.js';
import {oneDriveOperationalStatus} from '../services/onedrive-maintenance.js';
import {oneDriveSyncStatus,checkMicrosoftAuthorization,checkPublication} from '../services/onedrive-sync.js';
import {startOAuth,finishOAuth,graphResolve,connectionStatus,disconnect,oauthErrorDetails} from '../services/onedrive-oauth.js';
import {microsoftConfigErrorMessage} from '../services/microsoft-config.js';
import {oneDriveStats} from '../services/onedrive-quota.js';
import {reconcileLedger,scanR2Bucket} from '../services/reconcile.js';
import {dbFromEnv,one,many,execute} from '../services/database.js';
import {resolveUser,jsonBody} from '../services/auth.js';
import {ok,error} from '../utils/response.js';
import {settings,metrics,validateSettings,audit} from '../services/admin.js';
import {operationsSummary,buildQuotaAlerts,runMaintenance} from '../services/operations.js';
// Return only sanitized error identifiers in the URL; never forward code, state, tokens, or raw descriptions.
export function oauthCallbackRedirect({code,aadsts,microsoftError}={}){
 const p=new URLSearchParams({tab:'onedrive',oauth_error:/^[A-Z_]{4,75}$/.test(code||'')?code:'OAUTH_CALLBACK_ERROR'});
 if(/^AADSTS\d{4,8}$/.test(aadsts||''))p.set('aadsts',aadsts);
 if(/^[a-z_]{1,50}$/.test(microsoftError||''))p.set('ms_error',microsoftError);
 return new Response(null,{status:303,headers:{Location:'/settings?'+p.toString(),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
export async function adminRoute(req,env,path){
 const user=await resolveUser(req,env);
 if(!user&&path==='/api/v1/admin/onedrive/oauth/callback')return oauthCallbackRedirect({code:'OAUTH_SESSION_LOST'});
 if(!user)return error('UNAUTHORIZED','请先登录',401);
 if(user.role!=='super_admin'&&path==='/api/v1/admin/onedrive/oauth/callback')return oauthCallbackRedirect({code:'OAUTH_SESSION_LOST'});
 if(user.role!=='super_admin')return error('FORBIDDEN','仅超级管理员可操作',403);
 const db=dbFromEnv(env),method=req.method;
 if(path.startsWith('/api/v1/admin/onedrive/shares'))return adminSharePolicyRoute(req,env,path,user.id);
 if(path==='/api/v1/admin/onedrive/drive/batch-publish'||path.startsWith('/api/v1/admin/onedrive/groups'))return adminGroupRoute(req,env,path);
 if(path.startsWith('/api/v1/admin/onedrive/drive/'))return driveFileAdminRoute(req,env,path);
 if(path==='/api/v1/admin/onedrive/oauth/start'&&req.method==='GET'){
  try{return ok({authorization_url:await startOAuth(req,env,user.id)});}catch(e){const detail=microsoftConfigErrorMessage(e.message);const diagnostic=oauthErrorDetails(e);return error(detail?e.message:diagnostic.code,detail||diagnostic.message,503);}
 }
 if(path==='/api/v1/admin/onedrive/oauth/callback'&&req.method==='GET'){
  try{await finishOAuth(req,env,user.id);return new Response(null,{status:303,headers:{Location:'/settings?tab=onedrive&connected=1','Cache-Control':'no-store'}});}catch(e){return oauthCallbackRedirect(oauthErrorDetails(e));}
 }
 if(path==='/api/v1/admin/onedrive/oauth'&&req.method==='GET')return ok(await connectionStatus(env,req));
 if(path==='/api/v1/admin/onedrive/oauth'&&req.method==='DELETE'){await disconnect(env);return ok({connected:false});}
 if(path==='/api/v1/admin/onedrive/graph/resolve'&&req.method==='POST'){
  let body;try{body=await jsonBody(req);}catch{return error('INVALID_JSON','Invalid JSON',400);}
  try{return ok(await graphResolve(env,body?.url));}catch(e){return error(e.message||'GRAPH_FAILED','微软授权解析失败：'+String(e.message),e.message==='MICROSOFT_THROTTLED'?429:400);}
 }

 if(path==='/api/v1/admin/settings'){
  if(method==='GET')return ok(await settings(db));
  if(method==='PATCH'){
   const values=validateSettings(await jsonBody(req));if(!values)return error('INVALID_INPUT','设置内容无效',400);
   if(values.max_storage_bytes!==undefined){const totals=await one(db,'SELECT COALESCE(SUM(used_bytes+reserved_bytes),0) AS total FROM spaces');if(values.max_storage_bytes<totals.total)return error('QUOTA_CONFLICT','不能将配额设置为低于已占用及预留容量',409);}
   await db.batch(Object.entries(values).map(([key,value])=>db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP').bind(key,JSON.stringify(value))));
   await audit(db,user.id,'settings.update','settings',null,{keys:Object.keys(values)});
   return ok(await settings(db));
  }
 }
 if(path==='/api/v1/admin/onedrive/sync/status'&&method==='GET')return ok({...await oneDriveSyncStatus(db),configuration:await settings(db)});
 if(path==='/api/v1/admin/onedrive/sync/auth-check'&&method==='POST')return ok(await checkMicrosoftAuthorization(env));
 if(path==='/api/v1/admin/onedrive/sync/run'&&method==='POST'){
  const report=await runMaintenance(env,{source:'admin',actorId:user.id,tasks:['onedrive_sync'],forceSync:true});
  await audit(db,user.id,'onedrive.sync.run','onedrive',null,{status:report.status});return ok(report);
 }
 const itemSync=/^\/api\/v1\/admin\/onedrive\/sync\/items\/(odf_[a-f0-9]{32})\/check$/.exec(path);
 if(itemSync&&method==='POST'){
  const row=await one(db,"SELECT * FROM onedrive_drive_publications WHERE id=? AND status=\'active\'",[itemSync[1]]);
  if(!row)return error('NOT_FOUND','文件分享不存在',404);
  const outcome=await checkPublication(env,row,{intervalHours:(await settings(db)).onedrive_sync_interval_hours});
  await audit(db,user.id,'onedrive.sync.check','onedrive_file',itemSync[1],{status:outcome.status});return ok(outcome);
 }
 if(path==='/api/v1/admin/onedrive/stats'&&method==='GET')return ok({...await oneDriveStats(db),operations:await oneDriveOperationalStatus(db)});
 if(path==='/api/v1/admin/storage'&&method==='GET')return ok({...(await metrics(db)),settings:await settings(db)});
 if(path==='/api/v1/admin/dashboard'&&method==='GET'){
  const [usage,preferences,operations]=await Promise.all([metrics(db),settings(db),operationsSummary(db)]);
  return ok({usage,settings:preferences,operations,alerts:buildQuotaAlerts(usage,preferences,operations),
   usage_source:'D1 application ledger',cloudflare_billing_verified:false,backup_verified:false});
 }
 if(path==='/api/v1/admin/operations/events'&&method==='GET'){
  const params=new URL(req.url).searchParams;
  const page=Number(params.get('page')||1),limit=Number(params.get('limit')||30);
  if(!Number.isSafeInteger(page)||page<1||page>100||!Number.isSafeInteger(limit)||limit<1||limit>50)return error('INVALID_INPUT','分页范围无效',400);
  const only=params.get('unacknowledged')==='1';
  const rows=await many(db,`SELECT id,level,source,code,message,occurrences,first_seen_at,last_seen_at,acknowledged_at
    FROM operational_events WHERE (?=0 OR acknowledged_at IS NULL)
    ORDER BY last_seen_at DESC,id DESC LIMIT ? OFFSET ?`,[only?1:0,limit,(page-1)*limit]);
  return ok({items:rows,page,limit,has_more:rows.length===limit,details_redacted:true});
 }
 const eventAck=/^\/api\/v1\/admin\/operations\/events\/([0-9a-f-]{36})\/ack$/.exec(path);
 if(eventAck&&method==='POST'){
  const saved=await execute(db,'UPDATE operational_events SET acknowledged_at=CURRENT_TIMESTAMP,acknowledged_by=? WHERE id=? AND acknowledged_at IS NULL',[user.id,eventAck[1]]);
  if(!saved.meta?.changes)return error('NOT_FOUND','异常记录不存在或已确认',404);
  await audit(db,user.id,'incident.acknowledge','incident',eventAck[1]);
  return ok({acknowledged:true,id:eventAck[1]});
 }
 if(path==='/api/v1/admin/maintenance/runs'&&method==='GET'){
  const items=await many(db,'SELECT id,source,status,started_at,finished_at,error_count,error_code,result_json FROM maintenance_runs ORDER BY started_at DESC,id DESC LIMIT 30');
  return ok({items:items.map(row=>({...row,result:row.result_json?JSON.parse(row.result_json):null,result_json:undefined}))});
 }
 if(path==='/api/v1/admin/maintenance/run'&&method==='POST'){
  const report=await runMaintenance(env,{source:'admin',actorId:user.id});
  await audit(db,user.id,'maintenance.run','system',report.run_id||null,{status:report.status});
  return ok(report);
 }
 if(path==='/api/v1/admin/backups/records'&&method==='GET'){
  const items=await many(db,'SELECT b.id,b.backup_type,b.destination_label,b.notes,b.created_at,u.username AS recorded_by FROM backup_records b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.created_at DESC,b.id DESC LIMIT 30');
  return ok({items,verified:false,description:'管理员手工登记，记录不代表软件已核验备份完整性'});
 }
 if(path==='/api/v1/admin/backups/records'&&method==='POST'){
  const body=await jsonBody(req);
  if(!['d1_only','d1_and_r2'].includes(body?.backup_type)||typeof body.destination_label!=='string'||!body.destination_label.trim()||body.destination_label.length>120||
   (body.notes!==undefined&&(typeof body.notes!=='string'||body.notes.length>500)))return error('INVALID_INPUT','备份登记信息无效',400);
  const id=crypto.randomUUID();
  await execute(db,'INSERT INTO backup_records(id,created_by,backup_type,destination_label,notes) VALUES(?,?,?,?,?)',
   [id,user.id,body.backup_type,body.destination_label.trim(),body.notes?.trim()||null]);
  await audit(db,user.id,'backup.register','backup',id,{backup_type:body.backup_type});
  return ok({id,recorded:true,verified:false,note:'仅登记，尚未证明数据已安全备份'},201);
 }
 if(path==='/api/v1/admin/backups/manifest'&&method==='GET'){
  const [usage,ops,counts]=await Promise.all([metrics(db),operationsSummary(db),one(db,`SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM folders) AS folders,
    (SELECT COUNT(*) FROM storage_objects) AS physical_objects,
    (SELECT COUNT(*) FROM publications WHERE status='ready') AS active_publications`)]);
  const at=new Date().toISOString();
  const payload={kind:'CLOUDDRIVE_METADATA_MANIFEST',not_a_backup:true,generated_at:at,stage:env.APP_STAGE||'unknown',
   counts,logical_storage:usage.totals,space_summaries:usage.spaces,files:usage.files,shares:usage.shares,
   operations:{pending_cleanup:ops.cleanup_jobs,stalled_uploads:ops.stalled_uploads},
   warnings:['此清单不包含 D1 SQL 数据、账号密码哈希或 R2 文件字节。不能用于还原网盘。',
    '完整恢复需要 D1 SQL/Time Travel 与独立 R2 对象备份。']};
  return new Response(JSON.stringify(payload,null,2),{status:200,headers:{'Content-Type':'application/json; charset=utf-8',
   'Cache-Control':'no-store','Content-Disposition':`attachment; filename="clouddrive-manifest-${at.slice(0,10)}.json"`}});
 }

 if(path==='/api/v1/admin/audit-logs'&&method==='GET'){
  const url=new URL(req.url),limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||30));
  const before=url.searchParams.get('before');if(before&&!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(before))return error('INVALID_CURSOR','时间游标无效',400);
  const rows=await many(db,`SELECT a.id,a.action,a.target_type,a.target_id,a.created_at,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE (? IS NULL OR a.created_at<?) ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,[before,before,limit]);return ok({items:rows,next_before:rows.at(-1)?.created_at??null});
 }
 const m=/^\/api\/v1\/admin\/spaces\/([0-9a-f-]{36})\/quota$/.exec(path);
 if(m&&method==='PATCH'){
  const body=await jsonBody(req),value=body?.quota_bytes;if(!Number.isSafeInteger(value)||value<0||value>1024**4)return error('INVALID_INPUT','容量必须为非负整数（0 表示继承全局上限）',400);
  const s=await one(db,'SELECT used_bytes,reserved_bytes FROM spaces WHERE id=?',[m[1]]);if(!s)return error('NOT_FOUND','空间不存在',404);
  if(value!==0&&value<s.used_bytes+s.reserved_bytes)return error('QUOTA_CONFLICT','新上限小于空间已使用与预留容量',409);
  await execute(db,'UPDATE spaces SET quota_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[value,m[1]]);await audit(db,user.id,'space.quota.update','space',m[1],{quota_bytes:value});return ok({space_id:m[1],quota_bytes:value});
 }
 if(path==='/api/v1/admin/health'&&method==='GET'){
  const database=await one(db,'SELECT 1 AS ok');return ok({database:database?.ok===1,r2_private:Boolean(env.PRIVATE_BUCKET?.get),r2_public:Boolean(env.PUBLIC_BUCKET?.get),worker_version:env.APP_STAGE||'rc6',usage_source:'application_metadata',cloudflare_billing_verified:false});
 }
 if(path==='/api/v1/admin/uploads/recover'&&method==='POST'){
  const result=await runMaintenance(env,{source:'admin',actorId:user.id,tasks:['uploads','storage']});
  if(result.status==='skipped')return error('MAINTENANCE_BUSY','已有清理任务正在执行，请稍后重试',409);
  await audit(db,user.id,'upload.recovery.run','system',null,{run_id:result.run_id,status:result.status});
  return ok({uploads:result.results?.uploads||{attempted:0,cleaned:0,pending:0},storage:result.results?.storage||{attempted:0,cleaned:0},run_id:result.run_id,
   note:'只处理过期或停滞上传，并重试持久化清理任务；使用 RC9 同一维护任务锁。'});
 }
 if(path==='/api/v1/admin/version-operations'&&method==='GET'){
  const [sync,history,cleanup,usage]=await Promise.all([
   many(db,`SELECT status,COUNT(*) AS count,COALESCE(SUM(reserved_alias_bytes),0) AS reserved_bytes
      FROM publication_sync_jobs GROUP BY status`),
   one(db,`SELECT COUNT(*) AS count,COALESCE(SUM(v.size_bytes),0) AS logical_bytes
      FROM file_versions v WHERE EXISTS(SELECT 1 FROM storage_objects o WHERE o.id=v.object_id AND o.status='ready')`),
   one(db,`SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM storage_cleanup_jobs`),
   one(db,`SELECT COALESCE(SUM(used_bytes),0) AS used_bytes,COALESCE(SUM(reserved_bytes),0) AS reserved_bytes FROM spaces`)
  ]);
  return ok({sync_jobs:sync,private_history:history,cleanup_pending:cleanup,quota_ledger:usage,
   warnings:['统计来自 D1，历史对象可能被多个版本共同引用，不能简单相加。',
    'CDN_PURGE_NOT_CONFIGURED 时旧直链可能返回缓存；不要将 cache_unverified 视作全球一致。'],
   destructive_changes:false});
 }
 if(path==='/api/v1/admin/reconcile'&&method==='GET')return ok(await reconcileLedger(db));
 if(path==='/api/v1/admin/reconcile/objects'&&method==='GET'){
  const url=new URL(req.url);const type=url.searchParams.get('bucket');
  if(!['private','public'].includes(type))return error('INVALID_INPUT','bucket 必须是 private 或 public',400);
  const cursor=url.searchParams.get('cursor')||'';
  if(cursor.length>1024)return error('INVALID_CURSOR','游标过长',400);
  const raw=Number(url.searchParams.get('limit')||50);
  if(!Number.isSafeInteger(raw)||raw<1||raw>100)return error('INVALID_LIMIT','每页最多 100 个对象',400);
  try{return ok({bucket:type,...await scanR2Bucket(db,type==='private'?env.PRIVATE_BUCKET:env.PUBLIC_BUCKET,{cursor,limit:raw})});}
  catch(e){console.warn('R2 reconciliation scan unavailable',e);return error('R2_SCAN_FAILED','R2 容量扫描暂时不可用',503);}
 }
 return error('NOT_FOUND','接口不存在',404);
}
