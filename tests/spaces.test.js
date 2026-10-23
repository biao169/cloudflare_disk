import test from 'node:test';
import assert from 'node:assert/strict';
import {validName,permissions,canFolder,canSpace,ensurePersonal,spaceAccess,folderAccess} from '../worker/services/spaces.js';

test('space names reject invalid paths and control characters',()=>{
 assert.equal(validName('研发团队'),true);assert.equal(validName(''),false);
 assert.equal(validName('x/y'),false);assert.equal(validName('x\\y'),false);
 assert.equal(validName('x\ny'),false);assert.equal(validName('a'.repeat(101)),false);
});
test('role baselines do not allow viewers to write',()=>{
 assert.equal(canSpace({role:'viewer'},'read'),true);
 assert.equal(canSpace({role:'viewer'},'write'),false);
 assert.equal(canSpace({role:'editor'},'manage'),false);
 assert.equal(canSpace({role:'admin'},'manage'),true);
 assert.equal(canFolder({mask:permissions.read},'write'),false);
 assert.equal(canFolder({mask:permissions.read|permissions.write},'write'),true);
 assert.equal(canFolder(null,'read'),false);
});
test('personal space creation is idempotent',async()=>{
 const space={id:'space-test',owner_id:'user-test',type:'personal'};
 let created=false;const db={prepare(sql){return {bind(...args){return {async first(){return created?space:null},async run(){created=true;return {meta:{changes:1}}}}}}}};
 assert.deepEqual(await ensurePersonal(db,{id:'user-test'}),space);
 assert.deepEqual(await ensurePersonal(db,{id:'user-test'}),space);
});
test('nonmembers cannot access team spaces',async()=>{
 const db={prepare(sql){return {bind(...args){return {async first(){if(sql.startsWith('SELECT * FROM spaces'))return {id:'space-1',owner_id:'owner',type:'team'};return null}}}}}};
 assert.equal(await spaceAccess(db,{id:'outsider',role:'member'},'space-1'),null);
 assert.equal((await spaceAccess(db,{id:'owner',role:'member'},'space-1')).role,'admin');
});
test('folder ACL uses nearest inherited role override',async()=>{
 const folder={id:'child',space_id:'s',parent_id:'parent',deleted_at:null};
 const parent={id:'parent',space_id:'s',parent_id:null,deleted_at:null};
 const db={prepare(sql){return {bind(...args){return {
 async first(){if(sql.startsWith('SELECT * FROM folders'))return args[0]==='child'?folder:parent;
 if(sql.startsWith('SELECT * FROM spaces'))return {id:'s',type:'team',owner_id:'other'};
 if(sql.startsWith('SELECT role FROM space_members'))return {role:'editor'};return null},
 async all(){return {results:sql.startsWith('SELECT principal_type')&&args[0]==='parent'?[{principal_type:'role',principal_id:'editor',permission_mask:1}]:[]}}
 }}}}};
 const a=await folderAccess(db,{id:'member1',role:'member'},'child');assert.equal(a.mask,1);
 assert.equal(canFolder(a,'write'),false);
});
