// RC13.4: small UTF-8 text editor. Text is assigned through .value/.textContent,
// never innerHTML or iframe srcdoc. This component requires no build step.
import {requestJSON} from '../api.js';
export const EDITABLE_TEXT_EXTS=new Set(['txt','md','markdown','json','jsonl','xml','csv','html','htm','css','js','mjs','yaml','yml','log','ini']);
export const MAX_TEXT_EDIT_BYTES=512*1024;
export function canEditText(item){
 if(item?.kind==='folder')return false;
 const ext=String(item?.name||'').split('.').at(-1).toLowerCase();
 return EDITABLE_TEXT_EXTS.has(ext)&&!(/^(?:image\/|video\/|audio\/|application\/(?:pdf|zip))/.test(item?.mime_type||''));
}
const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const button=(label,cls='btn btn-sm btn-outline-secondary')=>{const b=el('button',cls,label);b.type='button';return b;};
const kb=s=>new TextEncoder().encode(s).byteLength;
export async function openTextEditor(item,{historyRevision=null,onSaved=()=>{}}={}){
 if(!window.bootstrap?.Modal)throw Error('Bootstrap 组件未加载');
 if(!canEditText(item))throw Error('此文件不支持在线文本编辑');
 const readonly=historyRevision!==null;
 const root=el('div','modal fade');root.tabIndex=-1;root.setAttribute('aria-label',readonly?'历史文本预览':'在线文本编辑');
 const dialog=el('div','modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable');
 const content=el('div','modal-content'),header=el('div','modal-header');
 header.append(el('h2','modal-title fs-5',`${readonly?'历史文本预览':'在线编辑'} · ${item.name}`));
 const close=el('button','btn-close');close.type='button';close.setAttribute('aria-label','关闭');header.append(close);
 const body=el('div','modal-body');
 const info=el('div','d-flex flex-wrap justify-content-between gap-2 small text-secondary mb-2'),rev=el('span'),bytes=el('span');info.append(rev,bytes);
 const feedback=el('div','small mb-2');feedback.setAttribute('role','status');
 const edit=el('textarea','form-control cd-text-editor font-monospace');edit.spellcheck=false;edit.readOnly=readonly;edit.setAttribute('aria-label','文件 UTF-8 文本内容');
 body.append(info,feedback,edit);
 const footer=el('div','modal-footer');
 const reload=button('重新读取','btn btn-outline-secondary'),save=button('保存新版本','btn btn-primary'),done=button('关闭');
 if(!readonly)footer.append(reload,save);footer.append(done);
 content.append(header,body,footer);dialog.append(content);root.append(dialog);document.body.append(root);
 const modal=new window.bootstrap.Modal(root,{backdrop:'static',keyboard:false});
 edit.readOnly=true; // Prevent typing before the initial server revision has loaded.
 let saved='',revision=0,working=false,closed=false;
 const note=(message,warning=false)=>{feedback.className=`small mb-2 ${warning?'text-danger':'text-secondary'}`;feedback.textContent=message;};
 const changed=()=>!readonly&&edit.value!==saved;
 const label=()=>{rev.textContent=`修订 V${revision}${changed()?' · 尚未保存':''}`;bytes.textContent=`UTF-8 ${kb(edit.value).toLocaleString()} / ${MAX_TEXT_EDIT_BYTES.toLocaleString()} 字节`;save.disabled=working||!changed()||kb(edit.value)>MAX_TEXT_EDIT_BYTES;};
 const path=()=>readonly?`/api/v1/files/${item.id}/versions/${historyRevision}/text`:`/api/v1/files/${item.id}/text`;
 async function load({prompt=false}={}){
  if(prompt&&changed()&&!confirm('重新读取会丢弃未保存的编辑，确定吗？'))return;
  working=true;save.disabled=true;reload.disabled=true;note('正在读取 UTF-8 文件…');
  try{const data=await requestJSON(path());if(closed)return;
   revision=data.revision;edit.value=data.text;saved=data.text;note(readonly?'历史版本只读预览':'保存会创建新的文件修订，文件 ID 和原有分享链接保持不变。');label();}
  catch(e){if(!closed)note(e.message,true);}
  finally{working=false;edit.readOnly=readonly;reload.disabled=false;label();}
 }
 async function doSave(){
  if(readonly||working||!changed())return;
  if(kb(edit.value)>MAX_TEXT_EDIT_BYTES)return note('文本超过 512 KiB，请下载修改后使用覆盖上传。',true);
  working=true;save.disabled=true;reload.disabled=true;note('正在安全保存新版本…');
  const snapshot=edit.value;
  try{
   const result=await requestJSON(`/api/v1/files/${item.id}/text`,{method:'PUT',body:{content:snapshot,expected_revision:revision}});
   if(closed)return;revision=result.revision;saved=snapshot;note('保存成功。文件 ID 与已有私密分享未改变；若已公开，相关版本同步按发布设置执行。');
   await Promise.resolve(onSaved(result));
  }catch(e){if(!closed)note(e.code==='VERSION_CONFLICT'?'其他成员已修改此文件。请复制未保存文本，再点击“重新读取”处理冲突。':e.message,true);}
  finally{working=false;edit.readOnly=readonly;reload.disabled=false;label();}
 }
 function closeEditor(){if(working)return;if(changed()&&!confirm('还有未保存的内容，确定关闭？'))return;modal.hide();}
 const keydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void doSave();}else if(e.key==='Escape'){e.preventDefault();closeEditor();}};
 function hidden(){closed=true;document.removeEventListener('keydown',keydown);root.remove();}
 root.addEventListener('hidden.bs.modal',hidden,{once:true});close.onclick=closeEditor;done.onclick=closeEditor;reload.onclick=()=>load({prompt:true});save.onclick=doSave;
 edit.addEventListener('input',label);document.addEventListener('keydown',keydown);
 modal.show();await load();edit.focus();
}
