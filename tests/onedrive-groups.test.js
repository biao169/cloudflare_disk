import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGroupRequest,validateGroupNextLink,collectSnapshot} from '../worker/services/onedrive-groups.js';
import {availableShareModes,defaultShareMode} from '../public/js/components/onedrive-share-wizard.js';

test('RC14.10 requires explicit publication, validates group mode and rejects implicit auto sync',()=>{
 assert.equal(validateGroupRequest({confirm_public:true,kind:'collection',title:' 资料合集 ',item_ids:['item!1']}).title,'资料合集');
 assert.throws(()=>validateGroupRequest({kind:'collection',title:'data',item_ids:['item!1']}),/CONFIRM_REQUIRED/);
 assert.throws(()=>validateGroupRequest({confirm_public:true,kind:'folder',title:'docs',item_ids:['item!1','item!2']}),/FOLDER_SELECTION_REQUIRED/);
 assert.throws(()=>validateGroupRequest({confirm_public:true,kind:'collection',title:'docs',item_ids:['item!1','item!1']}),/DUPLICATE_ITEM/);
 assert.throws(()=>validateGroupRequest({confirm_public:true,kind:'collection',title:'docs',item_ids:['item!1'],sync_mode:'dynamic'}),/AUTOMATIC_SYNC_NOT_SUPPORTED/);
 assert.throws(()=>validateGroupRequest({confirm_public:true,kind:'collection',title:'<data>',item_ids:['item!1'],description:'x\0'}),/INVALID_INPUT/);
 assert.ok(validateGroupRequest({confirm_public:true,kind:'collection',title:'正常',item_ids:['item!1'],description:'介绍'}));
});
test('RC14.10 Graph pagination is restricted to authorized me/drive children listings',()=>{
 assert.equal(validateGroupNextLink('https://graph.microsoft.com/v1.0/me/drive/items/folder!1/children?$skiptoken=xyz'),true);
 assert.equal(validateGroupNextLink('https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=xyz'),true);
 assert.equal(validateGroupNextLink('https://evil.example/v1.0/me/drive/root/children'),false);
 assert.equal(validateGroupNextLink('http://graph.microsoft.com/v1.0/me/drive/root/children'),false);
 assert.equal(validateGroupNextLink('https://graph.microsoft.com/v1.0/me/drive/items/../other/children'),false);
 assert.equal(validateGroupNextLink('https://graph.microsoft.com/v1.0/me/drive/items/file!1/content'),false);
});
test('RC14.10 create wizard offers folder, collection and individual publish only when appropriate',()=>{
 const file={id:'f1',name:'a.pdf',folder:false};const folder={id:'d1',name:'docs',folder:true};
 assert.deepEqual(availableShareModes([file]),['individual','collection']);
 assert.deepEqual(availableShareModes([folder]),['folder','collection']);
 assert.equal(defaultShareMode([file,file]),'collection');
 assert.equal(defaultShareMode([folder]),'folder');
 assert.equal(defaultShareMode([file]),'individual');
 assert.deepEqual(availableShareModes([]),[]);
});
test('RC14.10 rejects untrusted Graph nextLink before fetching it or publishing',async()=>{
 let requests=0;
 const read=async url=>{requests++;if(url.includes('?$select='))return {id:'dir!1',name:'Docs',folder:{},parentReference:{driveId:'drive!1'}};
  return {value:[], '@odata.nextLink':'https://attacker.invalid/steal'};};
 await assert.rejects(()=>collectSnapshot(read,{kind:'folder',item_ids:['dir!1']}),/UNSAFE_GRAPH_URL/);
 assert.equal(requests,2);
});

test('RC14.10 an empty folder produces a valid empty snapshot, not a partial error',async()=>{
 const read=async u=>u.includes('?$select=')?{id:'dir!3',name:'Empty',folder:{},parentReference:{driveId:'drive!1'}}:{value:[]};
 const nodes=await collectSnapshot(read,{kind:'folder',item_ids:['dir!3']});assert.equal(nodes.length,1);assert.equal(nodes[0].type,'folder');
});
test('RC14.10 snapshot halts at the 180 item cap',async()=>{
 const read=async u=>u.includes('?$select=')?{id:'dir!1',name:'Root',folder:{},parentReference:{driveId:'drive!1'}}:{value:Array.from({length:181},(_,i)=>({id:'f!'+i,name:'file'+i+'.pdf',file:{mimeType:'application/pdf'},parentReference:{driveId:'drive!1'}}))};
 await assert.rejects(()=>collectSnapshot(read,{kind:'folder',item_ids:['dir!1']}),/SNAPSHOT_TOO_LARGE/);
});
