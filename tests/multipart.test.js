import test from 'node:test';
import assert from 'node:assert/strict';
import {choosePartSize,validPartLayout,MiB,MAX_TOTAL} from '../worker/services/multipart.js';
test('default multipart size is 8 MiB',()=>assert.equal(choosePartSize(120*MiB),8*MiB));
test('parts are bounded by 10000',()=>assert.ok(Math.ceil(MAX_TOTAL/choosePartSize(MAX_TOTAL))<=10000));
test('reject zero, too big, and too small part sizes',()=>{assert.equal(validPartLayout(0,8*MiB),false);assert.equal(validPartLayout(MAX_TOTAL+1,8*MiB),false);assert.equal(validPartLayout(100*MiB,4*MiB),false)});
test('accept normal multipart layout',()=>assert.equal(validPartLayout(120*MiB,8*MiB),true));
