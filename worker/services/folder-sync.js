// RC13.3: bounded, server-authoritative folder merge/mirror journal.
// The client uploads bytes through the existing storage/multipart APIs; this
// service verifies committed D1 file IDs/revisions before allowing mirror trash.
import {one,many,execute,dbFromEnv} from './database.js';
import {spaceAccess,folderAccess,canFolder,canSpace,validName,uuid} from './spaces.js';
import {folderAccessBatch} from './permission-batch.js';
import {trashItem} from './trash.js';
import {targetForReplace} from './replacements.js';
import {ok,error} from '../utils/response.js';

export const FOLDER_SYNC_LIMITS=Object.freeze({files:150,folders:100,existing:280,total:420,depth:12});
const ID=/^[0-9a-f-]{36}$/;
const cleanId=x=>x===null||x===undefined||x===''?null:ID.test(x)?x:undefined;
const normalize=x=>String(x||'').normalize('NFC');
const fold=x=>normalize(x).toLowerCase();
const pathKey=x=>x.split('/').map(fold).join('/');
const parentPath=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
const baseName=p=>p.split('/').at(-1);
const depth=p=>p.split('/').length;
const validPath=p=>typeof p==='string'&&p===normalize(p)&&p.length<=1200&&depth(p)<=FOLDER_SYNC_LIMITS.depth&&p.split('/').every(n=>validName(n)&&n!=='.'&&n!=='..'&&n===normalize(n));
const bad=(code,message,status=409)=>({error:code,message,status});
const resolveResult=x=>x?.error?error(x.error,x.message||'操作失败',x.status||409):null;

export function normalizeManifest(input){
 if(!input||typeof input!=='object'||!['merge','mirror','new'].includes(input.mode)||!ID.test(input.space_id||'')||!validName(input.root_name)||input.root_name!==normalize(input.root_name)||cleanId(input.parent_folder_id)===undefined)return bad('INVALID_PLAN','空间、模式或根文件夹无效',400);
 const files=input.files,dirs=input.directories||[];
 if(!Array.isArray(files)||!Array.isArray(dirs)||files.length>FOLDER_SYNC_LIMITS.files||dirs.length>FOLDER_SYNC_LIMITS.folders||(files.length+dirs.length===0&&!(input.empty_root===true&&input.mode!=='mirror')))return bad('PLAN_LIMIT','单次最多 150 个文件、100 个目录；请分批同步',413);
 const resultFiles=[],known=new Map(),allDirs=new Map();
 function folder(p){const key=pathKey(p);if(known.get(key)==='file')return false;known.set(key,'folder');allDirs.set(key,p);return true;}
 for(const d of dirs){if(!validPath(d))return bad('INVALID_PATH','文件夹相对路径无效',400);let p='';for(const part of d.split('/')){p=p?p+'/'+part:part;if(!folder(p))return bad('PATH_CONFLICT','文件和文件夹相对路径冲突',409);}}
 for(const file of files){
  const p=file?.path,size=file?.size_bytes,mime=file?.mime_type||'application/octet-stream';
  if(!validPath(p)||!Number.isSafeInteger(size)||size<0||size>8*1024**3||typeof mime!=='string'||mime.length>120)return bad('INVALID_FILE','文件路径、大小或类型无效',400);
  let folderName='';const parts=p.split('/');for(const part of parts.slice(0,-1)){folderName=folderName?folderName+'/'+part:part;if(!folder(folderName))return bad('PATH_CONFLICT','文件路径与文件夹冲突',409);}
  const key=pathKey(p);if(known.has(key))return bad('PATH_CONFLICT','上传清单包含重复名称或大小写冲突',409);
  known.set(key,'file');resultFiles.push({path:p,size_bytes:size,mime_type:mime});
 }
 const folders=[...allDirs.values()].sort((a,b)=>depth(a)-depth(b)||a.localeCompare(b));
 if(resultFiles.length+folders.length>FOLDER_SYNC_LIMITS.total)return bad('PLAN_LIMIT','目录层级与操作总数超限',413);
 return {spaceId:input.space_id,parentId:cleanId(input.parent_folder_id),rootName:input.root_name,mode:input.mode,files:resultFiles.sort((a,b)=>a.path.localeCompare(b.path)),dirs:folders};
}

async function readTree(db,spaceId,rootId){
 if(!rootId)return {folders:[],files:[]};
 const limit=FOLDER_SYNC_LIMITS.existing+1;
 const folders=await many(db,`WITH RECURSIVE tree(id,parent_id,name,path,depth) AS (
 SELECT id,parent_id,name,name,1 FROM folders WHERE parent_id=? AND space_id=? AND deleted_at IS NULL
 UNION ALL SELECT f.id,f.parent_id,f.name,t.path||'/'||f.name,t.depth+1 FROM folders f JOIN tree t ON f.parent_id=t.id
 WHERE f.deleted_at IS NULL AND f.space_id=? AND t.depth<100
 ) SELECT id,parent_id,name,path,depth FROM tree LIMIT ?`,[rootId,spaceId,spaceId,limit]);
 if(folders.length>=limit)return bad('FOLDER_TOO_LARGE','目录中已有项目过多，请按子目录分批同步',413);
 if(folders.some(f=>f.depth>FOLDER_SYNC_LIMITS.depth))return bad('FOLDER_TOO_DEEP','现有目录深度超过本次安全同步上限，请拆分操作',413);
 const files=await many(db,`WITH RECURSIVE tree(id,depth) AS (
 SELECT id,0 FROM folders WHERE id=? UNION ALL SELECT f.id,t.depth+1 FROM folders f JOIN tree t ON f.parent_id=t.id
 WHERE f.deleted_at IS NULL AND f.space_id=? AND t.depth<100
 ) SELECT f.id,f.folder_id,f.name,f.revision,f.updated_at FROM files f JOIN tree t ON f.folder_id=t.id
 WHERE f.space_id=? AND f.status='ready' AND f.deleted_at IS NULL LIMIT ?`,[rootId,spaceId,spaceId,limit]);
 if(files.length+folders.length>FOLDER_SYNC_LIMITS.existing)return bad('FOLDER_TOO_LARGE','目录中已有项目过多，请按子目录分批同步',413);
 const pathOf=new Map([[rootId,'']]);for(const folder of [...folders].sort((a,b)=>a.depth-b.depth)){
  const base=pathOf.get(folder.parent_id);if(base===undefined)return bad('DIRECTORY_CHANGED','检测到目录结构异常，请刷新',409);
  pathOf.set(folder.id,base?base+'/'+folder.name:folder.name);
 }
 return {folders,files:files.map(f=>({...f,path:[pathOf.get(f.folder_id),f.name].filter(Boolean).join('/')}))};
}
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,'0')).join('');
export async function evaluateFolderSync(db,user,input){
 const manifest=normalizeManifest(input);if(manifest.error)return manifest;
 const {spaceId,parentId,rootName,mode,files,dirs}=manifest;
 const space=await spaceAccess(db,user,spaceId);if(!space||!(parentId?canFolder(await folderAccess(db,user,parentId),'write'):canSpace(space,'write')))return bad('FORBIDDEN','没有根目录写入权限',403);
 if(parentId){const p=await one(db,'SELECT space_id FROM folders WHERE id=? AND deleted_at IS NULL',[parentId]);if(p?.space_id!==spaceId)return bad('PARENT_NOT_FOUND','目标父目录无效',404);}
 let root=await one(db,'SELECT id,name FROM folders WHERE space_id=? AND parent_id IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL',[spaceId,parentId,rootName]);
 if(mode==='new'&&root){
  // One bounded query, not hundreds of individual D1 calls on Workers Free.
  const siblings=await many(db,'SELECT name FROM folders WHERE space_id=? AND parent_id IS ? AND deleted_at IS NULL LIMIT 600',[spaceId,parentId]);
  const names=new Set(siblings.map(x=>fold(x.name)));let candidate=null;
  for(let i=1;i<=600;i++){
   const name=`${rootName} (${i})`;if(!validName(name))return bad('INVALID_NAME','新文件夹名称过长',409);
   if(!names.has(fold(name))){candidate=name;break;}
  }
  if(!candidate)return bad('NAME_CONFLICT','无法自动生成不重复的文件夹名称',409);
  manifest.rootName=candidate;root=null;
 }
 const rootFile=await one(db,"SELECT id FROM files WHERE space_id=? AND folder_id IS ? AND name=? COLLATE NOCASE AND deleted_at IS NULL AND status='ready' LIMIT 1",[spaceId,parentId,manifest.rootName]);
 if(rootFile)return bad('NAME_CONFLICT','目标位置已有同名文件，不能建立同名文件夹',409);
 if(root&&!(canFolder(await folderAccess(db,user,root.id),'read')&&canFolder(await folderAccess(db,user,root.id),'write')))return bad('FORBIDDEN','没有根文件夹管理权限',403);
 const tree=await readTree(db,spaceId,root?.id);if(tree.error)return tree;
 const existingDirs=new Map(tree.folders.map(f=>[pathKey(f.path),f]));const existingFiles=new Map(tree.files.map(f=>[pathKey(f.path),f]));
 const requestedDirs=new Set(dirs.map(pathKey)),requestedFiles=new Set(files.map(f=>pathKey(f.path)));
 for(const dir of dirs)if(existingFiles.has(pathKey(dir)))return bad('PATH_CONFLICT',`文件夹路径与已有文件冲突：${dir}`,409);
 for(const f of files)if(existingDirs.has(pathKey(f.path)))return bad('PATH_CONFLICT',`文件路径与已有文件夹冲突：${f.path}`,409);
 const items=[];
 for(const path of dirs){const hit=existingDirs.get(pathKey(path));items.push({id:uuid(),kind:'folder',action:hit?'reuse':'mkdir',relative_path:path,target_id:hit?.id||null,expected_revision:null});}
 for(const f of files){const hit=existingFiles.get(pathKey(f.path));items.push({id:uuid(),kind:'file',action:hit?'replace':'create',relative_path:f.path,target_id:hit?.id||null,expected_revision:hit?.revision??null,expected_size:f.size_bytes,expected_mime:f.mime_type});}
 // Only delete extra roots; their descendants are safely handled by trashItem.
 if(mode==='mirror'){
  const extraDirs=tree.folders.filter(f=>!requestedDirs.has(pathKey(f.path))).sort((a,b)=>a.depth-b.depth);
  const delFolders=[];
  for(const f of extraDirs){if(delFolders.some(x=>pathKey(f.path).startsWith(pathKey(x.path)+'/')))continue;delFolders.push(f);}
  for(const f of tree.files){if(!requestedFiles.has(pathKey(f.path))&&!delFolders.some(d=>pathKey(f.path).startsWith(pathKey(d.path)+'/')))items.push({id:uuid(),kind:'delete_file',action:'trash',relative_path:f.path,target_id:f.id,expected_revision:f.revision});}
  for(const f of delFolders){
   const key=pathKey(f.path)+'/';
   const count=tree.folders.filter(x=>x.id===f.id||pathKey(x.path).startsWith(key)).length+
    tree.files.filter(x=>pathKey(x.path).startsWith(key)).length;
   if(count>200)return bad('MIRROR_SUBTREE_TOO_LARGE','某个待删除子文件夹包含超过 200 项，请先单独整理该子目录',413);
   items.push({id:uuid(),kind:'delete_folder',action:'trash',relative_path:f.path,target_id:f.id,expected_revision:null});
  }
 }
 if(items.length>FOLDER_SYNC_LIMITS.total)return bad('PLAN_LIMIT','变更总数过多，请按子目录分批同步',413);
 // A single bounded ACL lookup checks all existing folders; upload and mirror
 // later re-check the same permissions immediately before each mutation.
 const existingParentIds=new Set([root?.id,parentId,...tree.folders.map(f=>f.id)].filter(Boolean));
 const rights=await folderAccessBatch(db,user,[...existingParentIds]);
 const can=(id,action)=>id?canFolder(rights.get(id),action):canSpace(space,action);
 const pathToId=new Map([['',root?.id||null],...tree.folders.map(f=>[pathKey(f.path),f.id])]);
 for(const item of items){
  let parentKey=pathKey(parentPath(item.relative_path));
  while(parentKey&&!pathToId.has(parentKey))parentKey=pathKey(parentPath(parentKey));
  const parent=pathToId.get(parentKey)??root?.id??parentId;
  if(item.action==='reuse'){if(!can(item.target_id,'read'))return bad('FORBIDDEN','无法查看部分现有子目录',403);continue;}
  if(item.action==='mkdir'||item.action==='create'||item.action==='replace'){
   if(!can(parent,'write'))return bad('FORBIDDEN','没有子目录写入权限',403);
  }else if(item.action==='trash'){
   if(!can(parent,'delete')||(item.kind==='delete_folder'&&!can(item.target_id,'delete')))return bad('FORBIDDEN','镜像模式包含无权删除的目录或文件',403);
  }
 }
 const snapshot=[...tree.folders.map(f=>({kind:'folder',id:f.id,path:f.path})),...tree.files.map(f=>({kind:'file',id:f.id,path:f.path,revision:f.revision}))].sort((a,b)=>a.kind.localeCompare(b.kind)||a.path.localeCompare(b.path));
 const identity={spaceId,parentId,rootName:manifest.rootName,mode,rootId:root?.id||null,files:manifest.files,dirs, snapshot};
 const planHash=await sha(JSON.stringify(identity));
 return {manifest,rootId:root?.id||null,rootName:manifest.rootName,items,snapshot,planHash,counts:{new_files:items.filter(x=>x.action==='create').length,replaced_files:items.filter(x=>x.action==='replace').length,new_folders:items.filter(x=>x.action==='mkdir').length+(root?0:1),removed_files:items.filter(x=>x.kind==='delete_file').length,removed_folders:items.filter(x=>x.kind==='delete_folder').length},mode,spaceId,parentId};
}
export async function createFolderSyncJob(db,user,input){
 const plan=await evaluateFolderSync(db,user,input);if(plan.error)return plan;
 if(typeof input.plan_hash!=='string'||input.plan_hash!==plan.planHash)return bad('PLAN_CHANGED','目录内容或上传清单发生变化，请重新预览',409);
 if(plan.mode==='mirror'&&input.confirm_mirror!==true)return bad('MIRROR_CONFIRM_REQUIRED','镜像替换必须明确确认删除预览',409);
 const rootId=plan.rootId||uuid(),jobId=uuid();
 const statements=[];
 if(!plan.rootId)statements.push(db.prepare('INSERT INTO folders(id,space_id,parent_id,name) VALUES(?,?,?,?)').bind(rootId,plan.spaceId,plan.parentId,plan.rootName));
 statements.push(db.prepare(`INSERT INTO folder_sync_jobs(id,user_id,space_id,parent_folder_id,root_folder_id,root_name,mode,plan_hash,snapshot_json)
 VALUES(?,?,?,?,?,?,?,?,?)`).bind(jobId,user.id,plan.spaceId,plan.parentId,rootId,plan.rootName,plan.mode,plan.planHash,JSON.stringify(plan.snapshot)));
 const items=plan.items.map(x=>({...x,job_id:jobId}));
 if(items.length)statements.push(db.prepare(`INSERT INTO folder_sync_items
 (id,job_id,kind,action,relative_path,target_id,expected_revision,expected_size,expected_mime) SELECT
 json_extract(value,'$.id'),json_extract(value,'$.job_id'),json_extract(value,'$.kind'),json_extract(value,'$.action'),
 json_extract(value,'$.relative_path'),json_extract(value,'$.target_id'),json_extract(value,'$.expected_revision'),
 json_extract(value,'$.expected_size'),json_extract(value,'$.expected_mime') FROM json_each(?)`).bind(JSON.stringify(items)));
 try{await db.batch(statements);}
 catch(e){if(/UNIQUE constraint failed/i.test(String(e?.cause?.message||e?.message||'')))return bad('PLAN_CHANGED','其他用户已创建同名目录，请重新预览',409);throw e;}
 return {job_id:jobId,root_folder_id:rootId,root_name:plan.rootName,mode:plan.mode,counts:plan.counts,status:'running'};
}
export async function folderSyncJob(db,user,id){
 const job=await one(db,'SELECT * FROM folder_sync_jobs WHERE id=? AND user_id=?',[id,user.id]);if(!job)return null;
 const space=await spaceAccess(db,user,job.space_id);if(!space)return null;
 const root=job.root_folder_id?await folderAccess(db,user,job.root_folder_id):null;
 if(!root||!canFolder(root,'write'))return null;
 const items=await many(db,'SELECT id,kind,action,relative_path,target_id,expected_revision,result_id,result_revision,expected_size,expected_mime,status,error_code FROM folder_sync_items WHERE job_id=? ORDER BY CASE WHEN kind=\'folder\' THEN 0 WHEN kind=\'file\' THEN 1 ELSE 2 END,LENGTH(relative_path),relative_path',[id]);
 const pending=items.filter(i=>i.status!=='done'),deletions=items.filter(i=>i.action==='trash');
 return {id:job.id,space_id:job.space_id,root_folder_id:job.root_folder_id,root_name:job.root_name,mode:job.mode,status:job.status,expires_at:job.expires_at,items,counts:{total:items.length,completed:items.length-pending.length,pending:pending.length,deletions:deletions.length},_job:job};
}
function stale(job){return Date.parse(job.expires_at.replace(' ','T')+'Z')<=Date.now();}
async function resolvePath(db,job,path){
 let id=job.root_folder_id;for(const name of parentPath(path).split('/').filter(Boolean)){
  const folder=await one(db,'SELECT id FROM folders WHERE space_id=? AND parent_id=? AND name=? COLLATE NOCASE AND deleted_at IS NULL',[job.space_id,id,name]);
  if(!folder)return null;id=folder.id;
 }
 return id;
}
export async function acknowledgeFolderItem(db,user,job,itemId,body){
 if(job.status!=='running'||stale(job))return bad('JOB_INACTIVE','任务已结束或过期',409);
 const item=await one(db,'SELECT * FROM folder_sync_items WHERE job_id=? AND id=?',[job.id,itemId]);
 if(!item||item.action==='trash')return bad('ITEM_NOT_FOUND','任务项目不存在',404);
 if(item.status==='done')return {id:item.id,status:'done',result_id:item.result_id};
 const parent=await resolvePath(db,job,item.relative_path);if(!parent)return bad('PARENT_MISSING','上级目录不存在，请先完成目录创建',409);
 const name=baseName(item.relative_path),table=item.kind==='folder'?'folders':'files',col=item.kind==='folder'?'parent_id':'folder_id';
 const found=await one(db,`SELECT * FROM ${table} WHERE space_id=? AND ${col}=? AND name=? COLLATE NOCASE AND deleted_at IS NULL${item.kind==='file'?" AND status='ready'":''}`,[job.space_id,parent,name]);
 if(!found||found.id!==body?.result_id)return bad('ITEM_MISMATCH','上传结果与目标目录不一致',409);
 const mask=await folderAccess(db,user,parent);if(!canFolder(mask,item.action==='reuse'?'read':'write'))return bad('FORBIDDEN','目录访问权限已撤销',403);
 if(item.action==='reuse'&&!canFolder(await folderAccess(db,user,found.id),'read'))return bad('FORBIDDEN','子目录访问权限已撤销',403);
 if(item.kind==='file'&&(found.size_bytes!==item.expected_size||found.mime_type!==item.expected_mime))return bad('CONTENT_MISMATCH','文件大小或内容类型与同步清单不符',409);
 if(body.result_revision!==undefined&&item.kind==='file'&&body.result_revision!==found.revision)return bad('ITEM_STALE','上传版本与当前版本不一致',409);
 if(item.action==='reuse'&&item.target_id!==found.id||item.action==='replace'&&(item.target_id!==found.id||found.revision!==item.expected_revision+1)||
  item.action==='create'&&(found.revision!==1||found.created_by!==user.id)||item.action==='mkdir'&&item.target_id)return bad('ITEM_STALE','文件或目录已被其他操作修改，请重新建立同步任务',409);
 const rev=item.kind==='file'?found.revision:null;
 const r=await execute(db,"UPDATE folder_sync_items SET status='done',result_id=?,result_revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND job_id=? AND status='pending'",[found.id,rev,item.id,job.id]);
 if(!r.meta?.changes)return bad('BUSY','正在记录该项目的处理结果',409);
 return {id:item.id,status:'done',result_id:found.id,result_revision:rev};
}

async function mirrorSnapshotValid(db,job,items){
 const snapshot=JSON.parse(job.snapshot_json);const tree=await readTree(db,job.space_id,job.root_folder_id);if(tree.error)return false;
 const actual=[...tree.folders.map(f=>({kind:'folder',id:f.id,path:f.path,revision:null})),...tree.files.map(f=>({kind:'file',id:f.id,path:f.path,revision:f.revision}))];
 const expected=[...snapshot.map(x=>({...x,revision:x.revision??null})),...items.filter(x=>['create','mkdir'].includes(x.action)&&x.status==='done').map(x=>({kind:x.kind,id:x.result_id,path:x.relative_path,revision:x.kind==='file'?x.result_revision:null}))];
 const updates=new Map(items.filter(x=>x.action==='replace'&&x.status==='done').map(x=>[x.target_id,x.result_revision]));
 for(const e of expected)if(e.kind==='file'&&updates.has(e.id))e.revision=updates.get(e.id);
 const k=x=>`${x.kind}:${pathKey(x.path)}`;const byKey=new Map(expected.map(x=>[k(x),x]));
 if(actual.length!==expected.length||byKey.size!==expected.length)return false;
 return actual.every(x=>{const y=byKey.get(k(x));return y?.id===x.id&&(x.kind==='folder'||y.revision===x.revision)});
}
export async function finishFolderSync(env,user,job){
 const lease=uuid();
 const lock=await execute(dbFromEnv(env),`UPDATE folder_sync_jobs SET lease_token=?,lease_until=datetime('now','+45 seconds')
 WHERE id=? AND status IN ('running','deleting','failed') AND (lease_token IS NULL OR lease_until<CURRENT_TIMESTAMP)`,[lease,job.id]);
 if(!lock.meta?.changes){const current=await folderSyncJob(dbFromEnv(env),user,job.id);return current?.status==='completed'?{status:'completed'}:bad('JOB_BUSY','另一个请求正在提交，请刷新任务状态',409);}
 try{return await finishFolderSyncLeased(env,user,job);}finally{
  await execute(dbFromEnv(env),'UPDATE folder_sync_jobs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?',[job.id,lease]).catch(e=>console.error('Folder sync lease release deferred',e));
 }
}
async function finishFolderSyncLeased(env,user,job){
 const db=dbFromEnv(env),current=await folderSyncJob(db,user,job.id);
 if(!current)return bad('NOT_FOUND','同步任务不存在',404);
 const j=current._job,items=current.items;
 if(j.status==='completed')return {status:'completed',...current.counts};
 if(!['running','deleting','failed'].includes(j.status)||stale(j))return bad('JOB_INACTIVE','任务已取消或过期',409);
 if(items.some(x=>x.action!=='trash'&&x.status!=='done'))return bad('UPLOADS_PENDING','还有文件或目录尚未成功处理，禁止镜像删除',409);
 if(j.status==='running'&&j.mode==='mirror'&&!(await mirrorSnapshotValid(db,j,items)))return bad('MIRROR_STALE','目录在同步期间发生其他变更，已阻止旧项目删除，请重新规划',409);
 if(j.mode!=='mirror'||!items.some(x=>x.action==='trash'&&x.status!=='done')){
  await execute(db,"UPDATE folder_sync_jobs SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('running','deleting','failed')",[j.id]);return {status:'completed',...current.counts};
 }
 await execute(db,"UPDATE folder_sync_jobs SET status='deleting',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('running','deleting','failed')",[j.id]);
 // Exactly one destructive action per HTTP request: short and resumable.
 const next=items.find(x=>x.action==='trash'&&x.status!=='done');
 const parent=await resolvePath(db,j,next.relative_path);
 const table=next.kind==='delete_file'?'files':'folders',col=next.kind==='delete_file'?'folder_id':'parent_id';
 const target=await one(db,`SELECT id,${next.kind==='delete_file'?'revision':'name'} FROM ${table} WHERE id=? AND space_id=? AND ${col}=? AND name=? COLLATE NOCASE AND deleted_at IS NULL${next.kind==='delete_file'?" AND status='ready'":''}`,[next.target_id,j.space_id,parent,baseName(next.relative_path)]);
 if(!target){
  // D1 may have committed trashItem before the HTTP response was lost.
  const prior=await one(db,`SELECT t.id FROM trash_entries t WHERE t.target_type=? AND t.target_id=?
    AND t.deleted_by=? AND t.deleted_at>=? LIMIT 1`,[next.kind==='delete_file'?'file':'folder',next.target_id,user.id,j.created_at]);
  if(!prior)return bad('MIRROR_STALE','待删除对象被其他操作改变，已停止清理',409);
  await execute(db,"UPDATE folder_sync_items SET status='done',error_code=NULL WHERE id=? AND job_id=?",[next.id,j.id]);
  const remaining=items.filter(x=>x.action==='trash'&&x.status!=='done').length-1;
  if(!remaining)await execute(db,"UPDATE folder_sync_jobs SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=?",[j.id]);
  return {status:remaining?'deleting':'completed',recovered_previous_delete:true,remaining};
 }
 if(next.kind==='delete_file'&&target.revision!==next.expected_revision)return bad('MIRROR_STALE','待删除文件版本发生变化，已停止清理',409);
 const result=await trashItem(env,user,next.kind==='delete_file'?'file':'folder',next.target_id);
 if(result.status!==200){const body=await result.json().catch(()=>({}));await execute(db,"UPDATE folder_sync_items SET status='failed',error_code=? WHERE id=?",[body.error?.code||'TRASH_FAILED',next.id]);await execute(db,"UPDATE folder_sync_jobs SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?",[j.id]);return bad(body.error?.code||'TRASH_FAILED','镜像清理未完成，可保留任务后重试',result.status);}
 await execute(db,"UPDATE folder_sync_items SET status='done',error_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",[next.id]);
 const pending=items.filter(x=>x.action==='trash'&&x.status!=='done').length-1;
 if(pending===0){await execute(db,"UPDATE folder_sync_jobs SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=?",[j.id]);return {status:'completed',deleted:1,remaining:0};}
 return {status:'deleting',deleted:1,remaining:pending};
}
export async function cancelFolderSync(db,user,job){if(!['running','failed'].includes(job.status))return bad('JOB_INACTIVE','任务正在删除或已结束，不能取消',409);await execute(db,"UPDATE folder_sync_jobs SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?",[job.id,user.id]);return {status:'cancelled',message:'已停止后续同步；已经完成的上传不会被自动回滚'};}
export async function pruneFolderSync(db,{limit=20}={}){
 const n=Math.max(1,Math.min(30,limit));
 const expired=await execute(db,"UPDATE folder_sync_jobs SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE status='running' AND expires_at<CURRENT_TIMESTAMP AND id IN (SELECT id FROM folder_sync_jobs WHERE status='running' AND expires_at<CURRENT_TIMESTAMP LIMIT ?)",[n]);
 const stale=await many(db,"SELECT id FROM folder_sync_jobs WHERE status IN ('completed','cancelled') AND updated_at<datetime('now','-30 days') LIMIT ?",[n]);
 if(stale.length)await execute(db,`DELETE FROM folder_sync_jobs WHERE id IN (${stale.map(()=>'?').join(',')})`,stale.map(x=>x.id));
 return {expired:expired.meta?.changes||0,history_removed:stale.length};
}
