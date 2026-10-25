import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','migrations');

test('RC6 migration upgrades populated RC5 schema without replacing users or files',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON');
  const files=readdirSync(root).filter(n=>/^\d+.*\.sql$/.test(n)).sort();
  const rc6='0012_rc6_reliability.sql';assert.ok(files.includes(rc6));
  for(const f of files.filter(n=>n<rc6))db.exec(readFileSync(join(root,f),'utf8'));
  const user='88888888-8888-4888-8888-888888888888';
  const space='99999999-9999-4999-9999-999999999999';
  db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'before-upgrade','existing-hash','super_admin')").run(user);
  db.prepare("INSERT INTO spaces(id,name,type,owner_id) VALUES(?,'Original Space','personal',?)").run(space,user);
  db.exec(readFileSync(join(root,rc6),'utf8'));
  assert.equal(db.prepare('SELECT username FROM users WHERE id=?').get(user).username,'before-upgrade');
  assert.equal(db.prepare('SELECT name FROM spaces WHERE id=?').get(space).name,'Original Space');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trash_entry_items'").get());
  const uploadCols=db.prepare('PRAGMA table_info(upload_sessions)').all().map(x=>x.name);
  assert.ok(uploadCols.includes('recovery_error'));
  assert.ok(uploadCols.includes('recovery_attempts'));
  const jobCols=db.prepare('PRAGMA table_info(storage_cleanup_jobs)').all().map(x=>x.name);
  assert.ok(jobCols.includes('reserved_release_bytes'));
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{db.close()}
});
