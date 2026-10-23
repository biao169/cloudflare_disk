import test from 'node:test';import assert from 'node:assert/strict';import {passwordHash,checkPassword,validPassword,validUsername,randomToken,sha256,sessionCookie} from '../worker/services/auth.js';
test('login password length is 6–128 Unicode characters',()=>{
 assert.equal(validPassword('12345'),false);
 assert.equal(validPassword('123456'),true);
 assert.equal(validPassword('A-long-passphrase-123'),true);
 assert.equal(validPassword('a'.repeat(128)),true);
 assert.equal(validPassword('a'.repeat(129)),false);
 assert.equal(validPassword('汉'.repeat(128)),true, '128 CJK chars must not be rejected by a byte cap');
 assert.equal(validPassword('🍀'.repeat(128)),true, 'count Unicode code points rather than UTF-16 units');
 assert.equal(validPassword('🍀'.repeat(129)),false);
 assert.equal(validPassword(null),false);
});
test('username validation',()=>{assert.equal(validUsername('alice_01'),true);assert.equal(validUsername('a b'),false)});
test('password hashing and verification',async()=>{const h=await passwordHash('CorrectHorseBattery123!');assert.equal(await checkPassword('CorrectHorseBattery123!',h),true);assert.equal(await checkPassword('IncorrectPassword111!',h),false);assert.equal(h.includes('CorrectHorse'),false);const short=await passwordHash('abc123');assert.equal(await checkPassword('abc123',short),true);assert.equal(await checkPassword('abc124',short),false);});
test('tokens contain sufficient entropy and hash deterministically',async()=>{const a=randomToken(),b=randomToken();assert.equal(a.length,64);assert.notEqual(a,b);assert.equal(await sha256(a),await sha256(a))});
test('session cookie secure flag follows scheme',()=>{assert.match(sessionCookie('x',new Request('https://example.com')),/Secure/);assert.doesNotMatch(sessionCookie('x',new Request('http://localhost:8787')),/; Secure/)});
