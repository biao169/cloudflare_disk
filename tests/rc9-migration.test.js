import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','migrations');
test('RC9 additive upgrade from populated RC8 preserves users spaces files and shares',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON');
  const scripts=readdirSync(root).filter(n=>/^\d+.*\.sql$/.test(n)).sort();
  const target='0015_rc9_operations.sql';assert.equal(scripts.at(-1),target);
  for(const f of scripts.slice(0,-1))db.exec(readFileSync(join(root,f),'utf8'));
  const uuid=()=>crypto.randomUUID();const user=uuid(),space=uuid(),object=uuid(),file=uuid(),key=`private/${space}/${object}`;
  db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'production-account','legacy-hash','super_admin')").run(user);
  db.prepare("INSERT INTO spaces(id,name,type,owner_id,used_bytes) VALUES(?,'Production Space','personal',?,10)").run(space,user);
  db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'private',?,10,'ready')").run(object,key);
  db.prepare("INSERT INTO files(id,space_id,folder_id,name,object_id,size_bytes,status,created_by) VALUES(?, ?,NULL,'important.txt',?,10,'ready',?)").run(file,space,object,user);
  const share=uuid();
  db.prepare("INSERT INTO shares(id,type,target_type,target_id,share_code_hash,created_by) VALUES(?,'temporary','file',?,?,?)").run(share,file,'sha256-only-code',user);
  db.exec(readFileSync(join(root,target),'utf8'));
  assert.equal(db.prepare('SELECT username FROM users WHERE id=?').get(user).username,'production-account');
  assert.equal(db.prepare('SELECT used_bytes FROM spaces WHERE id=?').get(space).used_bytes,10);
  assert.equal(db.prepare('SELECT name FROM files WHERE id=?').get(file).name,'important.txt');
  assert.equal(db.prepare('SELECT share_code_hash FROM shares WHERE id=?').get(share).share_code_hash,'sha256-only-code');
  for(const name of ['maintenance_lock','maintenance_runs','operational_events','backup_records'])assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM maintenance_lock').get().c,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close()}
});
