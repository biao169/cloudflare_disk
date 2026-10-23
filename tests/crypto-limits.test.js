import test from 'node:test';
import assert from 'node:assert/strict';
import {passwordHash,checkPassword,validPassword} from '../worker/services/auth.js';

test('PBKDF2 password record uses 128-bit random salt and 256-bit derived output',async()=>{
 const password='a secure password for CloudDrive #2026';
 const record=await passwordHash(password);
 const [algorithm,iterations,saltHex,hashHex]=record.split('$');
 assert.equal(algorithm,'pbkdf2_sha256');
 assert.equal(iterations,'100000');
 assert.match(saltHex,/^[0-9a-f]{32}$/); // 16 bytes = 128 bits of salt
 assert.match(hashHex,/^[0-9a-f]{64}$/); // 32 bytes = 256 bits of derived hash
 assert.equal(await checkPassword(password,record),true);
 assert.equal(await checkPassword('wrong and definitely not a real password',record),false);
});

test('the 128-character limit is an app policy, not a PBKDF2 output-size limit',()=>{
 assert.equal(validPassword('a'.repeat(128)),true);
 assert.equal(validPassword('a'.repeat(129)),false);
 assert.equal(validPassword('中'.repeat(128)),true); // 384 UTF-8 bytes are permitted; max is 128 characters
 assert.equal(validPassword('中'.repeat(129)),false);
 assert.equal(validPassword('a'.repeat(5)),false);
 assert.equal(validPassword('a'.repeat(6)),true);
});
