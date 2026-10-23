import test from 'node:test';
import assert from 'node:assert/strict';
import {validShareCode,validExpiry,shareIsActive,shareSummary} from '../worker/services/sharing.js';
import {route} from '../worker/router.js';
test('share codes only allow long hex tokens',()=>{assert.equal(validShareCode('a'.repeat(64)),true);assert.equal(validShareCode('a'.repeat(10)),false);assert.equal(validShareCode('../secret'),false);});
test('expiration validated for future bounded times',()=>{assert.equal(validExpiry(null),true);assert.equal(validExpiry(new Date(Date.now()+86400000).toISOString()),true);assert.equal(validExpiry('2020-01-01'),false);assert.equal(validExpiry('invalid'),false);});
test('revoked and expired shares are inactive',()=>{assert.equal(shareIsActive({expires_at:null,revoked_at:null}),true);assert.equal(shareIsActive({expires_at:null,revoked_at:'2026-01-01'}),false);assert.equal(shareIsActive({expires_at:'2020-01-01',revoked_at:null}),false);});
test('share summary never returns password hash and secret token',()=>{const summary=shareSummary({id:'s',type:'page',password_hash:'secret',share_code_hash:'sensitive',target_type:'file',target_id:'f'});assert.equal(summary.has_password,true);assert.ok(!JSON.stringify(summary).includes('secret'));assert.ok(!JSON.stringify(summary).includes('sensitive'));});
test('health declares stage twelve',async()=>{const r=await route(new Request('http://localhost/api/v1/health'),{DB:{prepare(){}}});assert.equal((await r.json()).data.stage,'stage-12');});
