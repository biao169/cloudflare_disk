import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';
import {countView,countDownload} from '../../worker/services/onedrive-share-policy.js';

const FILE='odf_'+'a'.repeat(32),CHILD='odf_'+'c'.repeat(32),GROUP='odg_'+'b'.repeat(32);
function seed(db){db.native.prepare('INSERT INTO onedrive_share_groups (id,kind,title,item_count) VALUES(?,?,?,?)').run(GROUP,'collection','Public Example',1);
 for(const [id,group] of [[FILE,null],[CHILD,GROUP]])db.native.prepare('INSERT INTO onedrive_drive_publications (id,drive_id,item_id,file_name,group_id) VALUES(?,?,?,?,?)').run(id,'drive!1','item!1','example.pdf',group);
}
const patch=(id)=>`/api/v1/admin/onedrive/shares/${id}/policy`;
const pub=(id)=>`/api/v1/public/onedrive/${id}`;

async function envSetup(t){const env=makeTestEnv();t.after(()=>env.DB.close());env.MS_TOKEN_KEY='9'.repeat(64);const user=await initialize(env);seed(env.DB);return {env,user};}

test('RC14.11 backend enforces pause / member only / expiration for file and group',async t=>{
 const {env,user}=await envSetup(t);
 const paused=await api(env,patch(FILE),{method:'PATCH',cookie:user.cookie,body:{is_paused:true}});
 assert.equal(paused.status,200,JSON.stringify(paused.data));
 assert.equal((await api(env,pub(FILE))).data.error.code,'SHARE_PAUSED');
 assert.equal((await api(env,`/r/${FILE}`)).status,403);
 await api(env,patch(FILE),{method:'PATCH',cookie:user.cookie,body:{is_paused:false,access_mode:'member'}});
 assert.equal((await api(env,pub(FILE))).data.error.code,'LOGIN_REQUIRED');
 assert.equal((await api(env,pub(FILE),{cookie:user.cookie})).status,200);
 await api(env,patch(GROUP),{method:'PATCH',cookie:user.cookie,body:{is_paused:true}});
 assert.equal((await api(env,pub(CHILD))).data.error.code,'SHARE_PAUSED');
 assert.equal((await api(env,`/api/v1/public/onedrive/groups/${GROUP}`)).status,403);
 assert.equal((await api(env,`/r/${CHILD}`)).status,403);
});

test('RC14.11 password protection guards metadata, cover, preview and direct file URL; unlock cookie is signed',async t=>{
 const {env,user}=await envSetup(t);
 const policy=await api(env,patch(GROUP),{method:'PATCH',cookie:user.cookie,body:{password:'SixSafePassword!'}});
 assert.equal(policy.status,200,JSON.stringify(policy.data));assert.equal(policy.data.data.password_protected,true);
 const audit=env.DB.native.prepare("SELECT detail_json FROM audit_logs WHERE action='onedrive.share.policy.update' ORDER BY created_at DESC LIMIT 1").get();assert.ok(audit);assert.ok(!audit.detail_json.includes('SixSafePassword!'));assert.match(audit.detail_json,/changed_fields/);
 for(const route of [pub(CHILD),pub(CHILD)+'/cover',pub(CHILD)+'/preview',`/api/v1/public/onedrive/groups/${GROUP}`,`/r/${CHILD}`]){
  const r=await api(env,route);assert.equal(r.status,401,route);assert.equal(r.data.error.code,'PASSWORD_REQUIRED');
 }
 const bad=await api(env,'/api/v1/public/onedrive/unlock',{method:'POST',body:{id:CHILD,password:'not right'}});
 assert.equal(bad.status,403);assert.equal(bad.data.error.code,'INVALID_PASSWORD');
 const good=await api(env,'/api/v1/public/onedrive/unlock',{method:'POST',body:{id:CHILD,password:'SixSafePassword!'}});
 assert.equal(good.status,200,JSON.stringify(good.data));const cookie=good.response.headers.get('set-cookie').split(';')[0];assert.ok(cookie.startsWith('odunlock_'+GROUP+'='));assert.match(good.response.headers.get('set-cookie'),/HttpOnly/);assert.match(good.response.headers.get('set-cookie'),/SameSite=Lax/);
 assert.equal((await api(env,pub(CHILD),{cookie})).status,200);
 assert.equal((await api(env,`/api/v1/public/onedrive/groups/${GROUP}`,{cookie})).status,200);
 assert.equal((await api(env,pub(CHILD),{cookie:cookie.replace(/.$/,'f')})).status,401);
 await api(env,patch(GROUP),{method:'PATCH',cookie:user.cookie,body:{show_direct_link:false}});
 assert.equal((await api(env,pub(CHILD),{cookie})).status,401,'policy edit invalidates existing unlock');
});

test('RC14.11 view caps and grouped download caps are atomic; no extra counts on rejected requests',async t=>{
 const {env,user}=await envSetup(t);
 await api(env,patch(GROUP),{method:'PATCH',cookie:user.cookie,body:{max_downloads:1,max_views:1}});
 let r=await api(env,`/api/v1/public/onedrive/groups/${GROUP}`);assert.equal(r.status,200);
 r=await api(env,`/api/v1/public/onedrive/groups/${GROUP}`);assert.equal(r.status,429);assert.equal(r.data.error.code,'VIEW_LIMIT_REACHED');
 const child=await env.DB.prepare('SELECT * FROM onedrive_drive_publications WHERE id=?').bind(CHILD).first();
 assert.equal(await countDownload(env,child),true);
 assert.equal(await countDownload(env,child),false);
 assert.equal((await env.DB.query('SELECT download_count FROM onedrive_share_groups WHERE id=?',GROUP)).download_count,1);
 assert.equal((await env.DB.query('SELECT download_count FROM onedrive_drive_publications WHERE id=?',CHILD)).download_count,1);
 const summary=await api(env,'/api/v1/admin/onedrive/shares/summary',{cookie:user.cookie});assert.equal(summary.status,200);
 assert.equal(summary.data.data.group.downloads,1);
 const stats=await api(env,`/api/v1/admin/onedrive/shares/${GROUP}/stats`,{cookie:user.cookie});assert.equal(stats.status,200);assert.equal(stats.data.data.policy.download_count,1);
 assert.equal((await api(env,'/api/v1/admin/onedrive/shares/summary')).status,401);
});

test('RC14.11 direct child metadata honors revoked parent; password attempts are bounded',async t=>{
 const {env,user}=await envSetup(t);
 await api(env,patch(GROUP),{method:'PATCH',cookie:user.cookie,body:{password:'AValidPassword!'}});
 for(let i=0;i<8;i++){const r=await api(env,'/api/v1/public/onedrive/unlock',{method:'POST',body:{id:GROUP,password:'incorrect'}});assert.equal(r.status,403);}
 const limited=await api(env,'/api/v1/public/onedrive/unlock',{method:'POST',body:{id:GROUP,password:'AValidPassword!'}});
 assert.equal(limited.status,429);assert.equal(limited.data.error.code,'UNLOCK_RATE_LIMITED');
 const revoked=await api(env,`/api/v1/admin/onedrive/groups/${GROUP}`,{method:'DELETE',cookie:user.cookie});assert.equal(revoked.status,200);
 assert.equal((await api(env,pub(CHILD))).status,410);
});

async function installTestOAuth(env){
 env.MS_CLIENT_ID='11111111-2222-4333-8444-555555555555';env.MS_CLIENT_SECRET='unit-test-client-secret';
 const keyBytes=Uint8Array.from(env.MS_TOKEN_KEY.match(/../g),x=>parseInt(x,16));
 const key=await crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM'},false,['encrypt']);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify({access_token:'fake-test-token',refresh_token:'fake-test-refresh',expires_at:Date.now()+3600000})));
 const hex=Array.from(iv,x=>x.toString(16).padStart(2,'0')).join('');
 const b64=btoa(String.fromCharCode(...new Uint8Array(encrypted))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 env.DB.native.prepare("INSERT INTO onedrive_oauth_account (id,encrypted_tokens,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)").run('admin',`${hex}:${b64}`);
}

test('RC14.11 true file redirect counts only successful GET; HEAD cannot reveal unpaid download URL',async t=>{
 const {env,user}=await envSetup(t);await installTestOAuth(env);
 const previousFetch=globalThis.fetch;
 const download='https://public.dm.files.1drv.com/valid-file?token=temporary';
 let called=0;
 globalThis.fetch=async (url,opt)=>{called++;assert.ok(String(url).startsWith('https://graph.microsoft.com/v1.0/drives/'));assert.equal(opt.headers.Authorization,'Bearer fake-test-token');return Response.json({id:'item!1',file:{mimeType:'application/pdf'},'@microsoft.graph.downloadUrl':download});};
 t.after(()=>{globalThis.fetch=previousFetch;});
 await api(env,patch(FILE),{method:'PATCH',cookie:user.cookie,body:{max_downloads:1}});
 const head=await api(env,`/r/${FILE}`,{method:'HEAD'});
 assert.equal(head.status,204);assert.equal(head.response.headers.get('Location'),null);assert.equal(called,0);
 const first=await api(env,`/r/${FILE}`);
 assert.equal(first.status,302,JSON.stringify(first.data));assert.equal(first.response.headers.get('Location'),download);assert.equal(called,1);
 const second=await api(env,`/r/${FILE}`);assert.equal(second.status,429);assert.equal(called,1,'must reject before upstream Graph call');
 const stored=env.DB.query('SELECT access_count,download_count FROM onedrive_drive_publications WHERE id=?',FILE);
 assert.equal(stored.access_count,1);assert.equal(stored.download_count,1);
});

test('RC14.11 expired shares can be renewed; member-only files reject visitors but accept CloudDrive session',async t=>{
 const {env,user}=await envSetup(t);
 await api(env,patch(FILE),{method:'PATCH',cookie:user.cookie,body:{access_mode:'member',expires_at:'2030-01-01T00:00:00Z'}});
 let result=await api(env,pub(FILE));assert.equal(result.status,401);assert.equal(result.data.error.code,'LOGIN_REQUIRED');
 result=await api(env,pub(FILE),{cookie:user.cookie});assert.equal(result.status,200);
 env.DB.native.prepare('UPDATE onedrive_drive_publications SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00Z',FILE);
 assert.equal((await api(env,pub(FILE),{cookie:user.cookie})).status,410);
 const patchResult=await api(env,patch(FILE),{method:'PATCH',cookie:user.cookie,body:{expires_at:null}});assert.equal(patchResult.status,200);
 assert.equal((await api(env,pub(FILE),{cookie:user.cookie})).status,200);
});
