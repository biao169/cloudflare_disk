import test from 'node:test';
import assert from 'node:assert/strict';
import {startOAuth,finishOAuth,callbackUri,microsoftAuthorizationError,oauthErrorDetails} from '../worker/services/onedrive-oauth.js';
import {oauthCallbackRedirect} from '../worker/api/admin.js';
const envBase={MS_CLIENT_ID:'12345678-abcd-1234-abcd-123456789abc',MS_CLIENT_SECRET:'a-value-not-a-secret-id',MS_TOKEN_KEY:'0123456789abcdef'.repeat(4),MS_TENANT:'common'};
const callback='https://drive.example.org/api/v1/admin/onedrive/oauth/callback';
function mockDb(){
 const states=new Map();let saved=null;
 return {
  states,get saved(){return saved;},
  prepare(sql){
   return {bind(...args){
    return {
     async run(){
      if(sql.includes('INSERT INTO onedrive_oauth_states')){states.set(args[0],{state:args[0],owner_id:args[1],verifier:args[2],expires_at:args[3]});return {meta:{changes:1}};}
      if(sql.includes('DELETE FROM onedrive_oauth_states')){states.delete(args[0]);return {meta:{changes:1}};}
      if(sql.includes('INSERT INTO onedrive_oauth_account')){saved=args[0];return {meta:{changes:1}};}
      throw Error('Unexpected database write: '+sql);
     },
     async first(){
      if(sql.includes('SELECT * FROM onedrive_oauth_states')){const x=states.get(args[0]);return x?.owner_id===args[1]?x:null;}
      return null;
     }
    };
   }};
  }
 };
}
test('Microsoft authorization errors preserve safe AADSTS code and never raw description',()=>{
 const raw='AADSTS50011: redirect mismatch for user@example.org and secret=secret-value';
 const e=microsoftAuthorizationError('invalid_request',raw);const details=oauthErrorDetails(e);
 assert.equal(details.code,'MICROSOFT_REDIRECT_URI_MISMATCH');assert.equal(details.aadsts,'AADSTS50011');
 assert.equal(details.microsoftError,'invalid_request');assert.ok(!JSON.stringify(details).includes('user@example.org'));
 const denied=microsoftAuthorizationError('access_denied','User clicked cancel');
 assert.equal(denied.code,'MICROSOFT_CONSENT_DENIED');
 const account=microsoftAuthorizationError('invalid_request','AADSTS50020: personal account rejected');
 assert.equal(account.code,'MICROSOFT_ACCOUNT_TYPE_MISMATCH');
});
test('OAuth callback reports Microsoft error instead of generic OAUTH_FAILED',async()=>{
 const bad=`${callback}?state=some-state&error=access_denied&error_description=${encodeURIComponent('AADSTS65001: consent denied, email foo@example.org')}`;
 await assert.rejects(finishOAuth(new Request(bad),envBase,'admin'),e=>{
  assert.equal(e.code,'MICROSOFT_ADMIN_CONSENT_REQUIRED');
  assert.equal(e.aadsts,'AADSTS65001');
  assert.ok(!JSON.stringify(oauthErrorDetails(e)).includes('foo@example.org'));
  return true;
 });
 await assert.rejects(finishOAuth(new Request(callback),envBase,'admin'),/OAUTH_STATE_MISSING/);
 await assert.rejects(finishOAuth(new Request(callback+'?state=xyz'),envBase,'admin'),/OAUTH_CODE_MISSING/);
});
test('Callback failure redirects browser to useful error UI without state/code/description',()=>{
 const r=oauthCallbackRedirect({code:'MICROSOFT_ACCOUNT_TYPE_MISMATCH',aadsts:'AADSTS50020',microsoftError:'invalid_request'});
 assert.equal(r.status,303);
 const url=new URL(r.headers.get('Location'),'https://drive.example.org');
 assert.equal(url.pathname,'/settings');
 assert.equal(url.searchParams.get('tab'),'onedrive');
 assert.equal(url.searchParams.get('oauth_error'),'MICROSOFT_ACCOUNT_TYPE_MISMATCH');
 assert.equal(url.searchParams.get('aadsts'),'AADSTS50020');
 assert.equal(url.searchParams.get('ms_error'),'invalid_request');
 assert.equal(url.searchParams.get('code'),null);assert.equal(url.searchParams.get('state'),null);
 assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');
 const evil=oauthCallbackRedirect({code:'<bad>',aadsts:'evil-token',microsoftError:'token=secret'});
 assert.equal(new URL(evil.headers.get('Location'),'https://drive.example.org').searchParams.get('oauth_error'),'OAUTH_CALLBACK_ERROR');
 assert.ok(!evil.headers.get('Location').includes('secret'));
});
test('OAuth starts with exact configured redirect and checks original host',async()=>{
 const db=mockDb();const env={...envBase,DB:db,MS_REDIRECT_URI:callback};
 const loginUrl=await startOAuth(new Request('https://drive.example.org/settings'),env,'admin');
 const u=new URL(loginUrl);assert.equal(u.searchParams.get('redirect_uri'),callback);
 assert.equal(db.states.size,1);
 await assert.rejects(startOAuth(new Request('https://preview.example.org/settings'),env,'admin'),/MS_REDIRECT_ORIGIN_MISMATCH/);
 assert.equal(db.states.size,1);
 for(const bad of ['http://drive.example.org/api/v1/admin/onedrive/oauth/callback','https://drive.example.org/api/v1/admin/onedrive/oauth/callback/','https://drive.example.org/api/v1/admin/onedrive/oauth/callback?x=1']){
  assert.throws(()=>callbackUri(new Request('https://drive.example.org/settings'),{MS_REDIRECT_URI:bad}),/MS_REDIRECT_URI_INVALID/);
 }
});
test('OAuth uses same redirect_uri during token exchange and encrypts tokens; does not expose raw token',async()=>{
 const db=mockDb(),env={...envBase,DB:db,MS_REDIRECT_URI:callback};
 const url=await startOAuth(new Request('https://drive.example.org/settings'),env,'admin');
 const state=new URL(url).searchParams.get('state');
 const prev=globalThis.fetch;
 let actualForm;
 globalThis.fetch=async (url,init)=>{
  assert.match(url,/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/);
  actualForm=new URLSearchParams(init.body);
  return new Response(JSON.stringify({access_token:'secret-access',refresh_token:'secret-refresh',expires_in:3600}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 try{
  assert.equal(await finishOAuth(new Request(callback+'?code=auth-code&state='+state),env,'admin'),true);
  assert.equal(actualForm.get('redirect_uri'),callback);
  assert.equal(actualForm.get('code_verifier')?.length>40,true);
  assert.equal(db.states.size,0);
  assert.ok(db.saved.includes(':'));
  assert.ok(!db.saved.includes('secret-refresh'));
 }finally{globalThis.fetch=prev;}
});
test('Microsoft token errors retain safe codes without echoing secret values',async()=>{
 const db=mockDb(),env={...envBase,DB:db};
 const login=await startOAuth(new Request('https://drive.example.org/settings'),env,'admin');
 const state=new URL(login).searchParams.get('state');
 const prev=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({error:'invalid_client',error_description:'AADSTS7000215: secret-value was invalid for someone@example.org'}),{status:401,headers:{'Content-Type':'application/json'}});
 try{
  await assert.rejects(finishOAuth(new Request(callback+'?code=token&state='+state),env,'admin'),e=>{
   const diagnostic=oauthErrorDetails(e);assert.equal(diagnostic.code,'MICROSOFT_INVALID_CLIENT_SECRET');
   assert.equal(diagnostic.aadsts,'AADSTS7000215');
   assert.ok(!JSON.stringify(diagnostic).includes('secret-value'));return true;
  });
 }finally{globalThis.fetch=prev;}
});
