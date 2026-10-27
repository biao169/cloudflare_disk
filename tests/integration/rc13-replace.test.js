import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,api,initialize} from './support.js';
const bytes=s=>new TextEncoder().encode(s);
const send=(env,cookie,path,data)=>api(env,path,{method:'POST',cookie,body:bytes(data),headers:{'Content-Type':'text/plain'}});
test('RC13.1 small file replacement preserves ID, private share, previous object and rejects stale revision',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie,spaceId}=await initialize(env);
 const path=`/api/v1/storage/upload?space_id=${spaceId}&name=report.txt`;
 const original=await send(env,cookie,path,'old');assert.equal(original.status,201,JSON.stringify(original.data));
 const id=original.data.data.id;
 const share=await api(env,'/api/v1/shares',{method:'POST',cookie,body:{type:'temporary',target_type:'file',target_id:id,expires_at:new Date(Date.now()+86400000).toISOString()}});
 assert.equal(share.status,201,JSON.stringify(share.data));
 const url=new URL(share.data.data.url),link=url.pathname;
 const get0=await api(env,link);assert.equal(get0.status,200);assert.equal(await get0.response.text(),'old');
 const target=await api(env,`/api/v1/files/${id}/replacement-target`,{cookie});assert.equal(target.data.data.revision,1);
 const updated=await send(env,cookie,path+`&replace_file_id=${id}&expected_revision=1`,'new text');assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.data.file_id,id);assert.equal(updated.data.data.revision,2);
 const get1=await api(env,link);assert.equal(get1.status,200);assert.equal(await get1.response.text(),'new text');
 assert.equal(env.DB.query('SELECT id FROM files WHERE id=?',id).id,id);
 assert.equal(env.DB.query('SELECT revision FROM file_versions WHERE file_id=?',id).revision,1);
 assert.equal((await send(env,cookie,path+`&replace_file_id=${id}&expected_revision=1`,'bad')).status,409);
 const now=await api(env,`/api/v1/files/${id}/versions`,{cookie});assert.equal(now.status,200);assert.equal(now.data.data.versions.length,1);
 const count=env.DB.query('SELECT COUNT(*) AS n FROM files WHERE id=?',id).n;assert.equal(count,1);
});
test('RC13.1 denies replacing another file or from unauthorized account',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const a=await initialize(env);
 const original=await send(env,a.cookie,`/api/v1/storage/upload?space_id=${a.spaceId}&name=one.txt`,'one');const id=original.data.data.id;
 const wrong=await send(env,a.cookie,`/api/v1/storage/upload?space_id=${a.spaceId}&name=two.txt&replace_file_id=${id}&expected_revision=1`,'two');assert.equal(wrong.status,409);
 const created=await api(env,'/api/v1/users',{method:'POST',cookie:a.cookie,body:{username:'outsider',password:'a-long-password-123'}});assert.equal(created.status,201);
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'outsider',password:'a-long-password-123'}});const cookie=login.response.headers.get('set-cookie').split(';')[0];
 const denied=await send(env,cookie,`/api/v1/storage/upload?space_id=${a.spaceId}&name=one.txt&replace_file_id=${id}&expected_revision=1`,'two');assert.equal(denied.status,403);
});
test('RC13.1 multipart replacement and historic revision restore preserve file identity',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie,spaceId}=await initialize(env);
 const base=`/api/v1/storage/upload?space_id=${spaceId}&name=large.bin`;
 const first=await send(env,cookie,base,'first');assert.equal(first.status,201);
 const id=first.data.data.id,total=9*1048576;
 const start=await api(env,'/api/v1/uploads',{method:'POST',cookie,body:{name:'large.bin',space_id:spaceId,size_bytes:total,mime_type:'application/octet-stream',replace_file_id:id,expected_revision:1}});
 assert.equal(start.status,201,JSON.stringify(start.data));
 const session=start.data.data;
 for(let n=1;n<=session.total_parts;n++){
  const length=Math.min(session.part_size,total-(n-1)*session.part_size);
  const res=await api(env,`/api/v1/uploads/${session.upload_id}/parts/${n}`,{method:'PUT',cookie,body:new Uint8Array(length),headers:{'Content-Type':'application/octet-stream'}});
  assert.equal(res.status,200,JSON.stringify(res.data));
 }
 const done=await api(env,`/api/v1/uploads/${session.upload_id}/complete`,{method:'POST',cookie});assert.equal(done.status,201,JSON.stringify(done.data));
 assert.equal(done.data.data.file_id,id);
 assert.equal(env.DB.query('SELECT revision FROM files WHERE id=?',id).revision,2);
 const restored=await api(env,`/api/v1/files/${id}/versions/1/restore`,{method:'POST',cookie});assert.equal(restored.status,200,JSON.stringify(restored.data));
 assert.equal(restored.data.data.revision,3);
 const current=await api(env,`/api/v1/files/${id}/content`,{cookie});assert.equal(await current.response.text(),'first');
 assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM file_versions WHERE file_id=?',id).n,2);
});
