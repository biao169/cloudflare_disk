import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOneDriveUrl} from '../worker/services/onedrive.js';
import {onedriveRoute} from '../worker/api/onedrive.js';
import {DEFAULT_SETTINGS,validateSettings} from '../worker/services/admin.js';
const sample='https://1drv.ms/t/c/45ed996b079ab860/IQAeA-nNpMauRrmN5IV1xpzKAXimIbqgCf7nDAH0HGlZzVk?e=Cbjrip';
test('OneDrive personal t/c link parsed without requesting external content',()=>{
 const p=parseOneDriveUrl(sample);assert.equal(p.link_kind,'personal_cid_share');assert.equal(p.account_cid,'45ed996b079ab860');assert.equal(p.content_checked,false);assert.equal(p.download_verified,false);
 const recovered=atob(p.share_token.slice(2).replace(/-/g,'+').replace(/_/g,'/'));assert.equal(recovered,sample);
});
test('rejects non-Microsoft, credentials, fragments and unsafe schemes',()=>{
 for(const bad of ['https://1drv.ms.evil.test/t/c/a/b','http://1drv.ms/x','https://a@1drv.ms/t/c/45ed996b079ab860/x','https://1drv.ms/x#fragment','file:///etc/passwd','https://127.0.0.1/'])assert.throws(()=>parseOneDriveUrl(bad),TypeError);
});
test('OneDrive feature setting can be switched off',()=>{assert.equal(DEFAULT_SETTINGS.onedrive_anonymous_enabled,true);assert.deepEqual(validateSettings({onedrive_anonymous_enabled:false}),{onedrive_anonymous_enabled:false});});
test('backend never returns an invented download URL',async()=>{
 const db={prepare:(sql)=>({bind:()=>({all:async()=>({results:[]}),run:async()=>({meta:{changes:sql.includes('INSERT INTO onedrive_quota_counters')?3:0}})})})};
 const env={DB:db};const req=new Request('https://example.com/api/v1/tools/onedrive/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:sample})});
 const r=await onedriveRoute(req,env,'/api/v1/tools/onedrive/resolve');assert.equal(r.status,200);const body=await r.json();assert.equal(body.data.download_url,null);assert.equal(body.data.status,'authorization_required_for_download');
});

test('quota configuration rejects invalid limits',()=>{
 assert.equal(validateSettings({onedrive_guest_hour_limit:0}),null);
 assert.equal(validateSettings({onedrive_user_day_limit:10001}),null);
 assert.deepEqual(validateSettings({onedrive_guest_minute_limit:5}),{onedrive_guest_minute_limit:5});
});
test('backend refuses resolution when quota exhausted',async()=>{
 const db={prepare:()=>({bind:()=>({all:async()=>({results:[]}),run:async()=>({meta:{changes:0}})})})};
 const r=await onedriveRoute(new Request('https://example.com/api/v1/tools/onedrive/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:sample})}),{DB:db},'/api/v1/tools/onedrive/resolve');
 assert.equal(r.status,429);
});
