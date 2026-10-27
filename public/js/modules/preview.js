// Stage 8 — dependency-free Bootstrap modal file preview.
export const SUPPORTED_PREVIEW_MIME = new Set(['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf']);
export function canPreview(file){return SUPPORTED_PREVIEW_MIME.has(String(file?.mime_type||'').toLowerCase());}
export function previewUrl(id){if(!/^[0-9a-f-]{36}$/.test(id))throw Error('无效文件 ID');return `/api/v1/files/${encodeURIComponent(id)}/preview`;}
let active=null;
export function openPreview(file,files=[],{onError=console.error,urlOverride=null}={}){
 if(!canPreview(file)){onError('该文件类型不支持在线预览');return;}
 if(active)active.close();
 const shell=document.createElement('div');shell.className='cd-preview-backdrop';shell.setAttribute('role','dialog');shell.setAttribute('aria-modal','true');shell.setAttribute('aria-label','文件预览');
 const modal=document.createElement('section');modal.className='cd-preview-window';shell.append(modal);
 const header=document.createElement('header');header.className='cd-preview-header';
 const name=document.createElement('span');name.className='text-truncate fw-semibold';name.textContent=file.name;
 const controls=document.createElement('div');controls.className='d-flex gap-2 flex-shrink-0';
 const btn=(label,handler)=>{const b=document.createElement('button');b.type='button';b.className='btn btn-sm btn-outline-light';b.textContent=label;b.addEventListener('click',handler);return b;};
 const stage=document.createElement('div');stage.className='cd-preview-stage';
 const hint=document.createElement('div');hint.className='cd-preview-hint';hint.setAttribute('role','status');
 const close=()=>{document.removeEventListener('keydown',keydown);shell.remove();active=null;};
 let current=file,scale=1,rotation=0;
 const images=files.filter(f=>String(f.mime_type).startsWith('image/')&&canPreview(f));
 function render(){stage.replaceChildren();name.textContent=current.name;const url=urlOverride||previewUrl(current.id);scale=1;rotation=0;hint.textContent='';
  if(current.mime_type.startsWith('image/')){const img=document.createElement('img');img.className='cd-preview-image';img.alt=current.name;img.src=url;img.onerror=()=>{hint.textContent='预览加载失败，请检查文件内容或访问权限';};stage.append(img);}
  else if(current.mime_type.startsWith('video/')){const video=document.createElement('video');video.controls=true;video.preload='metadata';video.playsInline=true;video.src=url;video.addEventListener('error',()=>{hint.textContent='视频无法播放，可能是浏览器不支持该编码或文件不可用';});stage.append(video);}
  else if(current.mime_type==='application/pdf'){const frame=document.createElement('iframe');frame.title=`预览 ${current.name}`;frame.src=url;stage.append(frame);}
  updateControls();
 }
 function updateControls(){controls.replaceChildren();if(current.mime_type.startsWith('image/')){
  const pic=stage.querySelector('img');const apply=()=>{pic.style.transform=`scale(${scale}) rotate(${rotation}deg)`;};
  controls.append(btn('−',()=>{scale=Math.max(.25,scale-.25);apply()}),btn('+',()=>{scale=Math.min(5,scale+.25);apply()}),btn('旋转',()=>{rotation=(rotation+90)%360;apply()}));
  if(images.length>1){controls.append(btn('上一张',()=>advance(-1)),btn('下一张',()=>advance(1)));}
 }controls.append(btn('关闭',close));}
 function advance(delta){const idx=images.findIndex(f=>f.id===current.id);if(idx<0)return;current=images[(idx+delta+images.length)%images.length];render();}
 function keydown(e){if(e.key==='Escape'){e.preventDefault();close();}else if(current.mime_type.startsWith('image/')&&e.key==='ArrowLeft')advance(-1);else if(current.mime_type.startsWith('image/')&&e.key==='ArrowRight')advance(1);}
 header.append(name,controls);modal.append(header,stage,hint);document.body.append(shell);document.addEventListener('keydown',keydown);
 shell.addEventListener('click',e=>{if(e.target===shell)close()});active={close};render();controls.querySelector('button:last-child')?.focus();
}
