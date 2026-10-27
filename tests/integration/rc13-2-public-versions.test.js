import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,api,initialize} from './support.js';
import {syncPendingPublications} from '../../worker/services/public-versions.js';

const bytes=s=>new TextEncoder().encode(s);
const upload=(env,cookie,spaceId,name,content,params='')=>api(env,`/api/v1/storage/upload?space_id=${spaceId}&name=${encodeURIComponent(name)}${params}`,{method:'POST',cookie,body:bytes(content),headers:{'Content-Type':'text/plain'}});

async function scenario(env){
 const a=await initialize(env),initial=await upload(env,a.cookie,a.spaceId,'release.txt','v1');
 assert.equal(initial.status,201,JSON.stringify(initial.data));const fileId=initial.data.data.id;
 const published=await api(env,'/api/v1/publications',{method:'POST',cookie:a.cookie,body:{file_id:fileId}});
 assert.equal(published.status,201,JSON.stringify(published.data));
 return {a,fileId,published:published.data.data,initial};
}

test('RC13.2 /r uses uncached 302 to current version, while /p and legacy CDN alias receive new bytes',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const stable=new URL(published.url).pathname;
 assert.match(stable,/^\/r\/[a-f0-9-]{36}$/);
 const first=await api(env,stable);assert.equal(first.status,302);assert.equal(first.response.headers.get('Cache-Control').includes('no-store'),true);
 assert.match(first.response.headers.get('location'),/^https:\/\/cdn\.example\.test\/published\//);
 const oldKey=new URL(published.legacy_url).pathname.slice(1);
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(oldKey).bytes),'v1');
 const updated=await upload(env,a.cookie,a.spaceId,'release.txt','v2-latest',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(updated.status,200,JSON.stringify(updated.data));
 assert.equal(updated.data.data.file_id,fileId);
 const latest=await api(env,stable);assert.equal(latest.status,302);assert.match(latest.response.headers.get('location'),/\/versions\/[^/]+\/v2\//);
 assert.notEqual(first.response.headers.get('location'),latest.response.headers.get('location'));
 const immutableKey=new URL(latest.response.headers.get('location')).pathname.slice(1);
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(immutableKey).bytes),'v2-latest');
 assert.match(env.PUBLIC_BUCKET.objects.get(immutableKey).cacheControl,/immutable/);
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(oldKey).bytes),'v2-latest');
 const legacyWorker=await api(env,`/p/${published.id}`);assert.equal(legacyWorker.status,200);assert.equal(await legacyWorker.response.text(),'v2-latest');
 const pub=env.DB.query('SELECT published_revision,sync_state,legacy_object_id,public_object_id FROM publications WHERE id=?',published.id);
 assert.equal(pub.published_revision,2);assert.equal(pub.sync_state,'cache_unverified');assert.notEqual(pub.legacy_object_id,pub.public_object_id);
 const s=env.DB.query('SELECT used_bytes,reserved_bytes FROM spaces WHERE id=?',a.spaceId);
 assert.equal(s.used_bytes,2+9+9+9);assert.equal(s.reserved_bytes,0);
 const list=await api(env,`/api/v1/publications?file_id=${fileId}`,{cookie:a.cookie});
 assert.equal(list.data.data.publications[0].url,published.url);
 assert.equal(list.data.data.publications[0].legacy_url,published.legacy_url);
});

test('RC13.2 without configured CDN /r streams the current public copy, not a redirect',async t=>{
 const env=makeTestEnv();env.PUBLIC_BASE_URL='';t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const first=await api(env,new URL(published.url).pathname);assert.equal(first.status,200);assert.equal(await first.response.text(),'v1');
 const replaced=await upload(env,a.cookie,a.spaceId,'release.txt','v2',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(replaced.status,200,JSON.stringify(replaced.data));
 const second=await api(env,new URL(published.url).pathname);assert.equal(second.status,200);assert.equal(await second.response.text(),'v2');
});

test('RC13.2 immutable publication copy failure leaves old file and old public link intact, releasing quota',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const originalPut=env.PUBLIC_BUCKET.put.bind(env.PUBLIC_BUCKET);
 env.PUBLIC_BUCKET.put=async (key,body,opts)=>{if(key.startsWith('versions/'))throw Error('simulated CDN R2 failure');return originalPut(key,body,opts)};
 const result=await upload(env,a.cookie,a.spaceId,'release.txt','replacement',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(result.status,503,JSON.stringify(result.data));
 assert.equal(env.DB.query('SELECT revision FROM files WHERE id=?',fileId).revision,1);
 assert.equal((await api(env,new URL(published.url).pathname)).response.headers.get('location').endsWith('published/'+published.legacy_url.split('/').at(-1)),true);
 assert.equal(env.DB.query('SELECT reserved_bytes AS n FROM spaces WHERE id=?',a.spaceId).n,0);
});

test('RC13.2 legacy alias failure does not break current smart link; deferred job can retry',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 let failOnce=true;const originalPut=env.PUBLIC_BUCKET.put.bind(env.PUBLIC_BUCKET);
 env.PUBLIC_BUCKET.put=async (key,body,opts)=>{if(key.startsWith('published/')&&failOnce){failOnce=false;throw Error('simulated legacy alias failure')}return originalPut(key,body,opts)};
 const replacement=await upload(env,a.cookie,a.spaceId,'release.txt','v2',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(replacement.status,200,JSON.stringify(replacement.data));
 assert.match((await api(env,new URL(published.url).pathname)).response.headers.get('location'),/\/versions\//);
 assert.equal(env.DB.query('SELECT sync_state FROM publications WHERE id=?',published.id).sync_state,'alias_pending');
 const delayed=await syncPendingPublications(env);assert.equal(delayed.completed,0);
 assert.ok(env.DB.query('SELECT next_retry_at FROM publication_sync_jobs WHERE publication_id=?',published.id).next_retry_at);
 await env.DB.prepare("UPDATE publication_sync_jobs SET next_retry_at=datetime('now','-1 minute') WHERE publication_id=?").bind(published.id).run();
 const sync=await syncPendingPublications(env);assert.equal(sync.completed,1);
 assert.equal(env.DB.query('SELECT sync_state FROM publications WHERE id=?',published.id).sync_state,'cache_unverified');
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(new URL(published.legacy_url).pathname.slice(1)).bytes),'v2');
});

test('RC13.2 revocation disables /r and deletes both legacy and immutable physical objects',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 await upload(env,a.cookie,a.spaceId,'release.txt','v2',`&replace_file_id=${fileId}&expected_revision=1`);
 const revoke=await api(env,`/api/v1/publications/${published.id}`,{method:'DELETE',cookie:a.cookie});
 assert.equal(revoke.status,200,JSON.stringify(revoke.data));
 assert.equal((await api(env,new URL(published.url).pathname)).status,404);
 assert.equal((await api(env,`/p/${published.id}`)).status,404);
 assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM storage_cleanup_jobs').n,0);
 assert.equal(env.PUBLIC_BUCKET.objects.size,0);
 assert.equal(env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',a.spaceId).used_bytes,2+2);
});

test('RC13.2 public status and manual sync are super-admin only',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,published}=await scenario(env);
 const stat=await api(env,`/api/v1/publications/${published.id}/status`,{cookie:a.cookie});
 assert.equal(stat.status,200,JSON.stringify(stat.data));assert.equal(stat.data.data.revision,1);
 const history=await api(env,`/api/v1/publications/${published.id}/versions`,{cookie:a.cookie});
 assert.equal(history.status,200);assert.equal(history.data.data.versions.length,1);
 const retry=await api(env,`/api/v1/publications/${published.id}/sync`,{cookie:a.cookie,method:'POST'});
 assert.equal(retry.status,200);assert.equal(retry.data.data.status,'already_synchronized');
 assert.equal((await api(env,`/api/v1/publications/${published.id}/status`)).status,401);
});

test('RC13.2 restored historical revision also advances permanent smart URL without changing file ID',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const newer=await upload(env,a.cookie,a.spaceId,'release.txt','v2',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(newer.status,200,JSON.stringify(newer.data));
 const restored=await api(env,`/api/v1/files/${fileId}/versions/1/restore`,{method:'POST',cookie:a.cookie});
 assert.equal(restored.status,200,JSON.stringify(restored.data));assert.equal(restored.data.data.revision,3);
 const ptr=await api(env,new URL(published.url).pathname);assert.match(ptr.response.headers.get('location'),/\/v3\//);
 const key=new URL(ptr.response.headers.get('location')).pathname.slice(1);
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(key).bytes),'v1');
 assert.equal(env.DB.query('SELECT id,revision FROM files WHERE id=?',fileId).revision,3);
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(new URL(published.legacy_url).pathname.slice(1)).bytes),'v1');
});

test('RC13.2 large multipart replacement updates smart publication without changing ID',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const total=9*1048576;
 const start=await api(env,'/api/v1/uploads',{method:'POST',cookie:a.cookie,body:{name:'release.txt',space_id:a.spaceId,size_bytes:total,mime_type:'text/plain',replace_file_id:fileId,expected_revision:1}});
 assert.equal(start.status,201,JSON.stringify(start.data));const {upload_id,part_size,total_parts}=start.data.data;
 for(let part=1;part<=total_parts;part++){
  const length=Math.min(part_size,total-(part-1)*part_size),r=await api(env,`/api/v1/uploads/${upload_id}/parts/${part}`,{method:'PUT',cookie:a.cookie,body:new Uint8Array(length).fill(65)});
  assert.equal(r.status,200,JSON.stringify(r.data));
 }
 const complete=await api(env,`/api/v1/uploads/${upload_id}/complete`,{method:'POST',cookie:a.cookie});
 assert.equal(complete.status,201,JSON.stringify(complete.data));assert.equal(complete.data.data.file_id,fileId);
 const p=await api(env,new URL(published.url).pathname);assert.equal(p.status,302);
 const key=new URL(p.response.headers.get('location')).pathname.slice(1);
 assert.equal(env.PUBLIC_BUCKET.objects.get(key).bytes.length,total);
 const privateCopy=await api(env,`/api/v1/files/${fileId}/content`,{cookie:a.cookie});assert.equal(privateCopy.status,200);
 assert.equal(Number(privateCopy.response.headers.get('content-length')),total);
});

test('RC13.2 prune keeps latest and immediately preceding immutable copy plus stable legacy alias',async t=>{
 const {pruneOldPublicVersions}=await import('../../worker/services/public-versions.js');
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 for(let revision=1;revision<5;revision++){
  const changed=await upload(env,a.cookie,a.spaceId,'release.txt',`v${revision+1}`,`&replace_file_id=${fileId}&expected_revision=${revision}`);
  assert.equal(changed.status,200,JSON.stringify(changed.data));
 }
 const before=env.DB.query('SELECT COUNT(*) AS n FROM publication_versions WHERE publication_id=?',published.id).n;
 assert.ok(before>=5);
 env.DB.native.prepare("UPDATE publication_versions SET created_at=datetime('now','-3 days') WHERE publication_id=?").run(published.id);
 const pruned=await pruneOldPublicVersions(env,{limit:2});assert.equal(pruned.queued,2);assert.equal(pruned.cleaned,2);
 const now=env.DB.query('SELECT COUNT(*) AS n FROM publication_versions WHERE publication_id=?',published.id).n;
 assert.equal(now,before-2);
 assert.ok(env.PUBLIC_BUCKET.objects.has(new URL(published.legacy_url).pathname.slice(1)));
 assert.equal((await api(env,new URL(published.url).pathname)).status,302);
});

test('RC13.2 D1 post-commit response loss does not delete current version or public copy',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const originalBatch=env.DB.batch.bind(env.DB);let inject=true;
 env.DB.batch=async statements=>{
  const out=await originalBatch(statements);
  if(inject&&statements.length>5){inject=false;throw Error('simulated lost D1 success response');}
  return out;
 };
 const updated=await upload(env,a.cookie,a.spaceId,'release.txt','v2',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(updated.status,200,JSON.stringify(updated.data));
 assert.equal(env.DB.query('SELECT revision FROM files WHERE id=?',fileId).revision,2);
 const p=await api(env,new URL(published.url).pathname);assert.match(p.response.headers.get('location'),/\/versions\//);
});

test('RC13.2 cache status is honest without token, then explicit CDN purge marks legacy alias verified',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const next=await upload(env,a.cookie,a.spaceId,'release.txt','v2',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(next.status,200);assert.equal(env.DB.query('SELECT sync_state FROM publications WHERE id=?',published.id).sync_state,'cache_unverified');
 env.CDN_ZONE_ID='1'.repeat(32);env.CDN_PURGE_TOKEN='test-only-secret';
 const original=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return Response.json({success:true})};
 try{
  const res=await api(env,`/api/v1/publications/${published.id}/sync`,{method:'POST',cookie:a.cookie});
  assert.equal(res.status,200,JSON.stringify(res.data));assert.equal(res.data.data.status,'cache_refreshed');
  assert.equal(env.DB.query('SELECT sync_state FROM publications WHERE id=?',published.id).sync_state,'ready');
  assert.ok(calls.some(c=>c.body.files.some(f=>f===published.legacy_url)));
 }finally{globalThis.fetch=original;}
});

test('RC13.2 in-flight legacy copy cannot resurrect an alias after publication revocation',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const originalPut=env.PUBLIC_BUCKET.put.bind(env.PUBLIC_BUCKET);
 let revoked=false;
 env.PUBLIC_BUCKET.put=async(key,body,opts)=>{
  if(key.startsWith('published/')&&!revoked){
   revoked=true;
   const bytes=new Uint8Array(await new Response(body).arrayBuffer());
   const result=await api(env,`/api/v1/publications/${published.id}`,{method:'DELETE',cookie:a.cookie});
   assert.equal(result.status,200,JSON.stringify(result.data));
   return originalPut(key,bytes,opts); // Simulate a stale write completing AFTER revoke cleanup.
  }
  return originalPut(key,body,opts);
 };
 const replaced=await upload(env,a.cookie,a.spaceId,'release.txt','v2',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(replaced.status,200,JSON.stringify(replaced.data));
 assert.equal((await api(env,new URL(published.url).pathname)).status,404);
 assert.equal((await api(env,`/p/${published.id}`)).status,404);
 assert.equal(env.PUBLIC_BUCKET.objects.has(new URL(published.legacy_url).pathname.slice(1)),false);
 assert.equal(env.DB.query('SELECT status FROM publications WHERE id=?',published.id).status,'revoked');
});

test('RC13.2 stale legacy copy schedules recopy if a later revision already synchronized',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {a,fileId,published}=await scenario(env);
 const originalPut=env.PUBLIC_BUCKET.put.bind(env.PUBLIC_BUCKET);
 let race=false;
 env.PUBLIC_BUCKET.put=async(key,body,opts)=>{
  if(key.startsWith('published/')&&!race){
   race=true;
   const bytes=new Uint8Array(await new Response(body).arrayBuffer());
   const v3=await upload(env,a.cookie,a.spaceId,'release.txt','v3',`&replace_file_id=${fileId}&expected_revision=2`);
   assert.equal(v3.status,200,JSON.stringify(v3.data));
   return originalPut(key,bytes,opts); // v2 alias arrives AFTER v3 was synchronized.
  }
  return originalPut(key,body,opts);
 };
 const v2=await upload(env,a.cookie,a.spaceId,'release.txt','v2',`&replace_file_id=${fileId}&expected_revision=1`);
 assert.equal(v2.status,200,JSON.stringify(v2.data));
 assert.equal(env.DB.query('SELECT published_revision FROM publications WHERE id=?',published.id).published_revision,3);
 assert.equal(env.DB.query('SELECT sync_state FROM publications WHERE id=?',published.id).sync_state,'alias_pending');
 const sync=await syncPendingPublications(env);
 assert.equal(sync.completed,1);
 const legacy=new URL(published.legacy_url).pathname.slice(1);
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(legacy).bytes),'v3');
 assert.match((await api(env,new URL(published.url).pathname)).response.headers.get('location'),/\/v3\//);
});
