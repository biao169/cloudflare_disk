import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';
import {parseRecentCursor,recentCursor} from '../../worker/api/file-browser.js';
import {validShareOptions} from '../../public/js/components/share-dialog.js';
import {downloadUrl} from '../../public/js/modules/file-manager.js';

const bytes=s=>new TextEncoder().encode(s);
async function upload(env,cookie,space,name,text,folder){
 const qs=new URLSearchParams({space_id:space,name});if(folder)qs.set('folder_id',folder);
 const response=await api(env,`/api/v1/storage/upload?${qs}`,{method:'POST',cookie,body:bytes(text)});
 assert.equal(response.status,201,JSON.stringify(response.data));return response.data.data;
}
async function folder(env,cookie,space,name,parent_id){const r=await api(env,'/api/v1/folders',{method:'POST',cookie,body:{name,space_id:space,...(parent_id?{parent_id}:{})}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;}
async function otherUser(env,cookie){const pass='simple-password-123';const created=await api(env,'/api/v1/users',{method:'POST',cookie,body:{username:'viewerRC7',password:pass}});assert.equal(created.status,201,JSON.stringify(created.data));
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'viewerRC7',password:pass}});assert.equal(login.status,200);return {id:created.data.data.id,cookie:login.response.headers.get('set-cookie').split(';')[0]};}

test('RC7: truly recent files use modification time, keyset pagination and current-space ACL',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env);
 const a=await upload(env,adm.cookie,adm.spaceId,'older.txt','one');const b=await upload(env,adm.cookie,adm.spaceId,'newer.txt','two');
 env.DB.native.prepare("UPDATE files SET updated_at='2026-01-01 12:00:00' WHERE id=?").run(a.id);
 env.DB.native.prepare("UPDATE files SET updated_at='2026-09-01 12:00:00' WHERE id=?").run(b.id);
 const first=await api(env,'/api/v1/files/recent?limit=1',{cookie:adm.cookie});
 assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.data.files[0].id,b.id);
 assert.equal(first.data.data.has_more,true);assert.ok(first.data.data.cursor);
 const second=await api(env,'/api/v1/files/recent?limit=1&cursor='+encodeURIComponent(first.data.data.cursor),{cookie:adm.cookie});
 assert.equal(second.status,200);assert.equal(second.data.data.files[0].id,a.id);
 assert.equal((await api(env,'/api/v1/files/recent?cursor=%25',{cookie:adm.cookie})).status,400);
 const outsider=await otherUser(env,adm.cookie);
 const denied=await api(env,'/api/v1/files/recent',{cookie:outsider.cookie});assert.equal(denied.status,200);assert.equal(denied.data.data.files.length,0,'ordinary user must not see another user personal files');
 assert.deepEqual(parseRecentCursor(recentCursor({updated_at:'2026-01-01 12:00:00',id:a.id})),{date:'2026-01-01 12:00:00',id:a.id});
});

test('RC7: directory picker lists only readable folders and marks read-only destinations',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),viewer=await otherUser(env,adm.cookie);
 const space=await api(env,'/api/v1/spaces',{method:'POST',cookie:adm.cookie,body:{name:'Project team'}});assert.equal(space.status,201);
 const sid=space.data.data.id;
 const add=await api(env,`/api/v1/spaces/${sid}/members/${viewer.id}`,{method:'PUT',cookie:adm.cookie,body:{role:'viewer'}});assert.equal(add.status,200);
 const yes=await folder(env,adm.cookie,sid,'visible');const no=await folder(env,adm.cookie,sid,'blocked');
 const acl=await api(env,`/api/v1/folders/${no}/permissions`,{method:'PUT',cookie:adm.cookie,body:{principal_type:'user',principal_id:viewer.id,permission_mask:0}});assert.equal(acl.status,200);
 const catalog=await api(env,`/api/v1/spaces/${sid}/folders?limit=10`,{cookie:viewer.cookie});
 assert.equal(catalog.status,200,JSON.stringify(catalog.data));assert.equal(catalog.data.data.root_writable,false);
 assert.deepEqual(catalog.data.data.items.map(x=>x.id),[yes]);assert.equal(catalog.data.data.items[0].can_write,false);
 const owner=await api(env,`/api/v1/spaces/${sid}/folders`,{cookie:adm.cookie});assert.equal(owner.data.data.root_writable,true);
 assert.equal(owner.data.data.items.length,2);
});

test('RC7: mixed batch move and trash preserve ACL and folder nesting',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env);
 const dest=await folder(env,adm.cookie,adm.spaceId,'destination');const sub=await folder(env,adm.cookie,adm.spaceId,'source');
 const a=await upload(env,adm.cookie,adm.spaceId,'a.bin','abc');const b=await upload(env,adm.cookie,adm.spaceId,'b.bin','def');
 const moved=await api(env,'/api/v1/files/batch',{method:'POST',cookie:adm.cookie,body:{operation:'move',file_ids:[a.id,b.id],folder_ids:[sub],target_folder_id:dest}});
 assert.equal(moved.status,200,JSON.stringify(moved.data));assert.equal(moved.data.data.results.length,3);assert.equal(moved.data.data.partial_failure,false);
 assert.equal(env.DB.query('SELECT parent_id FROM folders WHERE id=?',sub).parent_id,dest);
 assert.equal(env.DB.query('SELECT folder_id FROM files WHERE id=?',a.id).folder_id,dest);
 const copy=await api(env,'/api/v1/files/batch',{method:'POST',cookie:adm.cookie,body:{operation:'copy',file_ids:[a.id],folder_ids:[],target_folder_id:null}});
 assert.equal(copy.status,200);assert.equal(copy.data.data.partial_failure,false);
 const denyCopyFolder=await api(env,'/api/v1/files/batch',{method:'POST',cookie:adm.cookie,body:{operation:'copy',file_ids:[],folder_ids:[sub],target_folder_id:null}});assert.equal(denyCopyFolder.status,400);
 const trashed=await api(env,'/api/v1/trash/batch',{method:'POST',cookie:adm.cookie,body:{items:[{kind:'file',id:a.id},{kind:'file',id:b.id},{kind:'folder',id:sub}]}});
 assert.equal(trashed.status,200,JSON.stringify(trashed.data));assert.equal(trashed.data.data.results.length,3);assert.equal(trashed.data.data.partial_failure,false);
 assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM trash_entries').n,3);
 const invalid=await api(env,'/api/v1/trash/batch',{method:'POST',cookie:adm.cookie,body:{items:[{kind:'file',id:a.id},{kind:'file',id:a.id}]}});assert.equal(invalid.status,400);
});

test('RC7: context share supports explicit lifetime and maintains safe token-only results',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env);const id=await folder(env,adm.cookie,adm.spaceId,'folder');
 const file=await upload(env,adm.cookie,adm.spaceId,'for-share.txt','content');const expire=new Date(Date.now()+7*86400000).toISOString();
 const temporary=await api(env,'/api/v1/shares',{method:'POST',cookie:adm.cookie,body:{type:'temporary',target_type:'file',target_id:file.id,expires_at:expire}});
 assert.equal(temporary.status,201,JSON.stringify(temporary.data));assert.equal(temporary.data.data.share.expires_at,expire);
 const page=await api(env,'/api/v1/shares',{method:'POST',cookie:adm.cookie,body:{type:'page',target_type:'folder',target_id:id,expires_at:null,password:'at-least-12-characters'}});
 assert.equal(page.status,201,JSON.stringify(page.data));assert.equal(page.data.data.share.expires_at,null);
 const list=await api(env,'/api/v1/shares',{cookie:adm.cookie});assert.equal(list.status,200);
 assert.ok(list.data.data.shares.some(s=>s.target_name==='for-share.txt'));assert.ok(list.data.data.shares.some(s=>s.target_name==='folder'));
 assert.equal(JSON.stringify(list.data).includes(temporary.data.data.url.split('/').at(-1)),false,'do not reveal plaintext share token via list endpoint');
 const publication=await api(env,'/api/v1/publications',{method:'POST',cookie:adm.cookie,body:{file_id:file.id}});assert.equal(publication.status,201);
 const pubs=await api(env,'/api/v1/publications',{cookie:adm.cookie});assert.ok(pubs.data.data.publications.some(p=>p.name==='for-share.txt'));
 assert.ok(validShareOptions({mode:'temporary',kind:'file',expires:'7d',password:''}));
 assert.equal(validShareOptions({mode:'public',kind:'folder',expires:'never',password:''}),false);
 assert.equal(validShareOptions({mode:'temporary',kind:'file',expires:'never',password:''}),false);
});

test('RC7: private downloads use streaming headers and correctly handle Range',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),file=await upload(env,adm.cookie,adm.spaceId,'download.bin','abcdefghijkl');
 const get=await api(env,downloadUrl(file.id),{cookie:adm.cookie});assert.equal(get.status,200);
 assert.equal(get.response.headers.get('accept-ranges'),'bytes');assert.match(get.response.headers.get('content-disposition'),/attachment/);
 assert.equal(await get.response.text(),'abcdefghijkl');
 const partial=await api(env,downloadUrl(file.id),{cookie:adm.cookie,headers:{Range:'bytes=4-7'}});assert.equal(partial.status,206);assert.equal(await partial.response.text(),'efgh');
 const suffix=await api(env,downloadUrl(file.id),{cookie:adm.cookie,headers:{Range:'bytes=-3'}});assert.equal(suffix.status,206);assert.equal(await suffix.response.text(),'jkl');
 const wrong=await api(env,downloadUrl(file.id),{cookie:adm.cookie,headers:{Range:'bytes=99-100'}});assert.equal(wrong.status,416);
 const head=await api(env,downloadUrl(file.id),{method:'HEAD',cookie:adm.cookie});assert.equal(head.status,200);assert.equal(head.response.headers.get('content-length'),'12');assert.equal(await head.response.text(),'');
 const mismatch=await api(env,downloadUrl(file.id),{cookie:adm.cookie,headers:{Range:'bytes=0-1','If-Range':'"outdated-etag"'}});assert.equal(mismatch.status,200);assert.equal(await mismatch.response.text(),'abcdefghijkl');
 const matching=await api(env,downloadUrl(file.id),{cookie:adm.cookie,headers:{Range:'bytes=0-1','If-Range':head.response.headers.get('etag')}});assert.equal(matching.status,206);assert.equal(await matching.response.text(),'ab');
});
