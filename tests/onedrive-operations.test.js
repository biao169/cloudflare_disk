import test from 'node:test';
import assert from 'node:assert/strict';
import {validMicrosoftDownloadUrl,microsoftDownloadTargetHost} from '../worker/services/onedrive-oauth.js';
import {pruneOneDriveRecords,oneDriveOperationalStatus} from '../worker/services/onedrive-maintenance.js';
test('temporary URL validator blocks unsafe hosts, URLs and credentials',()=>{
 assert.equal(validMicrosoftDownloadUrl('https://public.dm.files.1drv.com/file?a=1'),true);
 for(const url of ['http://public.dm.files.1drv.com/a','https://evil.com/','https://public.dm.files.1drv.com.evil.com/a','https://user:pass@public.dm.files.1drv.com/a','https://public.dm.files.1drv.com:8443/a','https://public.dm.files.1drv.com/a#fragment'])assert.equal(validMicrosoftDownloadUrl(url),false,url);
});
test('personal OneDrive new Microsoft personal-content download host is allowed, but arbitrary redirects are blocked',()=>{
 const legitimate='https://my.microsoftpersonalcontent.com/personal/45ed996b079ab860/_layouts/15/download.aspx?UniqueId=00000000-0000-0000-0000-000000000001&tempauth=PRIVATE_TOKEN';
 assert.equal(validMicrosoftDownloadUrl(legitimate),true);
 assert.equal(microsoftDownloadTargetHost(legitimate),'my.microsoftpersonalcontent.com');
 assert.equal(validMicrosoftDownloadUrl('https://contoso.sharepoint.com/_layouts/15/download.aspx?tempauth=x'),true);
 assert.equal(validMicrosoftDownloadUrl('https://abc.files.1drv.com/download?token=example'),true);
 assert.equal(validMicrosoftDownloadUrl('https://ams03pap005.storage.live.com/downloadfiles/a'),true);
 assert.equal(validMicrosoftDownloadUrl('https://s1.livefilestore.com/files/a'),true);
 for(const value of [
  'https://my.microsoftpersonalcontent.com.evil.example/personal/45/_layouts/15/download.aspx',
  'https://evil-my.microsoftpersonalcontent.com.evil.example/personal/45/_layouts/15/download.aspx',
  'https://my.microsoftpersonalcontent.com/personal/45/_layouts/15/evil.aspx',
  'https://my.microsoftpersonalcontent.com/_layouts/15/login.aspx',
  'https://attacker.example.invalid/file',
  'http://my.microsoftpersonalcontent.com/personal/45/_layouts/15/download.aspx',
  'https://user:secret@my.microsoftpersonalcontent.com/personal/45/_layouts/15/download.aspx',
  'https://my.microsoftpersonalcontent.com:8443/personal/45/_layouts/15/download.aspx',
  'https://my.microsoftpersonalcontent.com/personal/45/_layouts/15/download.aspx#ignored',
  'https://my.microsoftpersonalcontent.com./personal/45/_layouts/15/download.aspx',
  'https://my.microsoftpersonalcontent.com/personal/45/_layouts/15/download.aspx\n'
 ])assert.equal(validMicrosoftDownloadUrl(value),false,value);
});
test('cleanup uses bounded SQL and reports counts without raw identifiers',async()=>{
 const statements=[];const db={prepare(sql){statements.push(sql);return {bind(...args){assert.deepEqual(args,[100]);return {async run(){return {meta:{changes:4}};}};}};}};
 const result=await pruneOneDriveRecords(db);assert.deepEqual(result,{oauth_states:4,quota_counters:4,share_unlock_attempts:4,share_daily_stats:4,sync_events:4});assert.equal(statements.length,5);
});
test('cleanup batch size clamps to 200',async()=>{const seen=[];const db={prepare(){return {bind(...args){seen.push(...args);return {async run(){return {meta:{changes:0}}}}}}}};await pruneOneDriveRecords(db,{batchSize:9999});assert.deepEqual(seen,[200,200,200,200,200]);});
