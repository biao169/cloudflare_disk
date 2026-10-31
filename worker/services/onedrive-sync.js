// RC14.12: incremental Microsoft Graph Delta plus bounded individual publication verification.
// File bytes and preauthenticated download URLs are NEVER stored; new OneDrive items are NEVER auto-published.
import {dbFromEnv,one,many,execute} from './database.js';
import {getAccessToken} from './onedrive-oauth.js';

const GRAPH='https://graph.microsoft.com';
const ID=/^[A-Za-z0-9_!.-]{1,220}$/;
const PUB=/^odf_[a-f0-9]{32}$/;
const CODE=/^[A-Z][A-Z0-9_]{2,47}$/;
const UTC_AFTER=(ms)=>new Date(Date.now()+ms).toISOString().slice(0,19).replace('T',' ');
const clean=(s,n=500)=>typeof s==='string'&&s.length<=n?s:null;
const BATCH_MAX=20;

export function retryAfterSeconds(header,now=Date.now()){
 if(typeof header!=='string'||header.length>100)return null;
 if(/^\d+$/.test(header.trim()))return Math.min(3600,Math.max(1,Number(header.trim())));
 const date=Date.parse(header);return Number.isFinite(date)?Math.min(3600,Math.max(1,Math.ceil((date-now)/1000))):null;
}
export function safeDeltaUrl(raw,driveId){
 if(typeof raw!=='string'||raw.length>7000||!ID.test(driveId))return false;
 try{const u=new URL(raw);if(u.origin!==GRAPH||u.port||u.username||u.password||u.hash)return false;
  const base=`/v1.0/drives/${encodeURIComponent(driveId)}/root/delta`;
  // Graph may return delta(token=...) URLs as well as ?token=... links.
  return (u.pathname===base||u.pathname.startsWith(base+'(')&&u.pathname.endsWith(')')) && !u.searchParams.has('url');
 }catch{return false;}
}
function failStatus(status){return status===404?'missing':status===403?'denied':status===401?'reauthorize':status===429||status===503?'throttled':'error';}
export class GraphSyncError extends Error {
 constructor(code,status=0,retryAfter=null){super(code);this.code=code;this.status=status;this.retryAfter=retryAfter;}
}
export async function getGraphJson(env,url,{fetcher=fetch,etag=null}={}){
 // No arbitrary Graph proxy; the caller supplies either our verified Delta URL or generated /drives/{id}/items/{id}.
 const u=new URL(url);
 if(u.origin!==GRAPH||!u.pathname.startsWith('/v1.0/drives/')||u.username||u.password||u.port||u.hash)throw new GraphSyncError('INVALID_GRAPH_URL');
 const token=await getAccessToken(env);
 const requestHeaders={Authorization:`Bearer ${token}`,Accept:'application/json'};
 if(typeof etag==='string'&&etag.length>0&&etag.length<500&&!/[\r\n]/.test(etag))requestHeaders['If-None-Match']=etag;
 let res;
 try{res=await fetcher(u.href,{method:'GET',headers:requestHeaders,redirect:'manual',signal:AbortSignal.timeout(12000)});}
 catch{throw new GraphSyncError('GRAPH_TIMEOUT');}
 if(res.status===304&&requestHeaders['If-None-Match'])return {notModified:true};
 if(!res.ok){const status=res.status;throw new GraphSyncError(status===429?'GRAPH_THROTTLED':status===503?'GRAPH_UNAVAILABLE':status===401?'GRAPH_REAUTHORIZE':status===403?'GRAPH_DENIED':status===404?'GRAPH_NOT_FOUND':status===410?'GRAPH_DELTA_EXPIRED':'GRAPH_UPSTREAM_FAILED',status,retryAfterSeconds(res.headers.get('Retry-After')));}
 const size=Number(res.headers.get('Content-Length')||0);if(size>2*1024*1024)throw new GraphSyncError('GRAPH_RESPONSE_TOO_LARGE');
 try{const body=await res.text();if(body.length>2*1024*1024)throw new GraphSyncError('GRAPH_RESPONSE_TOO_LARGE');return JSON.parse(body);}catch(e){if(e instanceof GraphSyncError)throw e;throw new GraphSyncError('GRAPH_BAD_JSON');}
}
const graphPath=(drive,item)=>`${GRAPH}/v1.0/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}?$select=id,name,size,file,folder,eTag,lastModifiedDateTime`;
const deltaBase=drive=>`${GRAPH}/v1.0/drives/${encodeURIComponent(drive)}/root/delta`;
const statusError=e=>e instanceof GraphSyncError?failStatus(e.status):/ONEDRIVE_NOT_CONNECTED|MICROSOFT_TOKEN|OFFLINE_ACCESS|CORRUPT_CREDENTIAL|REAUTHORIZE/.test(String(e?.message))?'reauthorize':'error';
function backoffMs(status,streak,retryAfter){
 if(status==='throttled')return Math.max(60000,(retryAfter||Math.min(3600,60*2**Math.min(6,streak)))*1000);
 if(status==='missing'||status==='denied'||status==='reauthorize')return 6*3600000;
 return Math.min(6*3600000,300000*2**Math.min(streak,6));
}
async function event(db,id,kind,code=null){if(!['changed','missing','restored','authorization','throttled','delta_reset','failed'].includes(kind))return;
 await execute(db,'INSERT INTO onedrive_sync_events(id,publication_id,kind,code) VALUES(?,?,?,?)',[crypto.randomUUID(),id||null,kind,CODE.test(code||'')?code:null]);}
export function sourceChanged(row,item){
 if(typeof item?.eTag==='string'&&row.source_etag&&item.eTag!==row.source_etag)return true;
 if(typeof item?.name==='string'&&row.file_name&&item.name!==row.file_name)return true;
 if(Number.isSafeInteger(item?.size)&&row.file_size!==null&&Number(item.size)!==Number(row.file_size))return true;
 if(item?.lastModifiedDateTime&&row.file_modified_at&&item.lastModifiedDateTime!==row.file_modified_at)return true;
 return false;
}
export async function checkPublication(env,row,{intervalHours=6,fetcher=fetch}={}){
 const db=dbFromEnv(env);
 if(!row||!PUB.test(row.id))throw Error('INVALID_PUBLICATION');
 try{
  if(!ID.test(row.drive_id)||!ID.test(row.item_id))throw new GraphSyncError('INVALID_STORED_ID');
  const data=await getGraphJson(env,graphPath(row.drive_id,row.item_id),{fetcher,etag:row.source_etag});
  if(data?.notModified){
   await execute(db,`UPDATE onedrive_drive_publications SET sync_status='healthy',sync_error_code=NULL,sync_error_streak=0,last_checked_at=CURRENT_TIMESTAMP,next_check_at=? WHERE id=? AND status='active'`,[UTC_AFTER(intervalHours*3600000),row.id]);
   if(['missing','denied','reauthorize','error','throttled'].includes(row.sync_status))await event(db,row.id,'restored','SOURCE_ACCESS_RESTORED');
   return {id:row.id,status:'healthy',changed:false,not_modified:true};
  }
  if(data?.id!==row.item_id||!data.file||data.folder)throw new GraphSyncError('GRAPH_SOURCE_NOT_FILE',404);
  const changed=sourceChanged(row,data),restored=['missing','denied','reauthorize','error','throttled'].includes(row.sync_status);
  const next=UTC_AFTER(intervalHours*3600000);
  await execute(db,`UPDATE onedrive_drive_publications SET source_etag=?,file_name=?,file_size=?,file_mime=?,file_modified_at=?,
    sync_status='healthy',sync_error_code=NULL,sync_error_streak=0,last_checked_at=CURRENT_TIMESTAMP,next_check_at=?,
    last_change_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE last_change_at END
    WHERE id=? AND status='active'`,[clean(data.eTag),clean(data.name,255)||row.file_name,Number.isSafeInteger(data.size)?data.size:row.file_size,clean(data.file?.mimeType,255)||row.file_mime,clean(data.lastModifiedDateTime,100)||row.file_modified_at,next,changed?1:0,row.id]);
  if(changed)await event(db,row.id,'changed','SOURCE_METADATA_CHANGED');
  else if(restored)await event(db,row.id,'restored','SOURCE_ACCESS_RESTORED');
  return {id:row.id,status:'healthy',changed,restored};
 }catch(e){const status=statusError(e),streak=Math.min(12,(Number(row.sync_error_streak)||0)+1),delay=backoffMs(status,streak,e.retryAfter);
  const code=e instanceof GraphSyncError?e.code:status==='reauthorize'?'GRAPH_REAUTHORIZE':'GRAPH_CHECK_FAILED';
  await execute(db,`UPDATE onedrive_drive_publications SET sync_status=?,sync_error_code=?,sync_error_streak=?,last_checked_at=CURRENT_TIMESTAMP,next_check_at=? WHERE id=? AND status='active'`,[status,code,streak,UTC_AFTER(delay),row.id]);
  if(status!==row.sync_status)await event(db,row.id,status==='missing'?'missing':status==='reauthorize'?'authorization':status==='throttled'?'throttled':'failed',code);
  return {id:row.id,status,error_code:code,retry_after_seconds:Math.ceil(delay/1000)};
 }
}
export async function syncDuePublications(env,{force=false,limit=8,intervalHours=6,fetcher=fetch}={}){
 const db=dbFromEnv(env),count=Math.max(1,Math.min(BATCH_MAX,Math.trunc(limit)||8));
 const rows=await many(db,`SELECT id,drive_id,item_id,source_etag,file_name,file_size,file_mime,file_modified_at,sync_status,sync_error_streak FROM onedrive_drive_publications
    WHERE status='active' ${force?'':'AND next_check_at<=CURRENT_TIMESTAMP'} ORDER BY ${force?"COALESCE(last_checked_at,'')":"next_check_at"} ASC,id ASC LIMIT ?`,[count]);
 const summary={attempted:0,healthy:0,changed:0,failed:0,reauthorize:0,throttled:0};
 for(const row of rows){
  const r=await checkPublication(env,row,{intervalHours,fetcher});summary.attempted++;
  if(r.status==='healthy'){summary.healthy++;if(r.changed)summary.changed++;}else{summary.failed++;if(r.status==='reauthorize')summary.reauthorize++;if(r.status==='throttled')summary.throttled++;}
  // Do not hammer the same account once Microsoft requests a pause or new consent.
  if(r.status==='throttled'||r.status==='reauthorize')break;
 }
 return summary;
}
// Per drive bounded Delta continuation. One page is processed and checkpointed per run; no full-drive enumeration.
export async function syncDeltaDrive(env,{force=false,intervalHours=6,fetcher=fetch}={}){
 const db=dbFromEnv(env);
 // Register at most 30 NEW drives per run; excluding already registered drives avoids starving later ones.
 const drives=await many(db,`SELECT DISTINCT p.drive_id FROM onedrive_drive_publications p
    WHERE p.status='active' AND NOT EXISTS(SELECT 1 FROM onedrive_sync_drives s WHERE s.drive_id=p.drive_id)
    ORDER BY p.drive_id LIMIT 30`);
 for(const d of drives){if(!ID.test(d.drive_id))continue;
  await execute(db,'INSERT OR IGNORE INTO onedrive_sync_drives(drive_id) VALUES(?)',[d.drive_id]);
 }
 const drive=await one(db,`SELECT s.* FROM onedrive_sync_drives s WHERE EXISTS(SELECT 1 FROM onedrive_drive_publications p WHERE p.drive_id=s.drive_id AND p.status='active')
  ${force?'':'AND s.next_scan_at<=CURRENT_TIMESTAMP'} ORDER BY s.next_scan_at,s.drive_id LIMIT 1`);
 if(!drive)return {processed:0,reason:'NO_DUE_DRIVE'};
 const url=drive.delta_url||deltaBase(drive.drive_id)+'?token=latest';
 if(!safeDeltaUrl(url,drive.drive_id))throw Error('INVALID_STORED_DELTA_URL');
 try{
  const data=await getGraphJson(env,url,{fetcher});
  const next=data?.['@odata.nextLink'],checkpoint=data?.['@odata.deltaLink'];
  if(!Array.isArray(data?.value)||data.value.length>1000||!(next||checkpoint)||next&&!safeDeltaUrl(next,drive.drive_id)||checkpoint&&!safeDeltaUrl(checkpoint,drive.drive_id))throw new GraphSyncError('INVALID_DELTA_RESPONSE');
  let changes=0,missing=0;
  for(const item of data.value){if(!item||!ID.test(item.id))continue;
   const stored=await many(db,"SELECT id,source_etag,file_name,file_size,file_modified_at,sync_status FROM onedrive_drive_publications WHERE status='active' AND drive_id=? AND item_id=? LIMIT 100",[drive.drive_id,item.id]);
   for(const row of stored){
    if(item.deleted){
     await execute(db,"UPDATE onedrive_drive_publications SET sync_status='missing',sync_error_code='SOURCE_DELETED',last_checked_at=CURRENT_TIMESTAMP,next_check_at=? WHERE id=? AND status='active'",[UTC_AFTER(6*3600000),row.id]);
     if(row.sync_status!=='missing')await event(db,row.id,'missing','SOURCE_DELETED');missing++;
    }else if(sourceChanged(row,item)){
     await execute(db,"UPDATE onedrive_drive_publications SET sync_status='changed',next_check_at=CURRENT_TIMESTAMP,last_change_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'",[row.id]);
     if(row.sync_status!=='changed')await event(db,row.id,'changed','SOURCE_DELTA_CHANGED');changes++;
    }
   }
  }
  // Commit the continuation only after all matching publications have been processed.
  await execute(db,`UPDATE onedrive_sync_drives SET delta_url=?,last_checked_at=CURRENT_TIMESTAMP,
    last_completed_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE last_completed_at END,next_scan_at=?,last_error_code=NULL,error_streak=0,updated_at=CURRENT_TIMESTAMP WHERE drive_id=?`,
   [next||checkpoint,checkpoint?1:0,UTC_AFTER(checkpoint?intervalHours*3600000:60000),drive.drive_id]);
  return {processed:1,pages:1,changed:changes,deleted:missing,continuation:!!next};
 }catch(e){
  const code=e instanceof GraphSyncError?e.code:'GRAPH_DELTA_FAILED';const status=statusError(e);
  if(e.status===410){ // Delta token is expired; re-establish latest baseline, let direct checks handle existing files.
   await execute(db,"UPDATE onedrive_sync_drives SET delta_url=NULL,last_error_code='GRAPH_DELTA_EXPIRED',next_scan_at=CURRENT_TIMESTAMP,error_streak=0,updated_at=CURRENT_TIMESTAMP WHERE drive_id=?",[drive.drive_id]);
   await event(db,null,'delta_reset','GRAPH_DELTA_EXPIRED');return {processed:1,reset:true};
  }
  const streak=Math.min(12,(drive.error_streak||0)+1);
  await execute(db,'UPDATE onedrive_sync_drives SET last_error_code=?,error_streak=?,last_checked_at=CURRENT_TIMESTAMP,next_scan_at=?,updated_at=CURRENT_TIMESTAMP WHERE drive_id=?',
   [code,streak,UTC_AFTER(backoffMs(status,streak,e.retryAfter)),drive.drive_id]);
  return {processed:1,error_code:code,retry_pending:true};
 }
}
export async function runOneDriveSynchronization(env,{force=false,fetcher=fetch}={}){
 const {settings}=await import('./admin.js');const cfg=await settings(dbFromEnv(env));
 if(!cfg.onedrive_sync_enabled)return {status:'disabled'};
 const due=await syncDuePublications(env,{force,limit:cfg.onedrive_sync_batch_limit,intervalHours:cfg.onedrive_sync_interval_hours,fetcher});
 const delta=cfg.onedrive_delta_enabled&&due.reauthorize===0&&due.throttled===0?await syncDeltaDrive(env,{force,intervalHours:cfg.onedrive_sync_interval_hours,fetcher}):{processed:0,reason:'DISABLED_OR_THROTTLED'};
 return {status:due.failed||delta.error_code?'partial':'completed',due,delta,files_not_copied:true,new_files_not_published:true};
}
export async function oneDriveSyncStatus(db){
 const [rows,drives,events]=await Promise.all([
  many(db,"SELECT sync_status,COUNT(*) total FROM onedrive_drive_publications WHERE status='active' GROUP BY sync_status"),
  many(db,"SELECT drive_id,last_checked_at,last_completed_at,last_error_code,delta_url IS NOT NULL AS initialized FROM onedrive_sync_drives ORDER BY last_checked_at DESC LIMIT 20"),
  many(db,"SELECT publication_id,kind,code,created_at FROM onedrive_sync_events ORDER BY created_at DESC,id DESC LIMIT 20")
 ]);
 return {status_counts:Object.fromEntries(rows.map(r=>[r.sync_status,r.total])),drives:drives.map(({drive_id,...safe})=>safe),events,source:'D1 (not live Microsoft)',temporary_download_urls_stored:false};
}
export async function checkMicrosoftAuthorization(env,{fetcher=fetch}={}){
 try{
  const token=await getAccessToken(env);
  const res=await fetcher(`${GRAPH}/v1.0/me/drive?$select=id,driveType`,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000)});
  if(!res.ok)throw new GraphSyncError(res.status===401?'GRAPH_REAUTHORIZE':res.status===403?'GRAPH_DENIED':res.status===429?'GRAPH_THROTTLED':'GRAPH_UNAVAILABLE',res.status,retryAfterSeconds(res.headers.get('Retry-After')));
  const data=await res.json();
  return {healthy:!!data?.id,drive_type:['personal','business','documentLibrary'].includes(data.driveType)?data.driveType:'unknown',checked_at:new Date().toISOString()};
 }catch(e){return {healthy:false,code:e instanceof GraphSyncError?e.code:'GRAPH_REAUTHORIZE',retry_after_seconds:e.retryAfter||null,checked_at:new Date().toISOString()};}
}

