import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAnonymousDownload} from '../worker/services/onedrive-public.js';
const url='https://1drv.ms/t/c/45ed996b079ab860/IQAeA-nNpMauRrmN5IV1xpzKAXimIbqgCf7nDAH0HGlZzVk?e=Cbjrip';
const responder=(status,location)=>async(_url,opts)=>{assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,undefined);return new Response(null,{status,headers:location?{Location:location}:{}});};
test('independent public redirect allows Microsoft file host only',async()=>{
 const r=await resolveAnonymousDownload(url,responder(302,'https://abc.files.1drv.com/tempfile?token=x'));
 assert.equal(r.verified,true);
});
test('login redirect must not count as public download proof',async()=>{
 const r=await resolveAnonymousDownload(url,responder(302,'https://login.microsoftonline.com/common/oauth2/authorize'));
 assert.equal(r.verified,false);
});
test('no redirect means no public download',async()=>{
 const r=await resolveAnonymousDownload(url,responder(403));assert.equal(r.verified,false);
});
test('rate limits are not bypassed by retry',async()=>{
 const r=await resolveAnonymousDownload(url,responder(429));assert.equal(r.reason,'MICROSOFT_THROTTLED');
});
test('forbidden hosts rejected',async()=>{
 const r=await resolveAnonymousDownload(url,responder(302,'http://127.0.0.1/private'));
 assert.equal(r.verified,false);
});
