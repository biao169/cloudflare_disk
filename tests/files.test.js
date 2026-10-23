import test from 'node:test';
import assert from 'node:assert/strict';
import {fileManagementRoute} from '../worker/api/files.js';
const base='http://localhost:8787';
test('file operations require authenticated sessions',async()=>{
 for(const [path,method] of [['/api/v1/search?space_id=00000000-0000-0000-0000-000000000000&q=abc','GET'],['/api/v1/folders','POST'],['/api/v1/files/batch','POST']]){
 const res=await fileManagementRoute(new Request(base+path,{method,...(method==='POST'?{headers:{'content-type':'application/json'},body:'{}'}:{})}),{},new URL(base+path).pathname);
 assert.equal(res.status,401);
 }
});
test('metadata routes cannot be used as a file byte-download endpoint',async()=>{
 const res=await fileManagementRoute(new Request(base+'/api/v1/files/00000000-0000-0000-0000-000000000000/content'),{},'/api/v1/files/00000000-0000-0000-0000-000000000000/content');
 assert.equal(res.status,401);
});
