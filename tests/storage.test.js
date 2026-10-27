import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_UPLOAD_BYTES,uploadInputs,storageBinding,destinationAllowed} from '../worker/services/storage.js';
const uid='11111111-1111-4111-8111-111111111111';
test('upload parser accepts a small upload',()=>{
 const req=new Request(`http://localhost/api/v1/storage/upload?space_id=${uid}&name=hello.txt`,{method:'POST',headers:{'content-length':'4'},body:'test'});
 assert.deepEqual(uploadInputs(req,new URL(req.url)),{size:4,name:'hello.txt',spaceId:uid,folderId:null,replaceFileId:null,expectedRevision:null});
});
test('upload rejects missing size, invalid path, or oversized file',()=>{
 const u=new URL(`http://localhost/api/v1/storage/upload?space_id=${uid}&name=x.txt`);
 assert.equal(uploadInputs(new Request(u),u),null);
 assert.equal(uploadInputs(new Request(u,{headers:{'content-length':String(MAX_UPLOAD_BYTES+1)}}),u),null);
 const bad=new URL(`http://localhost/api/v1/storage/upload?space_id=${uid}&name=..%2Fprivate`);
 assert.equal(uploadInputs(new Request(bad,{headers:{'content-length':'3'}}),bad),null);
});
test('R2 binding check fails closed',()=>assert.throws(()=>storageBinding({}),/PRIVATE_BUCKET/));
test('missing user space cannot upload',async()=>{
 const db={prepare(){return {bind(){return {first:async()=>null}}}}};
 assert.equal(await destinationAllowed(db,{id:'someone'},uid,null),false);
});
