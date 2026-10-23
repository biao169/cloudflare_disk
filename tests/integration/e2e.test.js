import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,api,initialize} from './support.js';
import {cleanupPendingStorage} from '../../worker/services/cleanup.js';
import {matchesPreviewSignature} from '../../worker/services/storage.js';

async function upload(env,cookie,spaceId,name,bytes,mime='application/octet-stream'){
 const url=`/api/v1/storage/upload?space_id=${spaceId}&name=${encodeURIComponent(name)}`;
 return api(env,url,{method:'POST',cookie,body:bytes,headers:{'Content-Type':mime}});
}

test('real SQL + mock R2: private upload, permissions, range and content signatures',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const {cookie,spaceId}=await initialize(env);
 const folder=await api(env,'/api/v1/folders',{method:'POST',cookie,body:{space_id:spaceId,name:'设计文件'}});
 assert.equal(folder.status,201);
 const validPdf=new TextEncoder().encode('%PDF-1.7\n1 0 obj\n');
 const stored=await upload(env,cookie,spaceId,'manual.pdf',validPdf,'application/pdf');
 assert.equal(stored.status,201,JSON.stringify(stored.data));
 const fid=stored.data.data.id;
 const noauth=await api(env,`/api/v1/files/${fid}/content`);assert.equal(noauth.status,401);
 const got=await api(env,`/api/v1/files/${fid}/content`,{cookie});assert.equal(got.status,200);
 assert.equal(await got.response.text(),new TextDecoder().decode(validPdf));
 const partial=await api(env,`/api/v1/files/${fid}/preview`,{cookie,headers:{Range:'bytes=0-3'}});
 assert.equal(partial.status,206,JSON.stringify(partial.data));assert.equal(partial.response.headers.get('content-range'),`bytes 0-3/${validPdf.length}`);
 assert.equal(await partial.response.text(),'%PDF');
 const spoof=await upload(env,cookie,spaceId,'spoof.pdf',new TextEncoder().encode('NOT A PDF'),'application/pdf');assert.equal(spoof.status,201);
 const preview=await api(env,`/api/v1/files/${spoof.data.data.id}/preview`,{cookie});assert.equal(preview.status,415);
 assert.ok(matchesPreviewSignature('application/pdf',validPdf));
 const stat=env.DB.query('SELECT used_bytes,reserved_bytes FROM spaces WHERE id=?',spaceId);assert.equal(stat.used_bytes,validPdf.length+9);assert.equal(stat.reserved_bytes,0);
});

test('real SQL: disabled / read-only user cannot access private documents; origin guard',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const admin=await initialize(env);const pass='member-password-is-secret-123';
 const user=await api(env,'/api/v1/users',{method:'POST',cookie:admin.cookie,body:{username:'viewer01',password:pass}});assert.equal(user.status,201);
 const viewerLogin=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'viewer01',password:pass}});assert.equal(viewerLogin.status,200);
 const viewerCookie=viewerLogin.response.headers.get('set-cookie').split(';')[0];
 const file=await upload(env,admin.cookie,admin.spaceId,'private.txt',new TextEncoder().encode('my data'));assert.equal(file.status,201);
 assert.equal((await api(env,`/api/v1/files/${file.data.data.id}/content`,{cookie:viewerCookie})).status,404);
 assert.equal((await api(env,'/api/v1/folders',{method:'POST',cookie:admin.cookie,headers:{Origin:'https://attacker.example'},body:{space_id:admin.spaceId,name:'evil'}})).status,403);
 const stop=await api(env,`/api/v1/users/${user.data.data.id}`,{method:'PATCH',cookie:admin.cookie,body:{role:'member',status:'disabled'}});assert.equal(stop.status,200);
 assert.equal((await api(env,'/api/v1/auth/me',{cookie:viewerCookie})).status,401);
});

test('real SQL + R2: password share, expiry, cancel, public publication',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const {cookie,spaceId}=await initialize(env);
 const file=await upload(env,cookie,spaceId,'share.pdf',new TextEncoder().encode('%PDF-1.6\nHi'),'application/pdf');assert.equal(file.status,201);
 const fid=file.data.data.id;
 const share=await api(env,'/api/v1/shares',{method:'POST',cookie,body:{type:'page',target_type:'file',target_id:fid,password:'secure-share-password-123',expires_at:new Date(Date.now()+86400000).toISOString()}});
 assert.equal(share.status,201,JSON.stringify(share.data));
 const code=share.data.data.url.split('/').at(-1),base=`/api/v1/public/shares/${code}`;
 assert.equal((await api(env,base)).status,401);
 assert.equal((await api(env,`${base}/verify`,{method:'POST',body:{password:'not-the-right-password-000'}})).status,403);
 const verified=await api(env,`${base}/verify`,{method:'POST',body:{password:'secure-share-password-123'}});assert.equal(verified.status,200);
 const shareCookie=verified.response.headers.get('set-cookie').split(';')[0];
 assert.equal((await api(env,`${base}/contents`,{cookie:shareCookie})).status,200);
 assert.equal((await api(env,`${base}/files/${fid}/preview`,{cookie:shareCookie})).status,200);
 const revoke=await api(env,`/api/v1/shares/${share.data.data.share.id}`,{method:'DELETE',cookie});assert.equal(revoke.status,200);
 assert.equal((await api(env,`${base}/contents`,{cookie:shareCookie})).status,404);
 const published=await api(env,'/api/v1/publications',{method:'POST',cookie,body:{file_id:fid}});assert.equal(published.status,201,JSON.stringify(published.data));
 assert.ok(published.data.data.url.startsWith('https://cdn.example.test/published/'));
 assert.equal(env.PUBLIC_BUCKET.objects.size,1);
 assert.equal(env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',spaceId).used_bytes,2*new TextEncoder().encode('%PDF-1.6\nHi').length,'public copy charges physical quota');
 const removed=await api(env,`/api/v1/publications/${published.data.data.id}`,{method:'DELETE',cookie});assert.equal(removed.status,200);
 assert.equal(env.PUBLIC_BUCKET.objects.size,0);
 assert.equal(env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',spaceId).used_bytes,new TextEncoder().encode('%PDF-1.6\nHi').length,'revoke releases public copy');
});

test('real SQL + R2: shared immutable object stays until last copy, cleanup retries after R2 outage',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const {cookie,spaceId}=await initialize(env);
 const file=await upload(env,cookie,spaceId,'original.txt',new TextEncoder().encode('backup me'));assert.equal(file.status,201);
 const fid=file.data.data.id;
 const duplicate=await api(env,`/api/v1/files/${fid}/copy`,{method:'POST',cookie,body:{name:'copy.txt'}});assert.equal(duplicate.status,201,JSON.stringify(duplicate.data));
 const moved=await api(env,'/api/v1/trash',{method:'POST',cookie,body:{target_type:'file',target_id:fid}});assert.equal(moved.status,200,JSON.stringify(moved.data));
 const purge=await api(env,`/api/v1/trash/${moved.data.data.trash_id}/purge`,{method:'DELETE',cookie});assert.equal(purge.status,200,JSON.stringify(purge.data));
 assert.equal(env.PRIVATE_BUCKET.objects.size,1,'copy still holds object');
 const copyId=duplicate.data.data.id;
 const movedCopy=await api(env,'/api/v1/trash',{method:'POST',cookie,body:{target_type:'file',target_id:copyId}});assert.equal(movedCopy.status,200);
 env.PRIVATE_BUCKET.failDelete=true;
 const purgedCopy=await api(env,`/api/v1/trash/${movedCopy.data.data.trash_id}/purge`,{method:'DELETE',cookie});assert.equal(purgedCopy.status,200,JSON.stringify(purgedCopy.data));
 assert.equal(env.DB.query('SELECT COUNT(*) c FROM storage_cleanup_jobs').c,1);
 assert.equal(env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',spaceId).used_bytes,9);
 env.PRIVATE_BUCKET.failDelete=false;
 const cleanup=await cleanupPendingStorage(env);
 assert.equal(cleanup.cleaned,1);
 assert.equal(env.PRIVATE_BUCKET.objects.size,0);
 assert.equal(env.DB.query('SELECT COUNT(*) c FROM storage_cleanup_jobs').c,0);
 assert.equal(env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',spaceId).used_bytes,0);
});

test('real SQL + multipart mock: 9 MiB upload completes, list and quota accounting consistent',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const {cookie,spaceId}=await initialize(env);
 const total=9*1024*1024, bytes=new Uint8Array(total);bytes.fill(65);
 const start=await api(env,'/api/v1/uploads',{method:'POST',cookie,body:{name:'big.bin',space_id:spaceId,size_bytes:total,mime_type:'application/octet-stream'}});
 assert.equal(start.status,201,JSON.stringify(start.data));
 const {upload_id:id,part_size:partSize,total_parts:count}=start.data.data;
 assert.equal(count,2);
 for(let n=1;n<=count;n++){
  const part=bytes.slice((n-1)*partSize,Math.min(n*partSize,total));
  const sent=await api(env,`/api/v1/uploads/${id}/parts/${n}`,{method:'PUT',cookie,body:part,headers:{'Content-Type':'application/octet-stream'}});
  assert.equal(sent.status,200,JSON.stringify(sent.data));
 }
 const complete=await api(env,`/api/v1/uploads/${id}/complete`,{method:'POST',cookie});assert.equal(complete.status,201,JSON.stringify(complete.data));
 const listing=await api(env,`/api/v1/spaces/${spaceId}/contents`,{cookie});assert.ok(listing.data.data.files.find(x=>x.name==='big.bin'));
 assert.equal(env.DB.query('SELECT used_bytes FROM spaces WHERE id=?',spaceId).used_bytes,total);
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',spaceId).reserved_bytes,0);
});

test('real SQL: trash retention setting, quota blocking and administrative switches',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const admin=await initialize(env);
 const changed=await api(env,'/api/v1/admin/settings',{method:'PATCH',cookie:admin.cookie,body:{trash_retention_days:2,uploads_enabled:true,max_storage_bytes:1024*1024}});
 assert.equal(changed.status,200,JSON.stringify(changed.data));
 const uploaded=await upload(env,admin.cookie,admin.spaceId,'small.txt',new TextEncoder().encode('hello world'));
 assert.equal(uploaded.status,201);
 const deleted=await api(env,'/api/v1/trash',{method:'POST',cookie:admin.cookie,body:{target_type:'file',target_id:uploaded.data.data.id}});assert.equal(deleted.status,200);
 const delta=(Date.parse(deleted.data.data.purge_at.replace(' ','T')+'Z')-Date.now())/86400000;
 assert.ok(delta>1.95&&delta<2.05,'trash retention follows configured 2 days');
 const before=await api(env,'/api/v1/admin/reconcile',{cookie:admin.cookie});assert.equal(before.status,200);
 assert.equal(before.data.data.cleanup_pending.jobs,0);
 const disabled=await api(env,'/api/v1/admin/settings',{method:'PATCH',cookie:admin.cookie,body:{uploads_enabled:false}});assert.equal(disabled.status,200);
 const denied=await upload(env,admin.cookie,admin.spaceId,'next.txt',new TextEncoder().encode('hi'));
 assert.equal(denied.status,403);
 const large=await api(env,'/api/v1/uploads',{method:'POST',cookie:admin.cookie,body:{name:'future.bin',space_id:admin.spaceId,size_bytes:9*1024*1024}});
 assert.equal(large.status,403,'disabled setting also blocks multipart');
});

test('real SQL: expired share and forged Origin are rejected',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const admin=await initialize(env);
 const file=await upload(env,admin.cookie,admin.spaceId,'expires.txt',new TextEncoder().encode('hello'));assert.equal(file.status,201);
 const start=await api(env,'/api/v1/shares',{method:'POST',cookie:admin.cookie,body:{type:'temporary',target_type:'file',target_id:file.data.data.id,expires_at:new Date(Date.now()+3600000).toISOString()}});
 assert.equal(start.status,201);
 const code=start.data.data.url.split('/').at(-1);
 assert.equal((await api(env,`/t/${code}`)).status,200);
 env.DB.native.prepare("UPDATE shares SET expires_at=datetime('now','-1 minute') WHERE id=?").run(start.data.data.share.id);
 assert.equal((await api(env,`/t/${code}`)).status,404);
 const post=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'adminuser',password:'integration-password-123456'},headers:{Origin:'https://malicious.example'}});
 assert.equal(post.status,403);
});


test('real SQL: public publication respects global quota, including private source bytes',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const admin=await initialize(env);
 const max=1024*1024;
 const change=await api(env,'/api/v1/admin/settings',{method:'PATCH',cookie:admin.cookie,body:{max_storage_bytes:max}});assert.equal(change.status,200);
 const file=await upload(env,admin.cookie,admin.spaceId,'large-enough.bin',new Uint8Array(650000));assert.equal(file.status,201,JSON.stringify(file.data));
 const attempt=await api(env,'/api/v1/publications',{method:'POST',cookie:admin.cookie,body:{file_id:file.data.data.id}});
 assert.equal(attempt.status,413,JSON.stringify(attempt.data));
 assert.equal(env.PUBLIC_BUCKET.objects.size,0);
 assert.equal(env.DB.query('SELECT reserved_bytes FROM spaces WHERE id=?',admin.spaceId).reserved_bytes,0);
});

test('real SQL: share default expiry, HTML security headers, private SPA requires login',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const login=await api(env,'/login');assert.equal(login.status,200);
 assert.match(login.response.headers.get('content-security-policy')||'',/frame-ancestors 'none'/);
 assert.equal(login.response.headers.get('cache-control'),'private, no-store');
 const gate=await api(env,'/files');assert.equal(gate.status,302);
 const a=await initialize(env);
 const file=await upload(env,a.cookie,a.spaceId,'expiry-test.txt',new TextEncoder().encode('abc'));
 assert.equal(file.status,201);
 const share=await api(env,'/api/v1/shares',{method:'POST',cookie:a.cookie,body:{type:'page',target_type:'file',target_id:file.data.data.id}});
 assert.equal(share.status,201,JSON.stringify(share.data));
 const expiration=Date.parse(share.data.data.share.expires_at)-Date.now();
 assert.ok(expiration>6.9*86400000&&expiration<7.1*86400000);
});
