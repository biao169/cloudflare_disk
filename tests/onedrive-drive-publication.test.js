import test from 'node:test';
import assert from 'node:assert/strict';
import {redirectAuthorizedDriveFile,driveFileAdminRoute} from '../worker/services/onedrive-drive-files.js';

test('new fixed file links never accept malformed IDs', async()=>{
 const r=await redirectAuthorizedDriveFile(new Request('https://example.org/r/odf_nothex'),{},'odf_nothex');
 assert.equal(r.status,404);
});
test('published fixed file links reject unsafe HTTP methods before touching DB',async()=>{
 const r=await redirectAuthorizedDriveFile(new Request('https://example.org/r/odf_'+'a'.repeat(32),{method:'POST'}),{},'odf_'+'a'.repeat(32));
 assert.equal(r.status,405);
});
