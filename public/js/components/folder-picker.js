import {requestJSON} from '../api.js';
const ID=/^[0-9a-f-]{36}$/;
const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};

/** Browse permitted folders without exposing folder UUIDs or accepting arbitrary IDs. */
export function pickFolder({spaceId,spaceName='当前空间',title='选择目标文件夹'}={}){
 if(!ID.test(spaceId))return Promise.reject(Error('空间 ID 无效'));
 if(!window.bootstrap?.Modal)return Promise.reject(Error('Bootstrap 弹窗组件尚未加载'));
 return new Promise(resolve=>{
  const shell=el('div','modal fade');shell.tabIndex=-1;shell.setAttribute('aria-hidden','true');
  const dialog=el('div','modal-dialog modal-dialog-centered modal-dialog-scrollable');
  const content=el('div','modal-content');const header=el('div','modal-header');
  header.append(el('h2','modal-title fs-5',title));const x=el('button','btn-close');x.type='button';x.dataset.bsDismiss='modal';x.setAttribute('aria-label','关闭');header.append(x);
  const body=el('div','modal-body');const hint=el('p','small text-secondary','目标文件夹必须具有写入权限；可以选择当前空间根目录。');
  const crumb=el('div','d-flex flex-wrap align-items-center gap-1 mb-3');const list=el('div','list-group cd-picker-list');
  const state=el('div','small text-secondary mt-2');const more=el('button','btn btn-sm btn-outline-secondary mt-2','加载更多文件夹');more.type='button';more.hidden=true;
  body.append(hint,crumb,list,state,more);
  const footer=el('div','modal-footer');const cancel=el('button','btn btn-outline-secondary','取消');cancel.type='button';cancel.dataset.bsDismiss='modal';
  const choose=el('button','btn btn-primary','选择此目录');choose.type='button';footer.append(cancel,choose);
  content.append(header,body,footer);dialog.append(content);shell.append(dialog);document.body.append(shell);
  const bs=new bootstrap.Modal(shell,{backdrop:'static'});let resolved=false,current=null,parents=[],offset=0,writable=false,fetchSeq=0;
  const finish=value=>{if(!resolved){resolved=true;resolve(value);}bs.hide();};
  shell.addEventListener('hidden.bs.modal',()=>{if(!resolved){resolved=true;resolve(null)}bs.dispose();shell.remove()},{once:true});
  function crumbs(){crumb.replaceChildren();const root=el('button','btn btn-sm btn-outline-secondary',spaceName+' / 根目录');root.type='button';root.onclick=()=>{current=null;parents=[];reload()};crumb.append(root);
   parents.forEach((f,i)=>{crumb.append(el('span','text-secondary','/'));const b=el('button','btn btn-sm btn-link text-decoration-none',f.name);b.type='button';b.onclick=()=>{current=f.id;parents=parents.slice(0,i+1);reload()};crumb.append(b)});
  }
  function appendFolders(items){for(const f of items){const row=el('button','list-group-item list-group-item-action d-flex align-items-center gap-2');row.type='button';
   row.append(el('span','', '📁'),el('span','flex-grow-1 text-start text-truncate',f.name));if(!f.can_write)row.append(el('span','badge text-bg-light','只读'));
   row.onclick=()=>{parents.push(f);current=f.id;reload()};list.append(row)}
  }
  async function page(){const seq=++fetchSeq;state.textContent='加载中…';more.disabled=true;
   try{const q=new URLSearchParams({limit:'100',offset:String(offset)});if(current)q.set('parent_id',current);
    const data=await requestJSON(`/api/v1/spaces/${spaceId}/folders?${q}`);
    if(seq!==fetchSeq)return;
    if(offset===0)list.replaceChildren();appendFolders(data.items);writable=data.parent_writable;choose.disabled=!writable;
    if(!list.children.length)list.append(el('div','list-group-item small text-secondary','没有子文件夹'));
    offset+=100;more.hidden=!data.has_more;state.textContent=writable?'可选择此目录':'此目录无写入权限，仍可浏览子文件夹';
   }catch(err){if(seq!==fetchSeq)return;state.textContent=err.message;choose.disabled=true;more.hidden=true;}finally{if(seq===fetchSeq)more.disabled=false;}
  }
  function reload(){offset=0;crumbs();page()}
  more.onclick=page;choose.onclick=()=>{if(writable)finish({folderId:current})};
  bs.show();reload();
 });
}

/** Small Bootstrap prompt, avoiding browser-native prompt dialogs. */
export function askName({title='输入名称',label='名称',value='',confirm='保存'}={}){
 if(!window.bootstrap?.Modal)return Promise.reject(Error('Bootstrap 未加载'));
 return new Promise(resolve=>{
  const shell=el('div','modal fade');shell.tabIndex=-1;
  const dialog=el('div','modal-dialog modal-dialog-centered');const content=el('div','modal-content');
  const head=el('div','modal-header');head.append(el('h2','modal-title fs-5',title));const close=el('button','btn-close');close.dataset.bsDismiss='modal';head.append(close);
  const body=el('div','modal-body');const text=el('label','form-label',label);const input=el('input','form-control');input.type='text';input.maxLength=100;input.value=value;const feedback=el('div','invalid-feedback','名称不能为空，且不得包含 / 或反斜线');body.append(text,input,feedback);
  const foot=el('div','modal-footer');const cancel=el('button','btn btn-outline-secondary','取消');cancel.dataset.bsDismiss='modal';const submit=el('button','btn btn-primary',confirm);foot.append(cancel,submit);
  content.append(head,body,foot);dialog.append(content);shell.append(dialog);document.body.append(shell);
  const modal=new bootstrap.Modal(shell),done={v:false};
  const end=v=>{if(!done.v){done.v=true;resolve(v)}modal.hide()};
  submit.onclick=()=>{const name=input.value.trim();if(!name||/[\x00-\x1f/\\]/.test(name)){input.classList.add('is-invalid');return}end(name)};
  input.oninput=()=>input.classList.remove('is-invalid');input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();submit.click()}};
  shell.addEventListener('hidden.bs.modal',()=>{if(!done.v)resolve(null);modal.dispose();shell.remove()},{once:true});
  shell.addEventListener('shown.bs.modal',()=>{input.focus();input.select()},{once:true});modal.show();
 });
}
