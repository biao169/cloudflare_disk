import test from 'node:test';
import assert from 'node:assert/strict';
import {redirectOneDriveLink} from '../worker/services/onedrive-links.js';
const id='od_'+'a'.repeat(32);
function mockEnv(source,status='active'){
 return {DB:{prepare(sql){return {bind(...args){return {async first(){return {id,source_url:source,status,expires_at:null};},async run(){return {meta:{changes:1}};}};}}}}};
}
test('fixed link redirects to the original OneDrive share page only',async()=>{
 const url='https://1drv.ms/t/c/45ed996b079ab860/IQAeA-nNpMauRrmN5IV1xpzKAXimIbqgCf7nDAH0HGlZzVk?e=Cbjrip';
 const r=await redirectOneDriveLink(new Request('https://example.com/r/'+id,{method:'HEAD'}),mockEnv(url),id);
 assert.equal(r.status,302);assert.equal(r.headers.get('Location'),url);assert.equal(r.headers.get('Cache-Control'),'no-store, private');
});
test('revoked fixed link returns 410',async()=>{const r=await redirectOneDriveLink(new Request('https://example.com/r/'+id),mockEnv('https://1drv.ms/t/c/45ed996b079ab860/IQAeA-nNpMauRrmN5IV1xpzKAXimIbqgCf7nDAH0HGlZzVk?e=Cbjrip','revoked'),id);assert.equal(r.status,410);});
test('invalid source cannot become an open redirect',async()=>{const r=await redirectOneDriveLink(new Request('https://example.com/r/'+id,{method:'HEAD'}),mockEnv('https://evil.example/path'),id);assert.equal(r.status,502);});
test('invalid link ids rejected',async()=>{const r=await redirectOneDriveLink(new Request('https://example.com/r/od_invalid'),mockEnv('https://evil.example'), 'od_invalid');assert.equal(r.status,404);});
