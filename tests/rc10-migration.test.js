import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','migrations');
test('RC10 additive origin migration preserves existing users, files and hash-only shares',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON');
  const scripts=readdirSync(root).filter(n=>/^\d+.*\.sql$/.test(n)).sort();
  const target='0016_rc10_existing_links.sql';
  assert.ok(scripts.includes(target),'RC10 migration must remain available after RC11');
  for(const script of scripts.filter(s=>s<target))db.exec(readFileSync(join(root,script),'utf8'));
  const user=crypto.randomUUID(),space=crypto.randomUUID(),object=crypto.randomUUID(),file=crypto.randomUUID(),share=crypto.randomUUID();
  db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'existing-owner','hashed','super_admin')").run(user);
  db.prepare("INSERT INTO spaces(id,name,type,owner_id) VALUES(?,'Existing space','personal',?)").run(space,user);
  db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'private','private/example',20,'ready')").run(object);
  db.prepare("INSERT INTO files(id,space_id,name,object_id,size_bytes,created_by) VALUES(? ,?,'important.pdf',?,20,?)").run(file,space,object,user);
  db.prepare("INSERT INTO shares(id,type,target_type,target_id,share_code_hash,created_by) VALUES(?,'page','file',?,'old-hash-only',?)").run(share,file,user);
  for(const script of scripts.filter(s=>s>=target))db.exec(readFileSync(join(root,script),'utf8'));
  assert.equal(db.prepare('SELECT username FROM users WHERE id=?').get(user).username,'existing-owner');
  assert.equal(db.prepare('SELECT name FROM files WHERE id=?').get(file).name,'important.pdf');
  const old=db.prepare('SELECT share_code_hash,link_origin FROM shares WHERE id=?').get(share);
  assert.equal(old.share_code_hash,'old-hash-only');assert.equal(old.link_origin,null);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close()}
});
