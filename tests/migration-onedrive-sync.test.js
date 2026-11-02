import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const sql=readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
test('baseline schedules both existing and newly published OneDrive files for health check',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(sql);
  const a='odf_'+'a'.repeat(32),b='odf_'+'b'.repeat(32);
  db.prepare('INSERT INTO onedrive_drive_publications(id,drive_id,item_id,file_name) VALUES(?,?,?,?)').run(a,'drive!id','itemA','a.pdf');
  db.prepare('INSERT INTO onedrive_drive_publications(id,drive_id,item_id,file_name) VALUES(?,?,?,?)').run(b,'drive!id','itemB','b.pdf');
  const rows=db.prepare('SELECT id,sync_status,next_check_at FROM onedrive_drive_publications').all();
  assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.sync_status==='unknown' && r.next_check_at==='1970-01-01 00:00:00'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM onedrive_drive_publications WHERE next_check_at<=CURRENT_TIMESTAMP').get().n,2);
 }finally{db.close();}
});
