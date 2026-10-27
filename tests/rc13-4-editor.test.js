import test from 'node:test';
import assert from 'node:assert/strict';
import {canEditText,MAX_TEXT_EDIT_BYTES} from '../public/js/components/text-editor.js';
import {editableMime,MAX_TEXT_BYTES,textRoutePattern} from '../worker/api/text-editor.js';
import {versionRoutePattern} from '../worker/api/replacements.js';

const id='11111111-1111-4111-8111-111111111111';
test('RC13.4 UTF-8 editor supports common text but rejects SVG and known binary media',()=>{
 assert.equal(MAX_TEXT_EDIT_BYTES,MAX_TEXT_BYTES);
 for(const name of ['a.txt','b.md','c.json','d.xml','e.csv','index.html','app.css','service.js','config.yaml']){
  assert.equal(canEditText({name,kind:'file',mime_type:'text/plain'}),true,name);
  assert.ok(editableMime(name,'text/plain'),name);
 }
 assert.equal(canEditText({name:'attack.svg',mime_type:'image/svg+xml'}),false);
 assert.equal(editableMime('attack.svg','image/svg+xml'),null);
 assert.equal(canEditText({name:'scan.pdf',mime_type:'application/pdf'}),false);
 assert.equal(editableMime('scan.pdf','application/pdf'),null);
});
test('RC13.4 route patterns match history content/preview/restore without generic wildcard',()=>{
 for(const path of [`/api/v1/files/${id}/versions/1/content`,`/api/v1/files/${id}/versions/123/preview`,`/api/v1/files/${id}/versions/2/restore`,`/api/v1/files/${id}/versions`])assert.ok(versionRoutePattern.test(path),path);
 for(const path of [`/api/v1/files/${id}/text`,`/api/v1/files/${id}/versions/12/text`])assert.ok(textRoutePattern.test(path),path);
 assert.equal(versionRoutePattern.test(`/api/v1/files/${id}/versions/../../text`),false);
 assert.equal(textRoutePattern.test(`/api/v1/files/${id}/versions/0/text`),false);
});
