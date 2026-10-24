import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/deploy-cloudflare.mjs',import.meta.url));
function simulate({databasePresent,mode}) {
  const dir=mkdtempSync(join(tmpdir(),'clouddrive-deploy-test-'));
  const log=join(dir,'commands.log');
  const npm=join(dir,'npm');
  writeFileSync(npm,'#!/bin/sh\necho "$@" >> "$MOCK_DEPLOY_LOG"\nif [ "$2" = "db:migrations:list:remote" ] && [ "$MOCK_DB_PRESENT" = "no" ]; then echo "database not provisioned" >&2; exit 1; fi\nexit 0\n');
  chmodSync(npm,0o755);
  try {
    const result=spawnSync(process.execPath,[script,...(mode?[`--${mode}`]:[])],{
      encoding:'utf8',env:{...process.env,PATH:dir+delimiter+process.env.PATH,MOCK_DEPLOY_LOG:log,MOCK_DB_PRESENT:databasePresent?'yes':'no'}
    });
    const lines=readFileSync(log,'utf8').trim().split('\n');
    return {result,lines};
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test('real deploy runner handles unprovisioned account in the correct order', {skip:process.platform==='win32'},()=>{
  const {result,lines}=simulate({databasePresent:false});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(lines,['run db:migrations:list:remote','run deploy:code','run db:migrate:remote']);
});
test('real deploy runner performs migrations before upgrading an existing account', {skip:process.platform==='win32'},()=>{
  const {result,lines}=simulate({databasePresent:true});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(lines,['run db:migrations:list:remote','run db:migrate:remote','run deploy:code']);
});
test('explicit upgrade never attempts a provisional deploy', {skip:process.platform==='win32'},()=>{
  const {result,lines}=simulate({databasePresent:false,mode:'upgrade'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(lines,['run db:migrate:remote','run deploy:code']);
});
