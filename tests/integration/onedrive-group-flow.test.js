import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';

async function connected(env){
 const secret='abcdef0123456789'.repeat(4);env.MS_CLIENT_ID='12345678-abcd-1234-abcd-123456789abc';env.MS_CLIENT_SECRET='test';env.MS_TOKEN_KEY=secret;
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(secret.match(/../g),x=>parseInt(x,16)),'AES-GCM',false,['encrypt']);const iv=new Uint8Array(12).fill(9);
 const value=new TextEncoder().encode(JSON.stringify({access_token:'test-token',refresh_token:'test',expires_at:Date.now()+50000000}));const out=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,value));
 env.DB.native.prepare("INSERT INTO onedrive_oauth_account(id,encrypted_tokens,updated_at) VALUES('admin',?,CURRENT_TIMESTAMP)").run(Buffer.from(iv).toString('hex')+':'+Buffer.from(out).toString('base64url'));
}
const file=(id,name)=>({id,name,size:200,file:{mimeType:'application/pdf'},parentReference:{driveId:'drive!1'},lastModifiedDateTime:'2026-10-31T09:00:00Z','@microsoft.graph.downloadUrl':'https://a.files.1drv.com/download'});
const folder=(id,name)=>({id,name,folder:{childCount:2},parentReference:{driveId:'drive!1'}});
function stubGraph(){let hit=0;return {get hit(){return hit;},fetch:async(url,options)=>{
 const u=new URL(url);assert.equal(u.origin,'https://graph.microsoft.com');assert.equal(options.headers.Authorization,'Bearer test-token');hit++;
 if(u.pathname.endsWith('/items/dir!1/children')){if(u.searchParams.has('$skiptoken'))return Response.json({value:[file('file!3','Third.pdf')]});return Response.json({value:[file('file!1','First.pdf'),folder('dir!2','Nested')],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/drive/items/dir!1/children?$skiptoken=next'});}
 if(u.pathname.endsWith('/items/dir!2/children'))return Response.json({value:[file('file!2','Second.pdf')]});
 if(u.pathname.endsWith('/items/dir!1'))return Response.json(folder('dir!1','Course Materials'));
 if(u.pathname.endsWith('/items/dir!2'))return Response.json(folder('dir!2','Nested'));
 if(u.pathname.endsWith('/items/file!1'))return Response.json(file('file!1','First.pdf'));
 if(u.pathname.endsWith('/items/file!2'))return Response.json(file('file!2','Second.pdf'));
 if(u.pathname.endsWith('/items/file!3'))return Response.json(file('file!3','Third.pdf'));
 if(u.pathname.endsWith('/items/missing'))return new Response('missing',{status:404});
 return new Response('bad graph URL '+u.href,{status:400});
 }};}

test('RC14.10 folder snapshot, anonymous browsing, direct file routes, and revocation end to end',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);await connected(env);
 const old=globalThis.fetch;const graph=stubGraph();globalThis.fetch=graph.fetch;t.after(()=>{globalThis.fetch=old;});
 const anonymous=await api(env,'/api/v1/admin/onedrive/groups',{method:'POST',body:{kind:'folder',title:'docs',item_ids:['dir!1'],confirm_public:true}});assert.equal(anonymous.status,401);
 const created=await api(env,'/api/v1/admin/onedrive/groups',{cookie,method:'POST',body:{kind:'folder',title:'课程资料',description:'公开教学资料',item_ids:['dir!1'],sync_mode:'snapshot',confirm_public:true}});
 assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.data.id;assert.match(id,/^odg_[a-f0-9]{32}$/);assert.equal(created.data.data.item_count,3);assert.equal(created.data.data.folder_count,2);
 assert.equal(env.DB.query('SELECT COUNT(*) AS count FROM onedrive_share_group_entries WHERE group_id=?',id).count,5);
 const page=await api(env,`/s/${id}`);assert.equal(page.status,200);
 const before=graph.hit;
 const publicData=await api(env,`/api/v1/public/onedrive/groups/${id}`);assert.equal(publicData.status,200);
 assert.equal(graph.hit,before,'public folder listing must be fully D1-backed');
 const parsed=publicData.data.data;assert.equal(parsed.item_count,3);assert.equal(parsed.entries.length,5);
 assert.ok(!JSON.stringify(parsed).includes('drive!1'));assert.ok(!JSON.stringify(parsed).includes('test-token'));assert.ok(!JSON.stringify(parsed).includes('file!1'));
 const node=parsed.entries.find(x=>x.name==='Second.pdf');assert.match(node.share_url,/^\/s\/odf_/);
 const direct=await api(env,node.download_url);assert.equal(direct.status,302);assert.equal(direct.response.headers.get('location'),'https://a.files.1drv.com/download');
 const preview=await api(env,node.share_url);assert.equal(preview.status,200);
 const single=await api(env,'/api/v1/admin/onedrive/drive/publish',{cookie,method:'POST',body:{item_id:'file!3',confirm_public:true}});assert.equal(single.status,201);
 const revoked=await api(env,`/api/v1/admin/onedrive/groups/${id}`,{method:'DELETE',cookie});assert.equal(revoked.status,200);assert.equal(revoked.data.data.revoked,true);
 assert.equal((await api(env,`/api/v1/public/onedrive/groups/${id}`)).status,410);
 assert.equal((await api(env,node.download_url)).status,410);
 assert.equal((await api(env,node.share_url)).status,200,'HTML shell may still load; API metadata must be revoked');
 assert.equal((await api(env,`/api/v1/public/onedrive/${node.share_url.split('/').at(-1)}`)).status,410);
 assert.equal((await api(env,single.data.data.url)).status,302,'independent preexisting publication survives group revocation');
});

test('RC14.10 custom collection merges folders and files and rejects auto-sync',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);await connected(env);
 const old=globalThis.fetch;globalThis.fetch=stubGraph().fetch;t.after(()=>{globalThis.fetch=old;});
 const deny=await api(env,'/api/v1/admin/onedrive/groups',{cookie,method:'POST',body:{kind:'collection',title:'合辑',item_ids:['file!1'],sync_mode:'dynamic',confirm_public:true}});
 assert.equal(deny.status,400);assert.equal(deny.data.error.code,'AUTOMATIC_SYNC_NOT_SUPPORTED');
 const c=await api(env,'/api/v1/admin/onedrive/groups',{cookie,method:'POST',body:{kind:'collection',title:'合辑',item_ids:['file!1','dir!2'],confirm_public:true}});
 assert.equal(c.status,201,JSON.stringify(c.data));assert.equal(c.data.data.item_count,2);
 const id=c.data.data.id;
 const items=await api(env,`/api/v1/public/onedrive/groups/${id}`);assert.equal(items.data.data.entries.filter(x=>x.type==='folder').length,1);
 const update=await api(env,`/api/v1/admin/onedrive/groups/${id}`,{cookie,method:'PATCH',body:{title:'新名称',description:'扩展说明'}});assert.equal(update.status,200);
 assert.equal((await api(env,`/api/v1/public/onedrive/groups/${id}`)).data.data.title,'新名称');
 const adminList=await api(env,'/api/v1/admin/onedrive/groups',{cookie});assert.equal(adminList.status,200);assert.equal(adminList.data.data.items[0].title,'新名称');
 const pubs=await api(env,'/api/v1/admin/onedrive/drive/publications',{cookie});assert.equal(pubs.status,200);assert.equal(pubs.data.data.items.length,0,'collection subfiles do not clutter standalone publications list');
});

test('RC14.10 batch publication isolates individual failures and preserves successes',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);await connected(env);
 const old=globalThis.fetch;globalThis.fetch=stubGraph().fetch;t.after(()=>{globalThis.fetch=old;});
 const r=await api(env,'/api/v1/admin/onedrive/drive/batch-publish',{cookie,method:'POST',body:{item_ids:['file!1','missing','dir!1'],confirm_public:true}});
 assert.equal(r.status,207,JSON.stringify(r.data));assert.equal(r.data.data.succeeded,1);assert.equal(r.data.data.failed,2);
 assert.match(r.data.data.results[0].share_url,/^\/s\/odf_/);
 assert.equal(r.data.data.results[1].error,'MICROSOFT_NOT_FOUND');assert.equal(r.data.data.results[2].error,'FILE_REQUIRED');
 const pubs=await api(env,'/api/v1/admin/onedrive/drive/publications',{cookie});assert.equal(pubs.data.data.items.length,1);
});
