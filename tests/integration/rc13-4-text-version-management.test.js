import test from 'node:test';
import assert from 'node:assert/strict';
import {api,initialize,makeTestEnv} from './support.js';
import {editableMime,MAX_TEXT_BYTES} from '../../worker/api/text-editor.js';

const byte=s=>new TextEncoder().encode(s);
async function upload(env,cookie,spaceId,name,text,type='text/plain'){
 return api(env,`/api/v1/storage/upload?space_id=${spaceId}&name=${encodeURIComponent(name)}`,{method:'POST',cookie,body:byte(text),headers:{'Content-Type':type}});
}
const save=(env,cookie,id,revision,content)=>api(env,`/api/v1/files/${id}/text`,{method:'PUT',cookie,body:{expected_revision:revision,content}});

test('RC13.4 small UTF-8 online editing keeps private share, file ID, and history with download & restore',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie,spaceId}=await initialize(env);
 const first=await upload(env,cookie,spaceId,'说明.md','初始文本');assert.equal(first.status,201,JSON.stringify(first.data));const id=first.data.data.id;
 const created=await api(env,'/api/v1/shares',{method:'POST',cookie,body:{type:'temporary',target_type:'file',target_id:id,expires_at:new Date(Date.now()+86400000).toISOString()}});
 assert.equal(created.status,201,JSON.stringify(created.data));const shareURL=new URL(created.data.data.url).pathname;
 const read=await api(env,`/api/v1/files/${id}/text`,{cookie});assert.equal(read.status,200);assert.equal(read.data.data.text,'初始文本');assert.equal(read.data.data.revision,1);
 const edited=await save(env,cookie,id,1,'更新 **Markdown**，保留旧地址');assert.equal(edited.status,200,JSON.stringify(edited.data));
 assert.equal(edited.data.data.file_id,id);assert.equal(edited.data.data.revision,2);
 assert.equal((await api(env,shareURL)).status,200);
 assert.equal(await (await api(env,shareURL)).response.text(),'更新 **Markdown**，保留旧地址');
 const old=await api(env,`/api/v1/files/${id}/versions/1/text`,{cookie});assert.equal(old.status,200);assert.equal(old.data.data.text,'初始文本');
 const list=await api(env,`/api/v1/files/${id}/versions`,{cookie});assert.equal(list.status,200);assert.equal(list.data.data.current_revision,2);assert.equal(list.data.data.current_size_bytes,byte('更新 **Markdown**，保留旧地址').byteLength);
 const oldDownload=await api(env,`/api/v1/files/${id}/versions/1/content`,{cookie});assert.equal(oldDownload.status,200);assert.equal(await oldDownload.response.text(),'初始文本');assert.match(oldDownload.response.headers.get('content-disposition'),/attachment/);
 const stale=await save(env,cookie,id,1,'迟到更新');assert.equal(stale.status,409);assert.equal(stale.data.error.code,'VERSION_CONFLICT');
 const staleRestore=await api(env,`/api/v1/files/${id}/versions/1/restore`,{method:'POST',cookie,body:{expected_revision:1}});assert.equal(staleRestore.status,409);
 const restored=await api(env,`/api/v1/files/${id}/versions/1/restore`,{method:'POST',cookie,body:{expected_revision:2}});assert.equal(restored.status,200,JSON.stringify(restored.data));assert.equal(restored.data.data.revision,3);
 assert.equal(await (await api(env,shareURL)).response.text(),'初始文本');
 assert.equal(env.DB.query('SELECT COUNT(*) n FROM files WHERE id=?',id).n,1);
});

test('RC13.4 editing auto-publishes latest revision through existing /r entry without changing URL',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie,spaceId}=await initialize(env);
 const first=await upload(env,cookie,spaceId,'website.css','body {color: red}','text/css');const id=first.data.data.id;
 const published=await api(env,'/api/v1/publications',{method:'POST',cookie,body:{file_id:id}});assert.equal(published.status,201,JSON.stringify(published.data));
 const pubPath=new URL(published.data.data.url).pathname;
 const before=await api(env,pubPath);assert.equal(before.status,302);
 const update=await save(env,cookie,id,1,'body {color: blue}');assert.equal(update.status,200,JSON.stringify(update.data));
 const after=await api(env,pubPath);assert.equal(after.status,302);assert.notEqual(after.response.headers.get('location'),before.response.headers.get('location'));
 const versionKey=new URL(after.response.headers.get('location')).pathname.slice(1);
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(versionKey).bytes),'body {color: blue}');
 assert.equal(env.DB.query('SELECT published_revision AS n FROM publications WHERE id=?',published.data.data.id).n,2);
 const historical=await api(env,`/api/v1/publications/${published.data.data.id}/versions`,{cookie});assert.equal(historical.status,200);
 assert.ok(historical.data.data.versions.some(v=>v.file_revision===2&&v.size_bytes>0));
 const status=await api(env,`/api/v1/publications/${published.data.data.id}/status`,{cookie});assert.equal(status.data.data.source_revision,2);
});

test('RC13.4 rejects unsupported types, malicious text, invalid UTF-8 and oversized editors',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie,spaceId}=await initialize(env);
 assert.equal(editableMime('evil.svg','image/svg+xml'),null);
 const img=await upload(env,cookie,spaceId,'photo.png','hello','image/png');const imgId=img.data.data.id;
 assert.equal((await api(env,`/api/v1/files/${imgId}/text`,{cookie})).status,415);
 const html=await upload(env,cookie,spaceId,'example.html','<script>alert(1)</script>','text/html');const id=html.data.data.id;
 const view=await api(env,`/api/v1/files/${id}/text`,{cookie});assert.equal(view.status,200);assert.equal(view.data.data.text,'<script>alert(1)</script>');
 assert.equal((await save(env,cookie,id,1,'null\u0000byte')).status,400);
 assert.equal((await save(env,cookie,id,1,'a'.repeat(MAX_TEXT_BYTES+1))).status,413);
 const weird=await upload(env,cookie,spaceId,'broken.json','\ufffd','application/json');const brokenId=weird.data.data.id;
 const meta=env.DB.query('SELECT o.object_key FROM files f JOIN storage_objects o ON o.id=f.object_id WHERE f.id=?',brokenId);
 env.PRIVATE_BUCKET.objects.get(meta.object_key).bytes=new Uint8Array([0xff,0xfe,0xfd]);
 assert.equal((await api(env,`/api/v1/files/${brokenId}/text`,{cookie})).status,415);
});

test('RC13.4 historical downloads enforce current space ACL and support Range + HEAD',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie,spaceId}=await initialize(env);
 const first=await upload(env,cookie,spaceId,'document.txt','old-document');const id=first.data.data.id;
 await save(env,cookie,id,1,'new-document');
 const unauthorized=await api(env,`/api/v1/files/${id}/versions/1/content`);assert.equal(unauthorized.status,401);
 const ranged=await api(env,`/api/v1/files/${id}/versions/1/content`,{cookie,headers:{range:'bytes=0-2'}});
 assert.equal(ranged.status,206);assert.equal(ranged.response.headers.get('content-range'),'bytes 0-2/12');assert.equal(await ranged.response.text(),'old');
 const head=await api(env,`/api/v1/files/${id}/versions/1/content`,{method:'HEAD',cookie});assert.equal(head.status,200);assert.equal(head.response.headers.get('content-length'),'12');
 const noText=await api(env,`/api/v1/files/${id}/versions/123/text`,{cookie});assert.equal(noText.status,404);
});

test('RC13.4 public manager pauses auto sync, then manually catches up same /r URL',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie,spaceId}=await initialize(env);
 const u=await upload(env,cookie,spaceId,'changelog.md','one','text/plain');const id=u.data.data.id;
 const publication=await api(env,'/api/v1/publications',{method:'POST',cookie,body:{file_id:id}});assert.equal(publication.status,201,JSON.stringify(publication.data));
 const pubId=publication.data.data.id,urlPath=new URL(publication.data.data.url).pathname;
 const paused=await api(env,`/api/v1/publications/${pubId}`,{method:'PATCH',cookie,body:{auto_sync:false}});assert.equal(paused.status,200);
 const update=await save(env,cookie,id,1,'two');assert.equal(update.status,200,JSON.stringify(update.data));
 let state=await api(env,`/api/v1/publications/${pubId}/status`,{cookie});assert.equal(state.data.data.revision,1);assert.equal(state.data.data.source_revision,2);
 assert.equal((await api(env,urlPath)).status,302);
 const published=await api(env,`/api/v1/publications/${pubId}/publish-latest`,{method:'POST',cookie});
 assert.equal(published.status,200,JSON.stringify(published.data));assert.equal(published.data.data.revision,2);
 const current=await api(env,urlPath);assert.equal(current.status,302);const key=new URL(current.response.headers.get('location')).pathname.slice(1);
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(key).bytes),'two');
 state=await api(env,`/api/v1/publications/${pubId}/status`,{cookie});assert.equal(state.data.data.revision,2);
 assert.equal((await api(env,`/api/v1/publications/${pubId}/publish-latest`,{method:'POST',cookie})).data.data.status,'already_current');
 assert.equal((await api(env,`/api/v1/publications/${pubId}`,{method:'PATCH',cookie,body:{auto_sync:'yes'}})).status,400);
 assert.equal((await api(env,`/api/v1/publications/${pubId}/publish-latest`)).status,401);
 const resumed=await api(env,`/api/v1/publications/${pubId}`,{method:'PATCH',cookie,body:{auto_sync:true}});assert.equal(resumed.status,200);
 const third=await save(env,cookie,id,2,'three');assert.equal(third.status,200);
 const latest=await api(env,urlPath);assert.equal(latest.status,302);
 assert.match(latest.response.headers.get('location'),/\/v3\//);
 const s=env.DB.query('SELECT used_bytes,reserved_bytes FROM spaces WHERE id=?',spaceId);assert.equal(s.reserved_bytes,0);assert.ok(s.used_bytes>=3);
});

test('RC13.4 read-only team member can inspect history but cannot overwrite or restore, revoked members cannot read',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const admin=await initialize(env);
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:admin.cookie,body:{name:'Text-Team'}});assert.equal(team.status,201);
 const teamId=team.data.data.id;
 const added=await api(env,'/api/v1/users',{method:'POST',cookie:admin.cookie,body:{username:'reader134',password:'reader-strong-password'}});assert.equal(added.status,201);
 const uid=added.data.data.id;
 await api(env,`/api/v1/spaces/${teamId}/members/${uid}`,{method:'PUT',cookie:admin.cookie,body:{role:'viewer'}});
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'reader134',password:'reader-strong-password'}});
 const viewer=login.response.headers.get('set-cookie').split(';')[0];
 const file=await upload(env,admin.cookie,teamId,'team.json','{"v":1}','application/json');assert.equal(file.status,201);
 const id=file.data.data.id;
 await save(env,admin.cookie,id,1,'{"v":2}');
 const open=await api(env,`/api/v1/files/${id}/text`,{cookie:viewer});assert.equal(open.status,200);
 assert.equal((await api(env,`/api/v1/files/${id}/versions/1/text`,{cookie:viewer})).status,200);
 assert.equal((await api(env,`/api/v1/files/${id}/versions`,{cookie:viewer})).status,200);
 assert.equal((await save(env,viewer,id,2,'{"v":3}')).status,403);
 assert.equal((await api(env,`/api/v1/files/${id}/versions/1/restore`,{method:'POST',cookie:viewer})).status,403);
 await api(env,`/api/v1/spaces/${teamId}/members/${uid}`,{method:'DELETE',cookie:admin.cookie});
 assert.equal((await api(env,`/api/v1/files/${id}/text`,{cookie:viewer})).status,403);
 assert.equal((await api(env,`/api/v1/files/${id}/versions/1/content`,{cookie:viewer})).status,403);
});


test('RC13.4 manual public copy failure preserves last stable /r, and lost D1 response never deletes published copy',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie,spaceId}=await initialize(env);
 const first=await upload(env,cookie,spaceId,'release.txt','v1');const fileId=first.data.data.id;
 const pub=await api(env,'/api/v1/publications',{method:'POST',cookie,body:{file_id:fileId}});const id=pub.data.data.id,link=new URL(pub.data.data.url).pathname;
 await api(env,`/api/v1/publications/${id}`,{method:'PATCH',cookie,body:{auto_sync:false}});
 await save(env,cookie,fileId,1,'v2');
 const before=await api(env,link);const oldUrl=before.response.headers.get('location');
 const put=env.PUBLIC_BUCKET.put.bind(env.PUBLIC_BUCKET);
 env.PUBLIC_BUCKET.put=async (key,...rest)=>{if(key.startsWith('versions/'))throw Error('copy-down');return put(key,...rest);};
 assert.equal((await api(env,`/api/v1/publications/${id}/publish-latest`,{method:'POST',cookie})).status,503);
 assert.equal((await api(env,link)).response.headers.get('location'),oldUrl);
 env.PUBLIC_BUCKET.put=put;
 const oldBatch=env.DB.batch.bind(env.DB);let lose=true;
 env.DB.batch=async stmts=>{const r=await oldBatch(stmts);if(lose&&stmts.length===6){lose=false;throw Error('lost success response');}return r;};
 const result=await api(env,`/api/v1/publications/${id}/publish-latest`,{method:'POST',cookie});
 assert.equal(result.status,200,JSON.stringify(result.data));
 const newest=await api(env,link);assert.equal(newest.status,302);
 assert.notEqual(newest.response.headers.get('location'),oldUrl);
 const newKey=new URL(newest.response.headers.get('location')).pathname.slice(1);
 assert.ok(env.PUBLIC_BUCKET.objects.has(newKey),'the new live public object must not be deleted after lost response');
});
