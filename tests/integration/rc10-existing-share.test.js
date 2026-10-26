import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';
import {shareRecoveryState,showExistingFirst} from '../../public/js/components/share-dialog.js';

async function upload(env,login,name='rc10-existing-share.pdf'){
 const data=new TextEncoder().encode('%PDF-1.7\nCloudDrive RC10');
 const result=await api(env,`/api/v1/storage/upload?space_id=${login.spaceId}&name=${name}`,{
  method:'POST',cookie:login.cookie,body:data,headers:{'Content-Type':'application/pdf'}
 });
 assert.equal(result.status,201,JSON.stringify(result.data));return result.data.data.id;
}
function share(env,login,id,extra={}){
 return api(env,'/api/v1/shares',{method:'POST',cookie:login.cookie,body:{
  type:'page',target_type:'file',target_id:id,expires_at:new Date(Date.now()+7*86400000).toISOString(),...extra
 }});
}

// This flag is sent by the Share modal, not required of legacy API clients.
test('RC10: new interactive shares guarantee re-obtainable URLs when secret is ready',async t=>{
 const env=makeTestEnv();env.SHARE_LINK_KEY='8a'.repeat(32);t.after(()=>env.DB.close());
 const login=await initialize(env),id=await upload(env,login);
 const made=await share(env,login,id,{require_recoverable:true,password:'old-access-password-123'});
 assert.equal(made.status,201,JSON.stringify(made.data));
 const sid=made.data.data.share.id,original=made.data.data.url;
 assert.equal(env.DB.query('SELECT link_origin FROM shares WHERE id=?',sid).link_origin,'http://localhost:8787');
 const list=await api(env,`/api/v1/shares?target_type=file&target_id=${id}`,{cookie:login.cookie});
 assert.equal(list.status,200);assert.equal(list.data.data.shares.length,1);
 assert.equal(list.data.data.link_key_status,'ready');
 assert.equal(list.data.data.shares[0].link_recoverable,true);
 assert.ok(!JSON.stringify(list.data).includes(original),'list API does not leak bearer URL');
 const old=await api(env,`/api/v1/shares/${sid}/link`,{cookie:login.cookie});
 assert.equal(old.status,200);assert.equal(old.data.data.url,original);
 const worker=(await import('../../worker/index.js')).default;
 const alt=await worker.fetch(new Request(`https://new-domain.example.test/api/v1/shares/${sid}/link`,{headers:{Cookie:login.cookie}}),env);
 assert.equal(alt.status,200);assert.equal((await alt.json()).data.url,original,'original hostname must be preserved after later custom-domain switch');
 const change=await api(env,`/api/v1/shares/${sid}`,{cookie:login.cookie,method:'PATCH',body:{
  expires_at:new Date(Date.now()+10*86400000).toISOString(),
  max_downloads:4,allow_download:false,password_action:'replace',password:'new-access-password-456'
 }});
 assert.equal(change.status,200,JSON.stringify(change.data));
 assert.equal(change.data.data.share.max_downloads,4);
 assert.equal(change.data.data.share.allow_download,false);
 assert.equal(change.data.data.share.has_password,true);
 const same=await api(env,`/api/v1/shares/${sid}/link`,{cookie:login.cookie});
 assert.equal(same.status,200);assert.equal(same.data.data.url,original,'editing must preserve exact original URL');
});

test('RC10: original share URL can be retrieved while expired, then renewed without rotation',async t=>{
 const env=makeTestEnv();env.SHARE_LINK_KEY='91'.repeat(32);t.after(()=>env.DB.close());
 const login=await initialize(env),id=await upload(env,login);
 const made=await share(env,login,id,{type:'temporary',require_recoverable:true});
 assert.equal(made.status,201);const sid=made.data.data.share.id,original=made.data.data.url;
 env.DB.native.prepare("UPDATE shares SET expires_at='2020-01-01 00:00:00' WHERE id=?").run(sid);
 const listed=await api(env,`/api/v1/shares?target_type=file&target_id=${id}`,{cookie:login.cookie});
 assert.equal(listed.data.data.shares[0].status,'expired');
 const recovered=await api(env,`/api/v1/shares/${sid}/link`,{cookie:login.cookie});
 assert.equal(recovered.status,200,JSON.stringify(recovered.data));
 assert.equal(recovered.data.data.url,original);
 const changed=await api(env,`/api/v1/shares/${sid}`,{method:'PATCH',cookie:login.cookie,body:{expires_at:new Date(Date.now()+86400000).toISOString()}});
 assert.equal(changed.status,200);assert.equal(changed.data.data.share.status,'active');
 assert.equal((await api(env,`/api/v1/shares/${sid}/link`,{cookie:login.cookie})).data.data.url,original);
});

test('RC10: share owner cannot recover an expired URL after losing access to source',async t=>{
 const env=makeTestEnv();env.SHARE_LINK_KEY='a1'.repeat(32);t.after(()=>env.DB.close());
 const login=await initialize(env),id=await upload(env,login);
 const made=await share(env,login,id,{require_recoverable:true});const sid=made.data.data.share.id;
 env.DB.native.prepare("UPDATE shares SET expires_at='2020-01-01 00:00:00' WHERE id=?").run(sid);
 env.DB.native.prepare("UPDATE files SET status='trashed', deleted_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
 const recovered=await api(env,`/api/v1/shares/${sid}/link`,{cookie:login.cookie});
 assert.equal(recovered.status,403);
 assert.equal(recovered.data.error.code,'PERMISSION_REVOKED');
});

test('RC10: opt-in recoverability refuses new share without valid secret and stores nothing',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const login=await initialize(env),id=await upload(env,login);
 let r=await share(env,login,id,{require_recoverable:true});
 assert.equal(r.status,503);assert.equal(r.data.error.code,'SHARE_LINK_KEY_REQUIRED');
 assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM shares').n,0);
 r=await share(env,login,id,{require_recoverable:'yes'});
 assert.equal(r.status,400);
 assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM shares').n,0);
 // Legacy API clients are not broken; modal requires explicit user opt-out.
 const legacy=await share(env,login,id,{require_recoverable:false});
 assert.equal(legacy.status,201);assert.equal(legacy.data.data.link_recovery,'rotation_only');
 assert.equal((await api(env,`/api/v1/shares/${legacy.data.data.share.id}/link`,{cookie:login.cookie})).status,409);
 env.SHARE_LINK_KEY='a2'.repeat(32);
 const rotate=await api(env,`/api/v1/shares/${legacy.data.data.share.id}/rotate`,{method:'POST',cookie:login.cookie});
 assert.equal(rotate.status,200);assert.notEqual(rotate.data.data.url,legacy.data.data.url);
 assert.equal((await api(env,`/api/v1/shares/${legacy.data.data.share.id}/link`,{cookie:login.cookie})).data.data.url,rotate.data.data.url);
});

test('RC10: other account cannot see or retrieve existing owner share link',async t=>{
 const env=makeTestEnv();env.SHARE_LINK_KEY='a3'.repeat(32);t.after(()=>env.DB.close());
 const admin=await initialize(env),id=await upload(env,admin);
 const made=await share(env,admin,id,{require_recoverable:true});const sid=made.data.data.share.id;
 const create=await api(env,'/api/v1/users',{method:'POST',cookie:admin.cookie,body:{username:'rc10other',password:'pass1234'}});assert.equal(create.status,201);
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'rc10other',password:'pass1234'}});assert.equal(login.status,200);
 const otherCookie=login.response.headers.get('set-cookie').split(';')[0];
 assert.equal((await api(env,`/api/v1/shares/${sid}/link`,{cookie:otherCookie})).status,404);
 const listing=await api(env,`/api/v1/shares?target_type=file&target_id=${id}`,{cookie:otherCookie});
 assert.equal(listing.status,200);assert.equal(listing.data.data.shares.length,0);
});

test('RC10: view state advertises recoverable/legacy/key-missing and respects existing links',()=>{
 assert.equal(shareRecoveryState({status:'active',link_recoverable:true},'ready'),'recoverable');
 assert.equal(shareRecoveryState({status:'expired',link_recoverable:true},'ready'),'recoverable');
 assert.equal(shareRecoveryState({status:'active',link_recoverable:false},'ready'),'legacy');
 assert.equal(shareRecoveryState({status:'active',link_recoverable:true},'not_configured'),'missing_key');
 assert.equal(shareRecoveryState({status:'revoked',link_recoverable:true},'ready'),'unavailable');
 assert.equal(showExistingFirst([],[]),false);
 assert.equal(showExistingFirst([{id:'x'}]),true);
 assert.equal(showExistingFirst([],[{id:'p'}]),true);
});
