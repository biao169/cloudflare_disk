// RC13.3 folder synchronization orchestrator. Uploads use the existing file/
// multipart endpoints, and server-side journal verifies each committed result.
import {chooseFolderSyncPlan} from '../components/folder-sync-dialog.js';
import {requestJSON} from '../api.js';
import {safeUploadPath} from '../components/drag-upload.js';
const BOUND=150;
const keyOf=x=>x.normalize('NFC').toLowerCase();
const prefix=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
const basename=p=>p.split('/').at(-1);
const localKey=(space,parent,root)=>`cd-folder-sync:${space}:${parent||'root'}:${keyOf(root)}`;
const fingerprint=entries=>JSON.stringify(entries.map(e=>[e.path,e.file?.size??null,e.file?.lastModified??null,e.kind||'file']).sort((a,b)=>a[0].localeCompare(b[0])));
export function groupFolderEntries(entries){
 const groups=new Map(),loose=[];
 for(const e of entries){if(!safeUploadPath(e.path))throw Error(`不允许的文件路径：${e.path}`);
  const parts=e.path.replaceAll('\\','/').split('/');
  if(parts.length===1&&(e.kind!=='folder')){loose.push(e);continue;}
  const root=parts[0];if(!groups.has(keyOf(root)))groups.set(keyOf(root),{root,entries:[]});groups.get(keyOf(root)).entries.push(e);
 }
 return {groups:[...groups.values()],loose};
}
export function folderSyncClient({space,folder,smallUpload,multipart,onNotice,onFinished,progress}){
 async function sync(group){
  const spaceId=space(),parentId=folder();if(!spaceId)throw Error('请先选择一个有权限的空间');
  const root=group.root,entries=group.entries;
  const files=entries.filter(e=>e.file&&e.kind!=='folder').map(e=>({...e,relative:e.path.split('/').slice(1).join('/')}));
  const dirs=entries.filter(e=>e.kind==='folder').map(e=>e.path.split('/').slice(1).join('/')).filter(Boolean);
  const fileManifest=files.map(e=>({path:e.relative,size_bytes:e.file.size,mime_type:e.file.type||'application/octet-stream'}));
  if(files.length>BOUND)throw Error('单个文件夹同步最多 150 个文件，请分批操作');
  const manifest={space_id:spaceId,parent_folder_id:parentId,root_name:root,files:fileManifest,directories:dirs,empty_root:!fileManifest.length&&!dirs.length};
  const storage=localKey(spaceId,parentId,root),fp=fingerprint(entries);let job=null;
  try{const old=JSON.parse(localStorage.getItem(storage)||'null');if(old?.fingerprint===fp){
   const existing=await requestJSON(`/api/v1/folder-sync/jobs/${old.id}`);
   if(['running','deleting','failed'].includes(existing.status)&&Date.parse(existing.expires_at.replace(' ','T')+'Z')>Date.now()){
    job=existing;onNotice?.('检测到未完成的文件夹同步任务，继续上次操作。','info');
   }else localStorage.removeItem(storage);
  }}catch{localStorage.removeItem(storage)}
  if(!job){const selected=await chooseFolderSyncPlan({rootName:root,plan:mode=>requestJSON('/api/v1/folder-sync/plan',{method:'POST',body:{...manifest,mode}})});
   if(!selected)return {cancelled:true};
   const created=await requestJSON('/api/v1/folder-sync/jobs',{method:'POST',body:{...manifest,mode:selected.mode,plan_hash:selected.plan.plan_hash,confirm_mirror:selected.confirm_mirror}});
   localStorage.setItem(storage,JSON.stringify({id:created.job_id,fingerprint:fp}));
   job=await requestJSON(`/api/v1/folder-sync/jobs/${created.job_id}`);
  }
  const fileByPath=new Map(files.map(e=>[keyOf(e.relative),e.file]));
  const itemTotal=job.items.length;progress.start(`文件夹${job.mode==='mirror'?'镜像替换':job.mode==='new'?'新建上传':'合并更新'}：${job.root_name}`,itemTotal);
  const allFolders=new Map([['',job.root_folder_id]]);
  for(const old of job.items.filter(i=>i.action==='trash'&&i.status==='done'))progress.item({success:true,name:old.relative_path});
  const folderItems=job.items.filter(i=>i.kind==='folder').sort((a,b)=>a.relative_path.split('/').length-b.relative_path.split('/').length);
  for(const item of folderItems)if(item.status==='done'||item.action==='reuse')allFolders.set(keyOf(item.relative_path),item.result_id||item.target_id);
  // A resumed job may have pending directories whose parent was already created.
  for(const item of folderItems){if(progress.stopped)break;
   if(item.status==='done'){progress.item({success:true,name:item.relative_path});continue}
   try{
    const rel=keyOf(item.relative_path),parent=allFolders.get(keyOf(prefix(item.relative_path)));
    if(!parent)throw Error('上级目录尚未创建');
    let id=item.target_id;
    if(item.action==='mkdir'){
     try{id=(await requestJSON('/api/v1/folders',{method:'POST',body:{space_id:spaceId,parent_id:parent,name:basename(item.relative_path)}})).id}
     catch(e){if(e.code!=='NAME_CONFLICT')throw e;
      const list=await requestJSON(`/api/v1/spaces/${spaceId}/folders?parent_id=${encodeURIComponent(parent)}&limit=100`);
      id=list.items?.find(f=>keyOf(f.name)===keyOf(basename(item.relative_path)))?.id;
      if(!id)throw Error('目录已发生冲突，请重试任务');
     }
    }
    const ack=await requestJSON(`/api/v1/folder-sync/jobs/${job.id}/items/${item.id}/ack`,{method:'POST',body:{result_id:id}});
    allFolders.set(rel,ack.result_id);progress.item({success:true,name:item.relative_path});
   }catch(e){progress.item({success:false,name:item.relative_path,message:e.message});onNotice?.('同步暂未完成，重新选择相同文件夹可以续跑。','warning');return {pending:true};}
  }
  async function findAlreadyUploaded(item,dir){
   // If the browser finished an upload but lost its ACK, an authenticated
   // server-side journal check can reattach that file without duplicating it.
   for(let offset=0;offset<400;offset+=100){
    const q=new URLSearchParams({limit:'100',offset:String(offset)});if(dir)q.set('parent_id',dir);
    const page=await requestJSON(`/api/v1/spaces/${spaceId}/contents?${q}`);
    const found=(page.files||[]).find(f=>keyOf(f.name)===keyOf(basename(item.relative_path)));
    if(found){
     if(item.action==='replace'&&found.id!==item.target_id)throw Error('替换目标已更换，需要重新规划');
     if(item.action==='replace'){
      const latest=await requestJSON(`/api/v1/files/${found.id}/replacement-target`);
      if(latest.revision!==item.expected_revision+1)return null;
     }
     const ack=await requestJSON(`/api/v1/folder-sync/jobs/${job.id}/items/${item.id}/ack`,{method:'POST',body:{result_id:found.id}});
     return ack;
    }
    if(!page.has_more)break;
   }
   return null;
  }
  for(const item of job.items.filter(i=>i.kind==='file')){if(progress.stopped)break;
   if(item.status==='done'){progress.item({success:true,name:item.relative_path});continue}
   const file=fileByPath.get(keyOf(item.relative_path));if(!file){progress.item({success:false,name:item.relative_path,message:'重新选择的本地文件不完整'});return {pending:true}}
   const dir=allFolders.get(keyOf(prefix(item.relative_path)));if(!dir){progress.item({success:false,name:item.relative_path,message:'目标文件夹不存在'});return {pending:true}}
   try{
    const recovered=await findAlreadyUploaded(item,dir);
    if(recovered){progress.item({success:true,name:item.relative_path});continue;}
    const replace=item.action==='replace'?{id:item.target_id,revision:item.expected_revision}:null;
    let uploaded;
    if(file.size>8*1024*1024)uploaded=await multipart(file,spaceId,dir,replace);
    else uploaded=await smallUpload(file,dir,(done,total)=>progress.itemProgress(done,total),spaceId,replace);
    const fileId=uploaded?.file_id||uploaded?.id;if(!fileId)throw Error('上传未确认完成，请重新选择此文件夹恢复');
    await requestJSON(`/api/v1/folder-sync/jobs/${job.id}/items/${item.id}/ack`,{method:'POST',body:{result_id:fileId,...(uploaded.revision?{result_revision:uploaded.revision}:{})}});
    progress.item({success:true,name:item.relative_path});
   }catch(e){progress.item({success:false,name:item.relative_path,message:e.message});onNotice?.('上传中断，旧文件暂不删除；重新选择相同文件夹可恢复。','warning');return {pending:true};}
  }
  if(progress.stopped){onNotice?.('已暂停后续步骤；重新选择该文件夹可以继续。','warning');return {pending:true}}
  let attempts=0;
  while(attempts++<430&&!progress.stopped){
   const before=await requestJSON(`/api/v1/folder-sync/jobs/${job.id}`);
   if(before.status==='completed')break;
   let final;
   try{final=await requestJSON(`/api/v1/folder-sync/jobs/${job.id}/finish`,{method:'POST'});}catch(e){onNotice?.(`同步未完成：${e.message}。可重新选择相同文件夹续跑。`,'warning');return {pending:true}}
   if(final.deleted||final.recovered_previous_delete)progress.item({success:true,name:'移入回收站'});
   if(final.status==='completed')break;
  }
  const result=await requestJSON(`/api/v1/folder-sync/jobs/${job.id}`);
  if(result.status==='completed'){
   localStorage.removeItem(storage);progress.finish();onFinished?.();return {completed:true,job_id:job.id};
  }
  onNotice?.('同步任务未完成，请重新选择相同文件夹继续。','warning');return {pending:true};
 }
 return {sync};
}
