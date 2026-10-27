import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {immutableVersionKey} from '../worker/services/public-versions.js';
const root=fileURLToPath(new URL('../migrations/',import.meta.url));

test('RC13.2 upgrade of RC13.1 D1 preserves publication ID and old direct-CDN key',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  for(const name of readdirSync(root).filter(x=>/^\d+_.*\.sql$/.test(x)&&Number(x.slice(0,4))<20).sort())db.exec(readFileSync(join(root,name),'utf8'));
  const uid=crypto.randomUUID(),sid=crypto.randomUUID(),fid=crypto.randomUUID(),privateId=crypto.randomUUID(),pubId=crypto.randomUUID(),pubObj=crypto.randomUUID();
  db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,'admin','hash')").run(uid);
  db.prepare("INSERT INTO spaces(id,name,type,owner_id) VALUES(?,'personal','personal',?)").run(sid,uid);
  db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'private','private/original',3,'ready')").run(privateId);
  db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'public',?,3,'ready')").run(pubObj,`published/${pubObj}`);
  db.prepare("INSERT INTO files(id,space_id,name,object_id,size_bytes,status,created_by) VALUES(?,?,?, ?,3,'ready',?)").run(fid,sid,'old.txt',privateId,uid);
  db.prepare("INSERT INTO publications(id,source_file_id,public_object_id,public_path,status,created_by) VALUES(?,?,?,?, 'ready',?)").run(pubId,fid,pubObj,`published/${pubObj}`,uid);
  db.exec(readFileSync(join(root,'0020_rc13_2_public_versions.sql'),'utf8'));
  const p=db.prepare('SELECT id,legacy_object_id,public_object_id,public_path,published_revision FROM publications WHERE id=?').get(pubId);
  assert.equal(p.id,pubId);assert.equal(p.legacy_object_id,pubObj);assert.equal(p.public_object_id,pubObj);
  assert.equal(p.published_revision,0);assert.equal(p.public_path,`published/${pubObj}`);
  const v=db.prepare('SELECT file_revision,object_id FROM publication_versions WHERE publication_id=?').get(pubId);
  assert.equal(v.file_revision,0);assert.equal(v.object_id,pubObj);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM files').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shares').get().n,0);
 }finally{db.close();}
});

test('RC13.2 public version key is immutable and rejects untrusted path components',()=>{
 const id=crypto.randomUUID(),v=immutableVersionKey(id,2,crypto.randomUUID());assert.match(v,/^versions\/[\da-f-]{36}\/v2\/[\da-f-]{36}$/);
 assert.throws(()=>immutableVersionKey('../secret',2,crypto.randomUUID()));
 assert.throws(()=>immutableVersionKey(id,0,crypto.randomUUID()));
});
