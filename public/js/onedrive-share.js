import {requestShareMetadata} from './onedrive-share-access.js';
// Public page: display only explicitly published metadata and never fetch admin API.
import {formatUtc} from './utils/time.js';
import {qrSvg} from './vendor/qr-code.js';
const id=location.pathname.match(/^\/s\/(odf_[a-f0-9]{32})$/)?.[1];
const api=`/api/v1/public/onedrive/${id}`;
const get=x=>document.getElementById(`ods-${x}`);
const state=get('state'),card=get('content');
function message(s){const m=get('message');m.hidden=!s;m.textContent=s||'';}
function copy(s){if(!navigator.clipboard?.writeText){message('浏览器没有开放剪贴板权限，请手动复制地址栏的链接。');return;}
 navigator.clipboard.writeText(s).then(()=>message('链接已复制。')).catch(()=>message('复制失败，请检查 HTTPS 或浏览器剪贴板权限。'));
}
function sizeText(n){if(!Number.isFinite(n)||n<0)return null;const units=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return `${n.toFixed(i===0?0:1)} ${units[i]}`;}
function kind(m){if(m?.startsWith('image/'))return '图片';if(m?.startsWith('video/'))return '视频';if(m==='application/pdf')return 'PDF 文档';return '文件';}
function failure(msg){state.hidden=false;state.className='ods-loading';state.textContent=msg;card.hidden=true;document.title='分享暂不可用 · CloudDrive';}
function createPreview(mime,src){const region=get('preview-media');region.replaceChildren();let el;
 if(mime?.startsWith('image/')){el=document.createElement('img');el.alt='文件内容预览';}
 else if(mime?.startsWith('video/')){el=document.createElement('video');el.controls=true;el.preload='metadata';el.playsInline=true;}
 else if(mime==='application/pdf'){el=document.createElement('iframe');el.title='PDF 预览';el.referrerPolicy='no-referrer';}
 else {region.textContent='此格式暂不支持在线预览，请使用下载按钮。';return;}
 el.src=src;el.addEventListener('error',()=>message('预览暂时不可用，可尝试下载文件。'));region.append(el);
}
async function load(){if(!id){failure('无效的 OneDrive 分享地址');return;}
 try{const j=await requestShareMetadata(api,id,get('access'));
  if(!j){state.hidden=true;return;}state.hidden=true;card.hidden=false;
  get('title').textContent=j.title||j.name;document.title=`${j.title||j.name} · CloudDrive`;
  const type=kind(j.mime_type);get('type').textContent=type+' · OneDrive';
  get('cover-icon').textContent=type==='图片'?'▣':type==='视频'?'▷':type==='PDF 文档'?'▤':'□';
  const description=get('description');description.textContent=j.description||'';description.hidden=!j.description;
  const cover=get('cover');cover.className=`ods-cover ods-theme-${['auto','icon','ocean','violet','forest'].includes(j.cover_style)?j.cover_style:'auto'}`;
  const coverImage=get('cover-image');if(j.cover_style==='auto'||j.has_custom_cover){coverImage.src=j.cover_url;coverImage.hidden=false;coverImage.onerror=()=>{coverImage.hidden=true;};}
  const meta=get('metadata');meta.replaceChildren();
  const notes=[sizeText(j.size),j.display_name?`分享者：${j.display_name}`:null,j.updated_at?`更新于 ${formatUtc(j.updated_at)}`:null,j.created_at?`发布于 ${formatUtc(j.created_at)}`:null].filter(Boolean);
  for(const s of notes){const chip=document.createElement('span');chip.textContent=s;meta.append(chip);}
  const download=new URL(j.download_url,location.origin).href;get('download').href=download;
  const pButton=get('preview-toggle');pButton.hidden=!j.preview_enabled;
  pButton.onclick=()=>{const section=get('preview');section.hidden=!section.hidden;pButton.textContent=section.hidden?'在线预览':'收起预览';if(!section.hidden&&!get('preview-media').childNodes.length)createPreview(j.mime_type,j.preview_url);};
  get('preview-close').onclick=()=>{get('preview').hidden=true;pButton.textContent='在线预览';get('preview-media').replaceChildren();};
  const share=new URL(j.share_url,location.origin).href;
  get('copy-page').onclick=()=>copy(share);get('copy-direct').hidden=j.show_direct_link===false;get('copy-direct').onclick=()=>copy(download);
  let svg='';get('qr-toggle').onclick=()=>{const panel=get('qr-panel');panel.hidden=!panel.hidden;
   if(!panel.hidden&&!svg){try{svg=qrSvg(share);get('qr-image').innerHTML=svg;}catch{panel.hidden=true;message('当前二维码无法生成。');}}};
  get('qr-save').onclick=()=>{if(!svg)return;const blob=new Blob([svg],{type:'image/svg+xml'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`clouddrive-${id}.svg`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);};
 }catch{failure('网络连接失败，请刷新页面。');}
}
void load();
