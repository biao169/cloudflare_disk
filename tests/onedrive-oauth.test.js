import test from 'node:test';
import assert from 'node:assert/strict';
import {graphResolve,startOAuth} from '../worker/services/onedrive-oauth.js';
test('OAuth start requires configured application and encryption key',async()=>{
 await assert.rejects(startOAuth(new Request('https://example.com/a'),{},'a'),/MICROSOFT_CLIENT_ID_MISSING/);
});
test('Graph resolve never proceeds without credentials',async()=>{
 await assert.rejects(graphResolve({},'https://1drv.ms/t/c/45ed996b079ab860/IQAeA-nNpMauRrmN5IV1xpzKAXimIbqgCf7nDAH0HGlZzVk?e=Cbjrip'),/MICROSOFT_CLIENT_ID_MISSING/);
});
