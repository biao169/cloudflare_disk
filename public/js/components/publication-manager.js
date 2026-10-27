// RC13.4: administratively manage public revision history, sync status and
// compatibility alias retries. Public previous versions are not made private.
import {requestJSON} from '../api.js';
const el=(tag,cls='',value='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=value;return n;};
const btn=(label,fn,cls='btn btn-sm btn-outline-secondary')=>{const b=el('button',cls,label);b.type='button';b.onclick=fn;return b;};
const statuses={ready:'最新公开版本已就绪',alias_pending:'原始 CDN 地址等待同步',purge_pending:'等待缓存清理',cache_unverified:'旧 CDN 缓存状态未验证',failed:'同步失败'};
export async function openPublicationManager(publication,{onChanged=()=>{}}={}){
 if(!window.bootstrap?.Modal)throw Error('Bootstrap 未加载');
 const root=el('div','modal fade');root.tabIndex=-1;root.setAttribute('aria-label','永久直链版本管理');
 const dialog=el('div','modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable'),content=el('div','modal-content');
 const header=el('div','modal-header');header.append(el('h2','modal-title fs-5',`公开版本管理 · ${publication.name||'文件'}`));const x=el('button','btn-close');x.type='button';x.dataset.bsDismiss='modal';x.setAttribute('aria-label','关闭');header.append(x);
 const body=el('div','modal-body'),feedback=el('div','small mb-2'),info=el('div','border rounded p-3 mb-3'),list=el('div','list-group'),footer=el('div','modal-footer');body.append(feedback,info,el('h3','h6','历史公开版本'),list);
 const refresh=btn('刷新状态',()=>load()),publish=btn('手动发布最新版',()=>publishLatest(),'btn btn-outline-primary btn-sm'),retry=btn('重试旧 CDN 同步 / 缓存清理',()=>retrySync(),'btn btn-outline-secondary btn-sm'),close=btn('关闭',()=>modal.hide());footer.append(refresh,publish,retry,close);
 content.append(header,body,footer);dialog.append(content);root.append(dialog);document.body.append(root);
 const modal=new window.bootstrap.Modal(root);let closed=false,working=false;
 root.addEventListener('hidden.bs.modal',()=>{closed=true;root.remove()},{once:true});
 const note=(s,bad=false)=>{feedback.className=`small mb-2 ${bad?'text-danger':'text-secondary'}`;feedback.textContent=s;};
 const id=publication.id;const path=`/api/v1/publications/${id}`;
 async function load(){if(closed)return;note('读取发布状态中…');try{
  const [status,history]=await Promise.all([requestJSON(`${path}/status`),requestJSON(`${path}/versions`)]);if(closed)return;
  info.replaceChildren(el('p','fw-semibold mb-1',`已发布 V${status.revision} · ${statuses[status.sync_state]||status.sync_state}`),
   el('div','small text-secondary mb-2',`源文件当前修订 V${status.source_revision??'—'}。智能 /r/ 使用已发布修订；旧 /published/ 可能受到缓存影响。`));
  const label=el('label','form-check form-switch mb-2'),check=el('input','form-check-input');check.type='checkbox';check.checked=Boolean(status.auto_sync);
  label.append(check,el('span','form-check-label ms-2','私有文件更新后自动发布公开版本'));info.append(label);
  check.onchange=async()=>{check.disabled=true;try{await requestJSON(path,{method:'PATCH',body:{auto_sync:check.checked}});note('发布策略已更新；暂停期间的修订可以使用“手动发布最新版”同步。');await load();}catch(e){check.checked=!check.checked;note(e.message,true)}finally{check.disabled=false;}};
  publish.disabled=working||status.status!=='ready'||status.source_revision===status.revision;
  if(publication.legacy_url){
   const legacy=el('div','small text-secondary mt-2','旧版直接 CDN 地址（浏览器缓存可能滞后）');
   const group=el('div','input-group input-group-sm'),field=el('input','form-control');field.value=publication.legacy_url;field.readOnly=true;
   group.append(field,btn('复制旧地址',async()=>{try{await navigator.clipboard.writeText(field.value);note('已复制旧地址');}catch{field.select();note('已选中，请按 Ctrl+C 复制');}}));info.append(legacy,group);
  }
  if(status.smart_url){const group=el('div','input-group input-group-sm'),field=el('input','form-control');field.value=status.smart_url;field.readOnly=true;
   group.append(field,btn('复制智能链接',async()=>{try{await navigator.clipboard.writeText(field.value);note('智能永久链接已复制');}catch{field.select();note('已选中链接，请按 Ctrl+C 复制');}},'btn btn-outline-primary'));info.append(group);}
  list.replaceChildren();for(const v of history.versions||[]){const row=el('div','list-group-item d-flex justify-content-between gap-2');
   row.append(el('span','',`V${v.file_revision}${v.file_revision===status.revision?'（当前公开）':''}`),el('span','small text-secondary',`${v.size_bytes===null?'未知大小':(Number(v.size_bytes)/1024).toFixed(1)+' KiB'} · ${v.created_at||''}`));list.append(row);}
  if(!history.versions?.length)list.append(el('div','list-group-item text-secondary','暂无版本记录'));
  retry.disabled=working||status.status!=='ready'||status.sync_state==='ready';
  note('旧版直接 CDN 地址的缓存可能滞后，重试操作不会更改私有文件或智能永久 URL。');
 }catch(e){note(e.message,true);}}
 async function publishLatest(){if(working||!confirm('将当前私有文件修订发布到现有永久直链？原智能 URL 保持不变，新发布副本可能消耗额外的 R2 空间。'))return;
  working=true;publish.disabled=true;note('正在准备公开版本…');
  try{const data=await requestJSON(`${path}/publish-latest`,{method:'POST'});note(`发布结果：${data.status} · V${data.revision}`);await load();await Promise.resolve(onChanged());}
  catch(e){note(e.message,true)}finally{working=false;publish.disabled=false;}}
 async function retrySync(){if(working)return;working=true;retry.disabled=true;note('正在处理旧 CDN 同步…');
  try{const data=await requestJSON(`${path}/sync`,{method:'POST'});note(`任务状态：${data.status||'已提交'}，请刷新确认 CDN 状态`);await load();await Promise.resolve(onChanged());}
  catch(e){note(e.message,true)}finally{working=false;retry.disabled=false;}}
 modal.show();await load();
}
