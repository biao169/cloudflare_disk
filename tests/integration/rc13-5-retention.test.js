import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv} from './support.js';
import {finishStorageCleanup} from '../../worker/services/cleanup.js';
import {prunePrivateVersions} from '../../worker/services/version-retention.js';
import {reconcileLedger} from '../../worker/services/reconcile.js';
const id=()=>crypto.randomUUID();
function setup(env){
 const u=id(),s=id(),f=id(),current=id(),old=id(),older=id();
 const sql=(q,...v)=>env.DB.native.prepare(q).run(...v);
 sql("INSERT INTO users(id,username,password_hash) VALUES(?,'admin','hash')",u);
 sql("INSERT INTO spaces(id,name,type,owner_id,used_bytes) VALUES(?,'personal','personal',?,60)",s,u);
 for(const [oid,key] of [[current,'private/current'],[old,'private/old'],[older,'private/older']]){
  sql("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'private',?,20,'ready')",oid,key);
  env.PRIVATE_BUCKET.objects.set(key,{bytes:new TextEncoder().encode('x'.repeat(20)),size:20});
 }
 sql("INSERT INTO files(id,space_id,name,object_id,size_bytes,status,created_by,revision) VALUES(?,?, 'file.txt',?,20,'ready',?,3)",f,s,current,u);
 for(const [oid,rev] of [[old,2],[older,1]])sql("INSERT INTO file_versions(id,file_id,revision,object_id,size_bytes,mime_type,created_at) VALUES(?,?,?,?,20,'text/plain',datetime('now','-15 days'))",id(),f,rev,oid);
 return {s,f,current,old,older};
}
test('RC13.5 cleanup refuses objects still held by historical file revisions',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {s,old}=setup(env);
 const job=id();env.DB.native.prepare("INSERT INTO storage_cleanup_jobs(id,object_id,object_key,bucket_type,space_id,size_bytes) VALUES(?,?,'private/old','private',?,20)").run(job,old,s);
 await assert.rejects(finishStorageCleanup(env,{id:job,object_id:old,object_key:'private/old',bucket_type:'private',space_id:s,size_bytes:20}),/history/);
 assert.ok(env.PRIVATE_BUCKET.objects.has('private/old'));
});
test('RC13.5 history GC only removes oldest eligible revision and conserves current/latest',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const {current,old,older}=setup(env);
 const r=await prunePrivateVersions(env,{limit:1,keep:1,graceDays:7});
 assert.equal(r.queued,1);assert.equal(r.deleted,1);
 assert.ok(env.PRIVATE_BUCKET.objects.has('private/current'));
 assert.ok(env.PRIVATE_BUCKET.objects.has('private/old'));
 assert.ok(!env.PRIVATE_BUCKET.objects.has('private/older'));
 assert.equal(env.DB.query('SELECT COUNT(*) n FROM file_versions WHERE object_id=?',old).n,1);
 assert.equal(env.DB.query('SELECT COUNT(*) n FROM file_versions WHERE object_id=?',older).n,0);
 const report=await reconcileLedger(env.DB);
 assert.equal(report.issues.unreferenced_ready_objects,0);
});
