import {requestShareMetadata} from './onedrive-share-access.js';
// Anonymous static snapshot browser: D1 metadata only, no Graph credentials or URL.
import {formatUtc} from './utils/time.js';
import {qrSvg} from './vendor/qr-code.js';
const id=location.pathname.match(/^\/s\/(odg_[a-f0-9]{32})$/)?.[1];
const get=x=>document.getElementById('odg-'+x);
const nodes=new Map();let entries=[];let group=null;let current=null;let qrText='';
const make=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';n.textContent=text||'';return n;};
const url=x=>new URL(x,location.origin).href;
function notify(s){get('state').textContent=s;get('state').hidden=!s;}
function detailSize(n){if(!Number.isFinite(n)||n<0)return '';const units=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<4){n/=1024;i++;}return `${n.toFixed(i?1:0)} ${units[i]}`;}
function pathOf(folder){const list=[];const seen=new Set();let item=folder?nodes.get(folder):null;
 while(item&&item.type==='folder'&&!seen.has(item.id)){seen.add(item.id);list.unshift(item);item=item.parent_id?nodes.get(item.parent_id):null;}
 return list;
}
function go(parent){if(parent&&!nodes.has(parent))parent=null;current=parent;render();}
function render(){if(!group)return;
 const breadcrumb=get('breadcrumb');breadcrumb.replaceChildren();
 const root=make('button','','全部文件');root.type='button';root.disabled=current===null;root.onclick=()=>go(null);breadcrumb.append(root);
 for(const item of pathOf(current)){breadcrumb.append(make('span','odg-chevron','›'));const b=make('button','',item.name);b.type='button';b.disabled=item.id===current;b.onclick=()=>go(item.id);breadcrumb.append(b);}
 const list=get('list');list.replaceChildren();const visible=entries.filter(x=>x.parent_id===current).sort((a,b)=>(a.type===b.type?0:a.type==='folder'?-1:1)||a.name.localeCompare(b.name,'zh-CN'));
 get('count').textContent=`当前目录 ${visible.length} 项`;
 if(!visible.length){list.append(make('div','odg-empty','此目录暂无文件。'));return;}
 for(const item of visible){const line=make('div','odg-row');const emoji=make('span','odg-icon',item.type==='folder'?'📁':item.mime_type?.startsWith('image/')?'🖼️':item.mime_type?.startsWith('video/')?'🎞️':'📄');
  const meta=make('div','odg-fileinfo');const name=make('div','odg-name',item.name);meta.append(name);
  const sub=make('div','odg-filemeta',item.type==='folder'?'文件夹':[detailSize(item.size),item.updated_at?formatUtc(item.updated_at):null].filter(Boolean).join(' · '));meta.append(sub);
  const actions=make('div','odg-actions');
  if(item.type==='folder'){const open=make('button','odg-action odg-open','打开');open.type='button';open.onclick=()=>go(item.id);actions.append(open);line.classList.add('odg-is-folder');}
  else{
   for(const [label,path,primary] of [['预览',item.share_url,false],['下载',item.download_url,true]]){const a=make('a',`odg-action ${primary?'odg-download':''}`,label);a.href=path;a.rel='noopener noreferrer';if(!primary)a.target='_blank';actions.append(a);}
  }
  line.append(emoji,meta,actions);list.append(line);
 }
}
async function copy(value){try{await navigator.clipboard.writeText(value);notify('链接已复制。');}catch{notify('复制失败，请检查 HTTPS 和浏览器剪贴板权限。');}}
async function load(){if(!id){notify('分享地址无效。');return;}
 try{const info=await requestShareMetadata(`/api/v1/public/onedrive/groups/${id}`,id,get('access'));
  if(!info){notify('');get('list').replaceChildren();return;}
  group=info;entries=group.entries;nodes.clear();for(const item of entries)nodes.set(item.id,item);
  get('title').textContent=group.title;document.title=group.title+' · CloudDrive';get('kind').textContent=group.kind==='folder'?'OneDrive 文件夹分享':'OneDrive 自定义文件合集';
  get('desc').textContent=group.description||'';get('desc').hidden=!group.description;
  get('summary').textContent=`${group.item_count} 个文件 · ${group.folder_count} 个文件夹 · ${formatUtc(group.created_at)} 发布 · 静态快照`;
  notify('');go(null);
 }catch{notify('网络错误，请刷新后重试。');}}
get('copy').onclick=()=>copy(url(location.pathname));
get('qr-toggle').onclick=()=>{const panel=get('qr-panel');panel.hidden=!panel.hidden;
 if(!panel.hidden&&!qrText){try{qrText=qrSvg(url(location.pathname));get('qr-image').innerHTML=qrText;}catch{panel.hidden=true;notify('二维码暂不可用。');}}
};
get('qr-save').onclick=()=>{if(!qrText)return;const u=URL.createObjectURL(new Blob([qrText],{type:'image/svg+xml'}));const a=make('a');a.href=u;a.download=`clouddrive-${id}.svg`;a.click();setTimeout(()=>URL.revokeObjectURL(u),2000);};
void load();
