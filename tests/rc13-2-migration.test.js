import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { immutableVersionKey } from '../worker/services/public-versions.js';
const sql=readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
test('baseline retains legacy publication pointers and versioned public objects',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(sql);
  const uid=crypto.randomUUID(),sid=crypto.randomUUID(),fid=crypto.randomUUID(),obj=crypto.randomUUID(),pub=crypto.randomUUID(),pid=crypto.randomUUID();
  db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,'admin','hash')").run(uid);
  db.prepare("INSERT INTO spaces(id,name,type,owner_id) VALUES(?,'personal','personal',?)").run(sid,uid);
  db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'private',?,3,'ready')").run(obj,'private/'+obj);
  db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'public',?,3,'ready')").run(pub,`published/${pub}`);
  db.prepare("INSERT INTO files(id,space_id,name,object_id,size_bytes,status,created_by) VALUES(?,?,?, ?,3,'ready',?)").run(fid,sid,'old.txt',obj,uid);
  db.prepare("INSERT INTO publications(id,source_file_id,public_object_id,public_path,status,created_by,legacy_object_id,published_revision) VALUES(?,?,?,?, 'ready',?,?,0)").run(pid,fid,pub,`published/${pub}`,uid,pub);
  db.prepare('INSERT INTO publication_versions(id,publication_id,file_revision,object_id) VALUES(?,?,0,?)').run(crypto.randomUUID(),pid,pub);
  assert.equal(db.prepare('SELECT public_path FROM publications WHERE id=?').get(pid).public_path,`published/${pub}`);
  assert.equal(db.prepare('SELECT object_id FROM publication_versions WHERE publication_id=?').get(pid).object_id,pub);
 }finally{db.close();}
});
test('public version key rejects traversal and invalid revision',()=>{
 const id=crypto.randomUUID(),v=immutableVersionKey(id,2,crypto.randomUUID());assert.match(v,/^versions\/[\da-f-]{36}\/v2\/[\da-f-]{36}$/);
 assert.throws(()=>immutableVersionKey('../secret',2,crypto.randomUUID()));
 assert.throws(()=>immutableVersionKey(id,0,crypto.randomUUID()));
});
