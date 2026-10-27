// Build-free Bootstrap-style review dialog. No destructive job starts on preview.
const element=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n};
export function chooseFolderSyncPlan({rootName,plan}){
 return new Promise(resolve=>{
  const backdrop=element('div','modal d-block');backdrop.style.cssText='background:rgba(0,0,0,.55);z-index:2600;overflow:auto';backdrop.setAttribute('role','dialog');backdrop.setAttribute('aria-modal','true');backdrop.setAttribute('aria-label','文件夹合并或镜像替换');
  const modal=element('div','modal-dialog modal-dialog-centered modal-lg');const content=element('div','modal-content');
  const header=element('div','modal-header');header.append(element('h2','modal-title fs-5',`更新文件夹 · ${rootName}`));
  const close=element('button','btn-close');close.type='button';close.setAttribute('aria-label','关闭');header.append(close);
  const body=element('div','modal-body');body.append(element('p','small text-secondary','保留匹配的文件夹与文件 ID，更新文件内容后，原私密分享仍指向该文件。镜像模式会将本地清单中缺少的旧项目移入回收站。'));
  const modes=element('div','d-grid gap-2');const labels=[['merge','合并更新（推荐）','同名文件更新，新增文件加入；不删除其他旧文件'],['mirror','镜像替换','同名文件更新；完成全部上传后，缺少的旧项目移入回收站'],['new','保留两个文件夹','创建独立的新文件夹，不触碰原目录和分享']];
  for(const [value,title,description] of labels){const label=element('label','form-check border rounded-3 p-2');const radio=element('input','form-check-input me-2');radio.type='radio';radio.name='cd-folder-sync-mode';radio.value=value;radio.checked=value==='merge';const strong=element('strong','',title);label.append(radio,strong,element('div','small text-secondary ms-4',description));modes.append(label)}body.append(modes);
  const note=element('div','small text-secondary mt-3','正在计算文件夹差异…');note.setAttribute('role','status');body.append(note);
  const stats=element('div','small mt-2');body.append(stats);
  const details=element('details','mt-2');const summary=element('summary','small','查看变更清单（最多显示 60 项）');const list=element('ul','small mt-2');details.append(summary,list);body.append(details);
  const confirmRow=element('label','form-check mt-3');const checkbox=element('input','form-check-input');checkbox.type='checkbox';const label=element('span','form-check-label ms-2','我已检查将删除的旧文件/文件夹，确认执行镜像替换');confirmRow.append(checkbox,label);confirmRow.hidden=true;body.append(confirmRow);
  const footer=element('div','modal-footer');const cancel=element('button','btn btn-outline-secondary','取消');cancel.type='button';const submit=element('button','btn btn-primary','开始合并更新');submit.type='button';submit.disabled=true;footer.append(cancel,submit);
  content.append(header,body,footer);modal.append(content);backdrop.append(modal);document.body.append(backdrop);
  let currentMode='merge',currentPlan=null,sequence=0,closed=false;
  const finish=v=>{if(closed)return;closed=true;document.removeEventListener('keydown',escape);backdrop.remove();resolve(v)};
  const escape=e=>{if(e.key==='Escape')finish(null)};close.onclick=()=>finish(null);cancel.onclick=()=>finish(null);document.addEventListener('keydown',escape);
  checkbox.onchange=()=>{submit.disabled=!currentPlan||(currentMode==='mirror'&&!checkbox.checked)};
  async function refresh(){const n=++sequence;currentPlan=null;submit.disabled=true;note.textContent='正在从服务器计算差异与权限…';stats.replaceChildren();list.replaceChildren();details.open=false;
   confirmRow.hidden=currentMode!=='mirror';checkbox.checked=false;submit.textContent=currentMode==='mirror'?'确认镜像替换':currentMode==='new'?'创建新文件夹并上传':'开始合并更新';
   try{const result=await plan(currentMode);if(closed||sequence!==n)return;currentPlan=result;
    const c=result.counts||{};note.textContent=`目标文件夹：${result.root_name}${result.root_existing?'（复用已有目录）':'（创建新目录）'}`;
    stats.textContent=`新增文件 ${c.new_files||0} · 替换文件 ${c.replaced_files||0} · 新建目录 ${c.new_folders||0} · 删除旧文件 ${c.removed_files||0} · 删除旧文件夹 ${c.removed_folders||0}`;
    const parts=(result.changes||[]).slice(0,60);for(const item of parts)list.append(element('li','',`${item.action==='trash'?'将移入回收站':item.action==='replace'?'更新内容':item.action==='create'?'新增文件':item.action==='mkdir'?'新建目录':'保留目录'}：${item.path}`));
    if(currentMode==='mirror'){
     const total=(c.removed_files||0)+(c.removed_folders||0);label.textContent=total?`我已核对将删除的 ${total} 个旧项目，并确认全部新文件上传完成后执行删除`:'我确认使用镜像模式（当前没有需要删除的旧项目）';
     submit.disabled=true;
    }else submit.disabled=false;
   }catch(e){if(sequence===n&&!closed)note.textContent=`无法执行：${e.message}`;}
  }
  modes.onchange=()=>{const selected=modes.querySelector('input:checked');if(selected){currentMode=selected.value;void refresh();}};
  submit.onclick=()=>{if(!currentPlan)return;if(currentMode==='mirror'&&!checkbox.checked)return;finish({mode:currentMode,plan:currentPlan,confirm_mirror:currentMode==='mirror'})};
  void refresh();
 });
}
