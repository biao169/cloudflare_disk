import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,initialize,api} from './support.js';
import {sha256} from '../../worker/services/auth.js';
import {folderAccessBatch,spaceAccessBatch} from '../../worker/services/permission-batch.js';
import {pruneAuthRecords} from '../../worker/services/operations.js';

const ID=()=>crypto.randomUUID();
const bytes=text=>new TextEncoder().encode(text);
const createFolder=async(env,login,name,parent_id=null,space_id=login.spaceId)=>{
 const r=await api(env,'/api/v1/folders',{method:'POST',cookie:login.cookie,body:{space_id,name,parent_id}});
 assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;
};
const upload=async(env,login,name='file.pdf',folder_id=null,space_id=login.spaceId)=>{
 const q=new URLSearchParams({space_id,name});if(folder_id)q.set('folder_id',folder_id);
 const r=await api(env,`/api/v1/storage/upload?${q}`,{method:'POST',cookie:login.cookie,body:bytes('%PDF-1.7\nRC11'),headers:{'Content-Type':'application/pdf'}});
 assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;
};
function queryBudget(db){
 const original=db.prepare.bind(db),originalBatch=db.batch.bind(db);let queries=0,maxBindings=0;
 db.prepare=sql=>{queries++;const prep=original(sql);return {bind(...args){maxBindings=Math.max(maxBindings,args.length);assert.ok(args.length<=100,`D1 binding limit exceeded: ${args.length}`);return prep.bind(...args);}}};
 db.batch=async stmts=>{queries++;return originalBatch(stmts)};
 return {get queries(){return queries},get maxBindings(){return maxBindings},reset(){queries=0;maxBindings=0}};
}

test('RC11: bulk ACL honors nearest user overrides, inherited role ACL and deleted ancestors',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const admin=await initialize(env);
 const create=await api(env,'/api/v1/users',{method:'POST',cookie:admin.cookie,body:{username:'viewerRc11',password:'valid-pass11'}});
 const uid=create.data.data.id;
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:admin.cookie,body:{name:'RC11-team'}});const sid=team.data.data.id;
 await api(env,`/api/v1/spaces/${sid}/members/${uid}`,{method:'PUT',cookie:admin.cookie,body:{role:'editor'}});
 const root=await createFolder(env,admin,'root',null,sid),child=await createFolder(env,admin,'child',root,sid);
 await api(env,`/api/v1/folders/${root}/permissions`,{method:'PUT',cookie:admin.cookie,body:{principal_type:'role',principal_id:'editor',permission_mask:1}});
 await api(env,`/api/v1/folders/${child}/permissions`,{method:'PUT',cookie:admin.cookie,body:{principal_type:'user',principal_id:uid,permission_mask:3}});
 const user={id:uid,role:'member',status:'active'};
 const grants=await folderAccessBatch(env.DB,user,[root,child]);
 assert.equal(grants.get(root).mask,1);assert.equal(grants.get(child).mask,3);
 assert.equal((await spaceAccessBatch(env.DB,user,[sid])).get(sid).role,'editor');
 const no={id:ID(),role:'member',status:'active'};
 assert.equal((await folderAccessBatch(env.DB,no,[root])).size,0);
});

test('RC11: 95 owned share summaries use bounded D1 queries, even when one target is missing',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),fid=await upload(env,adm,'many.txt');
 const put=env.DB.native.prepare("INSERT INTO shares(id,type,target_type,target_id,share_code_hash,created_by) VALUES(?,'page','file',?,?,?)");
 for(let i=0;i<95;i++)put.run(ID(),i===94?ID():fid,`test-share-hash-${i}`,adm.userId);
 const budget=queryBudget(env.DB),r=await api(env,'/api/v1/shares',{cookie:adm.cookie});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.shares.length,95);
 assert.ok(budget.queries<=12,`too many queries: ${budget.queries}`);
 assert.equal(r.data.data.shares.filter(s=>s.status==='target_unavailable').length,1);
});

test('RC11: recent file query with many ACL-protected folders stays below D1 Free query budget',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env);
 const rows=[];for(let i=0;i<35;i++)rows.push(await createFolder(env,adm,'f-'+i));
 const file=await upload(env,adm,'prototype.txt',rows[0]);const original=env.DB.query('SELECT object_id FROM files WHERE id=?',file).object_id;
 const insert=env.DB.native.prepare("INSERT INTO files(id,space_id,folder_id,name,object_id,status,created_by,updated_at) VALUES(?,?,?,?,?,'ready',?,?)");
 for(let i=0;i<90;i++)insert.run(ID(),adm.spaceId,rows[i%rows.length],`t-${i}.txt`,original,adm.userId,`2026-01-${String(1+Math.floor(i/30)).padStart(2,'0')} 12:00:00`);
 const budget=queryBudget(env.DB);const result=await api(env,'/api/v1/files/recent?limit=50',{cookie:adm.cookie});
 assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.data.files.length,50);
 assert.ok(budget.queries<=14,`too many D1 calls: ${budget.queries}`);
});

test('RC11: folder move needs admin confirmation; editor cannot silently change inherited ACL',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env);
 const source=await createFolder(env,adm,'source'),destination=await createFolder(env,adm,'destination');
 const noConfirm=await api(env,`/api/v1/folders/${source}`,{method:'PATCH',cookie:adm.cookie,body:{parent_id:destination}});
 assert.equal(noConfirm.status,409);assert.equal(noConfirm.data.error.code,'ACL_CHANGE_CONFIRMATION_REQUIRED');
 assert.equal(env.DB.query('SELECT parent_id FROM folders WHERE id=?',source).parent_id,null);
 const yes=await api(env,`/api/v1/folders/${source}`,{method:'PATCH',cookie:adm.cookie,body:{parent_id:destination,confirm_acl_change:true}});
 assert.equal(yes.status,200);assert.equal(env.DB.query('SELECT parent_id FROM folders WHERE id=?',source).parent_id,destination);
 const create=await api(env,'/api/v1/users',{method:'POST',cookie:adm.cookie,body:{username:'editorRC11',password:'valid-pass11'}});
 const uid=create.data.data.id,team=await api(env,'/api/v1/spaces',{method:'POST',cookie:adm.cookie,body:{name:'Team-collab'}}),sid=team.data.data.id;
 await api(env,`/api/v1/spaces/${sid}/members/${uid}`,{method:'PUT',cookie:adm.cookie,body:{role:'editor'}});
 const a=await createFolder(env,adm,'a',null,sid),b=await createFolder(env,adm,'b',null,sid);
 const logged=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'editorRC11',password:'valid-pass11'}});
 const cookie=logged.response.headers.get('set-cookie').split(';')[0];
 const attempt=await api(env,`/api/v1/folders/${a}`,{method:'PATCH',cookie,body:{parent_id:b,confirm_acl_change:true}});
 assert.equal(attempt.status,403);
});

test('RC11: 130-file folder trash and restore stay inside D1 100-bind limit',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),dir=await createFolder(env,adm,'large');
 const fid=await upload(env,adm,'base.dat',dir),obj=env.DB.query('SELECT object_id FROM files WHERE id=?',fid).object_id;
 const insert=env.DB.native.prepare("INSERT INTO files(id,space_id,folder_id,name,object_id,status,created_by) VALUES(?,?,?,?,?,'ready',?)");
 for(let i=0;i<129;i++)insert.run(ID(),adm.spaceId,dir,`big-${i}.dat`,obj,adm.userId);
 const budget=queryBudget(env.DB),trash=await api(env,'/api/v1/trash',{method:'POST',cookie:adm.cookie,body:{target_type:'folder',target_id:dir}});
 assert.equal(trash.status,200,JSON.stringify(trash.data));assert.ok(budget.maxBindings<=100);
 assert.equal(env.DB.query("SELECT count(*) AS n FROM files WHERE status='trashed'").n,130);
 budget.reset();const restore=await api(env,`/api/v1/trash/${trash.data.data.trash_id}/restore`,{method:'POST',cookie:adm.cookie,body:{target_folder_id:null}});
 assert.equal(restore.status,200,JSON.stringify(restore.data));assert.ok(budget.maxBindings<=100);
 assert.equal(env.DB.query("SELECT count(*) AS n FROM files WHERE status='ready'").n,130);
});

test('RC11: exhausted download-limited shares refuse preview and subsequent download',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),fid=await upload(env,adm);
 const share=await api(env,'/api/v1/shares',{method:'POST',cookie:adm.cookie,body:{type:'page',target_type:'file',target_id:fid,max_downloads:1,expires_at:new Date(Date.now()+86400000).toISOString()}});
 assert.equal(share.status,201);const token=share.data.data.url.split('/').at(-1);
 const previewPath=`/api/v1/public/shares/${token}/files/${fid}/preview`;
 assert.equal((await api(env,previewPath)).status,200);
 const download=await api(env,`/api/v1/public/shares/${token}/files/${fid}/content`);
 assert.equal(download.status,200);
 const after=await api(env,previewPath);assert.notEqual(after.status,200);
 assert.equal((await api(env,`/api/v1/public/shares/${token}/files/${fid}/content`)).status,404);
});

test('RC11: IP-wide rate limit and safe periodic pruning of expired auth state',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env);
 for(let i=0;i<30;i++){
  const r=await api(env,'/api/v1/auth/login',{method:'POST',headers:{'CF-Connecting-IP':'198.51.100.42'},body:{username:`wrong${i}`,password:'valid-pass11'}});
  assert.equal(r.status,401);
 }
 const blocked=await api(env,'/api/v1/auth/login',{method:'POST',headers:{'CF-Connecting-IP':'198.51.100.42'},body:{username:'adminuser',password:'integration-password-123456'}});
 assert.equal(blocked.status,429);
 env.DB.native.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,'2020-01-01 00:00:00')").run(ID(),adm.userId,'old-session-hash');
 const validCount=env.DB.query('SELECT count(*) AS n FROM sessions').n;
 await pruneAuthRecords(env.DB,{batchSize:20});
 assert.equal(env.DB.query('SELECT count(*) AS n FROM sessions').n,validCount-1);
 assert.ok(env.DB.query('SELECT count(*) AS n FROM auth_attempts').n>=1,'non-expired attempt records are retained');
});

test('RC11: copying a write-only file cannot bypass read permission',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const admin=await initialize(env);
 const create=await api(env,'/api/v1/users',{method:'POST',cookie:admin.cookie,body:{username:'copyRc11',password:'valid-pass11'}});
 const uid=create.data.data.id;
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:admin.cookie,body:{name:'Protected files'}}),sid=team.data.data.id;
 await api(env,`/api/v1/spaces/${sid}/members/${uid}`,{method:'PUT',cookie:admin.cookie,body:{role:'editor'}});
 const folder=await createFolder(env,admin,'write-only',null,sid),id=await upload(env,admin,'secret.txt',folder,sid);
 await api(env,`/api/v1/folders/${folder}/permissions`,{method:'PUT',cookie:admin.cookie,body:{principal_type:'user',principal_id:uid,permission_mask:2}});
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'copyRc11',password:'valid-pass11'}});
 const cookie=login.response.headers.get('set-cookie').split(';')[0];
 const copy=await api(env,`/api/v1/files/${id}/copy`,{method:'POST',cookie,body:{name:'leak.txt',target_folder_id:folder}});
 assert.equal(copy.status,403);
 const original=env.DB.query('SELECT count(*) AS n FROM files').n;
 assert.equal(original,1);
});

test('RC11: share-password failed-attempt window resets after timeout',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const adm=await initialize(env),file=await upload(env,adm);
 const created=await api(env,'/api/v1/shares',{method:'POST',cookie:adm.cookie,body:{type:'page',target_type:'file',target_id:file,password:'valid-share-password-11',expires_at:new Date(Date.now()+86400000).toISOString()}});
 assert.equal(created.status,201);const token=created.data.data.url.split('/').at(-1);
 const url=`/api/v1/public/shares/${token}/verify`;
 for(let i=0;i<5;i++){const r=await api(env,url,{method:'POST',body:{password:'wrong-password'},headers:{'CF-Connecting-IP':'203.0.113.51'}});assert.equal(r.status,403);}
 const blocked=await api(env,url,{method:'POST',body:{password:'wrong-password'},headers:{'CF-Connecting-IP':'203.0.113.51'}});assert.equal(blocked.status,429);
 env.DB.native.exec("UPDATE share_password_attempts SET updated_at='2020-01-01 00:00:00',blocked_until='2020-01-01 00:00:00'");
 const reset=await api(env,url,{method:'POST',body:{password:'wrong-password'},headers:{'CF-Connecting-IP':'203.0.113.51'}});assert.equal(reset.status,403);
 const attempt=env.DB.query('SELECT failures,blocked_until FROM share_password_attempts');assert.equal(attempt.failures,1);assert.equal(attempt.blocked_until,null);
});
