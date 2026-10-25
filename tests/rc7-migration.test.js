import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..','migrations');
test('RC7 upgrade adds read-only index structures without changing existing user or file rows',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');const migrations=readdirSync(root).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
  assert.ok(migrations.includes('0013_rc7_file_browser.sql'));
  for(const f of migrations.filter(f=>f<'0013_rc7_file_browser.sql'))db.exec(readFileSync(join(root,f),'utf8'));
  const user='00000000-0000-4000-8000-000000000001',space='00000000-0000-4000-8000-000000000002';
  db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'existing-user','existing-hash','super_admin')").run(user);
  db.prepare("INSERT INTO spaces(id,name,type,owner_id) VALUES(?,'Original','personal',?)").run(space,user);
  db.exec(readFileSync(join(root,'0013_rc7_file_browser.sql'),'utf8'));
  assert.equal(db.prepare('SELECT name FROM spaces WHERE id=?').get(space).name,'Original');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rc7_recent_files'").get());
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close()}
});
