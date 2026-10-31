import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {retryAfterSeconds,safeDeltaUrl,sourceChanged,GraphSyncError} from '../worker/services/onedrive-sync.js';
import {validateSettings} from '../worker/services/admin.js';
const DRIVE='drive!abc';

test('RC14.12 Delta URLs are strictly tied to the Microsoft Graph host and the requested drive',()=>{
 assert.equal(safeDeltaUrl('https://graph.microsoft.com/v1.0/drives/drive!abc/root/delta?token=latest',DRIVE),true);
 assert.equal(safeDeltaUrl('https://graph.microsoft.com/v1.0/drives/drive!abc/root/delta(token=abc)',DRIVE),true);
 for(const url of ['https://graph.microsoft.com.evil.test/v1.0/drives/drive!abc/root/delta', 'http://graph.microsoft.com/v1.0/drives/drive!abc/root/delta',
  'https://graph.microsoft.com/v1.0/drives/other/root/delta', 'https://graph.microsoft.com/v1.0/me/drive/root/delta',
  'https://graph.microsoft.com/v1.0/drives/drive!abc/items/file/content','https://graph.microsoft.com/v1.0/drives/drive!abc/root/delta#fragment']){
  assert.equal(safeDeltaUrl(url,DRIVE),false,url);
 }
});
test('RC14.12 Retry-After duration and HTTP date are clamped; file change detection is monotonic',()=>{
 assert.equal(retryAfterSeconds('120'),120);assert.equal(retryAfterSeconds('999999'),3600);
 assert.equal(retryAfterSeconds(new Date(Date.UTC(2026,9,31,11,2)).toUTCString(),Date.UTC(2026,9,31,11,0)),120);
 assert.equal(retryAfterSeconds('garbage'),null);
 const row={source_etag:'etag1',file_name:'original.txt',file_size:100,file_modified_at:'2026-10-31T01:00:00Z'};
 assert.equal(sourceChanged(row,{eTag:'etag1',size:100,lastModifiedDateTime:'2026-10-31T01:00:00Z'}),false);
 assert.equal(sourceChanged(row,{eTag:'etag2'}),true);
 assert.equal(sourceChanged(row,{size:101}),true);assert.equal(sourceChanged(row,{name:'renamed.txt'}),true);
 assert.equal(sourceChanged(row,{lastModifiedDateTime:'2026-10-31T01:01:00Z'}),true);
});
test('RC14.12 settings validate safe synchronization limits',()=>{
 assert.deepEqual(validateSettings({onedrive_sync_enabled:false,onedrive_delta_enabled:true,onedrive_sync_batch_limit:8,onedrive_sync_interval_hours:6}),{onedrive_sync_enabled:false,onedrive_delta_enabled:true,onedrive_sync_batch_limit:8,onedrive_sync_interval_hours:6});
 for(const v of [-1,0,1.5,21,9999])assert.equal(validateSettings({onedrive_sync_batch_limit:v}),null);
 for(const v of [0,-1,1.5,169])assert.equal(validateSettings({onedrive_sync_interval_hours:v}),null);
});
