import test from 'node:test';
import assert from 'node:assert/strict';
import {validMicrosoftDownloadUrl} from '../worker/services/onedrive-oauth.js';
import {pruneOneDriveRecords,oneDriveOperationalStatus} from '../worker/services/onedrive-maintenance.js';
test('temporary URL validator blocks unsafe hosts, URLs and credentials',()=>{
 assert.equal(validMicrosoftDownloadUrl('https://public.dm.files.1drv.com/file?a=1'),true);
 for(const url of ['http://public.dm.files.1drv.com/a','https://evil.com/','https://public.dm.files.1drv.com.evil.com/a','https://user:pass@public.dm.files.1drv.com/a','https://public.dm.files.1drv.com:8443/a','https://public.dm.files.1drv.com/a#fragment'])assert.equal(validMicrosoftDownloadUrl(url),false,url);
});
test('cleanup uses bounded SQL and reports counts without raw identifiers',async()=>{
 const statements=[];const db={prepare(sql){statements.push(sql);return {bind(...args){assert.deepEqual(args,[100]);return {async run(){return {meta:{changes:4}};}};}};}};
 const result=await pruneOneDriveRecords(db);assert.deepEqual(result,{oauth_states:4,quota_counters:4});assert.equal(statements.length,2);
});
test('cleanup batch size clamps to 200',async()=>{const seen=[];const db={prepare(){return {bind(...args){seen.push(...args);return {async run(){return {meta:{changes:0}}}}}}}};await pruneOneDriveRecords(db,{batchSize:9999});assert.deepEqual(seen,[200,200]);});
