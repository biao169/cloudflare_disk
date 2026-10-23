import test from 'node:test';
import assert from 'node:assert/strict';
import {previewAllowed,downloadFile} from '../worker/services/storage.js';
import {canPreview,previewUrl} from '../public/js/modules/preview.js';
import {storageRoute} from '../worker/api/storage.js';
const fileId='11111111-1111-4111-8111-111111111111';
test('only an explicit safe allowlist is previewable',()=>{
 for(const type of ['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf']){
  assert.equal(previewAllowed(type),true);assert.equal(canPreview({mime_type:type}),true);
 }
 for(const type of ['text/html','image/svg+xml','application/javascript','application/octet-stream',null])assert.equal(previewAllowed(type),false);
});
test('preview URL validates identifiers',()=>{
 assert.equal(previewUrl(fileId),`/api/v1/files/${fileId}/preview`);
 assert.throws(()=>previewUrl('../not-a-file'));
});
test('download and preview routes share required login guard',async()=>{
 for(const suffix of ['content','preview']){
  const response=await storageRoute(new Request(`http://localhost/api/v1/files/${fileId}/${suffix}`),{DB:{prepare(){return {bind(){return {first:async()=>null}}}}}},`/api/v1/files/${fileId}/${suffix}`);
  assert.equal(response.status,401);
 }
});
