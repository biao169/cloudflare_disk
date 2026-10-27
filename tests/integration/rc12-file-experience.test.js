import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';
const uuid=()=>crypto.randomUUID();
async function folder(env,login,name,space_id=login.spaceId,parent_id=null){
 const r=await api(env,'/api/v1/folders',{method:'POST',cookie:login.cookie,body:{name,space_id,parent_id}});
 assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;
}
async function upload(env,login,name,space_id=login.spaceId,folder_id=null){
 const p=new URLSearchParams({space_id,name});if(folder_id)p.set('folder_id',folder_id);
 const r=await api(env,`/api/v1/storage/upload?${p}`,{method:'POST',cookie:login.cookie,body:new TextEncoder().encode('RC12 file'),headers:{'Content-Type':'text/plain'}});
 assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;
}
async function member(env,admin,username){
 const creation=await api(env,'/api/v1/users',{method:'POST',cookie:admin.cookie,body:{username,password:'password123'}});
 assert.equal(creation.status,201,JSON.stringify(creation.data));
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username,password:'password123'}});
 assert.equal(login.status,200);return {id:creation.data.data.id,cookie:login.response.headers.get('set-cookie').split(';')[0]};
}
test('RC12: global search is authenticated, searches spaces and escapes SQL wildcard input',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env);
 await upload(env,adm,'needle-document.txt');const dir=await folder(env,adm,'needle-folder');
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:adm.cookie,body:{name:'search-team'}});
 await upload(env,adm,'needle-team.txt',team.data.data.id);
 assert.equal((await api(env,'/api/v1/search/global?q=needle')).status,401);
 const r=await api(env,'/api/v1/search/global?q=needle',{cookie:adm.cookie});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.items.length,3);
 assert.ok(r.data.data.items.some(x=>x.kind==='folder'&&x.id===dir));
 const star=await upload(env,adm,'literal%value.txt');
 const escaped=await api(env,'/api/v1/search/global?q=%25',{cookie:adm.cookie});
 assert.equal(escaped.status,200,JSON.stringify(escaped.data));
 assert.deepEqual(escaped.data.data.items.map(x=>x.id),[star]);
 assert.equal((await api(env,'/api/v1/search/global?q=x&type=nope',{cookie:adm.cookie})).status,400);
});
test('RC12: global search and favorites cannot reveal hidden folder or revoked team membership',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),other=await member(env,adm,'rc12member');
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:adm.cookie,body:{name:'shared-RC12'}});const sid=team.data.data.id;
 await api(env,`/api/v1/spaces/${sid}/members/${other.id}`,{method:'PUT',cookie:adm.cookie,body:{role:'editor'}});
 const pub=await folder(env,adm,'search-readable',sid),secret=await folder(env,adm,'search-secret',sid);
 const visibleFile=await upload(env,adm,'finding-visible.txt',sid,pub);
 await upload(env,adm,'finding-secret.txt',sid,secret);
 await api(env,`/api/v1/folders/${secret}/permissions`,{method:'PUT',cookie:adm.cookie,body:{principal_type:'user',principal_id:other.id,permission_mask:0}});
 const found=await api(env,'/api/v1/search/global?q=finding',{cookie:other.cookie});
 assert.equal(found.status,200,JSON.stringify(found.data));assert.deepEqual(found.data.data.items.map(x=>x.id),[visibleFile]);
 const yes=await api(env,'/api/v1/favorites',{method:'POST',cookie:other.cookie,body:{kind:'file',id:visibleFile}});assert.equal(yes.status,200);
 const no=await api(env,'/api/v1/favorites',{method:'POST',cookie:other.cookie,body:{kind:'folder',id:secret}});assert.equal(no.status,404);
 const listed=await api(env,'/api/v1/favorites',{cookie:other.cookie});assert.deepEqual(listed.data.data.items.map(x=>x.id),[visibleFile]);
 await api(env,`/api/v1/spaces/${sid}/members/${other.id}`,{method:'DELETE',cookie:adm.cookie});
 assert.equal((await api(env,'/api/v1/search/global?q=finding',{cookie:other.cookie})).data.data.items.length,0);
 assert.equal((await api(env,'/api/v1/favorites',{cookie:other.cookie})).data.data.items.length,0);
 assert.equal((await api(env,`/api/v1/folders/${pub}/path`,{cookie:other.cookie})).status,404);
});
test('RC12: personal favorites are idempotent, checked in batches and removable without modifying source',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),dir=await folder(env,adm,'starfolder'),file=await upload(env,adm,'starfile.txt',adm.spaceId,dir);
 for(let i=0;i<2;i++)assert.equal((await api(env,'/api/v1/favorites',{method:'POST',cookie:adm.cookie,body:{kind:'file',id:file}})).status,200);
 await api(env,'/api/v1/favorites',{method:'POST',cookie:adm.cookie,body:{kind:'folder',id:dir}});
 assert.equal(env.DB.query('SELECT count(*) AS n FROM favorites').n,2);
 const check=await api(env,'/api/v1/favorites/check',{method:'POST',cookie:adm.cookie,body:{items:[{kind:'file',id:file},{kind:'folder',id:dir}]}});
 assert.deepEqual(check.data.data.keys.sort(),[`file:${file}`,`folder:${dir}`].sort());
 assert.equal((await api(env,'/api/v1/favorites/check',{method:'POST',cookie:adm.cookie,body:{items:Array(41).fill({kind:'file',id:file})}})).status,400);
 const path=await api(env,`/api/v1/folders/${dir}/path`,{cookie:adm.cookie});assert.equal(path.status,200);assert.deepEqual(path.data.data.path.map(x=>x.name),['starfolder']);
 const remove=await api(env,`/api/v1/favorites/file/${file}`,{method:'DELETE',cookie:adm.cookie});assert.equal(remove.status,200);
 assert.equal(env.DB.query('SELECT count(*) AS n FROM favorites').n,1);
 assert.ok(env.DB.query('SELECT id FROM files WHERE id=?',file));
});
test('RC12: cursor pagination cannot be used to escape ACL; large favorite sets remain query bounded',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env);
 const parent=await folder(env,adm,'series');const fid=await upload(env,adm,'series-file.txt',adm.spaceId,parent);
 const count=76;const insert=env.DB.native.prepare("INSERT INTO files(id,space_id,folder_id,name,object_id,status,created_by,updated_at) VALUES(?,?,?,?,?,'ready',?,?)");
 const source=env.DB.query('SELECT object_id FROM files WHERE id=?',fid).object_id;
 for(let i=0;i<count;i++)insert.run(uuid(),adm.spaceId,parent,`series-${i}.txt`,source,adm.userId,`2026-02-${String(1+Math.floor(i/29)).padStart(2,'0')} 12:00:00`);
 let cursor=null,found=[];
 for(let i=0;i<4;i++){
  const qp=new URLSearchParams({q:'series',type:'file',limit:'30'});if(cursor)qp.set('cursor',cursor);
  const result=await api(env,`/api/v1/search/global?${qp}`,{cookie:adm.cookie});assert.equal(result.status,200,JSON.stringify(result.data));
  found.push(...result.data.data.items.map(x=>x.id));cursor=result.data.data.cursor;if(!cursor)break;
 }
 assert.equal(new Set(found).size,count+1);
 assert.equal((await api(env,'/api/v1/search/global?q=series&cursor=bad!token',{cookie:adm.cookie})).status,400);
});
