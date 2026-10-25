import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';
import {cdnBaseUrl,publicationUrl} from '../../worker/services/sharing.js';
import {encryptShareCode,decryptShareCode,linkKeyStatus} from '../../worker/services/share-links.js';
import {shareStatusLabel} from '../../public/js/components/share-dialog.js';

async function upload(env,adm,name='rc8-share.pdf'){
 const r=await api(env,`/api/v1/storage/upload?space_id=${adm.spaceId}&name=${name}`,{method:'POST',cookie:adm.cookie,body:new TextEncoder().encode('%PDF-1.7\nHello'),headers:{'Content-Type':'application/pdf'}});
 assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;
}
const newShare=(env,adm,id,rest={})=>api(env,'/api/v1/shares',{method:'POST',cookie:adm.cookie,body:{type:'page',target_type:'file',target_id:id,expires_at:new Date(Date.now()+2*86400000).toISOString(),...rest}});

test('RC8: AES-GCM encryption authenticates share ID and rejects changed keys',async()=>{
 const env={SHARE_LINK_KEY:'ab'.repeat(32)},id=crypto.randomUUID(),code='cd'.repeat(32);
 const c=await encryptShareCode(env,id,code);assert.ok(c.startsWith('v1.'));
 assert.equal(await decryptShareCode(env,id,c),code);
 await assert.rejects(()=>decryptShareCode(env,crypto.randomUUID(),c));
 await assert.rejects(()=>decryptShareCode({SHARE_LINK_KEY:'ef'.repeat(32)},id,c));
 assert.equal(linkKeyStatus({}),'not_configured');assert.equal(linkKeyStatus({SHARE_LINK_KEY:'bad'}),'invalid');
 assert.equal(await encryptShareCode({},id,code),null);
});

test('RC8: new encrypted links can be re-obtained, not leaked via listing; owner-only',async t=>{
 const env=makeTestEnv();env.SHARE_LINK_KEY='bc'.repeat(32);t.after(()=>env.DB.close());
 const adm=await initialize(env),id=await upload(env,adm);
 const made=await newShare(env,adm,id);assert.equal(made.status,201,JSON.stringify(made.data));
 const shareId=made.data.data.share.id,url=made.data.data.url;
 assert.equal(made.data.data.link_recovery,'recoverable');
 const list=await api(env,`/api/v1/shares?target_type=file&target_id=${id}`,{cookie:adm.cookie});
 assert.equal(list.status,200);assert.equal(list.data.data.shares[0].status,'active');
 assert.equal(list.data.data.shares[0].link_recoverable,true);
 assert.ok(!JSON.stringify(list.data).includes(url.split('/').at(-1)),'list leaks no bearer tokens');
 const recovered=await api(env,`/api/v1/shares/${shareId}/link`,{cookie:adm.cookie});
 assert.equal(recovered.status,200,JSON.stringify(recovered.data));assert.equal(recovered.data.data.url,url);
 assert.equal((await api(env,`/api/v1/shares/${shareId}/link`)).status,401);
 const other=await api(env,'/api/v1/users',{method:'POST',cookie:adm.cookie,body:{username:'other8',password:'pass1234'}});assert.equal(other.status,201);
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'other8',password:'pass1234'}});
 assert.equal(login.status,200);const otherCookie=login.response.headers.get('set-cookie').split(';')[0];
 assert.equal((await api(env,`/api/v1/shares/${shareId}/link`,{cookie:otherCookie})).status,404);
 const tempForever=await api(env,'/api/v1/shares',{method:'POST',cookie:adm.cookie,body:{type:'temporary',target_type:'file',target_id:id,expires_at:null}});
 assert.equal(tempForever.status,400);
 const expiredForever=await api(env,`/api/v1/shares/${shareId}`,{method:'PATCH',cookie:adm.cookie,body:{type:'temporary',expires_at:null}});
 assert.equal(expiredForever.status,400);
 const temp=await api(env,'/api/v1/shares',{method:'POST',cookie:adm.cookie,body:{type:'temporary',target_type:'file',target_id:id,expires_at:new Date(Date.now()+3600000).toISOString()}});
 assert.equal(temp.status,201);
 const badForever=await api(env,`/api/v1/shares/${temp.data.data.share.id}`,{method:'PATCH',cookie:adm.cookie,body:{expires_at:null}});
 assert.equal(badForever.status,400);
});

test('RC8: legacy links are irreversible; rotation revokes old URL and supports recovery with key',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),id=await upload(env,adm);
 const made=await newShare(env,adm,id),shareId=made.data.data.share.id,old=made.data.data.url;
 assert.equal(made.status,201);assert.equal(made.data.data.link_recovery,'rotation_only');
 const retrieval=await api(env,`/api/v1/shares/${shareId}/link`,{cookie:adm.cookie});
 assert.equal(retrieval.status,409);assert.equal(retrieval.data.error.code,'LINK_ROTATION_REQUIRED');
 env.SHARE_LINK_KEY='23'.repeat(32);
 const rotated=await api(env,`/api/v1/shares/${shareId}/rotate`,{method:'POST',cookie:adm.cookie});
 assert.equal(rotated.status,200,JSON.stringify(rotated.data));assert.notEqual(rotated.data.data.url,old);
 const oldCode=old.split('/').at(-1);assert.equal((await api(env,`/api/v1/public/shares/${oldCode}`)).status,404);
 const good=await api(env,`/api/v1/shares/${shareId}/link`,{cookie:adm.cookie});assert.equal(good.status,200);assert.equal(good.data.data.url,rotated.data.data.url);
 env.SHARE_LINK_KEY='24'.repeat(32);
 const failed=await api(env,`/api/v1/shares/${shareId}/link`,{cookie:adm.cookie});assert.equal(failed.status,503);assert.equal(failed.data.error.code,'LINK_DECRYPT_FAILED');
});

test('RC8: edit expiry, download permission, limits, password; old password sessions revoked',async t=>{
 const env=makeTestEnv();env.SHARE_LINK_KEY='77'.repeat(32);t.after(()=>env.DB.close());const adm=await initialize(env),id=await upload(env,adm);
 const made=await newShare(env,adm,id,{password:'original-password-123'});assert.equal(made.status,201);
 const sid=made.data.data.share.id,code=made.data.data.url.split('/').at(-1),base=`/api/v1/public/shares/${code}`;
 const auth=await api(env,`${base}/verify`,{method:'POST',body:{password:'original-password-123'}});
 assert.equal(auth.status,200);const cookie=auth.response.headers.get('set-cookie').split(';')[0];
 assert.equal((await api(env,`${base}/contents`,{cookie})).status,200);
 const newExpiry=new Date(Date.now()+3*86400000).toISOString();
 const change=await api(env,`/api/v1/shares/${sid}`,{method:'PATCH',cookie:adm.cookie,body:{expires_at:newExpiry,allow_download:false,max_downloads:2,password_action:'replace',password:'replacement-password-123'}});
 assert.equal(change.status,200,JSON.stringify(change.data));assert.equal(change.data.data.share.allow_download,false);
 assert.equal(change.data.data.password_sessions_revoked,true);
 assert.equal((await api(env,`${base}/contents`,{cookie})).status,401);
 const newAuth=await api(env,`${base}/verify`,{method:'POST',body:{password:'replacement-password-123'}});assert.equal(newAuth.status,200);
 const newCookie=newAuth.response.headers.get('set-cookie').split(';')[0];
 const dl=await api(env,`${base}/files/${id}/content`,{cookie:newCookie});assert.equal(dl.status,403);
 const allow=await api(env,`/api/v1/shares/${sid}`,{method:'PATCH',cookie:adm.cookie,body:{allow_download:true}});assert.equal(allow.status,200);
 const download=await api(env,`${base}/files/${id}/content`,{cookie:newCookie});assert.equal(download.status,200);
 assert.equal((await api(env,`/api/v1/public/shares/${code}/files/${id}/content`,{cookie:newCookie})).status,200);
 const exhausted=await api(env,`/api/v1/shares/${sid}`,{cookie:adm.cookie});assert.equal(exhausted.data.data.share.status,'download_limit');
 const cleared=await api(env,`/api/v1/shares/${sid}`,{method:'PATCH',cookie:adm.cookie,body:{password_action:'clear',max_downloads:null}});assert.equal(cleared.status,200);
 assert.equal((await api(env,base)).status,200);
 const bad=await api(env,`/api/v1/shares/${sid}`,{method:'PATCH',cookie:adm.cookie,body:{target_id:crypto.randomUUID()}});assert.equal(bad.status,400);
});

test('RC8: status classifies expiry, deleted target and revoked correctly',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),file=await upload(env,adm);
 const share=await newShare(env,adm,file),sid=share.data.data.share.id;
 env.DB.native.prepare("UPDATE shares SET expires_at='2020-01-01 00:00:00' WHERE id=?").run(sid);
 let s=await api(env,`/api/v1/shares/${sid}`,{cookie:adm.cookie});assert.equal(s.data.data.share.status,'expired');
 await api(env,`/api/v1/shares/${sid}`,{method:'PATCH',cookie:adm.cookie,body:{expires_at:new Date(Date.now()+86400000).toISOString()}});
 env.DB.native.prepare("UPDATE files SET deleted_at=CURRENT_TIMESTAMP, status='trashed' WHERE id=?").run(file);
 s=await api(env,`/api/v1/shares/${sid}`,{cookie:adm.cookie});assert.equal(s.data.data.share.status,'target_unavailable');
 const stop=await api(env,`/api/v1/shares/${sid}`,{method:'DELETE',cookie:adm.cookie});assert.equal(stop.status,200);
 s=await api(env,`/api/v1/shares/${sid}`,{cookie:adm.cookie});assert.equal(s.data.data.share.status,'revoked');
 assert.equal(shareStatusLabel('revoked'),'已撤销');
});

test('RC8: publication list exposes CDN URLs without private data; revocation warns about cache',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),id=await upload(env,adm);
 const pub=await api(env,'/api/v1/publications',{method:'POST',cookie:adm.cookie,body:{file_id:id}});assert.equal(pub.status,201,JSON.stringify(pub.data));
 const listed=await api(env,`/api/v1/publications?file_id=${id}`,{cookie:adm.cookie});assert.equal(listed.status,200);
 assert.equal(listed.data.data.cdn_configured,true);
 assert.equal(listed.data.data.publications[0].url,pub.data.data.url);
 assert.equal(listed.data.data.publications[0].delivery,'cdn');
 const revoked=await api(env,`/api/v1/publications/${pub.data.data.id}`,{method:'DELETE',cookie:adm.cookie});
 assert.equal(revoked.status,200);assert.equal(revoked.data.data.cache.reason,'CDN_PURGE_NOT_CONFIGURED');
 const after=await api(env,'/api/v1/publications',{cookie:adm.cookie});assert.equal(after.data.data.publications[0].status,'revoked');
 assert.equal(after.data.data.publications[0].url,null);
 assert.equal(cdnBaseUrl('https://cdn.example.test'),'https://cdn.example.test');
 assert.equal(cdnBaseUrl('http://cdn.example.test'),null);assert.equal(cdnBaseUrl('https://cdn.example.test/a'),null);
 assert.equal(publicationUrl(new Request('https://disk.example.test'),{PUBLIC_BASE_URL:''},{id:pub.data.data.id,public_path:'published/x'}),`https://disk.example.test/p/${pub.data.data.id}`);
});
