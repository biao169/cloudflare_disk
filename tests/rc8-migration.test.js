import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=join(dirname(fileURLToPath(import.meta.url)),'..','migrations');
test('RC8 migration preserves legacy share hashes and publication records',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');
  for(const f of readdirSync(root).filter(x=>x.endsWith('.sql')&&x<'0014_rc8_share_management.sql').sort())db.exec(readFileSync(join(root,f),'utf8'));
  const user='00000000-0000-4000-8000-000000000001';
  db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'rc8existing','hash','super_admin')").run(user);
  const id='00000000-0000-4000-8000-000000000002';
  db.prepare("INSERT INTO shares(id,type,target_type,target_id,share_code_hash,created_by) VALUES(?,'page','file','legacy-file','hashold',?)").run(id,user);
  db.exec(readFileSync(join(root,'0014_rc8_share_management.sql'),'utf8'));
  const share=db.prepare('SELECT id,share_code_hash,link_ciphertext FROM shares WHERE id=?').get(id);
  assert.equal(share.share_code_hash,'hashold');assert.equal(share.link_ciphertext,null);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_shares_owner_target_status'").get());
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
