import {one,many,execute,dbFromEnv} from './database.js';
export const SETTING_KEYS=['site_name','max_storage_bytes','default_share_days','trash_retention_days','uploads_enabled','public_shares_enabled','quota_warn_percent','maintenance_paused','incident_retention_days','backup_reminder_days'];
export const DEFAULT_SETTINGS={site_name:'CloudDrive',max_storage_bytes:8*1024*1024*1024,default_share_days:7,trash_retention_days:7,uploads_enabled:true,public_shares_enabled:true,quota_warn_percent:85,maintenance_paused:false,incident_retention_days:30,backup_reminder_days:7};
export function validateSettings(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const out={};
 for(const [key,val] of Object.entries(input)){
  if(!SETTING_KEYS.includes(key))return null;
  if(key==='site_name'){if(typeof val!=='string'||val.trim().length<1||val.length>80)return null;out[key]=val.trim();}
  else if(key==='max_storage_bytes'){if(!Number.isSafeInteger(val)||val<1024*1024||val>1024**4)return null;out[key]=val;}
  else if(['default_share_days','trash_retention_days'].includes(key)){if(!Number.isInteger(val)||val<1||val>365)return null;out[key]=val;}
  else if(key==='quota_warn_percent'){if(!Number.isInteger(val)||val<50||val>99)return null;out[key]=val;}
  else if(key==='incident_retention_days'){if(!Number.isInteger(val)||val<7||val>90)return null;out[key]=val;}
  else if(key==='backup_reminder_days'){if(!Number.isInteger(val)||val<1||val>30)return null;out[key]=val;}
  else {if(typeof val!=='boolean')return null;out[key]=val;}
 }
 return Object.keys(out).length?out:null;
}
export async function settings(db){const rows=await many(db,`SELECT key,value_json FROM app_settings WHERE key IN (${SETTING_KEYS.map(()=>'?').join(',')})`,SETTING_KEYS);const s={...DEFAULT_SETTINGS};for(const r of rows){try{s[r.key]=JSON.parse(r.value_json)}catch{}}return s;}
export async function metrics(db){
 const [totals,perSpace,stats,shares]=await Promise.all([
  one(db,'SELECT COALESCE(SUM(used_bytes),0) used_bytes,COALESCE(SUM(reserved_bytes),0) reserved_bytes, COUNT(*) spaces FROM spaces'),
  many(db,'SELECT id,name,type,quota_bytes,used_bytes,reserved_bytes FROM spaces ORDER BY type,name LIMIT 100'),
  one(db,"SELECT COUNT(*) AS files,COALESCE(SUM(size_bytes),0) AS logical_bytes FROM files WHERE status='ready' AND deleted_at IS NULL"),
  one(db,"SELECT COUNT(*) AS total, SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) THEN 1 ELSE 0 END) AS active FROM shares")]);
 return {totals,spaces:perSpace,files:stats,shares};
}
export async function audit(db,actor,action,type,id,detail={}){try{await execute(db,'INSERT INTO audit_logs(id,actor_id,action,target_type,target_id,detail_json) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),actor,action,type,id,JSON.stringify(detail).slice(0,2000)]);}catch(e){console.error('audit logging failed',e);}}
// D1 serializes writes: aggregate quota predicate evaluated during conditional UPDATE.
// Account cap applies to all spaces combined, including pending reservations.
export const RESERVE_SQL=`UPDATE spaces SET reserved_bytes=reserved_bytes+? WHERE id=?
 AND used_bytes+reserved_bytes+?<=CASE WHEN quota_bytes>0 THEN quota_bytes ELSE
 COALESCE((SELECT CAST(json_extract(value_json,'$') AS INTEGER) FROM app_settings WHERE key='max_storage_bytes'),?) END
 AND (SELECT COALESCE(SUM(used_bytes+reserved_bytes),0) FROM spaces)+? <=
 COALESCE((SELECT CAST(json_extract(value_json,'$') AS INTEGER) FROM app_settings WHERE key='max_storage_bytes'),?)`;
export async function publicStatus(db){const s=await settings(db);return {site_name:s.site_name,uploads_enabled:s.uploads_enabled};}
