import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const moduleUrl=new URL('../public/js/utils/time.js',import.meta.url).href;
function inZone(tz, script){return execFileSync(process.execPath,['--input-type=module','-e',`import {parseUtc,formatUtc,localInputFromUtc,utcFromLocalInput} from ${JSON.stringify(moduleUrl)}; ${script}`],{env:{...process.env,TZ:tz},encoding:'utf8'}).trim();}
test('SQL UTC timestamps remain UTC even without Z',()=>{
 assert.equal(inZone('Asia/Shanghai',"console.log(parseUtc('2026-10-28 03:00:00').toISOString())"),'2026-10-28T03:00:00.000Z');
});
test('UTC displays in browser timezone',()=>{
 assert.equal(inZone('Asia/Shanghai',"console.log(localInputFromUtc('2026-10-28 03:00:00'))"),'2026-10-28T11:00');
 assert.equal(inZone('America/New_York',"console.log(localInputFromUtc('2026-10-28 03:00:00'))"),'2026-10-27T23:00');
});
test('DST offsets update automatically',()=>{
 assert.equal(inZone('America/New_York',"console.log(localInputFromUtc('2026-01-15T12:00:00Z'))"),'2026-01-15T07:00');
 assert.equal(inZone('America/New_York',"console.log(localInputFromUtc('2026-07-15T12:00:00Z'))"),'2026-07-15T08:00');
});
test('datetime-local inputs submit UTC',()=>{
 assert.equal(inZone('Asia/Shanghai',"console.log(utcFromLocalInput('2026-10-28T11:00'))"),'2026-10-28T03:00:00.000Z');
});
test('invalid timestamps and date-only values do not shift',()=>{
 assert.equal(inZone('Asia/Shanghai',"console.log(parseUtc('2026-10-28')===null && formatUtc('2026-10-28')==='2026-10-28')"),'true');
});
