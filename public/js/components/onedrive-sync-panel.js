// RC14.12 administrator-only sync and runtime diagnostics. Never display tokens or Graph continuation URLs.
import {requestJSON} from '../api.js';
import {formatUtc} from '../utils/time.js';
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const button=(text,action)=>{const b=el('button',text,'btn btn-outline-primary btn-sm');b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await action();}catch(e){alert(e.message||'操作失败');}finally{b.disabled=false;}});return b;};
const labelField=(parent,title,field,explanation)=>{const wrapper=el('div','','mb-3');wrapper.append(el('label',title,'small fw-semibold d-block mb-1'),field,el('p',explanation,'form-text mb-0'));parent.append(wrapper);return wrapper;};
export const syncLabel=s=>({unknown:'尚未检查',healthy:'正常',changed:'检测到修改',missing:'来源不存在或已删除',denied:'访问被拒绝',reauthorize:'需要重新授权',throttled:'微软正在限流',error:'检查异常'})[s]||'未知';
function fmt(x){try{return x?formatUtc(x):'尚无记录';}catch{return x||'尚无记录';}}
export async function renderOneDriveSyncDashboard(host){
 host.replaceChildren(el('h2','OneDrive 同步与运维','h6'),el('p','仅检查已经公开发布的文件。不会自动公开 OneDrive 后来新增的文件，也不会缓存微软临时下载地址。','small text-secondary'));
 const operations=el('div','','d-flex flex-wrap gap-2 mb-3');const details=el('div','','mb-3');host.append(operations,details);
 const reload=async()=>{details.replaceChildren(el('p','正在读取同步状态…','small text-secondary'));const data=await requestJSON('/api/v1/admin/onedrive/sync/status');
  details.replaceChildren();const summary=el('div','','d-flex flex-wrap gap-2 mb-3');for(const [state,count] of Object.entries(data.status_counts||{}))summary.append(el('span',`${syncLabel(state)}：${count}`,'badge text-bg-light border'));details.append(summary);
  const drives=el('div','','mb-3');drives.append(el('h3','增量同步状态','h6'));if(!data.drives?.length)drives.append(el('p','尚未初始化 Delta 游标；首次运行时将建立最新变化基线。','small text-secondary'));
  for(const item of data.drives||[])drives.append(el('p',`${item.last_error_code||'正常'} · 最近检查 ${fmt(item.last_checked_at)} · 最近完成 ${fmt(item.last_completed_at)}`,'small text-secondary mb-1'));
  details.append(drives);const history=el('div');history.append(el('h3','最近变化与异常','h6'));if(!data.events?.length)history.append(el('p','暂无记录。','small text-secondary'));
  for(const item of data.events||[]){history.append(el('p',`${fmt(item.created_at)} · ${item.publication_id||'同步服务'} · ${item.kind} · ${item.code||'—'}`,'small text-secondary mb-1'));}details.append(history);
  details.append(el('p','统计由 D1 中已完成的检查记录汇总，不代表当前正在实时连接 Microsoft。历史异常记录会定期清理。','form-text'));
 };
 operations.append(button('刷新同步状态',reload),button('检查 Microsoft 授权',async()=>{const r=await requestJSON('/api/v1/admin/onedrive/sync/auth-check',{method:'POST'});const msg=r.healthy?`账户访问正常（${r.drive_type}）`:`无法访问微软文件：${r.code||'未知错误'}`;details.prepend(el('div',msg,r.healthy?'alert alert-success py-2':'alert alert-warning py-2'));}),button('立即运行一次同步',async()=>{
  const r=await requestJSON('/api/v1/admin/onedrive/sync/run',{method:'POST'});
  await reload();details.prepend(el('div',r.status==='skipped'?'后台同步正在运行或已暂停，请稍后再试。':`已完成同步检查：${r.status||'未知结果'}`,'alert alert-info py-2'));
 }));
 try{await reload();}catch(e){details.replaceChildren(el('p','无法查询同步状态：'+(e.message||'网络错误'),'text-danger small'));}
}
export async function renderOneDriveSyncSettings(host){
 const section=el('section','','border rounded p-3 mb-3');host.append(section);
 section.append(el('h3','OneDrive 文件同步与健康检查','h6'),el('p','这些设置只检查已发布文件。定时任务使用 Worker 的 Cron Trigger（UTC）。静态文件夹分享不会自动收录新文件。','small text-secondary'));
 const form=el('div'),report=el('p','','small text-secondary');section.append(form,report);
 try{
  const settings=await requestJSON('/api/v1/admin/settings');
  const bool=(text,key,help)=>{const input=el('input','','form-check-input');input.type='checkbox';input.checked=settings[key]!==false;const wrapper=el('label','','form-check mb-3');wrapper.append(input,el('span',text,'form-check-label ms-2'),el('p',help,'form-text mb-0'));form.append(wrapper);return input;};
  const sync=bool('启用定期文件健康检查','onedrive_sync_enabled','关闭后 Cron 不再检查 OneDrive 文件状态；已有分享链接与下载仍可使用。');
  const delta=bool('启用 Microsoft Graph Delta 增量检测','onedrive_delta_enabled','只获取变化事件，首次建立最新变化基线，不扫描或公开整个 OneDrive。若账号接口不支持，可关闭此选项，仅使用逐文件检查。');
  const number=(name,key,min,max,help)=>{const i=el('input','','form-control form-control-sm');i.type='number';i.min=String(min);i.max=String(max);i.step='1';i.value=String(settings[key]);labelField(form,name,i,help);return i;};
  const hours=number('同一文件最低检查间隔（小时）','onedrive_sync_interval_hours',1,168,'建议 6–24 小时；Microsoft 发生限流时将按 Retry-After 延迟，不会频繁重试。');
  const batch=number('每次 Cron 检查的最大文件数','onedrive_sync_batch_limit',1,20,'建议 8 项。数值越大，单次 Graph 请求越多；仍会限制单次处理数量。');
  form.append(button('保存同步设置',async()=>{
   const payload={onedrive_sync_enabled:sync.checked,onedrive_delta_enabled:delta.checked,onedrive_sync_interval_hours:Number(hours.value),onedrive_sync_batch_limit:Number(batch.value)};
   await requestJSON('/api/v1/admin/settings',{method:'PATCH',body:payload});report.textContent='同步设置已保存。';
  }));
  section.append(el('p','运维提示：如果管理员更换了 OneDrive 账户或文件被删除，系统会显示来源异常而不会自动撤销分享。出现 401 时请在此页面上方重新授权；出现 429 时先等待微软限制解除。','form-text mt-2'));
 }catch(e){form.replaceChildren(el('p','无法加载同步设置：'+(e.message||'请求失败'),'text-danger small'));}
}
