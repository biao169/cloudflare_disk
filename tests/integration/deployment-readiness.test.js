import test from 'node:test';
import assert from 'node:assert/strict';
import {api, makeTestEnv, initialize} from './support.js';
import {deploymentOrder,explicitMode} from '../../scripts/deploy-cloudflare.mjs';

test('deploy command picks first-run provision before migration, upgrade migration before deployment',()=>{
  assert.deepEqual(deploymentOrder('auto',false),['deploy:code','db:migrate:remote']);
  assert.deepEqual(deploymentOrder('auto',true),['db:migrate:remote','deploy:code']);
  assert.deepEqual(deploymentOrder('initial',true),['deploy:code','db:migrate:remote']);
  assert.deepEqual(deploymentOrder('upgrade',false),['db:migrate:remote','deploy:code']);
  assert.equal(explicitMode(['--upgrade']),'upgrade');
});

test('readiness warns when bindings are absent, rather than reporting a false healthy database',async()=>{
  const response=await api({},'/api/v1/health/ready');
  assert.equal(response.status,503);
  assert.equal(response.data.data.code,'BINDING_MISSING');
});

test('readiness detects empty database schema and gives migration guidance',async t=>{
  const env=makeTestEnv();const originalDb=env.DB;t.after(()=>originalDb.close());
  // Point readiness at a zero-table database without modifying the actual migration suite.
  env.DB={prepare:()=>({all:async()=>({results:[]})})};
  const response=await api(env,'/api/v1/health/ready');
  assert.equal(response.status,503);
  assert.equal(response.data.data.code,'D1_MIGRATIONS_REQUIRED');
  assert.equal(response.data.data.next_action,'APPLY_REMOTE_D1_MIGRATIONS');
});

test('readiness identifies missing administrator secret and initial setup',async t=>{
  const env=makeTestEnv();t.after(()=>env.DB.close());
  // node:sqlite does not create Wrangler's own migrations ledger; simulate it in test harness.
  env.DB.native.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  delete env.BOOTSTRAP_TOKEN;
  let result=await api(env,'/api/v1/health/ready');
  assert.equal(result.status,503);
  assert.equal(result.data.data.code,'BOOTSTRAP_SECRET_REQUIRED');
  env.BOOTSTRAP_TOKEN='new-long-random-bootstrap-token-123456';
  result=await api(env,'/api/v1/health/ready');
  assert.equal(result.status,503);
  assert.equal(result.data.data.code,'ADMIN_SETUP_REQUIRED');
  await initialize(env,'stageadmin','123abc');
  result=await api(env,'/api/v1/health/ready');
  assert.equal(result.status,200);
  assert.equal(result.data.data.code,'READY');
  assert.equal(result.data.data.admin_initialized,true);
});

test('readiness handles remote D1 query failure without echoing SQL errors',async()=>{
  const env={DB:{prepare(){throw Error('secret SQL stack')}} ,PRIVATE_BUCKET:{get(){},put(){}},PUBLIC_BUCKET:{get(){},put(){}},ASSETS:{fetch(){}}};
  const response=await api(env,'/api/v1/health/ready');
  assert.equal(response.status,503);
  assert.equal(response.data.data.code,'D1_QUERY_FAILED');
  assert.equal(JSON.stringify(response.data).includes('secret SQL stack'),false);
});
