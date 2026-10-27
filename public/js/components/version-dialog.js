import {requestJSON} from '../api.js';
import {openPreview,canPreview} from '../modules/preview.js';
import {openTextEditor,canEditText} from './text-editor.js';
const el=(tag,cls='',value='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=value;return n;};
const btn=(label,fn,cls='btn btn-sm btn-outline-secondary')=>{const n=el('button',cls,label);n.type='button';n.onclick=fn;return n;};
const displayBytes=n=>`${(Number(n||0)/1024).toFixed(1)} KiB`;
export async function openVersionDialog(item,{onRestored=()=>{}}={}){
 if(!window.bootstrap?.Modal)throw Error('Bootstrap 组件未加载');
 const root=el('div','modal fade');root.tabIndex=-1;root.setAttribute('aria-label','文件历史版本管理');
 const dialog=el('div','modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable'),content=el('div','modal-content');
 const header=el('div','modal-header');header.append(el('h2','modal-title fs-5',`历史版本 · ${item.name}`));
 const x=el('button','btn-close');x.type='button';x.dataset.bsDismiss='modal';x.setAttribute('aria-label','关闭');header.append(x);
 const body=el('div','modal-body'),message=el('div','small mb-2'),summary=el('p','small text-secondary'),list=el('div','list-group');body.append(message,summary,list);
 const footer=el('div','modal-footer'),refresh=btn('刷新版本',()=>load()),close=btn('关闭',()=>modal.hide());footer.append(refresh,close);
 content.append(header,body,footer);dialog.append(content);root.append(dialog);document.body.append(root);
 const modal=new window.bootstrap.Modal(root);let closed=false,locked=false;
 root.addEventListener('hidden.bs.modal',()=>{closed=true;root.remove()},{once:true});
 const note=(s,danger=false)=>{message.className=`small mb-2 ${danger?'text-danger':'text-secondary'}`;message.textContent=s;};
 async function load(){if(closed)return;list.replaceChildren();note('正在读取历史修订…');
  try{const data=await requestJSON(`/api/v1/files/${item.id}/versions`);if(closed)return;
   summary.textContent=`当前为 V${data.current_revision} · ${displayBytes(data.current_size_bytes)} · 历史恢复会创建新修订，原文件 ID 和分享链接保持不变。`;
   if(!data.versions?.length){list.append(el('div','list-group-item text-secondary','暂无历史版本。'));}
   for(const version of data.versions||[]){const row=el('div','list-group-item d-flex align-items-center flex-wrap gap-2');
    const text=el('div','flex-grow-1');text.append(el('div','fw-semibold',`V${version.revision} · ${displayBytes(version.size_bytes)}`),el('div','small text-secondary',`${version.created_at||''} · ${version.mime_type||'未知类型'}`));row.append(text);
    const url=`/api/v1/files/${item.id}/versions/${version.revision}`;
    const old={...item,mime_type:version.mime_type};
    if(canPreview(old))row.append(btn('预览',()=>openPreview(old,[],{urlOverride:`${url}/preview`,onError:e=>note(e,true)})));
    else if(canEditText(old))row.append(btn('查看文本',()=>{
     root.addEventListener('hidden.bs.modal',()=>{void openTextEditor(old,{historyRevision:version.revision}).catch(e=>console.warn('历史文本预览不可用',e));},{once:true});
     modal.hide();
    }));
    const download=el('a','btn btn-sm btn-outline-secondary','下载');download.href=`${url}/content`;download.rel='nofollow';download.download='';row.append(download);
    row.append(btn('恢复此版本',async()=>{
     if(locked||!confirm(`将「${item.name}」恢复为历史 V${version.revision}？当前内容将成为新的历史修订，永久公开文件会按配置同步。`))return;
     locked=true;note('正在恢复文件…');
     try{const data2=await requestJSON(`${url}/restore`,{method:'POST',body:{expected_revision:data.current_revision}});note(`已恢复历史 V${version.revision}，现在是 V${data2.revision}。`);await Promise.resolve(onRestored(data2));await load();}
     catch(e){note(e.code==='VERSION_CONFLICT'?'当前文件已被其他成员修改，请刷新后重新决定恢复版本。':e.message,true);}
     finally{locked=false;}
    },'btn btn-sm btn-outline-primary'));
    list.append(row);
   }
   note('历史版本只向仍有文件读取权限的成员展示；恢复需要编辑权限。');
  }catch(e){note(e.message,true);}
 }
 modal.show();await load();
}
