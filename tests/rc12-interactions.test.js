import test from 'node:test';
import assert from 'node:assert/strict';
import {safeUploadPath,filesFromDrop} from '../public/js/components/drag-upload.js';
import {readFileSync} from 'node:fs';

test('RC12: drag upload accepts nested safe names, blocks traversal and excessively deep paths',()=>{
 assert.equal(safeUploadPath('images/banner.png'),true);
 assert.equal(safeUploadPath('资料/图片/logo.webp'),true);
 assert.equal(safeUploadPath('a/../secret.txt'),false);
 assert.equal(safeUploadPath('./file.txt'),false);
 assert.equal(safeUploadPath('a//file.txt'),false);
 assert.equal(safeUploadPath('a/evil\u0000.png'),false);
 assert.equal(safeUploadPath(Array(14).fill('a').join('/')),false);
 assert.equal(safeUploadPath('a/'.repeat(2)+'x'.repeat(101)),false);
});
test('RC12: dragging a folder enumerates all batches and preserves relative directory structure',async()=>{
 const file=(name)=>({isFile:true,isDirectory:false,name,file:resolve=>resolve({name,size:1})});
 const subdir={isFile:false,isDirectory:true,name:'images',createReader:()=>{
  let passes=0;return {readEntries:resolve=>resolve(passes++===0?[file('one.jpg')]:passes===2?[file('two.jpg')]:[])};
 }};
 const result=await filesFromDrop({items:[{kind:'file',webkitGetAsEntry:()=>subdir}]});
 assert.deepEqual(result.filter(f=>f.file).map(f=>f.path),['images/one.jpg','images/two.jpg']);
 assert.deepEqual(result.filter(f=>f.kind==='folder').map(f=>f.path),['images']);
});
test('RC12: frontend routes expose search/favorites and never need a frontend compiler',()=>{
 const main=readFileSync(new URL('../public/js/main.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.ok(main.includes('clouddrive:locate'));
 assert.ok(main.includes('renderGlobalSearch'));
 assert.ok(main.includes("'favorites'"));
 assert.ok(html.includes('data-route="search"'));
 assert.ok(html.includes('data-route="favorites"'));
 assert.ok(!html.includes('/dist/'));
});
