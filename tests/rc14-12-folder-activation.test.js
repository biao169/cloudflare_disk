import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bindFolderDoubleClick} from '../public/js/utils/folder-open.js';
function fakeNode(){
 const callbacks=new Map();return {callbacks,classList:{add(x){this[x]=true;}},addEventListener(type,fn){callbacks.set(type,fn)},title:''};
}
const makeEvent=(target,props={})=>({button:0,target,prevented:false,preventDefault(){this.prevented=true},...props});
test('folder double-click ignores actions, selection checkboxes, modifiers and other buttons',()=>{
 let count=0;const node=fakeNode();bindFolderDoubleClick(node,()=>count++);
 const handler=node.callbacks.get('dblclick');assert.equal(node.classList['cd-folder-dblclick'],true);
 for(const selector of ['button','input','a','.od-actions','.cd-file-actions']){
  const evt=makeEvent({closest(s){assert.ok(s.includes(selector));return {};}});handler(evt);assert.equal(count,0);assert.equal(evt.prevented,false);
 }
 for(const props of [{button:2},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true}])handler(makeEvent({closest(){return null;}},props));
 assert.equal(count,0);
 const e=makeEvent({closest(){return null;}});handler(e);assert.equal(count,1);assert.equal(e.prevented,true);
});
test('nonfolders do not gain a double-click handler',()=>{
 const node=fakeNode();bindFolderDoubleClick(node,()=>{throw Error('should not run')},{enabled:false});assert.equal(node.callbacks.size,0);
});
test('folder double-click is integrated in R2, OneDrive browser, space browser and group share views',()=>{
 for(const file of ['modules/file-manager.js','modules/onedrive-browser.js','modules/spaces.js','onedrive-group.js']){
  const src=readFileSync(new URL('../public/js/'+file,import.meta.url),'utf8');
  assert.match(src,/bindFolderDoubleClick\(/,file);
 }
});
