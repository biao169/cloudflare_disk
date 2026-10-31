import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSharePolicy,makePasswordRecord,verifyPassword,isExpired,policyPublic} from '../worker/services/onedrive-share-policy.js';

test('RC14.11 validates finite caps, UTC expiry, and safe share options',()=>{
 const good=validateSharePolicy({is_paused:true,access_mode:'member',max_downloads:5,max_views:null,show_direct_link:false});
 assert.deepEqual(good,{is_paused:1,access_mode:'member',max_downloads:5,max_views:null,show_direct_link:0});
 assert.throws(()=>validateSharePolicy({max_downloads:0}),/INVALID_POLICY/);
 assert.throws(()=>validateSharePolicy({max_downloads:1.5}),/INVALID_POLICY/);
 assert.throws(()=>validateSharePolicy({max_views:1e9}),/INVALID_POLICY/);
 assert.throws(()=>validateSharePolicy({password:'12345'}),/INVALID_PASSWORD/);
 assert.throws(()=>validateSharePolicy({password:'abc123',clear_password:true}),/INVALID_POLICY/);
 assert.throws(()=>validateSharePolicy({access_mode:'admin'}),/INVALID_POLICY/);
 assert.throws(()=>validateSharePolicy({id:'odf_bad',status:'active'}),/INVALID_POLICY/);
 assert.throws(()=>validateSharePolicy({expires_at:'2024-06-06T12:00:00Z'}),/INVALID_EXPIRY/);
 assert.throws(()=>validateSharePolicy({expires_at:'2049-01-01T12:00:00Z'}),/INVALID_EXPIRY/);
 assert.deepEqual(validateSharePolicy({expires_at:null}),{expires_at:null});
});

test('RC14.11 salted PBKDF2 share password hash verifies without storing plaintext',async()=>{
 const a=await makePasswordRecord('共有密碼Abc123');const b=await makePasswordRecord('共有密碼Abc123');
 assert.match(a.password_salt,/^[0-9a-f]{32}$/);assert.match(a.password_hash,/^[0-9a-f]{64}$/);
 assert.notEqual(a.password_salt,b.password_salt);assert.notEqual(a.password_hash,b.password_hash);
 assert.equal(await verifyPassword('共有密碼Abc123',a),true);
 assert.equal(await verifyPassword('other',a),false);
 assert.equal(await verifyPassword('共有密碼Abc123',{...a,password_iterations:10}),false);
});

test('RC14.11 expired and public policy metadata never returns password material',()=>{
 const row={id:'odf_'+'e'.repeat(32),status:'active',is_paused:0,expires_at:'2020-01-01T00:00:00Z',password_salt:'secret',password_hash:'private',policy_epoch:8,max_downloads:2,download_count:1,show_direct_link:0};
 assert.equal(isExpired(row),true);
 assert.equal(policyPublic(row).status,'expired');
 assert.equal(policyPublic({...row,is_paused:1}).status,'paused');
 assert.equal(policyPublic({...row,is_paused:0,expires_at:null}).status,'active');
 assert.equal(policyPublic(row).password_protected,true);
 assert.ok(!JSON.stringify(policyPublic(row)).includes('private'));
});
