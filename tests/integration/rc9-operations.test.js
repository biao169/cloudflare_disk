import test from 'node:test';
import assert from 'node:assert/strict';
import {api,makeTestEnv,initialize} from './support.js';
import {recordIncident,runMaintenance} from '../../worker/services/operations.js';

const path='/api/v1/admin/';
test('RC9 dashboard requires admin and reports accounting, backup warning',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 assert.equal((await api(env,path+'dashboard')).status,401);
 const {cookie}=await initialize(env);
 const r=await api(env,path+'dashboard',{cookie});
 assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal(r.data.data.usage_source,'D1 application ledger');
 assert.equal(r.data.data.cloudflare_billing_verified,false);
 assert.ok(r.data.data.alerts.some(x=>x.code==='BACKUP_NOT_RECORDED'));
 assert.equal(r.data.data.settings.quota_warn_percent,85);
});

test('RC9 incidents are grouped and can be acknowledged only by admins',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);
 assert.equal(await recordIncident(env,{source:'api',code:'DATABASE_UNAVAILABLE'}),true);
 assert.equal(await recordIncident(env,{source:'api',code:'DATABASE_UNAVAILABLE'}),true);
 const log=env.DB.query("SELECT * FROM operational_events WHERE source='api'");
 assert.equal(log.occurrences,2);
 assert.equal(log.message.includes('secret'),false);
 let result=await api(env,path+'operations/events?page=1&limit=5',{cookie});
 assert.equal(result.status,200);assert.equal(result.data.data.items[0].occurrences,2);
 assert.equal((await api(env,path+`operations/events/${log.id}/ack`,{method:'POST'})).status,401);
 result=await api(env,path+`operations/events/${log.id}/ack`,{method:'POST',cookie});
 assert.equal(result.status,200,JSON.stringify(result.data));
 assert.ok(env.DB.query('SELECT acknowledged_at AS ts FROM operational_events WHERE id=?',log.id).ts);
 assert.equal((await api(env,path+`operations/events/${log.id}/ack`,{method:'POST',cookie})).status,404);
});

test('RC9 cron and manual cleanup have a D1 lease and retain runs',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);
 const first=await api(env,path+'maintenance/run',{method:'POST',cookie});
 assert.equal(first.status,200,JSON.stringify(first.data));
 assert.equal(first.data.data.status,'completed');
 assert.ok(first.data.data.results.history_pruned);
 const runs=await api(env,path+'maintenance/runs',{cookie});
 assert.equal(runs.data.data.items.length,1);
 assert.equal(runs.data.data.items[0].source,'admin');
 env.DB.native.prepare("UPDATE maintenance_lock SET lease_token=?,lease_until=datetime('now','+30 minutes') WHERE id=1").run('someone-else');
 const busy=await runMaintenance(env,{source:'cron'});
 assert.equal(busy.status,'skipped');assert.equal(busy.reason,'MAINTENANCE_BUSY');
 env.DB.native.exec('UPDATE maintenance_lock SET lease_token=NULL,lease_until=NULL WHERE id=1');
 const settings=await api(env,path+'settings',{method:'PATCH',cookie,body:{maintenance_paused:true,incident_retention_days:14,backup_reminder_days:7,quota_warn_percent:90}});
 assert.equal(settings.status,200,JSON.stringify(settings.data));
 const paused=await runMaintenance(env,{source:'cron'});assert.equal(paused.reason,'MAINTENANCE_PAUSED');
 const manual=await runMaintenance(env,{source:'admin'});assert.equal(manual.status,'completed');
});

test('RC9 backup manifests explicitly exclude actual backup material',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);
 const r=await api(env,path+'backups/manifest',{cookie});
 assert.equal(r.status,200);
 const manifest=JSON.parse(await r.response.text());
 assert.equal(manifest.not_a_backup,true);
 assert.equal(manifest.kind,'CLOUDDRIVE_METADATA_MANIFEST');
 assert.equal(manifest.generated_at.length>10,true);
 assert.equal(JSON.stringify(manifest).includes(env.BOOTSTRAP_TOKEN),false);
 assert.match(r.response.headers.get('content-disposition'),/attachment/);
});

test('RC9 backups can be registered, but are explicitly unverified',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);
 const invalid=await api(env,path+'backups/records',{method:'POST',cookie,body:{backup_type:'made_up',destination_label:'anything'}});
 assert.equal(invalid.status,400);
 const saved=await api(env,path+'backups/records',{method:'POST',cookie,body:{backup_type:'d1_and_r2',destination_label:'encrypted external storage',notes:'offsite'}});
 assert.equal(saved.status,201,JSON.stringify(saved.data));assert.equal(saved.data.data.verified,false);
 const listing=await api(env,path+'backups/records',{cookie});assert.equal(listing.status,200);
 assert.equal(listing.data.data.items.length,1);
 const dashboard=await api(env,path+'dashboard',{cookie});
 assert.ok(!dashboard.data.data.alerts.some(x=>x.code==='BACKUP_NOT_RECORDED'));
});

test('RC9 maintenance expires old incident history without touching user records',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);
 const userCount=env.DB.query('SELECT COUNT(*) AS c FROM users').c;
 env.DB.native.prepare("INSERT INTO operational_events(id,hour_bucket,source,code,level,message,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,'2022-01-01','2022-01-01')").run(crypto.randomUUID(),'2022-01-01T10','api','OLD_ERROR','error','old');
 const result=await api(env,path+'maintenance/run',{method:'POST',cookie});assert.equal(result.status,200);
 assert.equal(env.DB.query("SELECT COUNT(*) AS c FROM operational_events WHERE code='OLD_ERROR'").c,0);
 assert.equal(env.DB.query('SELECT COUNT(*) AS c FROM users').c,userCount);
});

test('RC9 large folder trash purge progresses across bounded requests without losing unrelated files',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const {cookie,userId,spaceId}=await initialize(env);
 const root=await api(env,'/api/v1/folders',{method:'POST',cookie,body:{space_id:spaceId,name:'archive-folder'}});
 assert.equal(root.status,201,JSON.stringify(root.data));const folderId=root.data.data.id;
 for(let i=0;i<5;i++){
  const objectId=crypto.randomUUID(),fileId=crypto.randomUUID(),key=`private/${spaceId}/${objectId}`;
  await env.PRIVATE_BUCKET.put(key,new TextEncoder().encode('abcd'));
  env.DB.native.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'private',?,4,'ready')").run(objectId,key);
  env.DB.native.prepare("INSERT INTO files(id,space_id,folder_id,name,object_id,size_bytes,status,created_by) VALUES(?,?,?,?,?,4,'ready',?)").run(fileId,spaceId,folderId,`record-${i}.txt`,objectId,userId);
 }
 env.DB.native.prepare('UPDATE spaces SET used_bytes=20 WHERE id=?').run(spaceId);
 for(let i=0;i<4;i++){
  const r=await api(env,'/api/v1/folders',{method:'POST',cookie,body:{space_id:spaceId,parent_id:folderId,name:`sub-${i}`}});
  assert.equal(r.status,201,JSON.stringify(r.data));
 }
 const trashed=await api(env,'/api/v1/trash',{method:'POST',cookie,body:{target_type:'folder',target_id:folderId}});
 assert.equal(trashed.status,200,JSON.stringify(trashed.data));
 const trashId=trashed.data.data.trash_id;
 const counts=[];let lastStatus=0;
 for(let i=0;i<12;i++){
  const purge=await api(env,`/api/v1/trash/${trashId}/purge`,{method:'DELETE',cookie});
  assert.ok([200,202].includes(purge.status),JSON.stringify(purge.data));
  const count=env.DB.query('SELECT COUNT(*) AS c FROM files WHERE folder_id=?',folderId).c;counts.push(count);
  lastStatus=purge.status;if(lastStatus===200)break;
 }
 assert.ok(counts[0]>=3,'does not purge all 5 files in one request');
 assert.equal(lastStatus,200);
 assert.equal(env.DB.query('SELECT COUNT(*) AS c FROM files WHERE space_id=?',spaceId).c,0);
 assert.equal(env.DB.query('SELECT COUNT(*) AS c FROM folders WHERE id=?',folderId).c,0);
 assert.equal(env.DB.query('SELECT COUNT(*) AS c FROM trash_entries WHERE id=?',trashId).c,0);
 assert.equal(env.DB.query('SELECT used_bytes AS u FROM spaces WHERE id=?',spaceId).u,0);
});

test('RC9 scheduled handler persists maintenance history and respects pause setting',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);
 const worker=(await import('../../worker/index.js')).default;
 const promises=[];
 await worker.scheduled({cron:'0 */6 * * *'},env,{waitUntil:p=>promises.push(p)});
 await Promise.all(promises);
 assert.equal(env.DB.query('SELECT COUNT(*) AS c FROM maintenance_runs').c,1);
 const change=await api(env,path+'settings',{method:'PATCH',cookie,body:{maintenance_paused:true}});
 assert.equal(change.status,200);
 const promises2=[];await worker.scheduled({cron:'0 */6 * * *'},env,{waitUntil:p=>promises2.push(p)});
 await Promise.all(promises2);
 assert.equal(env.DB.query('SELECT COUNT(*) AS c FROM maintenance_runs').c,1);
});
