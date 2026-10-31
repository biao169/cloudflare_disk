import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,api,initialize} from './support.js';

const url='/api/v1/admin/onedrive/drive/browse';
async function addGraphCredentials(env){
 const secret='abcdef0123456789'.repeat(4);env.MS_CLIENT_ID='12345678-abcd-1234-abcd-123456789abc';env.MS_CLIENT_SECRET='test-secret';env.MS_TOKEN_KEY=secret;
 const raw=Uint8Array.from(secret.match(/../g),s=>parseInt(s,16));const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt']);const iv=new Uint8Array(12).fill(3);
 const body=new TextEncoder().encode(JSON.stringify({access_token:'test-access-token',refresh_token:'refresh',expires_at:Date.now()+36000000}));
 const value=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,body));
 const encrypted=Buffer.from(iv).toString('hex')+':'+Buffer.from(value).toString('base64url');
 env.DB.native.prepare("INSERT INTO onedrive_oauth_account (id,encrypted_tokens,updated_at) VALUES ('admin',?,CURRENT_TIMESTAMP)").run(encrypted);
}

test('RC14.8 admin-only browsing works over Worker API with real D1 auth and signed next cursor',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);await addGraphCredentials(env);
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 let calls=0;
 globalThis.fetch=async(url,opts)=>{
  calls++;const target=new URL(url);assert.equal(target.origin,'https://graph.microsoft.com');assert.equal(opts.headers.Authorization,'Bearer test-access-token');
  if(target.pathname.endsWith('/thumbnails'))return Response.json({value:[{medium:{url:'https://x.files.1drv.com/icon.jpg'}}]});
  if(target.searchParams.has('$skiptoken'))return Response.json({value:[{id:'item!2',name:'b.png',size:100,file:{mimeType:'image/png'},thumbnails:[{medium:{url:'https://x.files.1drv.com/b.png'}}]}]});
  if(target.searchParams.has('$expand'))return Response.json({value:[{id:'item!1',name:'资料',folder:{childCount:3}}], '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=next'});
  throw Error('Unexpected Graph URL '+target);
 };
 const anonymous=await api(env,url);assert.equal(anonymous.status,401);assert.equal(calls,0);
 const created=await api(env,'/api/v1/users',{method:'POST',cookie,body:{username:'onedriveViewer',password:'viewer-password-123'}});
 assert.equal(created.status,201);
 const logged=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'onedriveViewer',password:'viewer-password-123'}});
 assert.equal(logged.status,200);
 const viewerCookie=logged.response.headers.get('set-cookie').split(';')[0];
 const denied=await api(env,url,{cookie:viewerCookie});assert.equal(denied.status,403);assert.equal(calls,0);
 const deniedThumb=await api(env,'/api/v1/admin/onedrive/drive/thumbnail?item=item!2',{cookie:viewerCookie});assert.equal(deniedThumb.status,403);
 const first=await api(env,url,{cookie});assert.equal(first.status,200,JSON.stringify(first.data));
 assert.equal(first.data.data.items[0].name,'资料');assert.ok(first.data.data.next_cursor);
 assert.ok(!JSON.stringify(first.data).includes('test-access-token'));
 const cursor=first.data.data.next_cursor;
 const second=await api(env,`${url}?cursor=${encodeURIComponent(cursor)}`,{cookie});assert.equal(second.status,200,JSON.stringify(second.data));assert.equal(second.data.data.items[0].name,'b.png');
 assert.equal(second.data.data.next_cursor,null);
 const poisoned=await api(env,`${url}?cursor=${encodeURIComponent(cursor)}&parent=anotherFolder`,{cookie});assert.equal(poisoned.status,400);assert.equal(poisoned.data.error.code,'INVALID_CURSOR');
 const thumb=await api(env,'/api/v1/admin/onedrive/drive/thumbnail?item=item!2',{cookie});assert.equal(thumb.status,200);assert.equal(thumb.data.data.url,'https://x.files.1drv.com/icon.jpg');
});

test('RC14.8 public endpoint cannot access OneDrive management data',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const unauth=await api(env,'/api/v1/admin/onedrive/drive/thumbnail?item=abcdef');assert.equal(unauth.status,401);
 const bad=await api(env,'/api/v1/admin/onedrive/drive/browse?parent=https%3A%2F%2Fevil.example');assert.equal(bad.status,401);
});
