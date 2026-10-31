import {formatUtc} from '../utils/time.js';
import {requestJSON} from '../api.js';
import {openShareDialog,shareStatusLabel} from '../components/share-dialog.js';
import {openPublicationManager} from '../components/publication-manager.js';
const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const button=(name,fn,cls='btn btn-sm btn-outline-secondary')=>{const b=el('button',cls,name);b.type='button';b.onclick=fn;return b;};
const format=raw=>formatUtc(raw,{fallback:'永久'});
export async function renderShares(host){
 host.replaceChildren();host.append(el('h1','h3','分享管理'),el('p','small text-secondary','文件行的「分享」按钮和这里使用同一套弹窗：查看已有链接、编辑权限、重新获取或轮换链接。'));
 const message=el('div','mb-2'),filter=el('select','form-select form-select-sm mb-3');filter.style.maxWidth='230px';filter.setAttribute('aria-label','筛选分享状态');
 const categories=[['all','全部状态'],['active','有效'],['expired','已过期'],['download_limit','次数已耗尽'],['permission_revoked','权限失效'],['target_unavailable','源文件已删除'],['creator_disabled','账号已停用'],['revoked','已撤销']];
 for(const [v,label] of categories){const opt=el('option','',label);opt.value=v;filter.append(opt);}
 host.append(message,filter);const list=el('div','list-group');host.append(list);
 const publicationArea=el('div','mt-4');host.append(publicationArea);
 const info=(s,cls='alert-info')=>message.replaceChildren(el('div',`alert ${cls} py-2 small`,s));
 let records=[],isAdmin=false,publications=[];
 function redraw(){
  list.replaceChildren();const shown=records.filter(s=>filter.value==='all'||s.status===filter.value);
  if(!shown.length){list.append(el('div','list-group-item text-secondary','无匹配的分享记录。请在文件列表中选择文件并点击「分享」。'));return;}
  for(const s of shown){const row=el('div','list-group-item d-flex flex-wrap align-items-center gap-2');
   const details=el('div','flex-grow-1');details.append(el('div','fw-semibold text-break',s.target_name||`${s.target_type==='folder'?'文件夹':'文件'}（源文件可能不可用）`));
   details.append(el('div','small text-secondary',`${s.type==='page'?'分享页面':'临时直链'} · ${shareStatusLabel(s.status)} · 到期 ${format(s.expires_at)}${s.has_password?' · 已设访问密码':''}${s.max_downloads?` · 下载 ${s.download_count}/${s.max_downloads}`:''}`));
   row.append(details,button('查看原链接 / 编辑',()=>openShareDialog({id:s.target_id,kind:s.target_type,name:s.target_name||'已删除文件'},{isAdmin,onChanged:refresh,onCreated:refresh}),'btn btn-sm btn-outline-primary'));
   list.append(row);
  }
 }
 function drawPublications(meta){publicationArea.replaceChildren();if(!isAdmin)return;
  publicationArea.append(el('h2','h5','永久公开直链（R2）'));
  publicationArea.append(el('p','small text-secondary',meta.cdn_configured?`CDN 已配置：${meta.cdn_base_url}${meta.purge_configured?' · 已配置自动清理缓存':' · 未配置自动缓存清理'}`:'未绑定 R2 CDN 自定义域名时，/r/ 由 Worker 流式提供最新公开版本。'));
  if(!publications.length){publicationArea.append(el('div','small text-secondary','尚无公开发布记录'));return;}
  const wrap=el('div','list-group');for(const pub of publications){const row=el('div','list-group-item d-flex align-items-center flex-wrap gap-2');
   const label=el('div','flex-grow-1');label.append(el('div','fw-semibold text-break',pub.name||pub.public_path),el('div','text-secondary small',`${shareStatusLabel(pub.status)} · ${pub.delivery==='cdn'?'智能 CDN':'Worker'} · 发布 V${pub.published_revision??'?' } · ${pub.sync_state==='ready'?'旧地址已同步':'旧地址待同步'} · ${format(pub.created_at)}`));
   row.append(label);
   if(pub.status==='ready'&&pub.url){row.append(button('版本与同步',()=>openPublicationManager(pub,{onChanged:refresh}),'btn btn-sm btn-outline-primary'));row.append(button('复制智能永久链接',async()=>{try{await navigator.clipboard.writeText(pub.url);info('链接已复制','alert-success');}catch{info(`请手动复制公开 URL：${pub.url}`,'alert-warning');}},'btn btn-sm btn-outline-primary'));
    row.append(button('撤销公开',async()=>{if(!confirm('确定撤销 R2 公开副本？CDN 缓存可能仍有效。'))return;try{const r=await requestJSON(`/api/v1/publications/${pub.id}`,{method:'DELETE'});info(r.warning,'alert-warning');await refresh();}catch(e){info(e.message,'alert-danger');}},'btn btn-sm btn-outline-danger'));
   }
   wrap.append(row);
  }publicationArea.append(wrap);
 }
 async function refresh(){try{
  const data=await requestJSON('/api/v1/shares');records=data.shares||[];
  const me=await requestJSON('/api/v1/auth/me');isAdmin=me.user?.role==='super_admin';redraw();
  if(isAdmin){const pub=await requestJSON('/api/v1/publications');publications=pub.publications||[];drawPublications(pub);}else publicationArea.replaceChildren();
 }catch(e){info(e.message,'alert-danger');}}
 filter.onchange=redraw;await refresh();
}
