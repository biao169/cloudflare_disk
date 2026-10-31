import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';

async function authorize(env){
 const secret='abcdef0123456789'.repeat(4);env.MS_CLIENT_ID='12345678-abcd-1234-abcd-123456789abc';env.MS_CLIENT_SECRET='test-secret';env.MS_TOKEN_KEY=secret;
 const bytes=Uint8Array.from(secret.match(/../g),h=>parseInt(h,16));const key=await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt']);const iv=new Uint8Array(12).fill(6);
 const value=new TextEncoder().encode(JSON.stringify({access_token:'secret-test-token',refresh_token:'refresh',expires_at:Date.now()+50000000}));
 const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,value));
 env.DB.native.prepare("INSERT INTO onedrive_oauth_account (id,encrypted_tokens,updated_at) VALUES ('admin',?,CURRENT_TIMESTAMP)").run(Buffer.from(iv).toString('hex')+':'+Buffer.from(data).toString('base64url'));
}
const origin='http://localhost:8787';

test('RC14.9 admin publication, editable presentation, custom R2 cover, public preview and revocation',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);await authorize(env);
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 let graphCalls=0,mediaCalls=0;
 globalThis.fetch=async(url,opts={})=>{
  const u=new URL(url);
  if(u.hostname==='graph.microsoft.com'){
   graphCalls++;
   assert.equal(opts.headers.Authorization,'Bearer secret-test-token');
   if(u.pathname.endsWith('/thumbnails'))return Response.json({value:[{large:{url:'https://abc.files.1drv.com/photo-thumb.jpg'}}]});
   return Response.json({id:'item!1',name:'设计资料.pdf',size:4096,folder:null,file:{mimeType:'application/pdf'},parentReference:{driveId:'drive!1'},lastModifiedDateTime:'2026-10-30T10:00:00Z','@microsoft.graph.downloadUrl':'https://abc.files.1drv.com/original.pdf'});
  }
  if(u.hostname==='abc.files.1drv.com'){
   mediaCalls++;
   if(u.pathname.endsWith('photo-thumb.jpg'))return new Response(new Uint8Array([255,216,255,224,0,0,0,0,0,0,0,0,1,2,3,4]),{headers:{'Content-Type':'image/jpeg'}});
   const range=opts.headers?.Range;
   return new Response(opts.method==='HEAD'?null:new TextEncoder().encode('%PDF-test'),{status:range?206:200,headers:{'Content-Type':'application/pdf',...(range?{'Content-Range':'bytes 0-8/4096'}:{})}});
  }
  throw Error('Unexpected external network request '+url);
 };
 const noAuth=await api(env,'/api/v1/admin/onedrive/drive/publications',{method:'GET'});assert.equal(noAuth.status,401);
 const publish=await api(env,'/api/v1/admin/onedrive/drive/publish',{method:'POST',cookie,body:{item_id:'item!1',confirm_public:true}});
 assert.equal(publish.status,201,JSON.stringify(publish.data));const pub=publish.data.data;const id=pub.id;
 assert.equal(pub.share_url,`/s/${id}`);assert.equal(pub.url,`/r/${id}`);
 assert.equal(env.DB.query('SELECT file_size FROM onedrive_drive_publications WHERE id=?',id).file_size,4096);
 const before=graphCalls;
 const metadata=await api(env,`/api/v1/public/onedrive/${id}`);
 assert.equal(metadata.status,200,JSON.stringify(metadata.data));assert.equal(metadata.data.data.name,'设计资料.pdf');
 assert.equal(metadata.data.data.mime_type,'application/pdf');assert.equal(graphCalls,before,'public metadata is D1-only');
 assert.ok(!JSON.stringify(metadata.data).includes('drive!1'));assert.ok(!JSON.stringify(metadata.data).includes('secret-test-token'));
 const edit=await api(env,`/api/v1/admin/onedrive/drive/publications/${id}`,{method:'PATCH',cookie,body:{title:'教学资料',description:'第一章\n练习图',display_name:'课程组',cover_style:'ocean',preview_enabled:true}});
 assert.equal(edit.status,200,JSON.stringify(edit.data));assert.equal(edit.data.data.title,'教学资料');
 const open=await api(env,`/s/${id}`);assert.equal(open.status,200);assert.match(open.response.headers.get('content-security-policy'),/default-src 'self'/);
 const coverBytes=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0,0,1]);
 const upload=await api(env,`/api/v1/admin/onedrive/drive/publications/${id}/cover`,{method:'PUT',cookie,body:coverBytes,headers:{'Content-Type':'image/png'}});
 assert.equal(upload.status,200,JSON.stringify(upload.data));
 const cover=await api(env,`/api/v1/public/onedrive/${id}/cover`);assert.equal(cover.status,200);assert.equal(cover.response.headers.get('content-type'),'image/png');
 assert.deepEqual(new Uint8Array(await cover.response.arrayBuffer()),coverBytes);
 const download=await api(env,`/r/${id}`);assert.equal(download.status,302);assert.equal(download.response.headers.get('location'),'https://abc.files.1drv.com/original.pdf');
 const adminList=await api(env,'/api/v1/admin/onedrive/drive/publications',{cookie});assert.equal(adminList.status,200);assert.equal(adminList.data.data.items[0].title,'教学资料');assert.equal(adminList.data.data.items[0].has_custom_cover,true);
 const preview=await api(env,`/api/v1/public/onedrive/${id}/preview`,{headers:{Range:'bytes=0-8'}});
 assert.equal(preview.status,206);assert.equal(preview.response.headers.get('content-type'),'application/pdf');assert.equal(preview.response.headers.get('content-range'),'bytes 0-8/4096');
 assert.equal(await preview.response.text(),'%PDF-test');assert.ok(mediaCalls);
 const disabled=await api(env,`/api/v1/admin/onedrive/drive/publications/${id}`,{method:'PATCH',cookie,body:{preview_enabled:false}});assert.equal(disabled.status,200);
 const count=graphCalls;const noPreview=await api(env,`/api/v1/public/onedrive/${id}/preview`);assert.equal(noPreview.status,403);assert.equal(graphCalls,count);
 const revoked=await api(env,`/api/v1/admin/onedrive/drive/publications/${id}`,{method:'DELETE',cookie});assert.equal(revoked.status,200);
 const after=await api(env,`/api/v1/public/onedrive/${id}`);assert.equal(after.status,410);
 const afterCover=await api(env,`/api/v1/public/onedrive/${id}/cover`);assert.equal(afterCover.status,410);
 const afterPreview=await api(env,`/api/v1/public/onedrive/${id}/preview`);assert.equal(afterPreview.status,410);
 const afterDirect=await api(env,`/r/${id}`);assert.equal(afterDirect.status,410);
});

test('RC14.9 public endpoints do not grant permission to private records; deny unsafe inputs and redirects',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);await authorize(env);
 const orig=globalThis.fetch;t.after(()=>{globalThis.fetch=orig;});
 globalThis.fetch=async(url,opts)=>{
  if(new URL(url).hostname==='graph.microsoft.com')return Response.json({id:'item!2',name:'file.png',size:1024,file:{mimeType:'image/png'},parentReference:{driveId:'drive!1'},'@microsoft.graph.downloadUrl':'https://abc.files.1drv.com/file.png'});
  return new Response(null,{status:302,headers:{Location:'https://evil.invalid/steal'}});
 };
 const created=await api(env,'/api/v1/admin/onedrive/drive/publish',{method:'POST',cookie,body:{item_id:'item!2',confirm_public:true}});assert.equal(created.status,201);
 const id=created.data.data.id;
 const invalid=await api(env,`/api/v1/admin/onedrive/drive/publications/${id}`,{method:'PATCH',cookie,body:{cover_style:'javascript:alert(1)'}});assert.equal(invalid.status,400);
 const uploadBad=await api(env,`/api/v1/admin/onedrive/drive/publications/${id}/cover`,{method:'PUT',cookie,headers:{'Content-Type':'image/svg+xml'},body:'<svg/>'});assert.equal(uploadBad.status,400);
 const attempts=await api(env,`/api/v1/public/onedrive/${id}/preview`);assert.equal(attempts.status,503,'reject untrusted Microsoft redirect, no following arbitrary URL');
 const noMethod=await api(env,`/api/v1/public/onedrive/${id}`,{method:'DELETE'});assert.equal(noMethod.status,405);
 const viewer=await api(env,`/api/v1/admin/onedrive/drive/publications/${id}`,{method:'PATCH',body:{title:'attack'}});assert.equal(viewer.status,401);
});
