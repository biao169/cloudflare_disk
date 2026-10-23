import test from 'node:test';
import assert from 'node:assert/strict';
import {safeId,cleanupTrash} from '../worker/services/trash.js';
import {readFileSync} from 'node:fs';
test('trash IDs must be UUID-shaped',()=>{assert.equal(safeId(''),false);assert.equal(safeId('../abc'),false);assert.equal(safeId('00000000-0000-0000-0000-000000000001'),true)});
test('trash migration creates cleanup and reference indexes',()=>{const sql=readFileSync(new URL('../migrations/0009_trash.sql',import.meta.url),'utf8');for(const name of ['idx_trash_purge','idx_file_object_refs','idx_publications_source'])assert.match(sql,new RegExp(name));});
test('trash API requires authentication and uses safe routes',()=>{const src=readFileSync(new URL('../worker/api/trash.js',import.meta.url),'utf8');assert.match(src,/resolveUser/);assert.match(src,/trashItem/);assert.match(src,/purgeItem/);});
