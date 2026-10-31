import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';

const status='/api/v1/tools/onedrive/status';
const sample='https://1drv.ms/t/c/45ed996b079ab860/IQAeA-nNpMauRrmN5IV1xpzKAXimIbqgCf7nDAH0HGlZzVk?e=Cbjrip';

test('guest OneDrive parsing follows independent anonymous toggle while authenticated user still works',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {cookie}=await initialize(env);
 const guest=await api(env,status);assert.equal(guest.status,200);
 assert.equal(guest.data.data.authenticated,false);assert.equal(guest.data.data.anonymous_enabled,true);assert.equal(guest.data.data.capability,'format_only');
 const noProbe=await api(env,'/api/v1/tools/onedrive/public-check',{method:'POST',body:{url:sample}});
 assert.equal(noProbe.status,401,'guest cannot invoke a hidden public-download probe directly');
 const parsed=await api(env,'/api/v1/tools/onedrive/resolve',{method:'POST',body:{url:sample}});
 assert.equal(parsed.status,200);assert.match(parsed.data.data.share_token,/^u!/);
 // OneDrive API settings can now be saved from the dedicated tab; no new backend routes required.
 const changed=await api(env,'/api/v1/admin/settings',{method:'PATCH',cookie,body:{onedrive_anonymous_enabled:false}});
 assert.equal(changed.status,200,JSON.stringify(changed.data));
 assert.equal((await api(env,status)).status,401);
 assert.equal((await api(env,'/api/v1/tools/onedrive/resolve',{method:'POST',body:{url:sample}})).status,401);
 const signed=await api(env,status,{cookie});assert.equal(signed.status,200);
 assert.equal(signed.data.data.authenticated,true);
 const off=await api(env,'/api/v1/admin/settings',{method:'PATCH',cookie,body:{onedrive_tool_enabled:false}});
 assert.equal(off.status,200);
 assert.equal((await api(env,status,{cookie})).status,403);
});

test('unauthenticated user cannot change any OneDrive settings or start an admin OAuth session',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 assert.equal((await api(env,'/api/v1/admin/settings',{method:'PATCH',body:{onedrive_anonymous_enabled:true}})).status,401);
 assert.equal((await api(env,'/api/v1/admin/onedrive/oauth/start')).status,401);
});
