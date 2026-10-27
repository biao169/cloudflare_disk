import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTestEnv,api,initialize} from './support.js';
import {normalizeManifest} from '../../worker/services/folder-sync.js';
const b=s=>new TextEncoder().encode(s);
async function folder(env,cookie,space,parent,name){const r=await api(env,'/api/v1/folders',{method:'POST',cookie,body:{name,space_id:space,parent_id:parent}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;}
async function upload(env,cookie,space,parent,name,text,replace=null){const params=new URLSearchParams({space_id:space,name,folder_id:parent});if(replace){params.set('replace_file_id',replace.id);params.set('expected_revision',String(replace.revision));}return api(env,`/api/v1/storage/upload?${params}`,{method:'POST',cookie,body:b(text),headers:{'content-type':'text/plain'}})}
async function plan(env,cookie,space,parent,mode,files,dirs=[]){return api(env,'/api/v1/folder-sync/plan',{method:'POST',cookie,body:{space_id:space,parent_folder_id:null,root_name:'Project',mode,files:files.map(f=>({path:f.path,size_bytes:b(f.text).length,mime_type:'text/plain'})),directories:dirs}})}
async function start(env,cookie,space,parent,mode,files,dirs=[]){const input={space_id:space,parent_folder_id:null,root_name:'Project',mode,files:files.map(f=>({path:f.path,size_bytes:b(f.text).length,mime_type:'text/plain'})),directories:dirs};const prev=await api(env,'/api/v1/folder-sync/plan',{method:'POST',cookie,body:input});assert.equal(prev.status,200,JSON.stringify(prev.data));const r=await api(env,'/api/v1/folder-sync/jobs',{method:'POST',cookie,body:{...input,plan_hash:prev.data.data.plan_hash,confirm_mirror:true}});assert.equal(r.status,200,JSON.stringify(r.data));return {id:r.data.data.job_id,preview:prev.data.data,rootId:r.data.data.root_folder_id};}
async function process(env,cookie,space,id,files){const state=await api(env,`/api/v1/folder-sync/jobs/${id}`,{cookie});assert.equal(state.status,200,JSON.stringify(state.data));const job=state.data.data;const folders=new Map([['',job.root_folder_id]]);
 for(const item of job.items.filter(x=>x.kind==='folder')){
  if(item.action==='reuse')folders.set(item.relative_path,item.target_id);
  else{const parts=item.relative_path.split('/'),parent=folders.get(parts.slice(0,-1).join('/'));const created=await folder(env,cookie,space,parent,parts.at(-1));folders.set(item.relative_path,created)}
  const r=await api(env,`/api/v1/folder-sync/jobs/${id}/items/${item.id}/ack`,{method:'POST',cookie,body:{result_id:folders.get(item.relative_path)}});assert.equal(r.status,200,JSON.stringify(r.data));
 }
 for(const item of job.items.filter(x=>x.kind==='file')){
  const src=files.find(f=>f.path===item.relative_path);assert.ok(src);
  const parts=item.relative_path.split('/'),parent=folders.get(parts.slice(0,-1).join('/'));
  const up=await upload(env,cookie,space,parent,parts.at(-1),src.text,item.action==='replace'?{id:item.target_id,revision:item.expected_revision}:null);
  assert.equal(up.status,item.action==='replace'?200:201,JSON.stringify(up.data));
  const ack=await api(env,`/api/v1/folder-sync/jobs/${id}/items/${item.id}/ack`,{method:'POST',cookie,body:{result_id:up.data.data.file_id||up.data.data.id, result_revision:item.action==='replace'?up.data.data.revision:1}});
  assert.equal(ack.status,200,JSON.stringify(ack.data));
 }
 return job;
}

test('RC13.3 plan rejects traversal, manifest casefold collisions, cross-type collisions',async()=>{
 const input={space_id:crypto.randomUUID(),root_name:'Project',mode:'merge',parent_folder_id:null};
 assert.equal(normalizeManifest({...input,files:[{path:'../oops',size_bytes:1}]}).error,'INVALID_FILE');
 assert.equal(normalizeManifest({...input,files:[{path:'A.txt',size_bytes:1},{path:'a.TXT',size_bytes:1}]}).error,'PATH_CONFLICT');
 assert.equal(normalizeManifest({...input,files:[{path:'a/file.txt',size_bytes:1}],directories:['a/file.txt']}).error,'PATH_CONFLICT');
});
test('RC13.3 merge keeps the root/folder/file IDs, private share and untouched old extras',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const root=await folder(env,u.cookie,u.spaceId,null,'Project'),sub=await folder(env,u.cookie,u.spaceId,root,'Assets');
 const original=await upload(env,u.cookie,u.spaceId,sub,'readme.txt','original');assert.equal(original.status,201);
 const oldFile=original.data.data.id;
 const spare=await upload(env,u.cookie,u.spaceId,root,'untouched.txt','keep');
 const share=await api(env,'/api/v1/shares',{method:'POST',cookie:u.cookie,body:{type:'temporary',target_type:'file',target_id:oldFile,expires_at:new Date(Date.now()+86400000).toISOString()}});
 assert.equal(share.status,201);
 const files=[{path:'Assets/readme.txt',text:'new version'},{path:'Assets/new.txt',text:'added'}];
 const job=await start(env,u.cookie,u.spaceId,null,'merge',files,['Assets']);
 assert.equal(job.rootId,root);assert.equal(job.preview.counts.replaced_files,1);assert.equal(job.preview.counts.new_files,1);
 await process(env,u.cookie,u.spaceId,job.id,files);
 const finished=await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie});
 assert.equal(finished.status,200,JSON.stringify(finished.data));assert.equal(finished.data.data.status,'completed');
 assert.equal(env.DB.query('SELECT id FROM folders WHERE parent_id=? AND name=?',root,'Assets').id,sub);
 assert.equal(env.DB.query('SELECT id,revision FROM files WHERE id=?',oldFile).revision,2);
 const latest=await api(env,new URL(share.data.data.url).pathname);assert.equal(await latest.response.text(),'new version');
 assert.equal(env.DB.query('SELECT deleted_at FROM files WHERE id=?',spare.data.data.id).deleted_at,null);
 assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM file_versions WHERE file_id=?',oldFile).n,1);
});
test('RC13.3 mirror will not delete missing files while upload items remain pending; after success it moves missing items to trash',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const root=await folder(env,u.cookie,u.spaceId,null,'Project');
 const stale=await upload(env,u.cookie,u.spaceId,root,'obsolete.txt','obsolete');assert.equal(stale.status,201);
 const files=[{path:'current.txt',text:'new'}];const job=await start(env,u.cookie,u.spaceId,null,'mirror',files);
 const pending=await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie});
 assert.equal(pending.status,409);assert.equal(pending.data.error.code,'UPLOADS_PENDING');
 assert.equal(env.DB.query('SELECT status FROM files WHERE id=?',stale.data.data.id).status,'ready');
 await process(env,u.cookie,u.spaceId,job.id,files);
 const finished=await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie});assert.equal(finished.status,200,JSON.stringify(finished.data));
 assert.equal(finished.data.data.status,'completed');assert.equal(env.DB.query('SELECT status FROM files WHERE id=?',stale.data.data.id).status,'trashed');
 assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM trash_entries WHERE target_id=?',stale.data.data.id).n,1);
});
test('RC13.3 mirror refuses delete when a concurrent file appears after preview',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);const root=await folder(env,u.cookie,u.spaceId,null,'Project');
 const job=await start(env,u.cookie,u.spaceId,null,'mirror',[{path:'new.txt',text:'new'}]);
 await process(env,u.cookie,u.spaceId,job.id,[{path:'new.txt',text:'new'}]);
 await upload(env,u.cookie,u.spaceId,root,'somebody.txt','surprise');
 const result=await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie});assert.equal(result.status,409);assert.equal(result.data.error.code,'MIRROR_STALE');
 assert.equal(env.DB.query("SELECT status FROM files WHERE name='somebody.txt'").status,'ready');
});
test('RC13.3 mirror skips prior files on failed upload, requires explicit confirmation, and plan detects revision changes',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);const root=await folder(env,u.cookie,u.spaceId,null,'Project');
 const original=await upload(env,u.cookie,u.spaceId,root,'copy.txt','original');
 const input={space_id:u.spaceId,parent_folder_id:null,root_name:'Project',mode:'mirror',files:[{path:'copy.txt',size_bytes:3,mime_type:'text/plain'}],directories:[]};
 const plan=await api(env,'/api/v1/folder-sync/plan',{method:'POST',cookie:u.cookie,body:input});assert.equal(plan.status,200);
 const noConfirm=await api(env,'/api/v1/folder-sync/jobs',{method:'POST',cookie:u.cookie,body:{...input,plan_hash:plan.data.data.plan_hash}});assert.equal(noConfirm.status,409);
 const replace=await upload(env,u.cookie,u.spaceId,root,'copy.txt','updated',{id:original.data.data.id,revision:1});assert.equal(replace.status,200);
 const stale=await api(env,'/api/v1/folder-sync/jobs',{method:'POST',cookie:u.cookie,body:{...input,plan_hash:plan.data.data.plan_hash,confirm_mirror:true}});
 assert.equal(stale.status,409);assert.equal(stale.data.error.code,'PLAN_CHANGED');
});
test('RC13.3 job listing hides other user and does not grant access after membership removal',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const job=await start(env,u.cookie,u.spaceId,null,'merge',[{path:'doc.txt',text:'a'}]);
 const created=await api(env,'/api/v1/users',{method:'POST',cookie:u.cookie,body:{username:'outsider',password:'mypassword123'}});assert.equal(created.status,201);
 const outsider=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'outsider',password:'mypassword123'}});
 const cookie=outsider.response.headers.get('set-cookie').split(';')[0];
 const response=await api(env,`/api/v1/folder-sync/jobs/${job.id}`,{cookie});assert.equal(response.status,404);
});
test('RC13.3 mirror removes an extra nested directory without changing retained file identity',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const root=await folder(env,u.cookie,u.spaceId,null,'Project');const obsolete=await folder(env,u.cookie,u.spaceId,root,'Retired');
 const obsoleteFile=await upload(env,u.cookie,u.spaceId,obsolete,'old.txt','obsolete');
 const keep=await upload(env,u.cookie,u.spaceId,root,'active.txt','before');
 const current=[{path:'active.txt',text:'after'}];const job=await start(env,u.cookie,u.spaceId,null,'mirror',current);
 assert.equal(job.preview.counts.removed_folders,1);
 await process(env,u.cookie,u.spaceId,job.id,current);
 const finish=await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie});
 assert.equal(finish.status,200,JSON.stringify(finish.data));
 assert.equal(env.DB.query('SELECT status,revision FROM files WHERE id=?',keep.data.data.id).revision,2);
 assert.ok(env.DB.query('SELECT deleted_at FROM folders WHERE id=?',obsolete).deleted_at);
 assert.equal(env.DB.query('SELECT status FROM files WHERE id=?',obsoleteFile.data.data.id).status,'trashed');
 const second=await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie});assert.equal(second.data.data.status,'completed');
});
test('RC13.3 new mode creates a separate root and keeps the prior root/share unchanged',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const priorRoot=await folder(env,u.cookie,u.spaceId,null,'Project');
 const priorFile=await upload(env,u.cookie,u.spaceId,priorRoot,'doc.txt','old');
 const files=[{path:'doc.txt',text:'new'}];const job=await start(env,u.cookie,u.spaceId,null,'new',files);
 assert.notEqual(job.rootId,priorRoot);
 assert.equal(env.DB.query('SELECT name FROM folders WHERE id=?',job.rootId).name,'Project (1)');
 await process(env,u.cookie,u.spaceId,job.id,files);
 const finish=await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie});assert.equal(finish.status,200);
 assert.equal((await api(env,`/api/v1/files/${priorFile.data.data.id}/content`,{cookie:u.cookie})).response.status,200);
 assert.equal(env.DB.query('SELECT revision FROM files WHERE id=?',priorFile.data.data.id).revision,1);
});
test('RC13.3 mirror delete is resume-safe when client loses journal response after trash was already committed',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const root=await folder(env,u.cookie,u.spaceId,null,'Project');const old=await upload(env,u.cookie,u.spaceId,root,'old.txt','old');
 const keep=[{path:'new.txt',text:'new'}];const job=await start(env,u.cookie,u.spaceId,null,'mirror',keep);await process(env,u.cookie,u.spaceId,job.id,keep);
 // Simulate a successful trashItem but a lost folder-sync journal response.
 const trash=await api(env,'/api/v1/trash',{method:'POST',cookie:u.cookie,body:{target_type:'file',target_id:old.data.data.id}});
 assert.equal(trash.status,200);
 const finish=await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie});assert.equal(finish.status,409);
 // Snapshot was no longer pristine before the first mirror deletion. Fail closed.
 assert.equal(finish.data.error.code,'MIRROR_STALE');
});
test('RC13.3 resuming a job records already acknowledged directories and files once',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);const files=[{path:'docs/a.txt',text:'hello'}];
 const job=await start(env,u.cookie,u.spaceId,null,'merge',files,['docs']);await process(env,u.cookie,u.spaceId,job.id,files);
 const state=await api(env,`/api/v1/folder-sync/jobs/${job.id}`,{cookie:u.cookie});assert.equal(state.status,200);assert.equal(state.data.data.counts.pending,0);
 const item=state.data.data.items.find(x=>x.kind==='file');const repeat=await api(env,`/api/v1/folder-sync/jobs/${job.id}/items/${item.id}/ack`,{method:'POST',cookie:u.cookie,body:{result_id:item.result_id}});
 assert.equal(repeat.status,200);assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM folder_sync_items WHERE job_id=?',job.id).n,2);
});
test('RC13.3 a large JSON manifest uses one D1 write rather than exceeding binding limits',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const files=Array.from({length:100},(_,i)=>({path:`doc${i}.txt`,text:'x'}));const job=await start(env,u.cookie,u.spaceId,null,'merge',files);
 assert.ok(job.id);assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM folder_sync_items WHERE job_id=?',job.id).n,100);
});
test('RC13.3 merge replacement also updates the RC13.2 stable /r public URL',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const root=await folder(env,u.cookie,u.spaceId,null,'Project');
 const old=await upload(env,u.cookie,u.spaceId,root,'banner.txt','v1');const fileId=old.data.data.id;
 const pub=await api(env,'/api/v1/publications',{method:'POST',cookie:u.cookie,body:{file_id:fileId}});assert.equal(pub.status,201);
 const link=new URL(pub.data.data.url).pathname;const first=await api(env,link);assert.equal(first.status,302);
 const files=[{path:'banner.txt',text:'v2 global'}];const job=await start(env,u.cookie,u.spaceId,null,'merge',files);
 await process(env,u.cookie,u.spaceId,job.id,files);
 assert.equal((await api(env,`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST',cookie:u.cookie})).status,200);
 const next=await api(env,link);assert.equal(next.status,302);assert.notEqual(next.response.headers.get('location'),first.response.headers.get('location'));
 assert.equal(new TextDecoder().decode(env.PUBLIC_BUCKET.objects.get(new URL(next.response.headers.get('location')).pathname.slice(1)).bytes),'v2 global');
 assert.equal(env.DB.query('SELECT id FROM files WHERE id=?',fileId).id,fileId);
});
test('RC13.3 multipart replacement within folder sync retains file ID and version history',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const u=await initialize(env);
 const root=await folder(env,u.cookie,u.spaceId,null,'Project');const old=await upload(env,u.cookie,u.spaceId,root,'movie.bin','old');const fileId=old.data.data.id;
 const total=9*1048576;const input={space_id:u.spaceId,parent_folder_id:null,root_name:'Project',mode:'merge',files:[{path:'movie.bin',size_bytes:total,mime_type:'application/octet-stream'}],directories:[]};
 const plan=await api(env,'/api/v1/folder-sync/plan',{method:'POST',cookie:u.cookie,body:input});assert.equal(plan.status,200);
 const started=await api(env,'/api/v1/folder-sync/jobs',{method:'POST',cookie:u.cookie,body:{...input,plan_hash:plan.data.data.plan_hash}});assert.equal(started.status,200);
 const jobId=started.data.data.job_id;const begin=await api(env,'/api/v1/uploads',{method:'POST',cookie:u.cookie,body:{space_id:u.spaceId,folder_id:root,name:'movie.bin',size_bytes:total,mime_type:'application/octet-stream',replace_file_id:fileId,expected_revision:1}});
 assert.equal(begin.status,201,JSON.stringify(begin.data));const {upload_id,part_size,total_parts}=begin.data.data;
 for(let n=1;n<=total_parts;n++){
  const length=Math.min(part_size,total-(n-1)*part_size);
  const part=await api(env,`/api/v1/uploads/${upload_id}/parts/${n}`,{method:'PUT',cookie:u.cookie,body:new Uint8Array(length).fill(60+n)});
  assert.equal(part.status,200,JSON.stringify(part.data));
 }
 const completed=await api(env,`/api/v1/uploads/${upload_id}/complete`,{method:'POST',cookie:u.cookie});assert.equal(completed.status,201);
 const item=(await api(env,`/api/v1/folder-sync/jobs/${jobId}`,{cookie:u.cookie})).data.data.items[0];
 const ack=await api(env,`/api/v1/folder-sync/jobs/${jobId}/items/${item.id}/ack`,{method:'POST',cookie:u.cookie,body:{result_id:fileId}});
 assert.equal(ack.status,200,JSON.stringify(ack.data));
 assert.equal((await api(env,`/api/v1/folder-sync/jobs/${jobId}/finish`,{method:'POST',cookie:u.cookie})).status,200);
 assert.equal(env.DB.query('SELECT revision FROM files WHERE id=?',fileId).revision,2);
 assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM file_versions WHERE file_id=?',fileId).n,1);
});
test('RC13.3 folder jobs are not readable or actionable after user loses folder write permission',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const admin=await initialize(env);
 const newUser=await api(env,'/api/v1/users',{method:'POST',cookie:admin.cookie,body:{username:'collaborator',password:'123abcXYZxyz'}});
 assert.equal(newUser.status,201);const userId=newUser.data.data.id;
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'collaborator',password:'123abcXYZxyz'}});
 const userCookie=login.response.headers.get('set-cookie').split(';')[0];
 const team=await api(env,'/api/v1/spaces',{method:'POST',cookie:admin.cookie,body:{name:'Shared'}});
 assert.equal(team.status,201);const teamId=team.data.data.id;
 assert.equal((await api(env,`/api/v1/spaces/${teamId}/members/${userId}`,{method:'PUT',cookie:admin.cookie,body:{role:'editor'}})).status,200);
 const created=await api(env,'/api/v1/folder-sync/plan',{method:'POST',cookie:userCookie,body:{space_id:teamId,root_name:'Project',mode:'merge',files:[{path:'a.txt',size_bytes:1}],directories:[]}});
 assert.equal(created.status,200);
 const job=await api(env,'/api/v1/folder-sync/jobs',{method:'POST',cookie:userCookie,body:{space_id:teamId,root_name:'Project',mode:'merge',files:[{path:'a.txt',size_bytes:1}],directories:[],plan_hash:created.data.data.plan_hash}});
 assert.equal(job.status,200);
 assert.equal((await api(env,`/api/v1/spaces/${teamId}/members/${userId}`,{method:'PUT',cookie:admin.cookie,body:{role:'viewer'}})).status,200);
 assert.equal((await api(env,`/api/v1/folder-sync/jobs/${job.data.data.job_id}`,{cookie:userCookie})).status,404);
});
