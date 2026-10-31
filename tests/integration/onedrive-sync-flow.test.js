import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';
import {syncDuePublications,syncDeltaDrive,checkPublication,runOneDriveSynchronization} from '../../worker/services/onedrive-sync.js';
import {pruneOneDriveRecords} from '../../worker/services/onedrive-maintenance.js';
const A='odf_'+'e'.repeat(32),B='odf_'+'f'.repeat(32),DRIVE='drive!1';
const GRAPH='https://graph.microsoft.com/v1.0';
function seed(env){const stmt=env.DB.native.prepare('INSERT INTO onedrive_drive_publications (id,drive_id,item_id,file_name,file_size,file_mime,file_modified_at,source_etag) VALUES (?,?,?,?,?,?,?,?)');
 stmt.run(A,DRIVE,'item!1','original.txt',100,'text/plain','2026-10-20T12:00:00Z','v1');
 stmt.run(B,DRIVE,'item!2','other.txt',200,'text/plain','2026-10-20T12:00:00Z','v1');}
async function setup(t){const env=makeTestEnv();t.after(()=>env.DB.close());env.MS_TOKEN_KEY='c'.repeat(64);env.MS_CLIENT_ID='11111111-2222-4333-8444-555555555555';env.MS_CLIENT_SECRET='integration-only-test';const user=await initialize(env);seed(env);
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(env.MS_TOKEN_KEY.match(/../g),h=>parseInt(h,16)),'AES-GCM',false,['encrypt']);
 const iv=crypto.getRandomValues(new Uint8Array(12)),tokens={access_token:'fake-test-graph-token',refresh_token:'fake-refresh',expires_at:Date.now()+3600000};
 const raw=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(tokens)));
 const b64=btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 env.DB.native.prepare('INSERT INTO onedrive_oauth_account(id,encrypted_tokens,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)').run('admin',`${[...iv].map(x=>x.toString(16).padStart(2,'0')).join('')}:${b64}`);
 return {env,user};}
function mock(fn){return async(url,opts)=>{assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,'Bearer fake-test-graph-token');return fn(new URL(url));};}
const file=(id,etag='v1',size=100,name='original.txt')=>({id,file:{mimeType:'text/plain'},name,size,eTag:etag,lastModifiedDateTime:'2026-10-20T12:00:00Z'});

test('RC14.12 checks published items in small batches without changing IDs or published access rules',async t=>{
 const {env,user}=await setup(t);const calls=[];
 const fetcher=mock(url=>{calls.push(url.pathname);return Response.json(url.pathname.endsWith('item!1')?file('item!1','v2',110,'renamed.txt'):file('item!2','v1',200,'other.txt'));});
 const result=await syncDuePublications(env,{limit:1,fetcher});assert.equal(result.attempted,1);assert.equal(result.changed,1);
 const row=env.DB.query('SELECT id,file_name,file_size,source_etag,sync_status,last_change_at FROM onedrive_drive_publications WHERE id=?',A);
 assert.equal(row.id,A);assert.equal(row.file_name,'renamed.txt');assert.equal(row.source_etag,'v2');assert.equal(row.sync_status,'healthy');assert.ok(row.last_change_at);
 assert.equal(calls.length,1);
 assert.equal((await api(env,'/api/v1/admin/onedrive/sync/status')).status,401);
 assert.equal((await api(env,'/api/v1/admin/onedrive/sync/status',{cookie:user.cookie})).status,200);
 const r=await api(env,`/api/v1/public/onedrive/${A}`);assert.equal(r.status,200,'public share remains published');
});
test('RC14.12 deletion, throttling, backoff and recovery never auto-revoke shared files',async t=>{
 const {env}=await setup(t);let row=env.DB.query('SELECT * FROM onedrive_drive_publications WHERE id=?',A);
 const missing=await checkPublication(env,row,{fetcher:mock(()=>new Response('not found',{status:404}))});assert.equal(missing.status,'missing');
 assert.equal(env.DB.query('SELECT status,sync_status FROM onedrive_drive_publications WHERE id=?',A).status,'active');
 row=env.DB.query('SELECT * FROM onedrive_drive_publications WHERE id=?',A);
 const throttle=await checkPublication(env,row,{fetcher:mock(()=>new Response('throttle',{status:429,headers:{'Retry-After':'180'}}))});assert.equal(throttle.status,'throttled');assert.ok(throttle.retry_after_seconds>=180);
 row=env.DB.query('SELECT * FROM onedrive_drive_publications WHERE id=?',A);
 const recovered=await checkPublication(env,row,{fetcher:mock(()=>Response.json(file('item!1','v1',100)))});assert.equal(recovered.status,'healthy');assert.equal(recovered.restored,true);
 assert.ok(env.DB.query('SELECT COUNT(*) n FROM onedrive_sync_events').n>=2);
});
test('RC14.12 Delta creates a latest cursor without enumeration, processes only published IDs, and checkpoints one page',async t=>{
 const {env}=await setup(t);
 const deltaURL=`${GRAPH}/drives/${DRIVE}/root/delta`;
 const calls=[];
 const fetcher=mock(url=>{calls.push(url.href);
  if(url.searchParams.get('token')==='latest')return Response.json({value:[], '@odata.deltaLink':`${deltaURL}?token=one`});
  if(url.searchParams.get('token')==='one')return Response.json({value:[{id:'item!1',eTag:'v9',size:900},{id:'new!secret',file:{},name:'private.txt'}], '@odata.nextLink':`${deltaURL}?token=next`});
  return Response.json({value:[{id:'item!2',deleted:{state:'deleted'}}], '@odata.deltaLink':`${deltaURL}?token=two`});
 });
 let r=await syncDeltaDrive(env,{force:true,fetcher});assert.equal(r.processed,1);assert.equal(r.continuation,false);
 assert.equal(env.DB.query('SELECT COUNT(*) n FROM onedrive_drive_publications').n,2,'must not publish new items');
 r=await syncDeltaDrive(env,{force:true,fetcher});assert.equal(r.changed,1);assert.equal(r.continuation,true);
 assert.equal(env.DB.query('SELECT sync_status FROM onedrive_drive_publications WHERE id=?',A).sync_status,'changed');
 r=await syncDeltaDrive(env,{force:true,fetcher});assert.equal(r.deleted,1);
 assert.equal(env.DB.query('SELECT sync_status FROM onedrive_drive_publications WHERE id=?',B).sync_status,'missing');
 assert.equal(env.DB.query('SELECT COUNT(*) n FROM onedrive_drive_publications').n,2);
 assert.equal(calls.length,3);
});
test('RC14.12 Delta expired token resets to latest without exposing cursor and sync controls can be disabled',async t=>{
 const {env,user}=await setup(t);const url=`${GRAPH}/drives/${DRIVE}/root/delta`;
 env.DB.native.prepare('INSERT INTO onedrive_sync_drives(drive_id,delta_url) VALUES(?,?)').run(DRIVE,`${url}?token=expired`);
 const result=await syncDeltaDrive(env,{force:true,fetcher:mock(()=>new Response('',{status:410}))});assert.equal(result.reset,true);
 assert.equal(env.DB.query('SELECT delta_url FROM onedrive_sync_drives WHERE drive_id=?',DRIVE).delta_url,null);
 const stat=await api(env,'/api/v1/admin/onedrive/sync/status',{cookie:user.cookie});assert.equal(stat.status,200);assert.ok(!JSON.stringify(stat.data).includes('token=expired'));
 const patch=await api(env,'/api/v1/admin/settings',{method:'PATCH',cookie:user.cookie,body:{onedrive_sync_enabled:false}});assert.equal(patch.status,200);
 assert.equal((await runOneDriveSynchronization(env,{force:true,fetcher:mock(()=>{throw Error('must not fetch')})})).status,'disabled');
 env.DB.native.prepare("INSERT INTO onedrive_sync_events(id,kind,created_at) VALUES('old','failed',datetime('now','-100 days'))").run();
 const prune=await pruneOneDriveRecords(env.DB);assert.equal(prune.sync_events,1);
});
test('RC14.12 authenticated fallback streams Graph content only to a policy-permitted caller, not its OAuth header',async t=>{
 const {env,user}=await setup(t);const old=globalThis.fetch;let requests=[];
 globalThis.fetch=async(url,opt)=>{requests.push({url:String(url),headers:opt.headers});
  if(String(url).endsWith('/content'))return new Response('correct stream',{status:200,headers:{'Content-Type':'application/octet-stream','Content-Length':'14'}});
  return Response.json({id:'item!1',file:{mimeType:'text/plain'}});
 };
 t.after(()=>{globalThis.fetch=old});
 let r=await api(env,`/r/${A}`);assert.equal(r.status,200);assert.equal(await r.response.text(),'correct stream');assert.equal(requests.length,2);
 assert.ok(requests.every(x=>x.url.startsWith(GRAPH+'/drives/')));
 assert.ok(requests.every(x=>x.headers.Authorization==='Bearer fake-test-graph-token'));
 assert.equal(r.response.headers.get('Content-Disposition').startsWith('attachment;'),true);
 assert.equal(env.DB.query('SELECT download_count FROM onedrive_drive_publications WHERE id=?',A).download_count,1);
});

test('RC14.12 conditional Graph 304 avoids downloading metadata again, and does not consume new share IDs',async t=>{
 const {env}=await setup(t);
 const row=env.DB.query('SELECT * FROM onedrive_drive_publications WHERE id=?',A);
 const fetcher=mock((url)=>new Response(null,{status:304}));
 const result=await checkPublication(env,row,{fetcher});assert.equal(result.not_modified,true);
 assert.equal(env.DB.query('SELECT source_etag FROM onedrive_drive_publications WHERE id=?',A).source_etag,'v1');
 assert.equal(env.DB.query('SELECT sync_status FROM onedrive_drive_publications WHERE id=?',A).sync_status,'healthy');
});
test('RC14.12 rejects HTML disguised as Graph file content and does not charge a download',async t=>{
 const {env}=await setup(t);const old=globalThis.fetch;
 globalThis.fetch=async(url,opt)=>{
  if(String(url).endsWith('/content'))return new Response('<html>signin</html>',{status:200,headers:{'Content-Type':'text/html'}});
  return Response.json({id:'item!1',file:{mimeType:'text/plain'}});
 };
 t.after(()=>{globalThis.fetch=old});
 const result=await api(env,`/r/${A}`);assert.equal(result.status,502);
 assert.equal(env.DB.query('SELECT download_count FROM onedrive_drive_publications WHERE id=?',A).download_count,0);
});
