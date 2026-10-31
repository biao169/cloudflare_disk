import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const SQL=join(ROOT,'migrations');

test('RC14.12 migrates a populated RC14.11 D1 database and schedules old and newly published files',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  for(const name of readdirSync(SQL).filter(s=>/^\d+.*\.sql$/.test(s)&&!s.startsWith('0031_')).sort()){
   db.exec(readFileSync(join(SQL,name),'utf8'));
  }
  const original='odf_'+'a'.repeat(32),newFile='odf_'+'b'.repeat(32);
  db.prepare('INSERT INTO onedrive_drive_publications(id,drive_id,item_id,file_name) VALUES(?,?,?,?)')
    .run(original,'drive!id','item!original','already-shared.pdf');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM onedrive_drive_publications').get().count,1);
  db.exec(readFileSync(join(SQL,'0031_rc14_12_onedrive_sync.sql'),'utf8'));
  const upgraded=db.prepare('SELECT id,status,sync_status,next_check_at FROM onedrive_drive_publications WHERE id=?').get(original);
  assert.equal(upgraded.id,original);assert.equal(upgraded.status,'active');assert.equal(upgraded.sync_status,'unknown');
  assert.match(upgraded.next_check_at,/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  db.prepare('INSERT INTO onedrive_drive_publications(id,drive_id,item_id,file_name) VALUES(?,?,?,?)')
    .run(newFile,'drive!id','item!new','newly-shared.mp4');
  const added=db.prepare('SELECT id,next_check_at FROM onedrive_drive_publications WHERE id=?').get(newFile);
  assert.equal(added.id,newFile);assert.ok(added.next_check_at,'trigger schedules future publications');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM onedrive_drive_publications WHERE next_check_at <= CURRENT_TIMESTAMP').get().count,2);
 }finally{db.close();}
});
