import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectMigration,inspectMigrations} from '../scripts/check-migrations.mjs';

test('RC11 safety preflight refuses DROP and DELETE but tolerates comments and additive indexes',()=>{
 assert.deepEqual(inspectMigration('safe.sql','-- DELETE FROM files;\nCREATE INDEX IF NOT EXISTS idx ON files(name);'),[]);
 assert.equal(inspectMigration('danger.sql','DROP TABLE users;').length,1);
 assert.equal(inspectMigration('danger.sql','DELETE FROM storage_objects;').length,1);
 assert.equal(inspectMigration('danger.sql','ALTER TABLE shares DROP COLUMN password_hash;').length,1);
 assert.deepEqual(inspectMigrations(),[]);
});
