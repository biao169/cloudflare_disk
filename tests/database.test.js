import test from 'node:test';import assert from 'node:assert/strict';
import {dbFromEnv,one,many,execute,batch,DatabaseError} from '../worker/services/database.js';
import {route} from '../worker/router.js';
function fakeDb(){
 const calls=[]; const db={calls,prepare(sql){return {bind(...params){calls.push([sql,params]);return {async first(){return {count:5};},async all(){return {results:[{id:'u1',username:'test1'}]};},async run(){return {success:true};}}}}},async batch(x){return x.map(()=>({success:true}));}};return db;
}
test('database helpers bind parameters',async()=>{
 const db=fakeDb();assert.deepEqual(await one(db,'SELECT ?', ['x']),{count:5});
 assert.equal((await many(db,'SELECT ?',['y'])).length,1);await execute(db,'UPDATE x SET n=?',[5]);
 assert.deepEqual(db.calls.map(c=>c[1]),[['x'],['y'],[5]]);assert.equal((await batch(db,[1,2])).length,2);
});
test('database missing binding raises typed error',()=>assert.throws(()=>dbFromEnv({}),DatabaseError));
test('former fixture endpoint remains inaccessible',async()=>{
 const r=await route(new Request('http://localhost/api/v1/dev/fixtures'),{APP_ENV:'local',DB:fakeDb()});assert.equal(r.status,404);
});
test('database status is limited to schema readiness',async()=>{
 const r=await route(new Request('http://localhost/api/v1/system/database'),{APP_ENV:'local',DB:fakeDb()});
 assert.equal(r.status,200);const body=await r.json();assert.equal(body.data.schema_ready,true);assert.equal(body.data.migrations_table,true);
});
