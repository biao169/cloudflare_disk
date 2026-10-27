import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeTestEnv,initialize,api} from './support.js';

const origin='http://localhost:8787';
test('one-click deployment config declares both R2 buckets and D1 migration by binding',()=>{
 const cfg=JSON.parse(readFileSync(new URL('../../wrangler.jsonc',import.meta.url),'utf8'));
 const pkg=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8'));
 assert.equal(cfg.d1_databases[0].binding,'DB');
 assert.deepEqual(cfg.r2_buckets.map(x=>x.binding),['PRIVATE_BUCKET','PUBLIC_BUCKET']);
 assert.ok(cfg.assets.run_worker_first.includes('/p/*'));
 assert.match(pkg.scripts.deploy,/deploy-cloudflare\.mjs/);
 assert.equal(Object.hasOwn(cfg.d1_databases[0],'database_id'),false,'Do not commit a fake D1 database_id when auto-provisioning');
 assert.match(pkg.scripts['deploy:upgrade'],/--upgrade/);
 assert.match(pkg.scripts['db:migrate:remote'],/--migrate-only/);
});

test('published files work without a CDN domain on the Worker host; revocation invalidates them',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 delete env.PUBLIC_BASE_URL;
 const user=await initialize(env,'webadmin','a-very-safe-long-password-123');
 const doc=new TextEncoder().encode('%PDF-1.7\ntest');
 const upload=await api(env,`/api/v1/storage/upload?space_id=${user.spaceId}&name=public.pdf`,{method:'POST',cookie:user.cookie,body:doc,headers:{'Content-Type':'application/pdf'}});
 assert.equal(upload.status,201,JSON.stringify(upload.data));
 const pub=await api(env,'/api/v1/publications',{method:'POST',cookie:user.cookie,body:{file_id:upload.data.data.id}});
 assert.equal(pub.status,201,JSON.stringify(pub.data));
 const u=new URL(pub.data.data.url);assert.equal(u.origin,origin);assert.match(u.pathname,/^\/r\/[0-9a-f-]{36}$/);
 const fetched=await api(env,u.pathname);assert.equal(fetched.status,200);assert.equal(fetched.response.headers.get('cache-control'),'no-store');
 assert.equal(await fetched.response.text(),new TextDecoder().decode(doc));
 const partial=await api(env,u.pathname,{headers:{Range:'bytes=0-3'}});assert.equal(partial.status,206);assert.equal(partial.response.headers.get('content-range'),`bytes 0-3/${doc.length}`);assert.equal(await partial.response.text(),'%PDF');
 const head=await api(env,u.pathname,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.response.text(),'');
 const rev=await api(env,`/api/v1/publications/${pub.data.data.id}`,{method:'DELETE',cookie:user.cookie});assert.equal(rev.status,200);
 assert.equal((await api(env,u.pathname)).status,404);
});

test('example initialization token is not accepted as a production secret',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 env.BOOTSTRAP_TOKEN='REPLACE_WITH_A_UNIQUE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS';
 const response=await api(env,'/api/v1/auth/setup',{method:'POST',body:{username:'admin123',password:'sufficiently-long-password-xyz',bootstrap_token:env.BOOTSTRAP_TOKEN}});
 assert.equal(response.status,403);
});


test('six-character passwords work for admin setup, member creation, login, and password change',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());
 const short='abc123';
 const setup=await api(env,'/api/v1/auth/setup',{method:'POST',body:{username:'shortadmin',password:short,bootstrap_token:env.BOOTSTRAP_TOKEN}});
 assert.equal(setup.status,201,JSON.stringify(setup.data));
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'shortadmin',password:short}});
 assert.equal(login.status,200,JSON.stringify(login.data));
 const cookie=login.response.headers.get('set-cookie').split(';')[0];
 const bad=await api(env,'/api/v1/users',{method:'POST',cookie,body:{username:'shortbad',password:'12345'}});
 assert.equal(bad.status,400);
 const long=await api(env,'/api/v1/users',{method:'POST',cookie,body:{username:'longbad',password:'a'.repeat(129)}});
 assert.equal(long.status,400);
 const user=await api(env,'/api/v1/users',{method:'POST',cookie,body:{username:'shortuser',password:'Six123'}});
 assert.equal(user.status,201,JSON.stringify(user.data));
 const second=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'shortuser',password:'Six123'}});
 assert.equal(second.status,200,JSON.stringify(second.data));
 const change=await api(env,'/api/v1/auth/password',{method:'POST',cookie,body:{current_password:short,new_password:'new123'}});
 assert.equal(change.status,200,JSON.stringify(change.data));
 assert.equal((await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'shortadmin',password:'new123'}})).status,200);
});
