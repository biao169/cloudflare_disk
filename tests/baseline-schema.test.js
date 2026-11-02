import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { inspectBaselineRows } from '../scripts/deploy-cloudflare.mjs';
import { inspectMigrations } from '../scripts/check-migrations.mjs';

const baseline = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../scripts/schema-baseline.json', import.meta.url), 'utf8'));
const migrationDir = new URL('../migrations/', import.meta.url);
function open() {const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');return db;}
function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name).sort();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().map(x=>x.name).sort();
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(x=>x.name).sort();
  const columns = db.prepare("SELECT m.name table_name, p.name column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' ORDER BY m.name,p.cid").all();
  const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL").all();
  return {tables,indexes,triggers,columns,objects};
}

test('only one non-destructive SQL migration is shipped',()=>{
  assert.deepEqual(readdirSync(migrationDir).filter(x=>x.endsWith('.sql')),['0001_initial.sql']);
  assert.deepEqual(inspectMigrations(),[]);
  assert.doesNotMatch(baseline,/^\s*(DROP|ALTER|DELETE|TRUNCATE)\b/im);
  assert.doesNotMatch(baseline,/^\s*PRAGMA\s+foreign_keys\s*=/im);
});

test('baseline constructs every final table, index and trigger from scratch',()=>{
  const db=open();try{
    db.exec(baseline);
    const s=snapshot(db);
    assert.deepEqual(s.tables,Object.keys(manifest.tables).sort());
    assert.deepEqual(s.indexes,manifest.indexes);
    assert.deepEqual(s.triggers,manifest.triggers);
    for(const [name, cols] of Object.entries(manifest.tables)) {
      const actual=db.prepare(`PRAGMA table_info("${name}")`).all().map(r=>r.name);
      assert.deepEqual(actual,cols,`Missing columns in ${name}`);
    }
    assert.deepEqual(inspectBaselineRows(s.columns,s.objects),{empty:false,missingTables:[],missingColumns:[],missingObjects:[]});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_settings').get().n,4);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM maintenance_lock').get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});

test('consolidated baseline is idempotent and does not alter existing user/file/share data',()=>{
  const db=open();try{
    db.exec(baseline);
    const user=crypto.randomUUID(),space=crypto.randomUUID(),obj=crypto.randomUUID(),file=crypto.randomUUID(),share=crypto.randomUUID();
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'owner','hash','super_admin')").run(user);
    db.prepare("INSERT INTO spaces(id,name,type,owner_id) VALUES(?,'Personal','personal',?)").run(space,user);
    db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,status) VALUES(?,'private',?,12,'ready')").run(obj,'private/'+obj);
    db.prepare("INSERT INTO files(id,space_id,name,object_id,size_bytes,status,created_by) VALUES(?,?,'data.pdf',?,12,'ready',?)").run(file,space,obj,user);
    db.prepare("INSERT INTO shares(id,type,target_type,target_id,share_code_hash,created_by) VALUES(?,'page','file',?,'hash-only',?)").run(share,file,user);
    db.prepare("UPDATE app_settings SET value_json='123' WHERE key='storage_soft_limit_bytes'").run();
    db.exec(baseline); // A fully migrated legacy DB has same final tables/columns; does not reset rows.
    assert.equal(db.prepare('SELECT name FROM files WHERE id=?').get(file).name,'data.pdf');
    assert.equal(db.prepare('SELECT share_code_hash FROM shares WHERE id=?').get(share).share_code_hash,'hash-only');
    assert.equal(db.prepare('SELECT value_json FROM app_settings WHERE key=?').get('storage_soft_limit_bytes').value_json,'123');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});

test('partial historical schema is rejected, including missing columns and indexes',()=>{
  const db=open();try{
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT)');
    const s=snapshot(db),r=inspectBaselineRows(s.columns,s.objects);
    assert.equal(r.empty,false);
    assert.ok(r.missingTables.includes('onedrive_drive_publications'));
    assert.ok(r.missingColumns.includes('users.password_hash'));
    assert.ok(r.missingObjects.includes('index:idx_trash_purge'));
    assert.equal(inspectBaselineRows([],[]).empty,true);
  }finally{db.close();}
});
