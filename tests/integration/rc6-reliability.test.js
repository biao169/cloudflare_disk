import test from 'node:test';
import assert from 'node:assert/strict';
import {api,initialize,makeTestEnv} from './support.js';
import {cleanupExpired} from '../../worker/services/multipart.js';
import {cleanupPendingStorage} from '../../worker/services/cleanup.js';
import {reconcileLedger} from '../../worker/services/reconcile.js';
import {readFileSync} from 'node:fs';

const body=new TextEncoder();
async function login(env,username,password){const r=await api(env,'/api/v1/auth/login',{method:'POST',body:{username,password}});assert.equal(r.status,200,JSON.stringify(r.data));return r.response.headers.get('set-cookie').split(';')[0];}
async function addMember(env,admin,spaceId,role='editor'){
 const pwd='editor-safe-password-12345';
 const created=await api(env,'/api/v1/users',{method:'POST',cookie:admin,body:{username:'editor01',password:pwd}});
 assert.equal(created.status,201,JSON.stringify(created.data));
 const id=created.data.data.id;
 const add=await api(env,`/api/v1/spaces/${spaceId}/members/${id}`,{method:'PUT',cookie:admin,body:{role}});
 assert.equal(add.status,200,JSON.stringify(add.data));
 return {id,cookie:await login(env,'editor01',pwd)};
}
async function file(env,cookie,spaceId,name='report.pdf'){
 const bytes=body.encode('%PDF-1.7\nreport');
 const r=await api(env,`/api/v1/storage/upload?space_id=${spaceId}&name=${name}`,{method:'POST',cookie,body:bytes,headers:{'Content-Type':'application/pdf'}});
 assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;
}
async function share(env,cookie,fid,type='temporary'){
 const r=await api(env,'/api/v1/shares',{method:'POST',cookie,body:{type,target_type:'file',target_id:fid,expires_at:new Date(Date.now()+86400000).toISOString()}});
 assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.url;
}

test('RC6 team: member removal revokes old links, including those already issued',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const admin=await initialize(env);
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:admin.cookie,body:{name:'Project Team'}});
 assert.equal(team.status,201);const sid=team.data.data.id;
 const m=await addMember(env,admin.cookie,sid);const fid=await file(env,m.cookie,sid);
 const url=await share(env,m.cookie,fid);
 assert.equal((await api(env,new URL(url).pathname)).status,200);
 const del=await api(env,`/api/v1/spaces/${sid}/members/${m.id}`,{method:'DELETE',cookie:admin.cookie});assert.equal(del.status,200);
 assert.equal((await api(env,new URL(url).pathname)).status,404);
 assert.ok(env.DB.query('SELECT revoked_at FROM shares WHERE created_by=?',m.id).revoked_at);
});

test('RC6 team: downgrade viewer and live folder ACL revoke old shares',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const admin=await initialize(env);
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:admin.cookie,body:{name:'Team'}});const sid=team.data.data.id;
 const member=await addMember(env,admin.cookie,sid),fid=await file(env,member.cookie,sid);
 const url=await share(env,member.cookie,fid);
 const downgraded=await api(env,`/api/v1/spaces/${sid}/members/${member.id}`,{method:'PUT',cookie:admin.cookie,body:{role:'viewer'}});
 assert.equal(downgraded.status,200);assert.equal((await api(env,new URL(url).pathname)).status,404);
 const edit=await api(env,`/api/v1/spaces/${sid}/members/${member.id}`,{method:'PUT',cookie:admin.cookie,body:{role:'editor'}});assert.equal(edit.status,200);
 const folder=await api(env,'/api/v1/folders',{method:'POST',cookie:admin.cookie,body:{space_id:sid,name:'Protected'}});const folderId=folder.data.data.id;
 const moved=await api(env,`/api/v1/files/${fid}/move`,{method:'POST',cookie:admin.cookie,body:{target_folder_id:folderId}});
 assert.equal(moved.status,200,JSON.stringify(moved.data));
 const newer=await share(env,member.cookie,fid);
 assert.equal((await api(env,new URL(newer).pathname)).status,200);
 const deny=await api(env,`/api/v1/folders/${folderId}/permissions`,{method:'PUT',cookie:admin.cookie,body:{principal_type:'user',principal_id:member.id,permission_mask:0}});
 assert.equal(deny.status,200,JSON.stringify(deny.data));
 assert.equal((await api(env,new URL(newer).pathname)).status,404,'ACL deny invalidates link at access time');
});

test('RC6 trash: members see only own authorized trash, viewer cannot restore it',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const admin=await initialize(env);
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:admin.cookie,body:{name:'Team'}});const sid=team.data.data.id;
 const m=await addMember(env,admin.cookie,sid),mine=await file(env,m.cookie,sid,'own.pdf'),other=await file(env,admin.cookie,sid,'other.pdf');
 const ownTrash=await api(env,'/api/v1/trash',{method:'POST',cookie:m.cookie,body:{target_type:'file',target_id:mine}});
 const otherTrash=await api(env,'/api/v1/trash',{method:'POST',cookie:admin.cookie,body:{target_type:'file',target_id:other}});
 assert.equal(ownTrash.status,200);assert.equal(otherTrash.status,200);
 const listing=await api(env,`/api/v1/trash?space_id=${sid}`,{cookie:m.cookie});assert.equal(listing.status,200);
 assert.deepEqual(listing.data.data.entries.map(x=>x.id),[ownTrash.data.data.trash_id]);
 const otherRestore=await api(env,`/api/v1/trash/${otherTrash.data.data.trash_id}/restore`,{method:'POST',cookie:m.cookie,body:{}});
 assert.equal(otherRestore.status,404);
 await api(env,`/api/v1/spaces/${sid}/members/${m.id}`,{method:'PUT',cookie:admin.cookie,body:{role:'viewer'}});
 const newListing=await api(env,`/api/v1/trash?space_id=${sid}`,{cookie:m.cookie});assert.equal(newListing.data.data.entries.length,0);
 assert.equal((await api(env,`/api/v1/trash/${ownTrash.data.data.trash_id}/restore`,{method:'POST',cookie:m.cookie,body:{}})).status,404);
});

test('RC6 trash: nested protected directory blocks parent deletion; independent child trash is not resurrected',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const admin=await initialize(env);
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:admin.cookie,body:{name:'Team'}});const sid=team.data.data.id;
 const m=await addMember(env,admin.cookie,sid);
 const parent=await api(env,'/api/v1/folders',{method:'POST',cookie:admin.cookie,body:{space_id:sid,name:'Parent'}});const pid=parent.data.data.id;
 const child=await api(env,'/api/v1/folders',{method:'POST',cookie:admin.cookie,body:{space_id:sid,parent_id:pid,name:'Secret'}});const cid=child.data.data.id;
 const acl=await api(env,`/api/v1/folders/${cid}/permissions`,{method:'PUT',cookie:admin.cookie,body:{principal_type:'user',principal_id:m.id,permission_mask:0}});assert.equal(acl.status,200);
 const blocked=await api(env,'/api/v1/trash',{method:'POST',cookie:m.cookie,body:{target_type:'folder',target_id:pid}});assert.equal(blocked.status,403);
 const f=await file(env,admin.cookie,sid,'untouched.pdf');
 const moved=await api(env,`/api/v1/files/${f}/move`,{method:'POST',cookie:admin.cookie,body:{target_folder_id:cid}});assert.equal(moved.status,200);
 const childTrash=await api(env,'/api/v1/trash',{method:'POST',cookie:admin.cookie,body:{target_type:'file',target_id:f}});assert.equal(childTrash.status,200);
 const parentTrash=await api(env,'/api/v1/trash',{method:'POST',cookie:admin.cookie,body:{target_type:'folder',target_id:pid}});assert.equal(parentTrash.status,200,JSON.stringify(parentTrash.data));
 const restored=await api(env,`/api/v1/trash/${parentTrash.data.data.trash_id}/restore`,{method:'POST',cookie:admin.cookie,body:{}});assert.equal(restored.status,200);
 assert.equal(env.DB.query('SELECT status FROM files WHERE id=?',f).status,'trashed','independent child trash remains trashed');
});

const multipartSize=9*1024*1024;
async function uploadParts(env,cookie,sid){
 const r=await api(env,'/api/v1/uploads',{method:'POST',cookie,body:{name:'large.bin',space_id:sid,size_bytes:multipartSize}});
 assert.equal(r.status,201,JSON.stringify(r.data));const {upload_id:id,part_size:partSize,total_parts}=r.data.data;
 for(let i=0;i<total_parts;i++){
  const data=new Uint8Array(Math.min(partSize,multipartSize-i*partSize));data.fill(66);
  const put=await api(env,`/api/v1/uploads/${id}/parts/${i+1}`,{method:'PUT',cookie,body:data});assert.equal(put.status,200,JSON.stringify(put.data));
 }
 return id;
}

test('RC6 multipart: R2 completion + D1 transaction outage can recover same stored object',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const a=await initialize(env);
 const id=await uploadParts(env,a.cookie,a.spaceId);
 const originalBatch=env.DB.batch.bind(env.DB);let failOnce=true;
 env.DB.batch=async stmts=>{if(failOnce&&stmts.length===4){failOnce=false;throw Error('simulated D1 failure after R2 success');}return originalBatch(stmts);};
 const failed=await api(env,`/api/v1/uploads/${id}/complete`,{method:'POST',cookie:a.cookie});assert.equal(failed.status,503);
 const session=env.DB.query('SELECT * FROM upload_sessions WHERE id=?',id);assert.equal(session.status,'failed');
 assert.ok(env.PRIVATE_BUCKET.objects.has(session.object_key));
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',a.spaceId).reserved_bytes,multipartSize);
 const recovered=await api(env,`/api/v1/uploads/${id}/recover`,{method:'POST',cookie:a.cookie});
 assert.equal(recovered.status,200,JSON.stringify(recovered.data));
 assert.equal(recovered.data.data.status,'completed');
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',a.spaceId).reserved_bytes,0);
 assert.equal(env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',a.spaceId).used_bytes,multipartSize);
 assert.equal(env.DB.query('SELECT COUNT(*) c FROM files WHERE name=\'large.bin\'').c,1);
});

test('RC6 multipart: expired completed orphan is queued, and reservation released only after R2 deletion',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const a=await initialize(env);
 const id=await uploadParts(env,a.cookie,a.spaceId);
 const s=env.DB.query('SELECT * FROM upload_sessions WHERE id=?',id);
 // Simulate an R2 object completed before D1 file registration and creator revoked.
 await env.PRIVATE_BUCKET.put(s.object_key,new Uint8Array(multipartSize));
 env.DB.native.prepare("UPDATE upload_sessions SET status='failed',expires_at=datetime('now','-2 days'),updated_at=datetime('now','-2 days') WHERE id=?").run(id);
 env.DB.native.prepare("UPDATE users SET status='disabled' WHERE id=?").run(a.userId);
 const recovery=await cleanupExpired(env);assert.equal(recovery.cleaned,1);
 assert.equal(env.DB.query('SELECT status FROM upload_sessions WHERE id=?',id).status,'aborted');
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',a.spaceId).reserved_bytes,multipartSize);
 assert.equal(env.DB.query('SELECT COUNT(*) c FROM storage_cleanup_jobs').c,1);
 env.PRIVATE_BUCKET.failDelete=true;
 const pending=await cleanupPendingStorage(env);assert.equal(pending.cleaned,0);
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',a.spaceId).reserved_bytes,multipartSize);
 env.PRIVATE_BUCKET.failDelete=false;
 const done=await cleanupPendingStorage(env);assert.equal(done.cleaned,1);
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',a.spaceId).reserved_bytes,0);
 assert.equal(env.PRIVATE_BUCKET.objects.has(s.object_key),false);
});

test('RC6 reconciliation: physical R2 listing and D1 ledger report are read-only, admin-only and paginated',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const a=await initialize(env);
 await file(env,a.cookie,a.spaceId,'primary.pdf');
 const summary=await api(env,'/api/v1/admin/reconcile',{cookie:a.cookie});assert.equal(summary.status,200,JSON.stringify(summary.data));
 const row=summary.data.data.spaces.find(x=>x.id===a.spaceId);assert.equal(row.used_delta_bytes,0);
 assert.equal(row.reservation_delta_bytes,0);
 await env.PRIVATE_BUCKET.put('private/orphan',body.encode('orphan'));
 const physical=await api(env,'/api/v1/admin/reconcile/objects?bucket=private&limit=1',{cookie:a.cookie});assert.equal(physical.status,200,JSON.stringify(physical.data));
 assert.equal(physical.data.data.items.length,1);assert.equal(physical.data.data.truncated,true);
 const next=await api(env,`/api/v1/admin/reconcile/objects?bucket=private&limit=1&cursor=${physical.data.data.cursor}`,{cookie:a.cookie});
 assert.equal(next.status,200);assert.ok([...physical.data.data.items,...next.data.data.items].some(x=>x.key==='private/orphan'&&x.status==='untracked'));
 assert.equal((await api(env,'/api/v1/admin/reconcile/objects?bucket=private')).status,401);
 assert.equal(env.PRIVATE_BUCKET.objects.size,2,'read-only scan cannot delete objects');
});

test('RC6 frontend: downloads do not buffer full files through fetch().blob()',()=>{
 const src=readFileSync(new URL('../../public/js/modules/file-manager.js',import.meta.url),'utf8');
 assert.ok(src.includes('/content'));assert.equal(src.includes('await r.blob()'),false);
});

test('RC6: failed single PUT + failed R2 rollback persists an orphan job without freeing reserved bytes early',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const a=await initialize(env);
 const originalBatch=env.DB.batch.bind(env.DB);let fail=true;
 env.DB.batch=async stmts=>{if(fail&&stmts.length===3){fail=false;throw Error('D1 unavailable after R2.put');}return originalBatch(stmts);};
 env.PRIVATE_BUCKET.failDelete=true;
 const r=await api(env,`/api/v1/storage/upload?space_id=${a.spaceId}&name=failure.pdf`,{
  method:'POST',cookie:a.cookie,body:body.encode('%PDF-1.4\nhi'),headers:{'Content-Type':'application/pdf'}
 });
 assert.equal(r.status,503);
 const job=env.DB.query('SELECT * FROM storage_cleanup_jobs LIMIT 1');assert.ok(job);
 assert.equal(job.reserved_release_bytes,11);
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',a.spaceId).reserved_bytes,11);
 env.PRIVATE_BUCKET.failDelete=false;
 assert.equal((await cleanupPendingStorage(env)).cleaned,1);
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',a.spaceId).reserved_bytes,0);
 assert.equal(env.PRIVATE_BUCKET.objects.size,0);
});

test('RC6: replaying a stale R2 cleanup job never reduces charged storage twice',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const a=await initialize(env);
 const fid=await file(env,a.cookie,a.spaceId,'first.pdf');
 const one=await api(env,'/api/v1/trash',{method:'POST',cookie:a.cookie,body:{target_type:'file',target_id:fid}});
 env.PRIVATE_BUCKET.failDelete=true;
 await api(env,`/api/v1/trash/${one.data.data.trash_id}/purge`,{method:'DELETE',cookie:a.cookie});
 const job={...env.DB.query('SELECT * FROM storage_cleanup_jobs LIMIT 1')};
 const secondFile=await file(env,a.cookie,a.spaceId,'second.pdf');
 assert.ok(secondFile);
 const stored=env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',a.spaceId).used_bytes;
 env.PRIVATE_BUCKET.failDelete=false;
 const {finishStorageCleanup}=await import('../../worker/services/cleanup.js');
 await finishStorageCleanup(env,job);
 const after=env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',a.spaceId).used_bytes;
 await finishStorageCleanup(env,job);
 assert.equal(env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',a.spaceId).used_bytes,after);
 assert.ok(stored>after);
});

test('RC6: manual recovery is admin-only and never retries active uploads',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const a=await initialize(env);
 const noauth=await api(env,'/api/v1/admin/uploads/recover',{method:'POST'});assert.equal(noauth.status,401);
 const r=await api(env,'/api/v1/admin/uploads/recover',{method:'POST',cookie:a.cookie});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.uploads.attempted,0);
});

test('RC6: folder share filters subfolders revoked by creator ACL even when the root share remains active',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const a=await initialize(env);
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:a.cookie,body:{name:'Private Team'}});const sid=team.data.data.id;
 const m=await addMember(env,a.cookie,sid);
 const root=await api(env,'/api/v1/folders',{method:'POST',cookie:a.cookie,body:{space_id:sid,name:'Share Root'}});const rid=root.data.data.id;
 const child=await api(env,'/api/v1/folders',{method:'POST',cookie:a.cookie,body:{space_id:sid,parent_id:rid,name:'Hidden Child'}});const cid=child.data.data.id;
 const shared=await api(env,'/api/v1/shares',{method:'POST',cookie:m.cookie,body:{type:'page',target_type:'folder',target_id:rid}});
 assert.equal(shared.status,201,JSON.stringify(shared.data));const code=shared.data.data.url.split('/').at(-1);
 const url=`/api/v1/public/shares/${code}/contents?folder_id=${rid}`;
 assert.equal((await api(env,url)).data.data.folders.length,1);
 const deny=await api(env,`/api/v1/folders/${cid}/permissions`,{method:'PUT',cookie:a.cookie,body:{principal_type:'user',principal_id:m.id,permission_mask:0}});
 assert.equal(deny.status,200);
 const after=await api(env,url);assert.equal(after.status,200);assert.equal(after.data.data.folders.length,0);
});
