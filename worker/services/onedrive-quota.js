// D1 atomic counters enforce minute/hour/day limits in a single statement.
import {execute,many} from './database.js';
const windows=[['minute',60],['hour',3600],['day',86400]];
export async function quotaIdentity(req,user,env){
 if(user)return 'user:'+user.id;
 // CF-Connecting-IP is supplied by Cloudflare; don't trust arbitrary X-Forwarded-For.
 const ip=req.headers.get('CF-Connecting-IP');
 if(!ip) return 'guest:unknown'; // conservative shared bucket when no trusted IP exists
 const data=new TextEncoder().encode(String(env?.ONEDRIVE_QUOTA_SALT||'CloudDrive-OneDrive-IP-v1')+':'+ip);
 const hash=await crypto.subtle.digest('SHA-256',data);
 return 'guest:'+Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function enforceOneDriveQuota(db,req,user,s,env,now=Math.floor(Date.now()/1000)){
 const identity=await quotaIdentity(req,user,env),prefix=user?'onedrive_user_':'onedrive_guest_';
 const slots=windows.map(([name,seconds])=>({name,slot:Math.floor(now/seconds),limit:s[prefix+name+'_limit']}));
 // One atomic SQLite statement enforces all windows together.
 // D1 serializes writes so competing requests cannot overrun the limits.
 const values=slots.flatMap(x=>[identity,x.name,x.slot,x.limit]);
 const sql=`WITH limits(subject,kind,slot,cap) AS (VALUES (?,?,?,?),(?,?,?,?),(?,?,?,?))
 INSERT INTO onedrive_quota_counters(subject,window_name,window_slot,hits)
 SELECT subject,kind,slot,1 FROM limits
 WHERE NOT EXISTS (
  SELECT 1 FROM limits l LEFT JOIN onedrive_quota_counters c
  ON c.subject=l.subject AND c.window_name=l.kind AND c.window_slot=l.slot
  WHERE COALESCE(c.hits,0)>=l.cap
 )
 ON CONFLICT(subject,window_name,window_slot) DO UPDATE SET hits=hits+1`;
 const result=await execute(db,sql,values);
 return {allowed:result.meta?.changes===3};
}
export async function oneDriveStats(db){
 const rows=await many(db,`SELECT window_name,SUM(hits) hits,COUNT(DISTINCT subject) subjects FROM onedrive_quota_counters
 WHERE (window_name='minute' AND window_slot=CAST(strftime('%s','now') AS INTEGER)/60)
 OR (window_name='hour' AND window_slot=CAST(strftime('%s','now') AS INTEGER)/3600)
 OR (window_name='day' AND window_slot=CAST(strftime('%s','now') AS INTEGER)/86400)
 GROUP BY window_name`);
 return {windows:rows,counts_include_format_checks:true,personal_data_excluded:true};
}
