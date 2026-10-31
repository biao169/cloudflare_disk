import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeMicrosoftTokenKey,microsoftConfigStatus,requireMicrosoftConfig,microsoftConfigErrorMessage} from '../worker/services/microsoft-config.js';
import {startOAuth,connectionStatus} from '../worker/services/onedrive-oauth.js';

const client='12345678-abcd-1234-abcd-123456789abc';
const key='0123456789abcdef'.repeat(4);
const valid={MS_CLIENT_ID:client,MS_CLIENT_SECRET:'sensitive-client-secret',MS_TOKEN_KEY:key};

test('Microsoft config status distinguishes missing and invalid secrets',()=>{
 assert.deepEqual(microsoftConfigStatus({}).issues.map(x=>x.code),[
  'MICROSOFT_CLIENT_ID_MISSING','MICROSOFT_CLIENT_SECRET_MISSING','MICROSOFT_TOKEN_KEY_MISSING']);
 const bad=microsoftConfigStatus({...valid,MS_TOKEN_KEY:'secret-identifier-not-an-encryption-key'});
 assert.equal(bad.ready,false);
 assert.equal(bad.fields.MS_TOKEN_KEY.status,'invalid');
 assert.equal(bad.issues.at(-1).code,'MICROSOFT_TOKEN_KEY_INVALID');
 assert.match(microsoftConfigErrorMessage('MICROSOFT_TOKEN_KEY_INVALID'),/64/);
 assert.throws(()=>requireMicrosoftConfig({...valid,MS_TOKEN_KEY:'too-short'}),/MICROSOFT_TOKEN_KEY_INVALID/);
});

test('64 hex key accepts surrounding whitespace and uppercase',()=>{
 const state=microsoftConfigStatus({...valid,MS_TOKEN_KEY:`\n ${key.toUpperCase()} \r\n`});
 assert.equal(state.ready,true);
 const bytes=requireMicrosoftConfig({...valid,MS_TOKEN_KEY:`  ${key} \n`}).tokenKey;
 assert.equal(bytes.byteLength,32);
 assert.equal(Buffer.from(bytes).toString('hex'),key);
});

test('32-byte Base64 and Base64URL key formats are supported',()=>{
 const bytes=Uint8Array.from({length:32},(_,i)=>i*7%256);
 const b64=Buffer.from(bytes).toString('base64');
 const b64url=b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 assert.deepEqual(decodeMicrosoftTokenKey(b64),bytes);
 assert.deepEqual(decodeMicrosoftTokenKey(b64url),bytes);
 assert.equal(microsoftConfigStatus({...valid,MS_TOKEN_KEY:b64}).ready,true);
 for(const bad of ['','a','g'.repeat(64),'MS_TOKEN_KEY='+key,'REPLACE_WITH_SECRET','.'.repeat(43)])
  assert.equal(decodeMicrosoftTokenKey(bad),null);
});

test('legacy alias works but conflicting keys are rejected',()=>{
 const legacy=microsoftConfigStatus({...valid,MS_TOKEN_KEY:undefined,MICROSOFT_TOKEN_KEY:key});
 assert.equal(legacy.ready,true);
 assert.equal(legacy.fields.MS_TOKEN_KEY.source,'MICROSOFT_TOKEN_KEY');
 assert.equal(legacy.warnings.length,1);
 assert.equal(microsoftConfigStatus({...valid,MICROSOFT_TOKEN_KEY:key.toUpperCase()}).ready,true);
 assert.equal(microsoftConfigStatus({...valid,MICROSOFT_TOKEN_KEY:Buffer.from(key.match(/.{2}/g).map(s=>parseInt(s,16))).toString('base64')}).ready,true);
 const conflict=microsoftConfigStatus({...valid,MICROSOFT_TOKEN_KEY:'f'.repeat(64)});
 assert.equal(conflict.ready,false);
 assert.equal(conflict.issues.at(-1).code,'MICROSOFT_TOKEN_KEY_CONFLICT');
});

test('OAuth start uses normalized runtime secret and config status leaks no values',async()=>{
 const db={prepare(sql){return {bind(...args){return {
  async run(){assert.match(sql,/INSERT INTO onedrive_oauth_states/);assert.equal(args.length,4);return {success:true};},
  async first(){return null;}
 };}};}};
 const env={...valid,MS_TOKEN_KEY:`\n ${key} `,DB:db};
 const url=await startOAuth(new Request('https://drive.example.org/api/v1/admin/onedrive/oauth/start'),env,'admin-1');
 assert.equal(new URL(url).searchParams.get('client_id'),client);
 assert.equal(new URL(url).searchParams.get('redirect_uri'),'https://drive.example.org/api/v1/admin/onedrive/oauth/callback');
 const response=await connectionStatus(env);
 assert.equal(response.configured,true);
 assert.equal(response.configuration.fields.MS_TOKEN_KEY.status,'ready');
 assert.equal(response.connected,false);
 const text=JSON.stringify(response);
 assert.ok(!text.includes(key));
 assert.ok(!text.includes(valid.MS_CLIENT_SECRET));
});

test('missing token key fails OAuth with missing code, invalid format has distinct code',async()=>{
 await assert.rejects(startOAuth(new Request('https://drive.example.org/'),{...valid,MS_TOKEN_KEY:undefined},'admin'),/MICROSOFT_TOKEN_KEY_MISSING/);
 await assert.rejects(startOAuth(new Request('https://drive.example.org/'),{...valid,MS_TOKEN_KEY:'incorrect'},'admin'),/MICROSOFT_TOKEN_KEY_INVALID/);
});
