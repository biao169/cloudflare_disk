import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import worker from '../worker/index.js';
import {makeTestEnv, initialize} from './integration/support.js';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(readFileSync(join(root,'wrangler.jsonc'),'utf8'));

function assetEnv(env) {
  env.ASSETS={fetch:async req => {
    const path=new URL(req.url).pathname;
    if (config.assets.html_handling!=='none'&&path.endsWith('.html')){
      return Response.redirect(new URL(path.replace(/\.html$/,''),req.url),307);
    }
    if (!['/login.html','/index.html','/share.html'].includes(path))return new Response('Not Found',{status:404});
    const html=readFileSync(join(root,'public',path.slice(1)),'utf8');
    return new Response(html,{status:200,headers:{'Content-Type':'text/html; charset=utf-8'}});
  }};
  return env;
}

test('HTML handling is explicit and cannot redirect login.html to the Worker login route',()=>{
  assert.equal(config.assets.html_handling,'none');
  for(const path of ['/login','/setup','/files','/','/s/*']) assert.ok(config.assets.run_worker_first.includes(path),path);
});

test('before D1 migrations, /login and /setup serve the actual HTML page without redirects',async()=>{
  const env=assetEnv({});
  for(const path of ['/login','/setup']){
    const response=await worker.fetch(new Request('https://clouddrive.example'+path),env);
    assert.equal(response.status,200,path);
    assert.match(await response.text(),/id="auth-form"/);
    assert.equal(response.headers.get('Cache-Control'),'private, no-store');
    assert.equal(response.headers.get('Location'),null);
  }
});

test('unauthenticated protected route redirects once to working login page',async()=>{
  const env=assetEnv({});
  const r=await worker.fetch(new Request('https://clouddrive.example/files'),env);
  assert.equal(r.status,302);
  assert.equal(new URL(r.headers.get('Location')).pathname,'/login');
  const login=await worker.fetch(new Request(r.headers.get('Location')),env);
  assert.equal(login.status,200);
});

test('authenticated application HTML and public share HTML return 200 without canonical redirects',async t=>{
  const env=assetEnv(makeTestEnv());t.after(()=>env.DB.close());
  const {cookie}=await initialize(env);
  const app=await worker.fetch(new Request('http://localhost:8787/files',{headers:{Cookie:cookie}}),env);
  assert.equal(app.status,200);
  assert.match(await app.text(),/<!doctype html>/i);
  const share=await worker.fetch(new Request('http://localhost:8787/s/test-code'),env);
  assert.equal(share.status,200);
  assert.match(await share.text(),/<!doctype html>/i);
});

test('unexpected canonical Asset redirect terminates with 500 instead of redirect loop',async()=>{
  const env={ASSETS:{fetch:async()=>Response.redirect('https://clouddrive.example/login',307)}};
  const response=await worker.fetch(new Request('https://clouddrive.example/login'),env);
  assert.equal(response.status,500);
  assert.equal(response.headers.get('Location'),null);
});

test('login initialization reports missing migrations and missing bootstrap Secret to the user',()=>{
  const loginJs=readFileSync(join(root,'public/js/login.js'),'utf8');
  assert.match(loginJs,/D1_MIGRATIONS_REQUIRED/);
  assert.match(loginJs,/BOOTSTRAP_SECRET_REQUIRED/);
  assert.match(loginJs,/ADMIN_SETUP_REQUIRED/);
  assert.match(loginJs,/READY/);
  const loginHtml=readFileSync(join(root,'public/login.html'),'utf8');
  assert.match(loginHtml,/<form id="auth-form" hidden>/);
});
