import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';
import {downloadErrorDescription} from '../../worker/services/onedrive-drive-files.js';
const ID='odf_'+'d'.repeat(32),GRAPH='https://graph.microsoft.com/v1.0',FILE='item!42';
async function setup(t){
 const env=makeTestEnv();t.after(()=>env.DB.close());
 env.MS_TOKEN_KEY='a'.repeat(64);env.MS_CLIENT_ID='11111111-2222-4333-8444-555555555555';env.MS_CLIENT_SECRET='test-only';
 const user=await initialize(env);
 env.DB.native.prepare('INSERT INTO onedrive_drive_publications (id,drive_id,item_id,file_name,file_mime) VALUES (?,?,?,?,?)').run(ID,'drive!1',FILE,'manual.pdf','application/pdf');
 const iv=crypto.getRandomValues(new Uint8Array(12));const key=await crypto.subtle.importKey('raw',Uint8Array.from(env.MS_TOKEN_KEY.match(/../g),x=>parseInt(x,16)),'AES-GCM',false,['encrypt']);
 const token={access_token:'test-token',refresh_token:'test-refresh',expires_at:Date.now()+3600000};
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(token)));
 const b64=btoa(String.fromCharCode(...new Uint8Array(ciphertext))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 env.DB.native.prepare('INSERT INTO onedrive_oauth_account (id,encrypted_tokens,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)').run('admin',Array.from(iv,x=>x.toString(16).padStart(2,'0')).join('')+':'+b64);
 return {env,user};
}
function withFetch(t,fn){const old=globalThis.fetch;globalThis.fetch=async (url,opts)=>{
  assert.ok(String(url).startsWith(GRAPH+'/drives/'));assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,'Bearer test-token');
  return fn(new URL(url),opts);
 };t.after(()=>{globalThis.fetch=old;});}
const item=(url)=>({id:FILE,file:{mimeType:'application/pdf'},name:'manual.pdf',...(url?{'@microsoft.graph.downloadUrl':url}:{})});
const direct='https://public.dm.files.1drv.com/actual.pdf?temporary=1';
function checkCount(env,expected){assert.equal(env.DB.query('SELECT download_count FROM onedrive_drive_publications WHERE id=?',ID).download_count,expected);}

test('download uses Graph metadata preauthenticated URL, leaves original stable URL and counts once',async t=>{
 const {env}=await setup(t);let calls=0;
 withFetch(t,(url,opts)=>{calls++;assert.equal(url.searchParams.get('$select')?.includes('@microsoft.graph.downloadUrl'),true);return Response.json(item(direct));});
 const head=await api(env,`/r/${ID}`,{method:'HEAD'});assert.equal(head.status,204);assert.equal(calls,0);
 const r=await api(env,`/r/${ID}`);assert.equal(r.status,302);assert.equal(r.response.headers.get('Location'),direct);assert.equal(calls,1);checkCount(env,1);
});
test('missing downloadUrl retries Graph /content as a manual 302 without sending bearer to CDN',async t=>{
 const {env,user}=await setup(t);let step=0;
 withFetch(t,(url,opts)=>{step++;if(url.pathname.endsWith('/content')){assert.equal(opts.headers.Accept,'*/*');assert.equal(opts.headers.Range,undefined);return new Response(null,{status:302,headers:{Location:direct}});}return Response.json(item());});
 const r=await api(env,`/r/${ID}`,{headers:{Range:'bytes=0-10'}});assert.equal(r.status,302);assert.equal(r.response.headers.get('Location'),direct);assert.equal(step,2);checkCount(env,1);
 const admin=await api(env,`/api/v1/admin/onedrive/drive/publications/${ID}/download-diagnostic`,{cookie:user.cookie});assert.equal(admin.status,200);assert.equal(admin.data.data.method,'content_redirect');assert.equal(admin.data.data.available,true);assert.ok(!JSON.stringify(admin.data).includes('temporary=1'));
 const visitor=await api(env,`/api/v1/admin/onedrive/drive/publications/${ID}/download-diagnostic`);assert.equal(visitor.status,401);checkCount(env,1);
});
test('Graph /content can directly stream binary without assuming a redirect exists',async t=>{
 const {env}=await setup(t);withFetch(t,url=>url.pathname.endsWith('/content')?new Response('file body',{headers:{'Content-Type':'application/octet-stream','Content-Length':'9'}}):Response.json(item()));
 const r=await api(env,`/r/${ID}`);assert.equal(r.status,200);assert.equal(await r.response.text(),'file body');assert.match(r.response.headers.get('Content-Disposition'),/attachment/);checkCount(env,1);
});
test('untrusted Graph /content redirect yields a safe diagnostic not a runtime TypeError or generic Source temporarily unavailable',async t=>{
 const {env,user}=await setup(t);withFetch(t,url=>url.pathname.endsWith('/content')?new Response(null,{status:302,headers:{Location:'https://attacker.example.test/malware'}}):Response.json(item()));
 const r=await api(env,`/r/${ID}`);assert.equal(r.status,502);assert.equal(r.response.headers.get('X-CloudDrive-Error-Code'),'MICROSOFT_DOWNLOAD_REDIRECT_UNTRUSTED');assert.doesNotMatch(await r.response.text(),/Source temporarily unavailable|attacker\.example/);checkCount(env,0);
 assert.equal(env.DB.query('SELECT last_error FROM onedrive_drive_publications WHERE id=?',ID).last_error,'MICROSOFT_DOWNLOAD_REDIRECT_UNTRUSTED');
 const diag=await api(env,`/api/v1/admin/onedrive/drive/publications/${ID}/download-diagnostic`,{cookie:user.cookie});assert.equal(diag.data.data.code,'MICROSOFT_DOWNLOAD_REDIRECT_UNTRUSTED');assert.equal(diag.data.data.available,false);
});
test('Graph metadata downloadUrl on Microsoft personal-content service is accepted and downloads redirect safely',async t=>{
 const {env,user}=await setup(t);
 const loc='https://my.microsoftpersonalcontent.com/personal/45ed996b079ab860/_layouts/15/download.aspx?UniqueId=11111111-1111-1111-1111-111111111111&tempauth=SECRET_DOWNLOAD_ONLY';
 withFetch(t,url=>{assert.ok(!url.pathname.endsWith('/content'));return Response.json(item(loc));});
 const out=await api(env,`/r/${ID}`);
 assert.equal(out.status,302);
 assert.equal(out.response.headers.get('Location'),loc);
 assert.equal(out.response.headers.get('Referrer-Policy'),'no-referrer');
 assert.equal(out.response.headers.has('Authorization'),false);
 checkCount(env,1);
 const diag=await api(env,`/api/v1/admin/onedrive/drive/publications/${ID}/download-diagnostic`,{cookie:user.cookie});
 assert.equal(diag.status,200);
 assert.equal(diag.data.data.available,true);
 assert.ok(!JSON.stringify(diag.data).includes('SECRET_DOWNLOAD_ONLY'));
});

test('Graph /content 302 on Microsoft personal-content service is accepted; disallowed host diagnostics reveal only the hostname',async t=>{
 const {env,user}=await setup(t);
 const loc='https://my.microsoftpersonalcontent.com/personal/45ed996b079ab860/_layouts/15/download.aspx?UniqueId=abc&tempauth=CONFIDENTIAL';
 let evil=false;
 withFetch(t,url=>url.pathname.endsWith('/content')?new Response(null,{status:302,headers:{Location:evil?'https://attacker.example.invalid/content?token=CONFIDENTIAL':loc}}):Response.json(item()));
 const out=await api(env,`/r/${ID}`);
 assert.equal(out.status,302);assert.equal(out.response.headers.get('Location'),loc);checkCount(env,1);
 evil=true;
 const bad=await api(env,`/api/v1/admin/onedrive/drive/publications/${ID}/download-diagnostic`,{cookie:user.cookie});
 assert.equal(bad.data.data.code,'MICROSOFT_DOWNLOAD_REDIRECT_UNTRUSTED');
 assert.equal(bad.data.data.blocked_download_host,'attacker.example.invalid');
 assert.ok(!JSON.stringify(bad.data).includes('CONFIDENTIAL'));
});

test('Graph throttling keeps Retry-After and never charges a download',async t=>{
 const {env}=await setup(t);withFetch(t,()=>new Response('too many',{status:429,headers:{'Retry-After':'120'}}));
 const r=await api(env,`/r/${ID}`);assert.equal(r.status,503);assert.equal(r.response.headers.get('Retry-After'),'120');assert.equal(r.response.headers.get('X-CloudDrive-Error-Code'),'MICROSOFT_THROTTLED');checkCount(env,0);
});
test('Microsoft auth expiry and missing source are distinguishable without leaking tokens',async t=>{
 const {env}=await setup(t);withFetch(t,()=>new Response('invalid token SECRET',{status:401}));
 const r=await api(env,`/r/${ID}`);assert.equal(r.status,503);assert.equal(r.response.headers.get('X-CloudDrive-Error-Code'),'MICROSOFT_REAUTHORIZE');
 assert.doesNotMatch(await r.response.text(),/SECRET/);checkCount(env,0);
 assert.match(downloadErrorDescription('MICROSOFT_REAUTHORIZE'),/重新连接/);
});
test('Graph $select compatibility retries without select on HTTP 400, then streams direct content',async t=>{
 const {env}=await setup(t);let calls=0;withFetch(t,(url)=>{calls++;
  if(url.searchParams.has('$select'))return new Response('bad select',{status:400});
  if(url.pathname.endsWith('/content'))return new Response('fallback works',{headers:{'Content-Type':'application/octet-stream'}});
  return Response.json(item());
 });
 const r=await api(env,`/r/${ID}`);assert.equal(r.status,200);assert.equal(await r.response.text(),'fallback works');assert.equal(calls,3);checkCount(env,1);
});
