// Browser-native, build-free conflict dialog. The caller owns the upload sequence.
export function chooseUploadConflict(name,existing){
 return new Promise(resolve=>{
  const overlay=document.createElement('div');overlay.className='modal d-block';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.style.background='rgba(0,0,0,.45)';overlay.style.zIndex='2500';
  const dialog=document.createElement('div');dialog.className='modal-dialog modal-dialog-centered';
  const content=document.createElement('div');content.className='modal-content p-3';
  const heading=document.createElement('h2');heading.className='h5';heading.textContent='检测到同名文件';
  const description=document.createElement('p');description.className='small text-secondary';description.textContent=`“${name}” 已存在（修订 ${existing.revision||1}）。覆盖会保留文件 ID 和现有私密分享链接，新文件将成为最新版本。`;
  const group=document.createElement('div');group.className='d-grid gap-2';
  const buttons=[['replace','覆盖现有文件（保留分享）','btn btn-primary'],['rename','自动重命名，保留两个文件','btn btn-outline-secondary'],['skip','跳过此次上传','btn btn-outline-secondary']];
  const finish=value=>{document.removeEventListener('keydown',esc);overlay.remove();resolve(value)};
  const esc=e=>{if(e.key==='Escape')finish('skip')};
  for(const [value,label,cls] of buttons){const b=document.createElement('button');b.type='button';b.className=cls;b.textContent=label;b.addEventListener('click',()=>finish(value));group.append(b)}
  content.append(heading,description,group);dialog.append(content);overlay.append(dialog);document.body.append(overlay);document.addEventListener('keydown',esc);group.querySelector('button')?.focus();
 });
}
