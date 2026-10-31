// RC14.11: super-admin editor, per-field usage notes, and aggregate stats.
// Never displays password hashes, Microsoft OAuth tokens, or temporary download URLs.
import {requestJSON} from '../api.js';
import {formatUtc} from '../utils/time.js';
const BASE='/api/v1/admin/onedrive/shares';
const create=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const selectOption=(value,title)=>{const e=create('option','',title);e.value=value;return e;};
function dateForInput(date){if(!date)return '';const d=new Date(date);if(!Number.isFinite(d.getTime()))return '';return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function metricTitle(name){return ({view:'页面浏览',download:'下载跳转',preview:'预览请求',unlock_failure:'密码失败',upstream_error:'上游异常'})[name]||name;}
export async function openSharePolicyDialog(host,share,{onSaved}={}){
 const id=share?.id;if(!/^od[fg]_[a-f0-9]{32}$/.test(id||''))return;
 const dialog=create('dialog','od-editor');const form=create('form','od-editor-form');form.method='dialog';form.addEventListener('submit',e=>e.preventDefault());
 const header=create('div','d-flex flex-wrap justify-content-between align-items-center gap-2');header.append(create('h2','h5 mb-0','OneDrive 分享权限与统计'));const close=create('button','btn btn-sm btn-outline-secondary','关闭');close.type='button';close.onclick=()=>dialog.close();header.append(close);form.append(header);
 const info=create('p','small text-secondary mb-1','权限由 CloudDrive 后端统一检查；合集中的文件继承合集权限。下载计数代表成功发出 302 跳转，不能证明文件已下载完成。');form.append(info);
 const alert=create('p','small text-secondary');alert.setAttribute('role','status');alert.textContent='正在读取权限设置…';form.append(alert);
 dialog.append(form);host.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
 let policy,stats;
 try{[policy,stats]=await Promise.all([requestJSON(`${BASE}/${id}/policy`),requestJSON(`${BASE}/${id}/stats`)]);}catch(e){alert.textContent='加载失败：'+(e.message||'请求错误');return;}
 if(!dialog.open)return;alert.textContent=`当前：${policy.status==='active'?'已启用':policy.status==='paused'?'已暂停':policy.status==='expired'?'已过期':'已撤销'} · ${policy.password_protected?'需要密码':'无需密码'}。`;
 if(policy.group_id){form.append(create('p','alert alert-info small',`此文件属于合集 ${policy.group_id}，请管理合集权限。`));return;}
 const field=(title,kind='text',value='',help='')=>{const wrap=create('div','od-edit-field');const lab=create('label','form-label small fw-semibold',title);const input=create('input','form-control form-control-sm');input.type=kind;input.value=value??'';lab.append(input);wrap.append(lab);if(help)wrap.append(create('p','form-text mb-0',help));form.append(wrap);return input;};
 const choice=(title,value,options,help)=>{const wrap=create('div','od-edit-field');const lab=create('label','form-label small fw-semibold',title);const sel=create('select','form-select form-select-sm');for(const [v,t] of options)sel.append(selectOption(v,t));sel.value=value;lab.append(sel);wrap.append(lab,create('p','form-text mb-0',help));form.append(wrap);return sel;};
 const toggle=(title,initial,help)=>{const wrap=create('div','od-edit-field');const label=create('label','form-check');const input=create('input','form-check-input');input.type='checkbox';input.checked=initial;label.append(input,create('span','form-check-label ms-2',title));wrap.append(label,create('p','form-text mb-0',help));form.append(wrap);return input;};
 const paused=toggle('暂停此分享',policy.status==='paused','暂停立即禁止分享页、预览、下载；恢复后保留原固定链接 ID。');
 const access=choice('访问范围',policy.access_mode,[['anyone','持有链接的访客'],['member','仅 CloudDrive 登录用户']],'限制为登录用户时，不要求 Microsoft 登录；仍需满足分享密码等其他限制。');
 const password=field('设置或更换访问密码','password','','留空表示保留现有密码，6–128 字符，PBKDF2-SHA256 加盐保存，不会在界面显示原密码。');password.autocomplete='new-password';password.maxLength=128;
 const clearPassword=toggle('移除现有密码',false,'选择移除后无需分享密码；与输入新密码不能同时操作。');
 const expiry=field('到期日期（浏览器本地时间）','datetime-local',dateForInput(policy.expires_at),'留空代表不限期。保存时自动转换为 UTC；过期分享可通过设置未来日期恢复。');
 const maxViews=field('最多页面浏览次数','number',policy.max_views??'','留空表示不限制；计数按分享元数据页面成功读取次数累计，不是独立访客数。');
 const maxDownloads=field('最多下载跳转次数','number',policy.max_downloads??'','留空表示不限制；302 跳转计数不能阻止已经发放的微软临时地址再次使用。');
 for(const field of [maxViews,maxDownloads]){field.min='1';field.max='1000000';field.step='1';}
 const direct=toggle('分享页显示“复制下载直链”',policy.show_direct_link,'仅影响页面按钮，不撤销或隐藏已有 /r/odf_* 下载链接。');
 const summary=create('div','od-edit-field');summary.append(create('h3','h6 mt-2','访问统计（聚合）'));
 summary.append(create('p','small mb-2',`浏览：${policy.view_count||0} 次 · 下载跳转：${policy.download_count||0} 次`));
 if(stats.daily?.length){const rows=create('div','small od-share-daily');for(const d of stats.daily.slice(0,25)){rows.append(create('div','od-share-daily-row',`${d.utc_day} · ${metricTitle(d.metric)} ${d.amount}`));}summary.append(rows);}else summary.append(create('p','text-secondary small','最近 30 天暂无访问数据。'));
 form.append(summary);
 const actions=create('div','d-flex justify-content-end gap-2 mt-3');const save=create('button','btn btn-primary btn-sm','保存分享权限');save.type='button';save.onclick=async()=>{
  if(password.value&&clearPassword.checked){alert.textContent='不能同时设置和移除密码。';return;}
  const body={is_paused:paused.checked,access_mode:access.value,expires_at:expiry.value?new Date(expiry.value).toISOString():null,
   max_views:maxViews.value.trim()?Number(maxViews.value):null,max_downloads:maxDownloads.value.trim()?Number(maxDownloads.value):null,show_direct_link:direct.checked};
  if(password.value)body.password=password.value;if(clearPassword.checked)body.clear_password=true;
  save.disabled=true;alert.textContent='正在保存…';
  try{await requestJSON(`${BASE}/${id}/policy`,{method:'PATCH',body});alert.textContent='权限保存成功；旧密码解锁状态已失效。';password.value='';if(onSaved)await onSaved();dialog.close();}catch(e){alert.textContent=e.message||'保存失败';}finally{save.disabled=false;}
 };actions.append(save);form.append(actions);
}
export async function renderShareAnalytics(host,{onEdit}={}){
 host.replaceChildren(create('p','text-secondary small','正在加载分享统计…'));
 try{const [summary,result]=await Promise.all([requestJSON(`${BASE}/summary`),requestJSON(BASE)]);
  host.replaceChildren(create('h2','h6','OneDrive 分享权限与统计'));
  const info=create('p','small text-secondary','统计仅为 CloudDrive 请求汇总；下载跳转不代表微软端成功完成下载。无访客 IP、Cookie 或微软 Token 明文。');host.append(info);
  const counters=create('div','d-flex flex-wrap gap-2 mb-3');for(const [label,obj] of [['文件分享',summary.file],['文件夹/合集',summary.group]]){const c=create('div','p-3 border rounded flex-fill');c.append(create('div','fw-semibold',label),create('div','small text-secondary',`总数 ${obj.total||0} · 启用 ${obj.active||0} · 浏览 ${obj.views||0} · 下载跳转 ${obj.downloads||0}`));counters.append(c);}host.append(counters);
  const list=create('div','od-stats-list');for(const item of result.items){const row=create('div','od-pub-row');const body=create('div','od-pub-name');body.append(create('div','fw-semibold text-break',item.title||item.id),create('div','small text-secondary',`${item.kind==='group'?'合集':'文件'} · ${item.status==='revoked'?'已撤销':item.is_paused?'已暂停':'已发布'} · 浏览 ${item.view_count||0} · 下载跳转 ${item.download_count||0}`));row.append(body);
   if(item.status==='active'){const edit=create('button','btn btn-sm btn-outline-primary','权限与统计');edit.type='button';edit.onclick=()=>onEdit?.(item);row.append(edit);}list.append(row);}
  if(!result.items.length)list.append(create('p','text-secondary small','尚无 OneDrive 分享记录。'));host.append(list);
 }catch(e){host.replaceChildren(create('p','alert alert-danger',e.message||'统计加载失败'));}
}
