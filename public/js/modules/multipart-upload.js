// Browser-side multipart manager. No framework or build step.
const MiB=1048576;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const keyFor=(space,folder,file)=>`cd-upload:${space}:${folder||'root'}:${file.name}:${file.size}:${file.lastModified}`;
function readTask(key){try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}}
function writeTask(key,task){localStorage.setItem(key,JSON.stringify(task))}
async function api(path,options={}){const r=await fetch(path,{credentials:'same-origin',...options});const j=await r.json().catch(()=>({}));if(!r.ok||!j.success)throw Error(j.error?.message||`HTTP ${r.status}`);return j.data}
export function multipartUploadWidget(host,{space,folder,onFinished,onMessage}){
 const box=document.createElement('section');box.className='card p-3 mt-3';
 const title=document.createElement('strong');title.textContent='大文件上传';const progress=document.createElement('progress');progress.className='w-100 mt-2';progress.max=100;progress.value=0;
 const status=document.createElement('div');status.className='small text-muted mt-2';status.textContent='选择文件后开始上传；刷新页面后需重新选择相同文件续传。';
 const pause=document.createElement('button');pause.className='btn btn-outline-secondary btn-sm me-2';pause.textContent='暂停';pause.disabled=true;
 const resume=document.createElement('button');resume.className='btn btn-outline-primary btn-sm me-2';resume.textContent='继续';resume.disabled=true;
 const cancel=document.createElement('button');cancel.className='btn btn-outline-danger btn-sm';cancel.textContent='取消';cancel.disabled=true;
 const controls=document.createElement('div');controls.className='mt-2';controls.append(pause,resume,cancel);box.append(title,progress,status,controls);host.append(box);
 let state=null,paused=false,cancelled=false,controller=null,working=false;
 const show=(done,total,txt)=>{progress.value=Math.round(done/total*100);status.textContent=`${txt} · ${Math.round(done/MiB)} / ${Math.round(total/MiB)} MiB (${progress.value}%)`};
 pause.onclick=()=>{paused=true;pause.disabled=true;resume.disabled=false;status.textContent='暂停请求中；已完成的分片会保留。';controller?.abort()};
 resume.onclick=()=>{if(!state||working)return;paused=false;resume.disabled=true;pause.disabled=false;run()};
 cancel.onclick=async()=>{cancelled=true;paused=true;controller?.abort();if(state){try{await api(`/api/v1/uploads/${state.id}`,{method:'DELETE'})}catch(e){onMessage(`取消任务失败：${e.message}`)}localStorage.removeItem(state.key)}state=null;pause.disabled=resume.disabled=cancel.disabled=true;status.textContent='已取消上传任务'};
 async function send(number){const {file,partSize,id}=state;const offset=(number-1)*partSize,end=Math.min(offset+partSize,file.size);for(let attempt=0;attempt<3;attempt++){
  if(paused||cancelled)throw Error('paused');controller=new AbortController();try{
   await api(`/api/v1/uploads/${id}/parts/${number}`,{method:'PUT',body:file.slice(offset,end),signal:controller.signal});return;
  }catch(e){if(paused||cancelled)throw e;if(attempt===2)throw e;await sleep(500*2**attempt)}
 }}
 async function run(){if(working||!state)return;working=true;pause.disabled=false;cancel.disabled=false;resume.disabled=true;
  try{let s=await api(`/api/v1/uploads/${state.id}`);
   if(s.status==='failed'||s.status==='verifying'){
    status.textContent='检测到合并中断，正在安全核对 R2 状态…';
    const recovered=await api(`/api/v1/uploads/${state.id}/recover`,{method:'POST'});
    if(recovered.status==='completed'){
     localStorage.removeItem(state.key);show(state.file.size,state.file.size,'上传恢复完成');
     pause.disabled=resume.disabled=cancel.disabled=true;state=null;onFinished?.();return;
    }
    throw Error('合并仍未恢复，请稍后重试（不要重新上传整个文件）');
   }
   if(s.status==='completed'){
    localStorage.removeItem(state.key);show(state.file.size,state.file.size,'已上传完成');
    pause.disabled=resume.disabled=cancel.disabled=true;state=null;onFinished?.();return;
   }
   if(s.status!=='uploading')throw Error(`任务状态：${s.status}`);
   const completed=new Set(s.parts.map(p=>p.part_number));const total=Math.ceil(state.file.size/state.partSize);
   show(s.parts.reduce((sum,p)=>sum+p.size_bytes,0),state.file.size,'上传中');
   const jobs=Array.from({length:total},(_,i)=>i+1).filter(n=>!completed.has(n));let cursor=0;let failed=null;
   async function worker(){while(!paused&&!cancelled&&!failed){const index=cursor++;if(index>=jobs.length)return;const n=jobs[index];try{await send(n);completed.add(n);const done=[...completed].reduce((sum,num)=>sum+Math.min(state.partSize,state.file.size-(num-1)*state.partSize),0);show(done,state.file.size,'上传中')}catch(e){if(!paused&&!cancelled)failed=e;return}}}
   await Promise.all(Array.from({length:Math.min(3,jobs.length)},worker));
   if(failed)throw failed;if(paused||cancelled){status.textContent='已暂停，可继续';return}
   status.textContent='分片已上传，正在合并…';await api(`/api/v1/uploads/${state.id}/complete`,{method:'POST'});
   localStorage.removeItem(state.key);show(state.file.size,state.file.size,'上传完成');pause.disabled=resume.disabled=cancel.disabled=true;state=null;onFinished?.();
  }catch(e){if(!paused&&!cancelled){status.textContent=`上传中断：${e.message}；点击继续重试`;resume.disabled=false;pause.disabled=true;onMessage?.(e.message)}}finally{working=false;if(paused&&!cancelled)resume.disabled=false}
 }
 async function start(file,spaceId,folderId){if(state&&working)throw Error('已有进行中的分片任务');
  const key=keyFor(spaceId,folderId,file);let previous=readTask(key);let id,partSize;
  if(previous){
   try{
    const s=await api(`/api/v1/uploads/${previous.id}`);
    if(s.total_bytes!==file.size)throw Error('文件与上次上传任务不匹配');
    if(s.status==='completed'){localStorage.removeItem(key);onFinished?.();return;}
    if(s.status==='aborted'){localStorage.removeItem(key);previous=null;}
    else if(['uploading','failed','verifying'].includes(s.status)){id=previous.id;partSize=s.part_size;}
    else throw Error(`需管理员确认的上传状态：${s.status}`);
   }catch(e){
    if(/任务不存在|HTTP 404/.test(e.message)){localStorage.removeItem(key);previous=null;}
    else throw e; // Do NOT silently start another large upload after a failed completion.
   }
  }
  if(!previous){const s=await api('/api/v1/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,space_id:spaceId,folder_id:folderId,size_bytes:file.size,mime_type:file.type||'application/octet-stream'})});id=s.upload_id;partSize=s.part_size;writeTask(key,{id})}
  state={key,id,partSize,file};paused=false;cancelled=false;await run();
 }
 return {start,dispose(){controller?.abort();box.remove()}};
}
