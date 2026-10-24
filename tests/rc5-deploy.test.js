import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deployCloudDrive,extractTables,parseCommandJson,resolveDatabaseId} from '../scripts/deploy-cloudflare.mjs';
import {REQUIRED_TABLES} from '../worker/services/readiness.js';
const id='9fcfecc1-243a-4ab0-b629-ce371f621223';
const otherId='7fcfecc1-243a-4ab0-b629-ce371f621223';
const schema=JSON.stringify([{success:true,results:[...REQUIRED_TABLES,'d1_migrations'].map(name=>({name}))}]);

function harness(options={}) {
 const folder=mkdtempSync(join(tmpdir(),'clouddrive-rc5-'));
 const original={name:'cloudflare-disk', d1_databases:[{binding:'DB',database_name:'clouddrive-db',migrations_dir:'migrations'}],r2_buckets:[{binding:'PRIVATE_BUCKET',bucket_name:'clouddrive-private'},{binding:'PUBLIC_BUCKET',bucket_name:'clouddrive-public'}]};
 const configPath=join(folder,'wrangler.jsonc');
 writeFileSync(configPath,JSON.stringify(original));
 const migrationsDir=join(folder,'migrations');
 mkdirSync(migrationsDir);writeFileSync(join(migrationsDir,'0001_initial.sql'),'CREATE TABLE t(id INTEGER);');
 let exists=options.existing ?? true;
 const calls=[];
 const runner=args=>{
  const command=args.slice(0,3).join(' ');
  const temp=join(folder,'.clouddrive-deploy-'+process.pid+'.jsonc');
  const cfg=readdirSync(folder).filter(f=>f.startsWith('.clouddrive-deploy-'));
  calls.push({command:args.join(' '), config:cfg.length?JSON.parse(readFileSync(join(folder,cfg[0]),'utf8')):undefined});
  if (options.listError && args[0]==='d1'&&args[1]==='list') return {status:1,stderr:'network/token denied'};
  if (args[0]==='d1'&&args[1]==='list') return {status:0,stdout:JSON.stringify(exists?[{name:'clouddrive-db',uuid:id}]:[])};
  if (args[0]==='deploy') { exists=true; return {status:0,stdout:'deployed'}; }
  if (args[0]==='d1'&&args[1]==='migrations'&&args[2]==='apply') {
   if (options.migrationError) return {status:1,stderr:'migration failed'};
   return {status:0,stdout:'migrated'};
  }
  if (args[0]==='d1'&&args[1]==='execute') return {status:0,stdout:options.schemaError?'[{"results":[]}]':schema};
  if (args[0]==='d1'&&args[1]==='migrations'&&args[2]==='list')return {status:0,stdout:'no pending migrations'};
  if (args[0]==='d1'&&args[1]==='export') {writeFileSync(args[args.indexOf('--output')+1], '-- backup test');return {status:0,stdout:'exported'};}
  throw Error('Unexpected '+args.join(' '));
 };
 return {folder, configPath, original, calls, runner, cleanup(){rmSync(folder,{recursive:true,force:true});}};
}
async function simulate({options={},mode='auto'}={}) {
 const h=harness(options);const lines=[];
 try {
  const result=await deployCloudDrive({runner:h.runner,configPath:h.configPath,mode,logger:{log:v=>lines.push(v),warn:v=>lines.push(v)}});
  return {result,calls:h.calls,lines,source:readFileSync(h.configPath,'utf8'),remaining:readdirSync(h.folder).filter(n=>n.startsWith('.clouddrive-deploy-'))};
 } finally {h.cleanup();}
}

test('existing D1 is migrated and checked BEFORE activating new Worker, never reprovisioned', async()=>{
 const x=await simulate();
 assert.deepEqual(x.calls.map(c=>c.command.split(' --config')[0]).map(c=>c.split(' ').slice(0,3).join(' ')),['d1 list --json','d1 migrations apply','d1 execute DB','deploy']);
 assert.equal(x.calls.filter(c=>c.command.startsWith('deploy ')).length,1);
 assert.equal(x.calls.find(c=>c.command.startsWith('d1 migrations apply')).config.d1_databases[0].database_id,id);
 assert.equal(x.remaining.length,0);
 assert.equal(JSON.parse(x.source).d1_databases[0].database_id,undefined);
});

test('first-run auto provisioning then migration then verified second deploy',async()=>{
 const x=await simulate({options:{existing:false}});
 assert.equal(x.calls.filter(c=>c.command.startsWith('deploy ')).length,2);
 assert.equal(x.calls[1].config.d1_databases[0].database_id,undefined);
 assert.equal(x.calls.at(-1).config.d1_databases[0].database_id,id);
 assert.equal(x.calls.filter(c=>c.command.startsWith('d1 migrations apply')).length,1);
});

test('network/API listing failure NEVER becomes create-a-new-database fallback',async()=>{
 const h=harness({listError:true});
 try {await assert.rejects(deployCloudDrive({runner:h.runner,configPath:h.configPath,logger:{log(){},warn(){}}}),/network\/token denied/);assert.equal(h.calls.some(c=>c.command.startsWith('deploy ')),false);} finally {h.cleanup();}
});

test('migration failure prevents publishing a new Worker for an existing DB',async()=>{
 const h=harness({migrationError:true});
 try {await assert.rejects(deployCloudDrive({runner:h.runner,configPath:h.configPath,logger:{log(){},warn(){}}}),/migration failed/);assert.equal(h.calls.some(c=>c.command.startsWith('deploy ')),false);} finally {h.cleanup();}
});

test('schema verification must succeed before an existing Worker update',async()=>{
 const h=harness({schemaError:true});
 try {await assert.rejects(deployCloudDrive({runner:h.runner,configPath:h.configPath,logger:{log(){},warn(){}}}),/仍缺少/);assert.equal(h.calls.some(c=>c.command.startsWith('deploy ')),false);} finally {h.cleanup();}
});

test('migrate-only reuses the same D1 and does not deploy code',async()=>{
 const x=await simulate({mode:'migrate-only'});
 assert.equal(x.calls.some(c=>c.command.startsWith('deploy ')),false);
 assert.equal(x.result.migrated,true);
});

test('upgrade cannot silently create missing D1',async()=>{
 const h=harness({existing:false});
 try {await assert.rejects(deployCloudDrive({runner:h.runner,mode:'upgrade',configPath:h.configPath,logger:{log(){},warn(){}}}),/禁止新建数据库/);assert.equal(h.calls.some(c=>c.command.startsWith('deploy ')),false);} finally {h.cleanup();}
});

test('D1 identity resolution rejects wrong account, invalid IDs, duplicate names',()=>{
 assert.throws(()=>resolveDatabaseId([],'clouddrive-db',id),/账号/);
 assert.throws(()=>resolveDatabaseId([{name:'clouddrive-db',uuid:'bad'}],'clouddrive-db'),/格式/);
 assert.throws(()=>resolveDatabaseId([{name:'clouddrive-db',uuid:id}],'clouddrive-db',otherId),/不一致/);
 assert.throws(()=>resolveDatabaseId([{name:'clouddrive-db',uuid:id},{name:'clouddrive-db',uuid:id}],'clouddrive-db'),/多个同名/);
 assert.equal(extractTables(parseCommandJson(schema)).has('users'),true);
});

test('base D1 migration does not use forbidden PRAGMA foreign_keys change',()=>{
 const sql=readFileSync('migrations/0001_initial.sql','utf8');
 assert.doesNotMatch(sql,/^\s*PRAGMA\s+foreign_keys\s*=/im);
});


test('backup-only resolves correct remote D1 and exports locally without migration or deploy',async()=>{
 const h=harness();
 try {
  const result=await deployCloudDrive({runner:h.runner,configPath:h.configPath,mode:'backup-only',logger:{log(){},warn(){}}});
  assert.ok(result.backupFile?.endsWith('.sql'));
  assert.equal(h.calls.some(c=>c.command.startsWith('deploy ')),false);
  assert.equal(h.calls.some(c=>c.command.startsWith('d1 migrations apply')),false);
  assert.equal(h.calls.some(c=>c.command.startsWith('d1 export')),true);
 } finally {h.cleanup();}
});
