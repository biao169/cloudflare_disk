import {formatUtc,parseUtc,localInputFromUtc,utcFromLocalInput} from '../utils/time.js';
import {openPublicationManager} from './publication-manager.js';
import {requestJSON} from '../api.js';

const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const button=(text,fn,cls='btn btn-sm btn-outline-secondary')=>{const n=el('button',cls,text);n.type='button';n.onclick=fn;return n;};
const visible=(node,yes)=>{node.hidden=!yes;node.classList.toggle('d-none',!yes);};
const utcDate=parseUtc;
const format=raw=>formatUtc(raw,{fallback:'永久'});
const expiryDate=(choice,custom)=>{
 if(choice==='never')return null;
 if(choice==='custom'){
  const iso=utcFromLocalInput(custom);
  const d=iso?new Date(iso):new Date(NaN);
  if(!custom||!Number.isFinite(d.getTime())||d.getTime()<=Date.now()||d.getTime()>Date.now()+366*86400000)throw Error('自定义有效期需在未来 366 天以内');
  return d.toISOString();
 }
 const span={'1h':3600000,'1d':86400000,'7d':7*86400000,'30d':30*86400000}[choice];
 if(!span)throw Error('请选择有效期');return new Date(Date.now()+span).toISOString();
};
const statusLabels={active:'有效',expired:'已过期',revoked:'已撤销',download_limit:'下载次数耗尽',target_unavailable:'源文件已删除或不可用',creator_disabled:'分享者账号已停用',permission_revoked:'分享权限已撤销',ready:'已公开',source_unavailable:'源文件已删除',failed:'发布失败'};
export function shareStatusLabel(code){return statusLabels[code]||'状态未知';}
export function validShareOptions({mode,kind,expires,password}){
 if(!['public','temporary','page'].includes(mode))return false;
 if(kind==='folder'&&mode!=='page')return false;
 if(mode==='temporary'&&expires==='never')return false;
 if(mode!=='page'&&password)return false;
 return true;
}
/** Only the creator can retrieve a bearer link. Old SHA-256-only URLs are mathematically unrecoverable. */
export function shareRecoveryState(share,keyStatus){
 if(['revoked','target_unavailable','creator_disabled','permission_revoked'].includes(share.status))return 'unavailable';
 if(!share.link_recoverable)return 'legacy';
 if(keyStatus!=='ready')return 'missing_key';
 return 'recoverable';
}
export function showExistingFirst(shares,publications=[]){return shares.length>0||publications.length>0;}
function expiryControls(defaultValue='7d'){
 const wrap=el('div','mb-3');wrap.append(el('label','form-label','有效期'));
 const select=el('select','form-select form-select-sm');
 for(const [v,label] of [['1h','1 小时'],['1d','1 天'],['7d','7 天'],['30d','30 天'],['custom','自定义日期'],['never','永久有效']]){
  const o=el('option','',label);o.value=v;select.append(o);
 }
 select.value=defaultValue;
 const custom=el('input','form-control form-control-sm mt-2');custom.type='datetime-local';custom.setAttribute('aria-label','自定义过期时间');
 const sync=()=>visible(custom,select.value==='custom');select.onchange=sync;sync();wrap.append(select,custom);
 return {wrap,select,custom,value:()=>expiryDate(select.value,custom.value)};
}
function downloadLimit(value=null){
 const wrap=el('div','mb-3');wrap.append(el('label','form-label','最多下载次数（0 为不限）'),el('div','form-text mb-1','预览在额度耗尽前不计次；额度耗尽后预览和下载均停止。已传输内容仍可能被保存。'));
 const input=el('input','form-control form-control-sm');input.type='number';input.min='0';input.max='100000';input.step='1';input.value=value??0;
 wrap.append(input);return {wrap,value:()=>{const n=Number(input.value);if(input.value.trim()===''||!Number.isSafeInteger(n)||n<0||n>100000)throw Error('下载次数必须为 0–100000');return n===0?null:n;}};
}
function passwordField(){
 const wrap=el('div','mb-3');wrap.append(el('label','form-label','访问密码（仅分享页面，可选）'));
 const input=el('input','form-control form-control-sm');input.type='password';input.autocomplete='new-password';input.placeholder='留空不设置；设置时 12–128 字符';input.maxLength=128;wrap.append(input);return {wrap,input};
}
function allowField(checked=true){const wrap=el('label','form-check mb-3'),input=el('input','form-check-input');input.type='checkbox';input.checked=checked;wrap.append(input,el('span','form-check-label ms-2','允许下载'));return {wrap,input};}

/**
 * Unified in-place sharing manager: opening an already-shared item displays
 * existing records first. The recoverable original URL is automatically read
 * for the newest accessible share and can be copied without creating another.
 */
export async function openShareDialog(item,{isAdmin=false,onCreated=()=>{},onChanged=()=>{}}={}){
 if(!window.bootstrap?.Modal)throw Error('Bootstrap 未加载');
 const kind=item.kind||'file',knownUrls=new Map();
 const root=el('div','modal fade');root.tabIndex=-1;root.setAttribute('aria-label','分享与链接管理');
 const dialog=el('div','modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable');
 const content=el('div','modal-content'),header=el('div','modal-header');
 header.append(el('h2','modal-title fs-5',`分享与链接管理 · ${item.name||'文件'}`));
 const close=el('button','btn-close');close.type='button';close.dataset.bsDismiss='modal';close.setAttribute('aria-label','关闭');header.append(close);
 const body=el('div','modal-body'),status=el('div','small mb-2'),existing=el('section','mb-3');
 const existingHeader=el('div','d-flex justify-content-between align-items-center gap-2 mb-2');
 const existingTitle=el('h3','h6 mb-0','已有分享');
 const refresh=button('刷新已有链接',()=>loadExisting());existingHeader.append(existingTitle,refresh);
 const existingList=el('div','cd-share-existing');existing.append(existingHeader,existingList);
 const createdLink=el('div','alert alert-info py-2');visible(createdLink,false);
 const divider=el('div','border-top pt-3 mt-3');
 const toggleNew=button('＋ 创建另一条分享链接',()=>{createTouched=true;setCreateOpen(!createOpen);},'btn btn-sm btn-outline-primary mb-3');
 divider.append(toggleNew);
 const createPanel=el('section','cd-share-create');createPanel.append(el('h3','h6','新建分享（已有链接不会改变）'));
 const mode=el('select','form-select form-select-sm mb-3');mode.setAttribute('aria-label','选择分享模式');
 for(const [value,label] of [['temporary','临时授权直链（直接下载）'],['page','文件分享页面（密码与预览）'],['public','永久智能直链（/r/ 固定地址，自动读取最新版）']]){
  const opt=el('option','',label);opt.value=value;opt.disabled=(kind==='folder'&&value!=='page')||(value==='public'&&!isAdmin);mode.append(opt);
 }
 mode.value=kind==='folder'?'page':'temporary';createPanel.append(mode);
 const expire=expiryControls(),limit=downloadLimit(),pw=passwordField(),allow=allowField();
 createPanel.append(expire.wrap,limit.wrap,pw.wrap,allow.wrap);
 const keyWarning=el('div','alert alert-warning small py-2');
 const keyNotice=el('div','mb-2');keyWarning.append(keyNotice);
 const optOut=el('label','form-check');const optOutInput=el('input','form-check-input');optOutInput.type='checkbox';
 optOut.append(optOutInput,el('span','form-check-label ms-1','我了解本次创建的原始链接无法再次找回，仍要创建'));
 keyWarning.append(optOut);createPanel.append(keyWarning);
 const publicWarning=el('p','small text-warning');createPanel.append(publicWarning);
 const create=button('创建并显示分享链接',()=>{},'btn btn-primary');createPanel.append(create);
 divider.append(createPanel);body.append(status,existing,createdLink,divider);
 const footer=el('div','modal-footer');const done=button('关闭',()=>{},'btn btn-outline-secondary');done.dataset.bsDismiss='modal';footer.append(done);
 content.append(header,body,footer);dialog.append(content);root.append(dialog);document.body.append(root);
 const modal=new window.bootstrap.Modal(root);
 let keyStatus='not_configured',createOpen=true,createTouched=false,fetchSeq=0,activeEditor=null;
 let destroyed=false;
 function note(message,cls='text-danger'){status.className=`small mb-2 ${cls}`;status.textContent=message;}
 function setCreateOpen(yes){createOpen=yes;visible(createPanel,yes);toggleNew.textContent=yes?'收起新建分享':'＋ 创建另一条分享链接';}
 async function copyUrl(url,field){try{await navigator.clipboard.writeText(url);note('链接已复制','text-success');}catch{field.focus();field.select();note('已选中链接，请按 Ctrl+C 复制','text-warning');}}
 function displayUrl(host,url,label='原始分享链接（保持不变）'){
  host.replaceChildren(el('div','small text-secondary mt-2 mb-1',label));
  const group=el('div','input-group input-group-sm cd-share-url');
  const field=el('input','form-control');field.value=url;field.readOnly=true;field.setAttribute('aria-label','可复制的原始分享地址');
  group.append(field,button('复制链接',()=>copyUrl(url,field),'btn btn-outline-primary'));host.append(group);
 }
 function syncCreate(){const v=mode.value;visible(expire.wrap,v!=='public');
  const never=expire.select.querySelector('option[value="never"]');never.disabled=v==='temporary';
  if(never.disabled&&expire.select.value==='never')expire.select.value='7d';expire.select.onchange();
  visible(limit.wrap,v!=='public');visible(pw.wrap,v==='page');visible(allow.wrap,v==='page');
  visible(keyWarning,v!=='public'&&keyStatus!=='ready');
  keyNotice.textContent=keyStatus==='invalid'?'SHARE_LINK_KEY 格式错误。请管理员配置 64 位十六进制密钥；当前无法安全创建可恢复链接。':'未配置 SHARE_LINK_KEY。新建链接将无法再次获取原地址，建议管理员先在 Worker Runtime Secrets 中配置。';
  visible(optOut,keyStatus==='not_configured');
  visible(publicWarning,v==='public');
  publicWarning.textContent=v==='public'?'新建永久直链固定为 /r/ 智能地址，更新文件后无需换链接；公开文件不支持密码或有效期，已经缓存的副本无法即时收回。':'';
  create.disabled=v!=='public'&&(keyStatus==='invalid'||(keyStatus==='not_configured'&&!optOutInput.checked));
 }
 mode.onchange=syncCreate;optOutInput.onchange=syncCreate;
 function panelMessage(panel,message,variant='warning'){
  let alert=panel.querySelector('.cd-share-row-message');
  if(!alert){alert=el('div','cd-share-row-message mt-2 small');panel.append(alert);}
  alert.className=`cd-share-row-message mt-2 small text-${variant}`;alert.textContent=message;
 }
 async function retrieve(s,card,urlHolder){
  if(knownUrls.has(s.id)){displayUrl(urlHolder,knownUrls.get(s.id));return;}
  urlHolder.replaceChildren(el('span','small text-secondary','正在安全获取原链接…'));
  try{const result=await requestJSON(`/api/v1/shares/${s.id}/link`);if(destroyed)return;
   knownUrls.set(s.id,result.url);displayUrl(urlHolder,result.url);
  }catch(err){if(!destroyed){urlHolder.replaceChildren();panelMessage(card,err.message,'danger');}}
 }
 async function rotate(s,card){
  if(keyStatus!=='ready')return panelMessage(card,'请先配置正确的 SHARE_LINK_KEY，以保证生成的新链接以后仍可找回。','danger');
  if(!window.confirm('轮换链接后，原地址立即失效，已经发给别人的旧链接将无法访问。确定继续？'))return;
  try{const result=await requestJSON(`/api/v1/shares/${s.id}/rotate`,{method:'POST'});
   knownUrls.set(s.id,result.url);note('已轮换为新地址，旧链接立即失效','text-success');await loadExisting();onChanged();
  }catch(err){panelMessage(card,err.message,'danger');}
 }
 function editorFor(s,card){
  if(activeEditor?.isConnected)activeEditor.remove();
  const panel=el('div','card mt-3 border-primary cd-share-editor');const form=el('div','card-body');panel.append(form);
  form.append(el('h4','h6','修改现有链接的属性（URL 不变）'));
  const expired=s.status==='expired';const expiry=expiryControls(s.expires_at&&!expired?'custom':s.expires_at?'7d':'never');
  if(s.expires_at&&!expired){const dt=utcDate(s.expires_at);if(dt){expiry.custom.value=localInputFromUtc(dt);visible(expiry.custom,true);}}
  const never=expiry.select.querySelector('option[value="never"]');never.disabled=s.type==='temporary';
  const max=downloadLimit(s.max_downloads),allowed=allowField(s.allow_download);form.append(expiry.wrap,max.wrap);
  if(s.type==='page')form.append(allowed.wrap);
  const pwAction=el('select','form-select form-select-sm mb-2');
  for(const [value,label] of [['keep','保留现有访问密码'],['replace','设置或更换访问密码'],['clear','移除访问密码']]){
   const opt=el('option','',label);opt.value=value;pwAction.append(opt);
  }
  const password=passwordField();visible(password.wrap,false);pwAction.onchange=()=>visible(password.wrap,pwAction.value==='replace');
  if(s.type==='page')form.append(pwAction,password.wrap,el('div','small text-secondary mb-2','更换或移除密码后，之前已验证的访客需重新验证。'));
  const controls=el('div','d-flex gap-2 flex-wrap');const save=button('保存修改（保留原链接）',async()=>{
   try{const payload={expires_at:expiry.value(),max_downloads:max.value()};
    if(s.type==='page'){payload.allow_download=allowed.input.checked;payload.password_action=pwAction.value;if(pwAction.value==='replace')payload.password=password.input.value;}
    save.disabled=true;await requestJSON(`/api/v1/shares/${s.id}`,{method:'PATCH',body:payload});
    note('已修改属性，原分享链接保持不变','text-success');await loadExisting();onChanged();
   }catch(err){panelMessage(panel,err.message,'danger');}finally{save.disabled=false;}
  },'btn btn-sm btn-primary');
  controls.append(save,button('取消',()=>{panel.remove();activeEditor=null;}));form.append(controls);card.append(panel);activeEditor=panel;
 }
 async function loadExisting(){
  const seq=++fetchSeq;refresh.disabled=true;existingList.replaceChildren(el('div','text-secondary small','正在读取已有分享…'));
  try{
   const params=new URLSearchParams({target_type:kind,target_id:item.id});
   const data=await requestJSON(`/api/v1/shares?${params}`);
   if(destroyed||seq!==fetchSeq)return;keyStatus=data.link_key_status;
   const shares=(data.shares||[]).sort((a,b)=>(a.status==='active'?0:1)-(b.status==='active'?0:1));
   let publications=[];let pubMeta=null;
   if(isAdmin&&kind==='file'){
    try{pubMeta=await requestJSON(`/api/v1/publications?file_id=${encodeURIComponent(item.id)}`);publications=pubMeta.publications||[];}
    catch(err){panelMessage(existing,`读取公开链接失败：${err.message}`,'warning');}
   }
   if(destroyed||seq!==fetchSeq)return;
   existingList.replaceChildren();existingTitle.textContent=`已有分享 (${shares.length+publications.length})`;
   if(!shares.length&&!publications.length)existingList.append(el('p','text-secondary small','此文件尚未由当前账号创建分享。可以在下方新建链接。'));
   else existingList.append(el('p','text-secondary small mb-2','这里只显示由当前账号创建的私密分享；您可以直接取回原链接，编辑属性无需重新分享。'));
   if(!createTouched)setCreateOpen(!showExistingFirst(shares,publications));else setCreateOpen(createOpen);
   if(keyStatus!=='ready'&&shares.length){
    const message=keyStatus==='invalid'?'SHARE_LINK_KEY 格式不正确，无法解密原链接。请检查 Worker 的 Secret。':'未配置 SHARE_LINK_KEY。旧链接仍可访问，但未加密保存的链接无法反向找回。';
    existingList.append(el('div','small alert alert-warning py-2',message));
   }
   let autoLoad=null;
   for(const s of shares){
    const card=el('div','border rounded-3 p-3 mb-2 cd-share-card');const top=el('div','d-flex justify-content-between align-items-start gap-2');
    top.append(el('div','fw-semibold small',s.type==='page'?'分享页面':'临时授权直链'));
    const badge=el('span',`badge ${s.status==='active'?'text-bg-success':s.status==='expired'||s.status==='download_limit'?'text-bg-warning':'text-bg-secondary'}`,shareStatusLabel(s.status));top.append(badge);card.append(top);
    card.append(el('div','small text-secondary mt-1',`到期：${format(s.expires_at)} · ${s.has_password?'有密码':'无密码'} · ${s.allow_download?'允许下载':'禁止下载'} · ${s.max_downloads?`已下载 ${s.download_count}/${s.max_downloads}`:'不限下载次数'}`));
    const urlHolder=el('div','cd-share-link-holder');card.append(urlHolder);
    const state=shareRecoveryState(s,keyStatus),actions=el('div','d-flex flex-wrap gap-2 mt-2');
    if(knownUrls.has(s.id))displayUrl(urlHolder,knownUrls.get(s.id));
    else if(state==='recoverable'){
     actions.append(button('查看 / 复制原链接',()=>retrieve(s,card,urlHolder),'btn btn-sm btn-outline-primary'));
     if(!autoLoad&&['active','expired','download_limit'].includes(s.status))autoLoad=()=>retrieve(s,card,urlHolder);
    }else if(state==='legacy')card.append(el('div','small text-warning mt-2','这是旧版分享：只保存了令牌哈希，无法找回原地址。可在配置密钥后轮换出新地址，但会使旧链接失效。'));
    else if(state==='missing_key')card.append(el('div','small text-warning mt-2','该链接有加密记录，但当前缺少正确的 SHARE_LINK_KEY。请恢复原密钥，不要随意轮换。'));
    else card.append(el('div','small text-secondary mt-2','该分享已失效，不能取回或使用原链接。'));
    if(['active','expired','download_limit'].includes(s.status)){
     actions.append(button('编辑期限 / 密码 / 权限',()=>editorFor(s,card),'btn btn-sm btn-outline-secondary'));
     if(s.status==='active'&&keyStatus==='ready')actions.append(button('轮换链接',()=>rotate(s,card)));
     if(s.status==='expired')card.append(el('div','small text-warning mt-2','链接已经过期；修改有效期为未来日期后，原 URL 可以继续使用。'));
    }
    if(!s.revoked_at)actions.append(button('撤销',async()=>{
     if(!window.confirm('撤销后原链接将永久失效，确定吗？'))return;
     try{await requestJSON(`/api/v1/shares/${s.id}`,{method:'DELETE'});knownUrls.delete(s.id);note('已撤销分享','text-success');await loadExisting();onChanged();}
     catch(err){panelMessage(card,err.message,'danger');}
    },'btn btn-sm btn-outline-danger'));
    card.append(actions);existingList.append(card);
   }
   if(publications.length){existingList.append(el('h4','h6 mt-3','永久公开直链'));
    for(const p of publications){
     const card=el('div','border rounded-3 p-3 mb-2');
     card.append(el('div','small fw-semibold',`永久公开 · ${shareStatusLabel(p.status)} · ${p.delivery==='cdn'?'智能 CDN 加速':'Worker 流式访问'} · 发布 V${p.published_revision??'?'}`));
     if(p.status==='ready'&&p.url){
      const holder=el('div','mt-1');displayUrl(holder,p.url,'智能永久链接（始终解析最新发布版本）');card.append(holder);
      if(p.legacy_url&&p.legacy_url!==p.url){const older=el('div','mt-2');displayUrl(older,p.legacy_url,'原始 CDN 地址（兼容旧外链，缓存更新可能延迟）');card.append(older);}
      if(p.sync_state&&p.sync_state!=='ready'){
       card.append(el('div','small text-warning mt-2',`原始 CDN 地址同步状态：${p.sync_state}；/r/ 智能链接仍指向最新发布版本。`));
       card.append(button(p.sync_state==='cache_unverified'?'请求刷新 CDN 缓存':'重试原始 CDN 同步',async()=>{
        try{const r=await requestJSON(`/api/v1/publications/${p.id}/sync`,{method:'POST'});note(`同步结果：${r.status}`,'text-secondary');await loadExisting();}
        catch(err){panelMessage(card,err.message,'danger');}
       },'btn btn-sm btn-outline-primary mt-2'));
      }
      card.append(button('版本与同步',()=>{
       // Avoid stacking two Bootstrap modals: finish closing the share manager first.
       root.addEventListener('hidden.bs.modal',()=>{void openPublicationManager(p,{onChanged}).catch(e=>console.warn('公开版本管理不可用',e));},{once:true});
       modal.hide();
      },'btn btn-sm btn-outline-primary mt-2'));
      card.append(button('撤销公开',async()=>{if(!window.confirm('撤销后 /r/ 和 /p/ 立即拒绝新请求；CDN 与浏览器缓存的公开副本可能暂时保留。确定撤销？'))return;
       try{const result=await requestJSON(`/api/v1/publications/${p.id}`,{method:'DELETE'});note(result.warning||'公开发布已撤销','text-warning');await loadExisting();onChanged();}
       catch(err){panelMessage(card,err.message,'danger');}
      },'btn btn-sm btn-outline-danger mt-2'));
     }
     existingList.append(card);
    }
    if(pubMeta)existingList.append(el('p','small text-secondary',pubMeta.cdn_configured?`CDN：${pubMeta.cdn_base_url}`:'未配置公开 CDN 时，/r/ 由 Worker 直接提供最新文件。'));
   }
   syncCreate();
   if(autoLoad)await autoLoad();
  }catch(err){if(seq===fetchSeq&&!destroyed)existingList.replaceChildren(el('div','alert alert-warning small',err.message));}
  finally{if(seq===fetchSeq)refresh.disabled=false;}
 }
 create.onclick=async()=>{
  const v=mode.value;note('');
  if(!validShareOptions({mode:v,kind,expires:expire.select.value,password:v==='page'?pw.input.value:''}))return note('当前分享模式不适用于此文件或文件夹');
  if(v==='page'&&pw.input.value){const n=Array.from(pw.input.value).length;if(n<12||n>128)return note('分享访问密码需要 12–128 个字符');}
  if(v!=='public'&&keyStatus==='not_configured'&&!optOutInput.checked)return note('请先配置 SHARE_LINK_KEY，或明确确认这条链接只能在创建时复制');
  if(v!=='public'&&keyStatus==='invalid')return note('SHARE_LINK_KEY 格式错误，请管理员检查');
  try{
   const payload=v==='public'?{file_id:item.id}:{type:v,target_type:kind,target_id:item.id,expires_at:expire.value(),max_downloads:limit.value(),allow_download:v==='page'?allow.input.checked:true,require_recoverable:!optOutInput.checked,...(v==='page'&&pw.input.value?{password:pw.input.value}:{})};
   create.disabled=true;const result=await requestJSON(v==='public'?'/api/v1/publications':'/api/v1/shares',{method:'POST',body:payload});
   const urlHolder=el('div');displayUrl(urlHolder,result.url,'新分享已创建，请复制链接');createdLink.replaceChildren(urlHolder);visible(createdLink,true);
   note(result.warning||'创建成功','text-success');pw.input.value='';optOutInput.checked=false;await loadExisting();onCreated(result);onChanged();
  }catch(err){note(err.message);}finally{create.disabled=false;syncCreate();}
 };
 root.addEventListener('hidden.bs.modal',()=>{destroyed=true;knownUrls.clear();modal.dispose();root.remove();},{once:true});
 setCreateOpen(true);modal.show();await loadExisting();
}
