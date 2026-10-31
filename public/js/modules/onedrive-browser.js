// RC14.8 - OneDrive explorer. All Microsoft calls run through admin-only Worker APIs.
import {requestJSON} from '../api.js';
import {formatUtc} from '../utils/time.js';
import {bindFolderDoubleClick} from '../utils/folder-open.js';
import {openShareWizard,openGroupEditor} from '../components/onedrive-share-wizard.js';
import {openSharePolicyDialog,renderShareAnalytics} from '../components/onedrive-share-policy.js';
import {renderOneDriveSyncDashboard,syncLabel} from '../components/onedrive-sync-panel.js';

const api='/api/v1/admin/onedrive/drive';
const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const btn=(text,fn,cls='btn btn-sm btn-outline-secondary')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const option=(value,label)=>{const x=el('option','',label);x.value=value;return x;};
const bytes=n=>n>=1073741824?`${(n/1073741824).toFixed(2)} GB`:n>=1048576?`${(n/1048576).toFixed(1)} MB`:n>=1024?`${(n/1024).toFixed(1)} KB`:`${n||0} B`;
const glyph=item=>item.folder?'📁':item.type==='image'?'🖼️':item.type==='video'?'🎞️':item.type==='audio'?'🎵':item.type==='document'?'📄':'📦';
const isImage=item=>!item.folder&&['image','video','document'].includes(item.type);
function shareUrl(path){return new URL(path,location.origin).href;}
function safeAction(fn,handle){return async()=>{try{await fn();}catch(e){handle(e);}};}
function messageFor(e){if(e.code==='MICROSOFT_THROTTLED')return '微软接口请求过于频繁，请稍后刷新。';if(e.code==='MICROSOFT_REAUTHORIZE'||e.code==='ONEDRIVE_NOT_CONNECTED')return 'Microsoft 授权已失效，请前往系统设置重新连接。';if(e.code==='INVALID_CURSOR')return '分页已过期或浏览条件发生变化，请刷新当前目录。';return e.message||'操作失败';}
const fieldOptions=[['all','全部类型'],['folder','文件夹'],['image','图片'],['video','视频'],['document','文档'],['audio','音频'],['other','其他']];
const orderOptions=[['name_asc','名称 A → Z'],['name_desc','名称 Z → A'],['updated_desc','最近修改'],['updated_asc','最早修改'],['size_desc','文件从大到小'],['size_asc','文件从小到大']];
function searchSorted(items,sort){const copy=[...items];const name=(a,b)=>a.name.localeCompare(b.name,'zh-CN',{sensitivity:'base'});const c={name_asc:name,name_desc:(a,b)=>-name(a,b),updated_desc:(a,b)=>(b.updated_at||'').localeCompare(a.updated_at||'')||name(a,b),updated_asc:(a,b)=>(a.updated_at||'').localeCompare(b.updated_at||'')||name(a,b),size_desc:(a,b)=>b.size-a.size||name(a,b),size_asc:(a,b)=>a.size-b.size||name(a,b)};return copy.sort(c[sort]||name);}

export async function renderOneDriveBrowser(host){
 const id=crypto.randomUUID();host.dataset.odBrowser=id;host.replaceChildren();
 const alive=()=>host.isConnected&&host.dataset.odBrowser===id;
 let seq=0,busy=false,items=[],nextCursor=null,sortOnClient=false,view='grid',sort='name_asc',filter='all',query='',trail=[{id:'root',name:'我的文件'}];
 const selected=new Map(),thumbnailCache=new Map();let observer=null,searchTimer=0,tab='files';
 try{view=localStorage.getItem('cd.od.view')==='list'?'list':'grid';const last=localStorage.getItem('cd.od.sort');if(orderOptions.some(x=>x[0]===last))sort=last;}catch{}
 const header=el('div','d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3');
 const name=el('div');name.append(el('h1','h3 mb-1','OneDrive 文件'),el('p','text-secondary small mb-0','浏览已授权文件、选择内容并生成固定下载直链。文件仍保存在 OneDrive。'));
 const headActions=el('div','d-flex gap-2 flex-wrap');const account=el('span','badge text-bg-light border align-self-center','正在检查连接');
 const settings=el('a','btn btn-outline-secondary btn-sm','账户设置');settings.href='/settings?tab=onedrive';settings.dataset.route='settings';
 const refresh=btn('↻ 刷新',()=>{if(tab==='shares')void loadPublications();else if(tab==='groups')void loadGroups();else if(tab==='stats')void loadStatistics();else if(tab==='sync')void renderOneDriveSyncDashboard(syncPanel);else void load(true);},'btn btn-outline-primary btn-sm');headActions.append(account,settings,refresh);header.append(name,headActions);host.append(header);
 const notice=el('div','mb-3');host.append(notice);
 function say(text,tone='warning'){if(!alive())return;notice.replaceChildren(el('div',`alert alert-${tone} py-2 small mb-0`,text));}
 const tabs=el('div','d-flex gap-2 mb-3 flex-wrap');const fileTab=btn('文件浏览',()=>setTab('files'),'btn btn-sm btn-primary');const shareTab=btn('已发布直链',()=>setTab('shares'),'btn btn-sm btn-outline-secondary');const groupTab=btn('文件夹与合集分享',()=>setTab('groups'),'btn btn-sm btn-outline-secondary');const statsTab=btn('权限与统计',()=>setTab('stats'),'btn btn-sm btn-outline-secondary');const syncTab=btn('同步与运维',()=>setTab('sync'),'btn btn-sm btn-outline-secondary');tabs.append(fileTab,shareTab,groupTab,statsTab,syncTab);host.append(tabs);
 const main=el('section','');const pubs=el('section','panel p-3');pubs.hidden=true;const groups=el('section','panel p-3');groups.hidden=true;const stats=el('section','panel p-3');stats.hidden=true;const syncPanel=el('section','panel p-3');syncPanel.hidden=true;host.append(main,pubs,groups,stats,syncPanel);
 const toolbar=el('div','panel p-3 mb-3 od-toolbar');
 const first=el('div','d-flex flex-wrap gap-2 align-items-center');
 const search=el('input','form-control form-control-sm od-search');search.type='search';search.placeholder='搜索整个 OneDrive（按文件名或内容）';search.setAttribute('aria-label','搜索整个 OneDrive');
 const searchButton=btn('搜索',()=>applySearch(),'btn btn-sm btn-primary');const clearSearch=btn('清除搜索',()=>{search.value='';applySearch();});
 const typeSelect=el('select','form-select form-select-sm od-select');typeSelect.setAttribute('aria-label','文件类型筛选');for(const [v,n] of fieldOptions)typeSelect.append(option(v,n));
 const sortSelect=el('select','form-select form-select-sm od-select');sortSelect.setAttribute('aria-label','排序方式');for(const [v,n] of orderOptions)sortSelect.append(option(v,n));sortSelect.value=sort;
 const views=el('div','btn-group btn-group-sm');views.setAttribute('role','group');views.setAttribute('aria-label','显示方式');const gridBtn=btn('▦ 网格',()=>setView('grid'));const listBtn=btn('☰ 列表',()=>setView('list'));views.append(gridBtn,listBtn);
 first.append(search,searchButton,clearSearch,typeSelect,sortSelect,views);toolbar.append(first);
 const tips=el('div','small text-secondary mt-2','筛选仅作用于已加载的文件；文件夹排序由 OneDrive 提供。');toolbar.append(tips);main.append(toolbar);
 const breadcrumb=el('nav','d-flex align-items-center flex-wrap gap-1 small mb-3 od-trail');breadcrumb.setAttribute('aria-label','目录路径');main.append(breadcrumb);
 const selectionBar=el('div','d-flex gap-2 flex-wrap align-items-center mb-3');const count=el('span','small text-secondary');const selectAll=btn('选择当前可见项',()=>{for(const x of shown())selected.set(x.id,x);draw();});const clear=btn('清除选择',()=>{selected.clear();draw();});const copyNames=btn('复制所选文件名',async()=>{try{await navigator.clipboard.writeText([...selected.values()].map(x=>x.name).join('\n'));say('已复制所选文件名。','success');}catch{say('浏览器不允许复制，请检查 HTTPS 和剪贴板权限。');}});
 const shareOne=btn('发布所选单个文件',()=>{const item=[...selected.values()].find(x=>!x.folder);if(item)void publish(item);},'btn btn-sm btn-outline-primary');const shareWizard=btn('创建分享 / 批量发布',()=>openShareWizard(host,[...selected.values()],{onComplete:()=>say('分享已创建，可在对应分享列表中管理。','success')}),'btn btn-sm btn-primary');selectionBar.append(count,selectAll,clear,copyNames,shareOne,shareWizard);main.append(selectionBar);
 const result=el('div','panel od-results');result.setAttribute('aria-label','OneDrive 文件');main.append(result);
 const footer=el('div','d-flex flex-wrap align-items-center justify-content-between gap-2 my-3');const summary=el('span','small text-secondary');const more=btn('加载更多文件',()=>void load(false),'btn btn-sm btn-outline-primary');footer.append(summary,more);main.append(footer);
 function setTab(which){tab=which;main.hidden=which!=='files';pubs.hidden=which!=='shares';groups.hidden=which!=='groups';stats.hidden=which!=='stats';syncPanel.hidden=which!=='sync';syncTab.className=which==='sync'?'btn btn-sm btn-primary':'btn btn-sm btn-outline-secondary';statsTab.className=which==='stats'?'btn btn-sm btn-primary':'btn btn-sm btn-outline-secondary';fileTab.className=which==='files'?'btn btn-sm btn-primary':'btn btn-sm btn-outline-secondary';shareTab.className=which==='shares'?'btn btn-sm btn-primary':'btn btn-sm btn-outline-secondary';groupTab.className=which==='groups'?'btn btn-sm btn-primary':'btn btn-sm btn-outline-secondary';if(which==='shares')void loadPublications();if(which==='groups')void loadGroups();if(which==='stats')void loadStatistics();if(which==='sync')void renderOneDriveSyncDashboard(syncPanel);}
 async function loadStatistics(){await renderShareAnalytics(stats,{onEdit:item=>void openSharePolicyDialog(host,item,{onSaved:()=>loadStatistics()})});}
 function setView(value){view=value;try{localStorage.setItem('cd.od.view',value);}catch{}draw();}
 function applySearch(){clearTimeout(searchTimer);const v=search.value.trim();if(v.length>120){say('搜索内容不能超过 120 字符。');return;}if(v===query)return;query=v;void load(true);}
 search.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(alive())applySearch();},550);});
 search.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();applySearch();}});
 typeSelect.addEventListener('change',()=>{filter=typeSelect.value;draw();});
 sortSelect.addEventListener('change',()=>{sort=sortSelect.value;try{localStorage.setItem('cd.od.sort',sort);}catch{}void load(true);});
 function shown(){const filtered=items.filter(x=>filter==='all'||(filter==='folder'?x.folder:x.type===filter));return sortOnClient?searchSorted(filtered,sort):filtered;}
 function renderTrail(){breadcrumb.replaceChildren();if(query){breadcrumb.append(el('span','text-secondary','整个 OneDrive / 搜索结果'));breadcrumb.append(btn('返回文件夹',()=>{search.value='';query='';void load(true);},'btn btn-link btn-sm text-decoration-none'));return;}
  trail.forEach((item,i)=>{if(i)breadcrumb.append(el('span','text-secondary','›'));const link=btn(item.name,()=>{trail=trail.slice(0,i+1);void load(true);},'btn btn-link btn-sm text-decoration-none od-crumb');link.disabled=i===trail.length-1;breadcrumb.append(link);});}
 function folder(item){if(!item.folder)return;const fromSearch=!!query;clearTimeout(searchTimer);search.value='';query='';if(fromSearch)trail=[{id:'root',name:'我的文件'}];trail.push({id:item.id,name:item.name});void load(true);}
 function displayImage(item){
  const wrap=el('div','od-thumbnail');wrap.append(el('span','od-glyph',glyph(item)));
  if(!isImage(item))return wrap;
  const img=el('img','od-thumb-image');img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.decoding='async';img.addEventListener('load',()=>wrap.classList.add('od-has-image'));img.addEventListener('error',()=>{wrap.classList.remove('od-has-image');img.remove();});wrap.append(img);
  const thumb=item.thumbnail_url||thumbnailCache.get(item.id);
  if(thumb)img.src=thumb;
  else if(observer&&!thumbnailCache.has(item.id)){wrap.dataset.item=item.id;observer.observe(wrap);}
  return wrap;
 }
 async function findThumbnail(itemId){
  if(thumbnailCache.has(itemId))return;
  // Concurrency is bound by the queue; never expose the Graph bearer token in an img URL.
  try{const info=await requestJSON(`${api}/thumbnail?item=${encodeURIComponent(itemId)}`);if(!alive())return;thumbnailCache.set(itemId,info.url||null);
   if(info.url)for(const wrap of result.querySelectorAll('.od-thumbnail')){if(wrap.dataset.item===itemId){const img=wrap.querySelector('img');if(img&&!img.src)img.src=info.url;}}
  }catch{thumbnailCache.set(itemId,null);}
 }
 let thumbInFlight=0;const thumbQueue=[];
 function queueThumbnail(itemId){if(thumbnailCache.has(itemId)||thumbQueue.includes(itemId))return;thumbQueue.push(itemId);pump();}
 function pump(){while(thumbInFlight<3&&thumbQueue.length){const item=thumbQueue.shift();if(!alive())return;thumbInFlight++;void findThumbnail(item).finally(()=>{thumbInFlight--;pump();});}}
 if(typeof IntersectionObserver!=='undefined')observer=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting){observer.unobserve(e.target);queueThumbnail(e.target.dataset.item);}}},{rootMargin:'120px'});
 function checkbox(item){const ch=el('input','form-check-input od-check');ch.type='checkbox';ch.checked=selected.has(item.id);ch.setAttribute('aria-label',`选择 ${item.name}`);ch.addEventListener('change',()=>{if(ch.checked)selected.set(item.id,item);else selected.delete(item.id);draw();});return ch;}
 function makeCard(item){const card=el('article','od-card');const thumb=displayImage(item);card.append(thumb);
  const label=el('div','od-card-name text-break',item.name);label.title=item.name;
  if(item.folder){label.tabIndex=0;label.setAttribute('aria-label',`打开文件夹 ${item.name}`);label.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();folder(item);}});}card.append(label);
  card.append(el('div','small text-secondary',item.folder?'文件夹 · '+(item.child_count??'—')+' 项':bytes(item.size)));
  card.append(el('div','small text-secondary od-date',formatUtc(item.updated_at)));
  const actions=el('div','od-actions');actions.append(checkbox(item));actions.append(btn(item.folder?'打开':'发布直链',()=>item.folder?folder(item):void publish(item),'btn btn-outline-primary btn-sm'));
  card.append(actions);if(item.folder)bindFolderDoubleClick(card,()=>folder(item));return card;}
 function makeRow(item){const row=el('div','od-list-row');row.append(checkbox(item));const thumb=displayImage(item);row.append(thumb);
  const text=el('div','od-list-name');const fileName=el('div','fw-semibold text-break',item.name);
  if(item.folder){fileName.tabIndex=0;fileName.setAttribute('aria-label',`打开文件夹 ${item.name}`);fileName.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();folder(item);}});}text.append(fileName,el('div','small text-secondary',item.folder?'文件夹':item.mime_type||'文件'));
  row.append(text,el('div','small text-secondary od-list-size',item.folder?'—':bytes(item.size)),el('div','small text-secondary od-list-date',formatUtc(item.updated_at)),btn(item.folder?'打开':'发布直链',()=>item.folder?folder(item):void publish(item),'btn btn-outline-primary btn-sm'));
  if(item.folder)bindFolderDoubleClick(row,()=>folder(item));return row;}
 function draw(){if(!alive())return;
  observer?.disconnect();
  gridBtn.classList.toggle('active',view==='grid');listBtn.classList.toggle('active',view==='list');
  const visible=shown();result.replaceChildren();if(!visible.length){result.append(el('div','text-secondary text-center p-5',busy?'正在读取文件…':items.length?'当前筛选条件下没有文件。':'文件夹为空，或没有符合搜索条件的文件。'));}
  else{const layout=el('div',view==='grid'?'od-grid':'od-list');for(const item of visible)layout.append(view==='grid'?makeCard(item):makeRow(item));result.append(layout);}
  count.textContent=`已选择 ${selected.size} 项 · 当前展示 ${visible.length} / 已加载 ${items.length} 项`;
  clear.disabled=copyNames.disabled=!selected.size;shareOne.disabled=selected.size!==1||[...selected.values()][0]?.folder;shareWizard.disabled=!selected.size||selected.size>30;
  selectAll.disabled=!visible.length;
  summary.textContent=`已加载 ${items.length} 项${nextCursor?' · 还有下一页':' · 已到末页'}`;
  more.hidden=!nextCursor;more.disabled=busy;
  if(query)tips.textContent='搜索范围：整个 OneDrive。搜索结果只对已加载部分排序与筛选；继续加载可查看更多。';
  else tips.textContent=sortOnClient?'当前 OneDrive 不支持此服务端排序，已按加载记录排序；可继续加载更多。':'当前文件夹按 OneDrive 服务端排序，类型筛选作用于已加载文件。';
  renderTrail();
 }
 async function load(reset){if(!alive()||busy&&!reset)return;const mySeq=++seq;busy=true;
  if(reset){items=[];nextCursor=null;sortOnClient=!!query;thumbnailCache.clear();thumbQueue.length=0;notice.replaceChildren();}
  draw();
  try{const u=new URL(`${api}/browse`,location.origin);u.searchParams.set('parent',trail.at(-1).id);u.searchParams.set('sort',sort);if(query)u.searchParams.set('q',query);if(!reset&&nextCursor)u.searchParams.set('cursor',nextCursor);
   const data=await requestJSON(u.pathname+u.search);if(!alive()||mySeq!==seq)return;
   const old=new Set(items.map(x=>x.id));items.push(...data.items.filter(x=>!old.has(x.id)));nextCursor=data.next_cursor||null;sortOnClient=data.sort_scope==='client_loaded_results';
   if(data.thumbnail_expand_supported===false&&!query)say('此账号不支持批量缩略图，已改为滚动时按需获取。','info');
  }catch(e){if(alive()&&mySeq===seq){say(messageFor(e),'danger');if(!reset&&e.code==='INVALID_CURSOR')nextCursor=null;}}
  finally{if(alive()&&mySeq===seq){busy=false;draw();}}
 }
 async function editPresentation(record){
  if(!alive())return;
  const dialog=el('dialog','od-editor');const content=el('form','od-editor-form');content.method='dialog';
  const heading=el('div','d-flex align-items-center justify-content-between gap-3');heading.append(el('h2','h5 mb-0','编辑 OneDrive 分享展示'),btn('关闭',()=>dialog.close()));content.append(heading);
  const note=el('p','small text-secondary mb-1','分享页 /s/odf_* 用于展示文件信息；旧 /r/odf_* 下载直链不会改变。所有持有链接的访问者仍可下载文件，请勿发布私人资料。');content.append(note);
  function field(label,initial,max,multiline=false,help=''){
   const wrapper=el('div','od-edit-field');const name=el('label','form-label small fw-semibold',label);const node=el(multiline?'textarea':'input','form-control form-control-sm');if(multiline)node.rows=3;node.maxLength=max;node.value=initial||'';node.id='od-edit-'+label;name.htmlFor=node.id;wrapper.append(name,node);if(help)wrapper.append(el('p','form-text mb-0',help));content.append(wrapper);return node;
  }
  const title=field('分享标题',record.title||record.file_name,140,false,'留空后使用文件原名称。');
  const description=field('文件介绍',record.description,1200,true,'可加入文件用途、阅读说明；最多 1200 字，不允许 HTML。');
  const displayName=field('分享者显示名称',record.display_name,80,false,'可留空，不会自动公开 Microsoft 账号名称。');
  const coverGroup=el('div','od-edit-field');coverGroup.append(el('label','form-label small fw-semibold','封面风格'));
  const styles=el('select','form-select form-select-sm');for(const [value,label] of [['auto','自动获取 OneDrive 缩略图'],['icon','简洁文件图标'],['ocean','海蓝渐变'],['violet','淡紫渐变'],['forest','薄荷绿渐变']])styles.append(option(value,label));styles.value=record.cover_style||'auto';coverGroup.append(styles,el('p','form-text mb-0','自动缩略图受 Microsoft 接口支持情况影响，失败后会回退文件图标。'));content.append(coverGroup);
  const previewBox=el('label','od-edit-check form-check');const preview=el('input','form-check-input');preview.type='checkbox';preview.checked=record.preview_enabled!==0;previewBox.append(preview,el('span','form-check-label ms-2','允许访客在线预览图片、PDF 和受支持的视频'));content.append(previewBox);
  const coverArea=el('div','od-edit-field');coverArea.append(el('label','form-label small fw-semibold','自定义封面（可选）'));
  const upload=el('input','form-control form-control-sm');upload.type='file';upload.accept='image/jpeg,image/png,image/webp';coverArea.append(upload,el('p','form-text mb-0','支持 JPEG / PNG / WebP，最多 2 MB，上传后存储在 CloudDrive 私有 R2。'));
  const removeCover=btn('删除已有自定义封面',async()=>{try{await requestJSON(`${api}/publications/${record.id}/cover`,{method:'DELETE'});removeCover.disabled=true;feedback.textContent='自定义封面已删除。';}catch(e){feedback.textContent=messageFor(e);}},'btn btn-sm btn-outline-danger mt-2');removeCover.hidden=!record.has_custom_cover;coverArea.append(removeCover);content.append(coverArea);
  const feedback=el('p','od-edit-feedback small text-secondary');feedback.setAttribute('role','status');content.append(feedback);
  const actions=el('div','d-flex gap-2 flex-wrap justify-content-end');const shareLink=el('a','btn btn-sm btn-outline-primary','查看分享页面');shareLink.href=shareUrl(record.share_url||`/s/${record.id}`);shareLink.target='_blank';shareLink.rel='noopener noreferrer';const save=btn('保存展示设置',async()=>{
   const f=upload.files?.[0];if(f&&(f.size>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(f.type))){feedback.textContent='请上传 2 MB 以内的 JPEG、PNG 或 WebP 图片。';return;}
   save.disabled=true;feedback.textContent='正在保存…';
   try{
    await requestJSON(`${api}/publications/${record.id}`,{method:'PATCH',body:{title:title.value,description:description.value,display_name:displayName.value,cover_style:styles.value,preview_enabled:preview.checked}});
    if(f){const response=await fetch(`${api}/publications/${record.id}/cover`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':f.type},body:f});const j=await response.json();if(!response.ok||!j.success)throw new Error(j.error?.message||'封面上传失败');}
    if(!alive())return;dialog.close();say('分享页面设置已保存。','success');if(tab==='shares')void loadPublications();
   }catch(e){feedback.textContent=messageFor(e);}finally{save.disabled=false;}
  },'btn btn-sm btn-primary');actions.append(shareLink,save);content.append(actions);dialog.append(content);host.append(dialog);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
 }
 async function publish(item){if(!alive()||item.folder)return;
  if(!confirm(`确定将“${item.name}”发布成可公开访问的直链？\n任何获得此链接的人均可使用管理员授权下载该文件，包括原本在 OneDrive 中为私人文件的内容。`))return;
  try{const created=await requestJSON(`${api}/publish`,{method:'POST',body:{item_id:item.id,confirm_public:true}});if(!alive())return;
   say(`已发布“${item.name}”：分享页面 ${shareUrl(created.share_url)} · 下载直链 ${shareUrl(created.url)}`,'success');
   // Immediately offer optional editing. Canceling the editor does not revoke the new publication.
   void editPresentation({...created,file_name:item.name,preview_enabled:1,cover_style:'auto'});
  }catch(e){say(messageFor(e),'danger');}
 }
 async function loadGroups(){groups.replaceChildren(el('div','text-secondary small','正在加载文件夹和合集分享…'));
  try{const data=await requestJSON('/api/v1/admin/onedrive/groups');if(!alive()||tab!=='groups')return;
   groups.replaceChildren();groups.append(el('h2','h6','已发布文件夹与合集'));
   groups.append(el('p','small text-secondary','当前使用静态快照：OneDrive 后续新增的文件不会自动公开。撤销后，合集内的所有专属文件直链也会停止访问。'));
   if(!data.items.length){groups.append(el('p','small text-secondary','尚无文件夹或合集分享。请在文件浏览中多选文件或选中一个文件夹，点击“创建分享 / 批量发布”。'));return;}
   for(const group of data.items){const line=el('div','od-pub-row');const label=el('div','od-pub-name');label.append(el('div','fw-semibold text-break',group.title),el('div','small text-secondary',`${group.kind==='folder'?'文件夹':'文件合集'} · ${group.item_count} 个文件 · ${group.folder_count} 个文件夹 · ${group.status==='active'?(group.is_paused?'已暂停':'已发布'):'已撤销'} · ${formatUtc(group.created_at)}`));if(group.description)label.append(el('p','small text-secondary mb-0',group.description));line.append(label);
    if(group.status==='active'){const actions=el('div','d-flex flex-wrap gap-2');const open=el('a','btn btn-sm btn-outline-primary','查看分享页');open.href=shareUrl(group.share_url);open.target='_blank';open.rel='noopener noreferrer';
     const copy=btn('复制链接',async()=>{try{await navigator.clipboard.writeText(shareUrl(group.share_url));say('分享链接已复制。','success');}catch{say('复制失败，请检查浏览器权限。');}});
     const edit=btn('编辑',()=>openGroupEditor(host,group,{onSaved:()=>void loadGroups()}));
     const revoke=btn('撤销合集',async()=>{if(!confirm(`确定撤销“${group.title}”？
该合集和其中所有专属文件分享链接将立即失效。`))return;
      try{await requestJSON(`/api/v1/admin/onedrive/groups/${group.id}`,{method:'DELETE'});await loadGroups();say('合集已撤销，子文件分享也已经停用。','success');}catch(e){say(messageFor(e),'danger');}},'btn btn-sm btn-outline-danger');const permissions=btn('权限与统计',()=>void openSharePolicyDialog(host,group,{onSaved:()=>loadGroups()}),'btn btn-sm btn-outline-primary');actions.append(open,copy,edit,permissions,revoke);line.append(actions);}
    groups.append(line);
   }
  }catch(e){if(alive())groups.replaceChildren(el('div','alert alert-danger',messageFor(e)));}
 }
 async function loadPublications(){pubs.replaceChildren(el('div','text-secondary small','正在加载已发布分享…'));
  try{const data=await requestJSON(`${api}/publications`);if(!alive()||tab!=='shares')return;pubs.replaceChildren();pubs.append(el('h2','h6','已发布 OneDrive 文件'));
   pubs.append(el('p','small text-secondary','同一文件同时提供 /s/odf_* 分享展示页与原有 /r/odf_* 下载直链。撤销后两种入口均失效。'));
   if(!data.items.length){pubs.append(el('div','text-secondary small','尚无已发布文件。'));return;}
   for(const item of data.items){const line=el('div','od-pub-row');const label=el('div','od-pub-name');label.append(el('div','fw-semibold text-break',item.title||item.file_name),el('div','small text-secondary',`${item.status==='active'?(item.is_paused?'已暂停':'已发布'):'已撤销'} · 浏览 ${item.view_count||0} 次 · 下载跳转 ${item.download_count||0} 次 · ${formatUtc(item.created_at)}`));if(item.description)label.append(el('div','text-secondary small od-pub-summary',item.description));label.append(el('div','small text-secondary',`来源状态：${syncLabel(item.sync_status)} · 最近检查 ${item.last_checked_at?formatUtc(item.last_checked_at):'未检查'}`));line.append(label);
    if(item.status==='active'){
     const actions=el('div','d-flex flex-wrap gap-2');
     const open=el('a','btn btn-sm btn-outline-secondary','查看页面');open.href=shareUrl(item.share_url);open.target='_blank';open.rel='noopener noreferrer';
     const pageCopy=btn('复制分享页',async()=>{try{await navigator.clipboard.writeText(shareUrl(item.share_url));say('分享页链接已复制。','success');}catch{say('复制失败，请检查浏览器权限。');}});
     const directCopy=btn('复制直链',async()=>{try{await navigator.clipboard.writeText(shareUrl(item.url));say('下载直链已复制。','success');}catch{say('复制失败，请检查浏览器权限。');}});
     const edit=btn('编辑展示',()=>void editPresentation(item),'btn btn-sm btn-outline-primary');
     const revoke=btn('撤销',async()=>{if(!confirm(`确定撤销“${item.file_name}”？分享页面和下载直链将同时失效。`))return;try{await requestJSON(`${api}/publications/${item.id}`,{method:'DELETE'});await loadPublications();}catch(e){say(messageFor(e),'danger');}},'btn btn-sm btn-outline-danger');
     const permissions=btn('权限与统计',()=>void openSharePolicyDialog(host,item,{onSaved:()=>loadPublications()}),'btn btn-sm btn-outline-primary');const diagnose=btn('诊断下载',async()=>{try{const info=await requestJSON(`${api}/publications/${item.id}/download-diagnostic`);say(info.available?`下载接口可用：${info.method}。${info.note||''}`:`下载诊断：${info.message||info.code}（${info.code}）${info.upstream_status?' · Microsoft HTTP '+info.upstream_status:''}${info.blocked_download_host?' · 被拦截的域名：'+info.blocked_download_host:''}` ,info.available?'success':'warning');}catch(e){say(messageFor(e),'danger');}});const health=btn('检查来源',async()=>{try{const r=await requestJSON(`/api/v1/admin/onedrive/sync/items/${item.id}/check`,{method:'POST'});say(`检查完成：${syncLabel(r.status)}${r.changed?'（文件内容已更新）':''}`,'info');await loadPublications();}catch(e){say(messageFor(e),'danger');}});actions.append(open,pageCopy,directCopy,edit,permissions,diagnose,health,revoke);line.append(actions);
    }pubs.append(line);
   }
  }catch(e){if(alive())pubs.replaceChildren(el('div','alert alert-danger',messageFor(e)));}
 }
 try{const oauth=await requestJSON('/api/v1/admin/onedrive/oauth');if(!alive())return;
  account.textContent=oauth.connected?'✓ OneDrive 已连接':'OneDrive 未连接';account.className=oauth.connected?'badge text-bg-success align-self-center':'badge text-bg-warning align-self-center';
  if(!oauth.connected){main.replaceChildren(el('p','alert alert-warning','尚未连接管理员 Microsoft 账户。请先在系统设置完成授权。'));pubs.hidden=true;tabs.hidden=true;return;}
  await load(true);
 }catch(e){if(alive()){main.replaceChildren();say(messageFor(e),'danger');}}
}
