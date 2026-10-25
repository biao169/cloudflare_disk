import {requestJSON} from '../api.js';

const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const button=(text,fn,cls='btn btn-sm btn-outline-secondary')=>{const n=el('button',cls,text);n.type='button';n.onclick=fn;return n;};
const expiryDate=(choice,custom)=>{
 if(choice==='never')return null;
 if(choice==='custom'){
  const d=new Date(custom);if(!custom||!Number.isFinite(d.getTime())||d.getTime()<=Date.now()||d.getTime()>Date.now()+366*86400000)throw Error('自定义有效期需在未来 366 天以内');
  return d.toISOString();
 }
 const span={'1h':3600000,'1d':86400000,'7d':7*86400000,'30d':30*86400000}[choice];
 if(!span)throw Error('请选择有效期');return new Date(Date.now()+span).toISOString();
};
const format=raw=>{if(!raw)return '永久';const text=/^\d{4}-\d\d-\d\d /.test(raw)?raw.replace(' ','T')+'Z':raw;const d=new Date(text);return Number.isNaN(d.getTime())?String(raw):d.toLocaleString('zh-CN');};
const statusLabels={active:'有效',expired:'已过期',revoked:'已撤销',download_limit:'下载次数耗尽',target_unavailable:'源文件已删除或不可用',creator_disabled:'分享者账号已停用',permission_revoked:'分享权限已撤销',ready:'已公开',source_unavailable:'源文件已删除',failed:'发布失败'};
export function shareStatusLabel(code){return statusLabels[code]||'状态未知';}
export function validShareOptions({mode,kind,expires,password}){
 if(!['public','temporary','page'].includes(mode))return false;
 if(kind==='folder'&&mode!=='page')return false;
 if(mode==='temporary'&&expires==='never')return false;
 if(mode!=='page'&&password)return false;
 return true;
}
function expiryControls(defaultValue='7d'){
 const wrap=el('div','mb-3');wrap.append(el('label','form-label','有效期'));
 const select=el('select','form-select form-select-sm');
 for(const [v,label] of [['1h','1 小时'],['1d','1 天'],['7d','7 天'],['30d','30 天'],['custom','自定义时间'],['never','永久']]){
  const o=el('option','',label);o.value=v;select.append(o);
 }
 select.value=defaultValue;
 const custom=el('input','form-control form-control-sm mt-2');custom.type='datetime-local';custom.setAttribute('aria-label','自定义过期时间');
 const sync=()=>{custom.hidden=select.value!=='custom';};select.onchange=sync;sync();wrap.append(select,custom);
 return {wrap,select,custom,value:()=>expiryDate(select.value,custom.value)};
}
function downloadLimit(value=null){
 const wrap=el('div','mb-3');wrap.append(el('label','form-label','最多下载次数（0 为不限）'));
 const input=el('input','form-control form-control-sm');input.type='number';input.min='0';input.max='100000';input.step='1';input.value=value??0;
 wrap.append(input);return {wrap,value:()=>{const n=Number(input.value);if(input.value.trim()===''||!Number.isSafeInteger(n)||n<0||n>100000)throw Error('下载次数必须为 0–100000');return n===0?null:n;}};
}
function passwordField(){
 const wrap=el('div','mb-3');wrap.append(el('label','form-label','访问密码（仅分享页面，可选）'));
 const input=el('input','form-control form-control-sm');input.type='password';input.autocomplete='new-password';input.placeholder='留空不设置；设置时 12–128 字符';input.maxLength=128;wrap.append(input);return {wrap,input};
}
function allowField(checked=true){const wrap=el('label','form-check mb-3'),input=el('input','form-check-input');input.type='checkbox';input.checked=checked;wrap.append(input,el('span','form-check-label ms-2','允许下载'));return {wrap,input};}

/** Identical Bootstrap manager for file-row Share and the global My Shares view. */
export async function openShareDialog(item,{isAdmin=false,onCreated=()=>{},onChanged=()=>{}}={}){
 if(!window.bootstrap?.Modal)throw Error('Bootstrap 未加载');
 const kind=item.kind||'file',dialogRoot=el('div','modal fade');dialogRoot.tabIndex=-1;dialogRoot.setAttribute('aria-label','分享设置');
 const dialog=el('div','modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable'),content=el('div','modal-content');
 const header=el('div','modal-header');header.append(el('h2','modal-title fs-5',`分享 · ${item.name||'文件'}`));const close=el('button','btn-close');close.type='button';close.dataset.bsDismiss='modal';close.setAttribute('aria-label','关闭');header.append(close);
 const body=el('div','modal-body');const status=el('div','small mb-2');const existing=el('div','mb-4');body.append(status,existing);
 const output=el('div','d-none alert alert-info py-2');body.append(output);
 const createPanel=el('section','border-top pt-3');createPanel.append(el('h3','h6','创建新分享'));
 const mode=el('select','form-select form-select-sm mb-3');mode.setAttribute('aria-label','选择分享模式');
 for(const [value,name] of [['temporary','临时授权直链（直接下载）'],['page','文件分享页面（密码、预览）'],['public','永久公开直链（R2 / CDN）']]){
  const o=el('option','',name);o.value=value;o.disabled=(kind==='folder'&&value!=='page')||(value==='public'&&!isAdmin);mode.append(o);
 }
 mode.value=kind==='folder'?'page':'temporary';createPanel.append(mode);
 const expire=expiryControls(),limit=downloadLimit(),pw=passwordField(),allow=allowField();
 createPanel.append(expire.wrap,limit.wrap,pw.wrap,allow.wrap);
 const pubWarning=el('p','small text-warning');createPanel.append(pubWarning);
 const create=button('创建分享并复制链接',()=>{},'btn btn-primary');createPanel.append(create);body.append(createPanel);
 const footer=el('div','modal-footer');const done=button('关闭',()=>{},'btn btn-outline-secondary');done.dataset.bsDismiss='modal';footer.append(done);
 content.append(header,body,footer);dialog.append(content);dialogRoot.append(dialog);document.body.append(dialogRoot);
 const modal=new bootstrap.Modal(dialogRoot);
 function note(message,cls='text-danger'){status.className=`small mb-2 ${cls}`;status.textContent=message;}
 async function reveal(url,message='分享链接（请妥善保管）'){
  output.replaceChildren(el('div','fw-semibold small mb-2',message));const line=el('div','input-group input-group-sm');
  const field=el('input','form-control');field.readOnly=true;field.value=url;field.setAttribute('aria-label','分享链接');
  const copy=button('复制',async()=>{try{await navigator.clipboard.writeText(url);note('链接已复制','text-success');}catch{field.focus();field.select();note('请手动复制已选中的链接','text-warning');}},'btn btn-outline-primary');
  line.append(field,copy);output.append(line);output.classList.remove('d-none');
 }
 function syncCreation(){const v=mode.value;expire.wrap.hidden=v==='public';const never=expire.select.querySelector('option[value="never"]');never.disabled=v==='temporary';if(never.disabled&&expire.select.value==='never')expire.select.value='7d';expire.select.onchange();
  limit.wrap.hidden=v==='public';pw.wrap.hidden=v!=='page';allow.wrap.hidden=v!=='page';pubWarning.textContent=v==='public'?'公开直链无法设置密码和有效期。未设置 R2 自定义域名时会通过 Worker 提供；CDN 已缓存的文件撤销后可能仍能被读取。':'';
 }
 mode.onchange=syncCreation;syncCreation();
 async function existingShares(){
  existing.replaceChildren(el('p','text-secondary small','正在读取已有分享…'));
  try{
   const params=new URLSearchParams({target_type:kind,target_id:item.id});
   const data=await requestJSON(`/api/v1/shares?${params}`);const shares=data.shares||[];
   existing.replaceChildren(el('h3','h6','已有分享链接'));
   if(data.link_key_status!=='ready')existing.append(el('p','small text-warning',data.link_key_status==='not_configured'?'未设置 SHARE_LINK_KEY：新链接只能轮换生成，不能再次读取原地址。':'SHARE_LINK_KEY 配置有误，暂不能安全保存新链接。'));
   if(!shares.length)existing.append(el('div','small text-secondary mb-2','尚无分享记录'));
   for(const s of shares){
    const panel=el('div','border rounded-3 p-2 mb-2');const heading=el('div','fw-semibold small',`${s.type==='page'?'分享页面':'临时直链'} · ${shareStatusLabel(s.status)}`);
    panel.append(heading,el('div','small text-secondary',`到期：${format(s.expires_at)} · ${s.has_password?'有密码':'无密码'} · ${s.allow_download?'允许下载':'禁止下载'}${s.max_downloads?` · 已下载 ${s.download_count}/${s.max_downloads}`:''}`));
    const actions=el('div','d-flex flex-wrap gap-2 mt-2');const active=s.status==='active';
    if(active){
     actions.append(button(s.link_recoverable?'重新获取原链接':'轮换并获取新链接',async()=>{
      if(!s.link_recoverable&&!confirm('旧链接无法还原。轮换后旧链接立即失效，是否继续？'))return;
      try{const r=await requestJSON(s.link_recoverable?`/api/v1/shares/${s.id}/link`:`/api/v1/shares/${s.id}/rotate`,{method:s.link_recoverable?'GET':'POST'});await reveal(r.url,r.rotated?'已轮换链接，旧地址失效':'已安全取回原链接');if(r.rotated){note('链接已轮换，旧链接立即失效','text-success');await existingShares();onChanged();}}
      catch(e){note(e.message);}
     },'btn btn-sm btn-outline-primary'));
     actions.append(button('轮换链接',async()=>{if(!confirm('轮换后旧地址会立即失效，确定吗？'))return;
      try{const r=await requestJSON(`/api/v1/shares/${s.id}/rotate`,{method:'POST'});await reveal(r.url,'轮换成功，请复制新链接');await existingShares();onChanged();}catch(e){note(e.message);}
     }));
    }
    if(!s.revoked_at&&['active','expired','download_limit'].includes(s.status))actions.append(button('编辑权限 / 期限',()=>edit(s),'btn btn-sm btn-outline-secondary'));
    if(!s.revoked_at)actions.append(button('撤销',async()=>{if(!confirm('撤销分享后原链接将永久失效，确认？'))return;try{await requestJSON(`/api/v1/shares/${s.id}`,{method:'DELETE'});note('分享已撤销','text-success');await existingShares();onChanged();}catch(e){note(e.message);}},'btn btn-sm btn-outline-danger'));
    panel.append(actions);existing.append(panel);
   }
   if(isAdmin&&kind==='file'){
    const result=await requestJSON(`/api/v1/publications?file_id=${encodeURIComponent(item.id)}`);
    if(result.publications.length){existing.append(el('h3','h6 mt-3','永久公开直链'));
     for(const p of result.publications){const panel=el('div','border rounded-3 p-2 mb-2');panel.append(el('div','small fw-semibold',`公开 R2 · ${shareStatusLabel(p.status)} · ${p.delivery==='cdn'?'CDN 域名':'Worker 访问'}`));
      const row=el('div','d-flex flex-wrap gap-2 mt-2');if(p.status==='ready'&&p.url)row.append(button('获取公开链接',()=>reveal(p.url,'永久公开链接')));
      if(p.status==='ready')row.append(button('撤销公开',async()=>{if(!confirm('公开 CDN 缓存可能继续存在。确认撤销 R2 公开副本？'))return;try{const r=await requestJSON(`/api/v1/publications/${p.id}`,{method:'DELETE'});note(r.warning,'text-warning');await existingShares();onChanged();}catch(e){note(e.message);}},'btn btn-sm btn-outline-danger'));
      panel.append(row);existing.append(panel);
     }
    }
    const text=result.cdn_configured?`公开 CDN 已配置：${result.cdn_base_url}${result.purge_configured?' · 已配置自动缓存清理':' · 建议配置缓存清理 Secret'}`:'未设置 PUBLIC_BASE_URL：公开文件通过 Worker /p/ 访问，不享受独立 R2 CDN 直连。';
    existing.append(el('div','small text-secondary mt-2',text));
   }
  }catch(err){existing.replaceChildren(el('div','alert alert-warning small',err.message));}
 }
 function edit(s){
  const panel=el('div','card border-primary mt-2'),form=el('div','card-body');panel.append(form);form.append(el('h4','h6','编辑现有分享：不改变分享链接'));
  const expiry=expiryControls(s.expires_at?'custom':'never');if(s.expires_at){const d=new Date(/^\d{4}-\d\d-\d\d /.test(s.expires_at)?s.expires_at.replace(' ','T')+'Z':s.expires_at);const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);expiry.custom.value=local.toISOString().slice(0,16);expiry.custom.hidden=false;}
  const max=downloadLimit(s.max_downloads),allowed=allowField(s.allow_download);form.append(expiry.wrap,max.wrap);
  if(s.type==='page')form.append(allowed.wrap);
  const passAction=el('select','form-select form-select-sm mb-2');for(const [v,label] of [['keep','不修改访问密码'],['replace','设置新密码'],['clear','移除密码']]){const o=el('option','',label);o.value=v;passAction.append(o);}
  const password=passwordField();password.wrap.hidden=true;passAction.onchange=()=>password.wrap.hidden=passAction.value!=='replace';if(s.type==='page')form.append(passAction,password.wrap);
  const notice=el('div','small text-warning mb-2','修改或移除密码将使原先已验证的访客会话失效。');if(s.type==='page')form.append(notice);
  const save=button('保存修改',async()=>{try{
   const body={expires_at:expiry.value(),max_downloads:max.value()};if(s.type==='page'){body.allow_download=allowed.input.checked;body.password_action=passAction.value;if(passAction.value==='replace')body.password=password.input.value;}
   save.disabled=true;await requestJSON(`/api/v1/shares/${s.id}`,{method:'PATCH',body});note('分享设置已保存','text-success');await existingShares();onChanged();
  }catch(e){note(e.message);}finally{save.disabled=false;}},'btn btn-sm btn-primary');const cancel=button('取消',()=>panel.remove());form.append(save,el('span','ms-2'),cancel);existing.prepend(panel);
 }
 create.onclick=async()=>{const v=mode.value;note('');
  if(!validShareOptions({mode:v,kind,expires:expire.select.value,password:v==='page'?pw.input.value:''}))return note('当前模式不适用于此文件或文件夹');
  if(v==='page'&&pw.input.value){const n=Array.from(pw.input.value).length;if(n<12||n>128)return note('分享访问密码需要 12–128 字符');}
  try{
   const body=v==='public'?{file_id:item.id}:{type:v,target_type:kind,target_id:item.id,expires_at:expire.value(),max_downloads:limit.value(),allow_download:v==='page'?allow.input.checked:true,...(v==='page'&&pw.input.value?{password:pw.input.value}:{})};
   create.disabled=true;const result=await requestJSON(v==='public'?'/api/v1/publications':'/api/v1/shares',{method:'POST',body});
   await reveal(result.url,'分享创建成功，请复制链接');pw.input.value='';note(result.warning||'创建成功','text-success');await existingShares();onCreated(result);onChanged();
  }catch(err){note(err.message);}finally{create.disabled=false;}
 };
 dialogRoot.addEventListener('hidden.bs.modal',()=>{modal.dispose();dialogRoot.remove()},{once:true});modal.show();await existingShares();
}
