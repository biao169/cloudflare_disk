import {requestJSON} from '../api.js';

const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};

/** Preserve the folder role overrides previously offered on the /personal page.
 * The Worker checks the folder/space ACL again on every update. */
export function openFolderPermissions(folder){
 if(!window.bootstrap?.Modal)return Promise.reject(Error('Bootstrap 弹窗组件尚未加载'));
 return new Promise(resolve=>{
  const shell=el('div','modal fade');shell.tabIndex=-1;shell.setAttribute('aria-label',`文件夹权限 · ${folder.name}`);
  const dialog=el('div','modal-dialog modal-dialog-centered');
  const content=el('div','modal-content');
  const head=el('div','modal-header');head.append(el('h2','modal-title fs-5',`文件夹权限 · ${folder.name}`));
  const close=el('button','btn-close');close.type='button';close.dataset.bsDismiss='modal';close.setAttribute('aria-label','关闭');head.append(close);
  const body=el('div','modal-body');body.append(el('p','small text-secondary','对当前文件夹设置角色权限覆盖；实际操作仍由服务器验证访问权限。'));
  const roleLabel=el('label','form-label','成员角色');const role=el('select','form-select mb-3');
  for(const [value,label] of [['viewer','只读成员'],['editor','编辑成员']]){const o=el('option','',label);o.value=value;role.append(o)}
  const maskLabel=el('label','form-label','允许的操作');const mask=el('select','form-select mb-3');
  for(const [value,label] of [['0','禁止访问'],['1','仅查看'],['3','查看与编辑'],['15','查看、编辑、删除和分享']]){const o=el('option','',label);o.value=value;mask.append(o)}
  const state=el('div','small');state.setAttribute('role','status');body.append(roleLabel,role,maskLabel,mask,state);
  const foot=el('div','modal-footer');const cancel=el('button','btn btn-outline-secondary','取消');cancel.type='button';cancel.dataset.bsDismiss='modal';
  const save=el('button','btn btn-primary','保存权限');save.type='button';foot.append(cancel,save);
  content.append(head,body,foot);dialog.append(content);shell.append(dialog);document.body.append(shell);
  const modal=new window.bootstrap.Modal(shell);let finished=false;
  const finish=changed=>{if(!finished){finished=true;resolve(changed)}modal.hide()};
  shell.addEventListener('hidden.bs.modal',()=>{if(!finished){finished=true;resolve(false)}modal.dispose();shell.remove()},{once:true});
  save.onclick=async()=>{save.disabled=true;state.textContent='正在保存…';try{
   await requestJSON(`/api/v1/folders/${folder.id}/permissions`,{method:'PUT',body:{principal_type:'role',principal_id:role.value,permission_mask:Number(mask.value)}});
   finish(true);
  }catch(err){state.className='small text-danger';state.textContent=err.message;save.disabled=false}};
  modal.show();
 });
}
