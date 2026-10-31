import test from 'node:test';
import assert from 'node:assert/strict';
import {sealBrowserCursor,unsealBrowserCursor,validGraphNextLink,validateBrowseParams,validatedThumbnailUrl,normalizeDriveItem,browseDrivePage} from '../worker/services/onedrive-browser.js';

const secret='0123456789abcdef'.repeat(4);
const env={MS_CLIENT_ID:'12345678-abcd-1234-abcd-123456789abc',MS_CLIENT_SECRET:'test-value',MS_TOKEN_KEY:secret};
const next="https://graph.microsoft.com/v1.0/me/drive/root/children?%24skiptoken=part1";

test('Graph continuation URL only accepts official endpoint and valid OneDrive folder/search paths',()=>{
 assert.equal(validGraphNextLink(next),true);
 assert.equal(validGraphNextLink("https://graph.microsoft.com/v1.0/me/drive/root/search(q='test')?%24skiptoken=abc"),true);
 for(const bad of ['https://graph.microsoft.com.evil.test/v1.0/me/drive/root/children','http://graph.microsoft.com/v1.0/me/drive/root/children','https://graph.microsoft.com/v1.0/users','https://graph.microsoft.com/v1.0/me/drive/items/id/content','https://graph.microsoft.com:8443/v1.0/me/drive/root/children','https://graph.microsoft.com/v1.0/me/drive/root/children#fragment'])
  assert.equal(validGraphNextLink(bad),false,bad);
});

test('opaque cursor is signed, time-limited, and bound to parent/search/sort',async()=>{
 const args={parent:'root',query:'',sort:'name_asc'};
 const sealed=await sealBrowserCursor(env,{next,...args});
 assert.equal(await unsealBrowserCursor(env,sealed,args),next);
 await assert.rejects(unsealBrowserCursor(env,sealed,{...args,parent:'AB!10'}),/INVALID_CURSOR/);
 await assert.rejects(unsealBrowserCursor(env,sealed,{...args,sort:'updated_desc'}),/INVALID_CURSOR/);
 await assert.rejects(unsealBrowserCursor(env,sealed,{...args,query:'private'}),/INVALID_CURSOR/);
 const [p,sig]=sealed.split('.');await assert.rejects(unsealBrowserCursor(env,`${p}.${sig[0]==='a'?'b':'a'}${sig.slice(1)}`,args),/INVALID_CURSOR/);
 await assert.rejects(unsealBrowserCursor(env,`${p}.not-a-signature`,args),/INVALID_CURSOR/);
 const other=await sealBrowserCursor(env,{next,...args});
 await assert.rejects(unsealBrowserCursor({...env,MS_TOKEN_KEY:'f'.repeat(64)},other,args),/INVALID_CURSOR/);
});

test('browse parameters reject malformed IDs, searches and OData sort injection',()=>{
 assert.deepEqual(validateBrowseParams({}),{parent:'root',query:'',sort:'name_asc'});
 for(const args of [{parent:'https://host/foo'},{parent:'abc/123'},{query:'a'.repeat(121)},{query:'bad\nsearch'},{sort:'name asc; users'}])
  assert.throws(()=>validateBrowseParams(args));
});

test('Graph thumbnail URL validation restricts origins and sanitizes items',()=>{
 assert.equal(validatedThumbnailUrl('https://sn1.files.1drv.com/th.jpg'),'https://sn1.files.1drv.com/th.jpg');
 assert.equal(validatedThumbnailUrl('https://evil.sharepoint.com.evil.test/thumb'),null);
 assert.equal(validatedThumbnailUrl('javascript:alert(1)'),null);
 assert.equal(validatedThumbnailUrl('https://someone:pass@contoso.sharepoint.com/x'),null);
 const x=normalizeDriveItem({id:'file!13',name:'新建文档.png',size:123,file:{mimeType:'image/png'},thumbnails:[{medium:{url:'https://sn1.files.1drv.com/thumb'}}],lastModifiedDateTime:'2026-10-31T00:00:00Z'});
 assert.equal(x.type,'image');assert.equal(x.thumbnail_url,'https://sn1.files.1drv.com/thumb');assert.equal(x.size,123);
});

test('folder browsing uses valid Graph endpoints, pages without leaking nextLink, and safe server sort',async()=>{
 const original=globalThis.fetch;
 const encryptedToken='test_access_token';
 // An in-memory D1 credential record encrypted as the production service expects.
 const bytes=Uint8Array.from(secret.match(/../g),x=>parseInt(x,16));
 const key=await crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt']);
 const iv=new Uint8Array(12).fill(7);
 const data=new TextEncoder().encode(JSON.stringify({access_token:encryptedToken,refresh_token:'refresh',expires_at:Date.now()+36000000}));
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data));
 const record=Buffer.from(iv).toString('hex')+':'+Buffer.from(encrypted).toString('base64url');
 const mock={...env,DB:{prepare(sql){if(sql.includes('onedrive_oauth_account'))return {bind(){return {first:async()=>({encrypted_tokens:record})};},first:async()=>({encrypted_tokens:record})};throw Error('Unexpected query');}}};
 let calls=0;
 try{
  globalThis.fetch=async (url,opts)=>{
   calls++;const u=new URL(url);assert.equal(u.hostname,'graph.microsoft.com');assert.equal(opts.headers.Authorization,`Bearer ${encryptedToken}`);assert.equal(opts.redirect,'manual');
   if(calls===1){assert.equal(u.searchParams.get('$top'),'60');assert.equal(u.searchParams.get('$orderby'),'name asc');assert.equal(u.searchParams.get('$expand'),'thumbnails');
    return Response.json({value:[{id:'root!1',name:'文件夹',folder:{childCount:2},size:0}], '@odata.nextLink':next});}
   assert.equal(u.searchParams.get('$skiptoken'),'part1');
   return Response.json({value:[{id:'root!2',name:'报告.pdf',file:{mimeType:'application/pdf'},size:512}],});
  };
  const first=await browseDrivePage(mock,{});
  assert.equal(first.items[0].folder,true);assert.equal(first.has_more,true);assert.ok(first.next_cursor);
  assert.ok(!JSON.stringify(first).includes('skiptoken'));assert.ok(!JSON.stringify(first).includes(encryptedToken));
  const second=await browseDrivePage(mock,{cursor:first.next_cursor});
  assert.equal(second.items[0].name,'报告.pdf');assert.equal(second.next_cursor,null);
  assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});

test('Graph 400 on expanded children falls back to unexpanded list for business accounts',async()=>{
 const original=globalThis.fetch;
 // Intercept Graph token retrieval through synthetic D1 row.
 const bytes=Uint8Array.from(secret.match(/../g),x=>parseInt(x,16)),iv=new Uint8Array(12).fill(8);
 const key=await crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt']);
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify({access_token:'mocktoken',refresh_token:'mockrefresh',expires_at:Date.now()+36000000}))));
 const cred=Buffer.from(iv).toString('hex')+':'+Buffer.from(encrypted).toString('base64url');
 const mock={...env,DB:{prepare(){return {bind(){return {first:async()=>({encrypted_tokens:cred})};},first:async()=>({encrypted_tokens:cred})};}}};
 let calls=0;
 try{globalThis.fetch=async u=>{calls++;const q=new URL(u).searchParams;if(q.has('$expand'))return Response.json({error:{code:'invalidRequest'}},{status:400});return Response.json({value:[{id:'a!1',name:'文件.txt',file:{mimeType:'text/plain'}}]});};
  const r=await browseDrivePage(mock);assert.equal(r.items.length,1);assert.equal(r.thumbnail_expand_supported,false);assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});

test('Graph search escapes apostrophes without placing user input in an arbitrary URL',async()=>{
 const original=globalThis.fetch;
 const bytes=Uint8Array.from(secret.match(/../g),x=>parseInt(x,16)),iv=new Uint8Array(12).fill(9);
 const key=await crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt']);
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify({access_token:'token',refresh_token:'refresh',expires_at:Date.now()+36000000}))));
 const cred=Buffer.from(iv).toString('hex')+':'+Buffer.from(encrypted).toString('base64url');
 const local={...env,DB:{prepare(){return {bind(){return {first:async()=>({encrypted_tokens:cred})};},first:async()=>({encrypted_tokens:cred})};}}};
 try{
  globalThis.fetch=async url=>{const u=new URL(url);assert.match(decodeURIComponent(u.pathname),/search\(q='O''Reilly'\)/);return Response.json({value:[{id:'file!id',name:"O'Reilly.txt",file:{mimeType:'text/plain'},size:55}]});};
  const got=await browseDrivePage(local,{query:"O'Reilly"});
  assert.equal(got.items[0].name,"O'Reilly.txt");assert.equal(got.sort_scope,'client_loaded_results');assert.equal(got.scope,'drive_search');
 }finally{globalThis.fetch=original;}
});
