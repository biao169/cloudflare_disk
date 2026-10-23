import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULT_SETTINGS,validateSettings,RESERVE_SQL} from '../worker/services/admin.js';
import {adminRoute} from '../worker/api/admin.js';
test('admin setting validation rejects unexpected keys and unsafe values',()=>{assert.equal(validateSettings({unexpected:1}),null);assert.equal(validateSettings({max_storage_bytes:-1}),null);assert.equal(validateSettings({uploads_enabled:'yes'}),null);assert.deepEqual(validateSettings({uploads_enabled:false}),{uploads_enabled:false});});
test('admin defaults and global quota predicate',()=>{assert.equal(DEFAULT_SETTINGS.max_storage_bytes,8*1024**3);assert.match(RESERVE_SQL,/SUM\(used_bytes\+reserved_bytes\)/);assert.match(RESERVE_SQL,/max_storage_bytes/);});
test('admin endpoints reject unauthenticated callers',async()=>{const response=await adminRoute(new Request('http://localhost/api/v1/admin/settings'),{},'/api/v1/admin/settings');assert.equal(response.status,401)});
test('admin frontend uses DOM construction and fetch APIs',()=>{const src=readFileSync(new URL('../public/js/modules/admin.js',import.meta.url),'utf8');assert.match(src,/requestJSON/);assert.match(src,/renderAdmin/)});
