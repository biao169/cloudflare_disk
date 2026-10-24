import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJsonc,parseMode} from '../scripts/deploy-cloudflare.mjs';

test('CloudDrive RC5 config deploys the existing Worker with automatic remote D1 migrations',()=>{
 const cfg=parseJsonc(readFileSync('wrangler.jsonc','utf8'));
 const pkg=JSON.parse(readFileSync('package.json','utf8'));
 assert.equal(cfg.name,'cloudflare-disk');
 assert.equal(cfg.d1_databases[0].binding,'DB');
 assert.equal(cfg.d1_databases[0].database_name,'clouddrive-db');
 assert.equal(cfg.d1_databases[0].database_id,undefined,'Never commit a real or placeholder account D1 ID');
 assert.match(pkg.scripts.deploy,/deploy-cloudflare\.mjs/);
 assert.match(pkg.scripts['db:migrate:remote'],/--migrate-only/);
 assert.equal(cfg.assets.html_handling,'none');
 assert.equal(parseMode(['--upgrade']),'upgrade');
 assert.equal(parseMode(['--migrate-only']),'migrate-only');
});

test('JSONC parser preserves URLs and accepts comments/trailing commas',()=>{
 const cfg=parseJsonc('{ // comment\n "url":"https://example.org/a//b", /* comment */ "a": 5, }');
 assert.deepEqual(cfg,{url:'https://example.org/a//b',a:5});
});
