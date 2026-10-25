import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {safeEventCode,safeEventSource,buildQuotaAlerts} from '../worker/services/operations.js';
import {DEFAULT_SETTINGS,validateSettings} from '../worker/services/admin.js';

test('RC9 setting constraints and no unexpected fields',()=>{
 assert.equal(DEFAULT_SETTINGS.quota_warn_percent,85);
 assert.deepEqual(validateSettings({maintenance_paused:true,quota_warn_percent:90}),{maintenance_paused:true,quota_warn_percent:90});
 for(const value of [-1,0,49,100,1.4,'85'])assert.equal(validateSettings({quota_warn_percent:value}),null);
 assert.equal(validateSettings({incident_retention_days:91}),null);
 assert.equal(validateSettings({backup_reminder_days:0}),null);
});
test('RC9 incident labels never store arbitrary error strings',()=>{
 assert.equal(safeEventCode('Database unavailable!token=secret'),'SERVER_ERROR');
 assert.equal(safeEventSource('https://secret/?token=x'),'worker');
 assert.equal(safeEventCode('D1_READ_FAILED'),'D1_READ_FAILED');
});
test('RC9 dashboard reports quota pressure from committed plus reserved bytes',()=>{
 const mock={totals:{used_bytes:7*1024**3,reserved_bytes:1*1024**3},spaces:[{id:'x',name:'workspace',used_bytes:80,reserved_bytes:10,quota_bytes:100}]};
 const ops={unacknowledged_events:0,cleanup_jobs:0,stalled_uploads:{count:0},last_backup_record:null};
 const alerts=buildQuotaAlerts(mock,{...DEFAULT_SETTINGS,quota_warn_percent:85},ops);
 assert.ok(alerts.some(x=>x.code==='GLOBAL_QUOTA'&&x.severity==='critical'));
 assert.ok(alerts.some(x=>x.code==='SPACE_QUOTA'));
 assert.ok(alerts.some(x=>x.code==='BACKUP_NOT_RECORDED'));
});
test('RC9 scheduled maintenance and recovery scripts are bounded and isolated',()=>{
 const src=readFileSync(new URL('../worker/services/operations.js',import.meta.url),'utf8');
 assert.match(src,/cleanupExpired\(env,\{limit:2\}\)/);
 assert.match(src,/cleanupTrash\(env,\{limit:1\}\)/);
 const restore=readFileSync(new URL('../scripts/restore-production.ps1',import.meta.url),'utf8');
 assert.match(restore,/ISOLATED-RESTORE/);
 assert.match(restore,/clouddrive-db/);
 const backup=readFileSync(new URL('../scripts/backup-production.ps1',import.meta.url),'utf8');
 assert.match(backup,/rclone copy/);
 assert.match(backup,/backup_type/);
});
