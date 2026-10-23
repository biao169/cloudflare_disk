import test from 'node:test';import assert from 'node:assert/strict';import {route} from '../worker/router.js';
test('health confirms stage 12 binding without pretending migrations completed',async()=>{
 const r=await route(new Request('http://localhost/api/v1/health'),{APP_NAME:'CloudDrive',APP_STAGE:'stage-12',DB:{prepare(){}}});
 assert.equal(r.status,200);const v=await r.json();assert.equal(v.data.stage,'stage-12');assert.equal(v.data.database,'binding-present');
});
test('unimplemented APIs remain 501',async()=>{
 const r=await route(new Request('http://localhost/api/v1/files'),{});assert.equal(r.status,501);
});
test('non-API requests delegate to assets',async()=>assert.equal(await route(new Request('http://localhost/files'),{}),null));
test('fixture endpoint disabled by default',async()=>{
 const r=await route(new Request('http://localhost/api/v1/dev/fixtures'),{});assert.equal(r.status,404);
});
test('missing D1 binding fails safely',async()=>{
 const r=await route(new Request('http://localhost/api/v1/system/database'),{APP_ENV:'local'});assert.equal(r.status,503);
});
