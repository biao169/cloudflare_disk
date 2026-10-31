import {formatUtc} from '../utils/time.js';
import {bindFolderDoubleClick} from '../utils/folder-open.js';
import {chooseUploadConflict} from '../components/replace-conflict.js';
import {canEditText,openTextEditor} from '../components/text-editor.js';
import {openVersionDialog} from '../components/version-dialog.js';
import {multipartUploadWidget} from './multipart-upload.js';
import {folderSyncClient,groupFolderEntries} from './folder-sync.js';
import {requestJSON} from '../api.js';
import {openPreview,canPreview} from './preview.js';
import {pickFolder,askName} from '../components/folder-picker.js';
import {openShareDialog} from '../components/share-dialog.js';
import {mountFolderTree} from '../components/folder-tree.js';
import {enableDragUpload,safeUploadPath} from '../components/drag-upload.js';
import {taskProgress} from '../components/task-progress.js';

const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const fileKey=x=>`${x.kind}:${x.id}`;
const fileIcon=x=>x.kind==='folder'?'📁':x.mime_type?.startsWith('image/')?'🖼️':x.mime_type?.startsWith('video/')?'🎬':x.mime_type==='application/pdf'?'📕':'📄';
const size=n=>!Number.isFinite(Number(n))?'—':Number(n)>=1073741824?`${(n/1073741824).toFixed(2)} GB`:n>=1048576?`${(n/1048576).toFixed(1)} MB`:n>=1024?`${(n/1024).toFixed(1)} KB`:`${n} B`;
const date=v=>formatUtc(v);
const btn=(text,fn,cls='btn btn-sm btn-outline-secondary')=>{const b=el('button',cls,text);b.type='button';b.onclick=fn;return b;};
const option=(value,label)=>{const o=el('option','',label);o.value=value;return o};
const isUuid=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const BATCH=10; // Keep Worker Free requests short; backend allows up to 20.
const downloadable=item=>item.kind==='file';

// Native download: the browser handles streaming and Range requests. No JS Blob or RAM-sized buffering.
export function downloadUrl(id){if(!isUuid(id))throw Error('文件 ID 无效');return `/api/v1/files/${encodeURIComponent(id)}/content`;}
export function downloadNative(item){const anchor=el('a');anchor.href=downloadUrl(item.id);anchor.download='';anchor.hidden=true;document.body.append(anchor);anchor.click();anchor.remove();}
function sortedLocal(items,sort){const out=[...items];const cmp=(a,b)=>a.name.localeCompare(b.name,'zh-CN',{sensitivity:'base'});
 if(sort==='name_desc')out.sort((a,b)=>-cmp(a,b));else if(sort==='updated_desc')out.sort((a,b)=>(b.updated_at||'').localeCompare(a.updated_at||'')||cmp(a,b));else if(sort==='size_desc')out.sort((a,b)=>(b.size_bytes||0)-(a.size_bytes||0)||cmp(a,b));else out.sort(cmp);return out;
}
function matchesType(x,filter){if(filter==='all')return true;if(x.kind==='folder')return false;const mime=(x.mime_type||'').toLowerCase();
 if(filter==='images')return mime.startsWith('image/');if(filter==='videos')return mime.startsWith('video/');if(filter==='documents')return mime==='application/pdf'||mime.startsWith('text/')||mime.includes('document')||mime.includes('spreadsheet');return !matchesType(x,'images')&&!matchesType(x,'videos')&&!matchesType(x,'documents');
}

export async function renderFileManager(host,mode='files'){
 const recent=mode==='recent',favorites=mode==='favorites',aggregated=recent||favorites,viewId=crypto.randomUUID();host.dataset.fileView=viewId;
 host.replaceChildren();const isAlive=()=>host.isConnected&&host.dataset.fileView===viewId;
 const heading=el('div','d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3');
 const title=el('div');title.append(el('h1','h3 mb-1',recent?'最近文件':favorites?'我的收藏':'文件管理'),el('p','text-secondary small mb-0',recent?'按最近修改时间排列所有你有权访问的文件':favorites?'你收藏的文件和目录；失去访问权限后自动隐藏':'个人及团队空间 · 文件列表、网格与安全分享'));
 const refresh=btn('↻ 刷新',()=>load(),'btn btn-sm btn-outline-primary');heading.append(title,refresh);host.append(heading);
 const message=el('div','mb-2');host.append(message);
 function note(text,kind='danger'){if(!isAlive())return;message.replaceChildren(el('div',`alert alert-${kind} py-2 small`,text));}
 const control=el('div','cd-file-toolbar panel p-3 mb-3');const first=el('div','d-flex flex-wrap gap-2 align-items-center');
 const spaceSelect=el('select','form-select form-select-sm');spaceSelect.style.maxWidth='260px';spaceSelect.setAttribute('aria-label','选择空间');
 if(!aggregated)first.append(spaceSelect);
 const search=el('input','form-control form-control-sm');search.type='search';search.placeholder=aggregated?'筛选当前页（全局搜索在侧栏）':'搜索当前空间中的文件';search.setAttribute('aria-label','文件搜索');search.style.maxWidth='250px';first.append(search);
 const filter=el('select','form-select form-select-sm');filter.setAttribute('aria-label','文件类型');filter.style.maxWidth='150px';
 for(const [v,t] of [['all','所有类型'],['images','图片'],['videos','视频'],['documents','文档'],['other','其他']])filter.append(option(v,t));first.append(filter);
 const sort=el('select','form-select form-select-sm');sort.setAttribute('aria-label','排序方式');sort.style.maxWidth='168px';
 for(const [v,t] of [['name_asc','名称 A→Z'],['name_desc','名称 Z→A'],['updated_desc','最近修改'],['size_desc','文件大小']])sort.append(option(v,t));if(aggregated){sort.value='updated_desc';sort.disabled=true;sort.title='最近文件/收藏按服务端时间排序';}first.append(sort);
 const layout=el('div','btn-group btn-group-sm');layout.setAttribute('role','group');layout.setAttribute('aria-label','文件视图');const listBtn=btn('☰ 列表',()=>setView('list'),'btn btn-sm btn-outline-secondary');const gridBtn=btn('▦ 网格',()=>setView('grid'),'btn btn-sm btn-outline-secondary');layout.append(listBtn,gridBtn);first.append(layout);control.append(first);host.append(control);
 const trail=el('nav','d-flex flex-wrap align-items-center gap-1 mb-2 small');trail.setAttribute('aria-label','面包屑');if(!aggregated)host.append(trail);
 const actions=el('div','d-flex align-items-center flex-wrap gap-2 mb-3');host.append(actions);
 const selectedInfo=el('span','small text-secondary');const chooseAll=btn('选择本页',()=>{for(const x of currentItems)selected.set(fileKey(x),x);draw()});
 const clear=btn('清除选择',()=>{selected.clear();draw()});const batchMove=btn('移动所选',()=>batchOperation('move'),'btn btn-sm btn-outline-primary');const batchCopy=btn('复制所选文件',()=>batchOperation('copy'));
 const batchTrash=btn('删除所选',()=>batchOperation('delete'),'btn btn-sm btn-outline-danger');
 const progressTasks=taskProgress(host);
 const itemsBox=el('section','panel cd-file-results');itemsBox.setAttribute('aria-label','文件列表');
 const explorer=el('div','cd-explorer-layout');const treePanel=el('aside','panel cd-explorer-tree');const contentPanel=el('div','cd-explorer-content');
 contentPanel.append(itemsBox);if(!aggregated){explorer.append(treePanel,contentPanel);host.append(explorer)}else host.append(itemsBox);
 let folderTree=null;
 const paging=el('div','d-flex align-items-center justify-content-between gap-2 my-3');const pageState=el('span','small text-secondary');const pageButtons=el('div','d-flex gap-2');
 const prev=btn('上一页',()=>goPage(-1)),next=btn('下一页',()=>goPage(1));pageButtons.append(prev,next);paging.append(pageState,pageButtons);if(!aggregated)contentPanel.append(paging);else host.append(paging);
 let spaceId=null,parentId=null,history=[],spaceList=[],offset=0,nextPage=false,aggregateCursors=[null],pageNo=0,currentItems=[],selected=new Map(),favoriteIds=new Set(),view='list',seq=0;
 try{const v=localStorage.getItem('cloudDrive.fileView');if(v==='grid'||v==='list')view=v;}catch{}
 function setView(value){view=value;try{localStorage.setItem('cloudDrive.fileView',value)}catch{}draw()}
 function currentSpace(){return spaceList.find(s=>s.id===spaceId)}
 const spaceFor=x=>aggregated?x.space_id:spaceId;
 const displayName=x=>x.kind==='folder'?'文件夹':'文件';
 function breadcrumb(){trail.replaceChildren();const root=btn((currentSpace()?.name||'当前空间')+' / 根目录',()=>void browseFolder(null),'btn btn-sm btn-link text-decoration-none');trail.append(root);
  history.forEach((f,i)=>{trail.append(el('span','text-secondary','/'));trail.append(btn(f.name,()=>void browseFolder(f.id),'btn btn-sm btn-link text-decoration-none'))});
 }
 function selectionState(){selectedInfo.textContent=`已选 ${selected.size} 项`;
  for(const b of [batchMove,batchTrash,clear])b.disabled=!selected.size;
  batchCopy.disabled=!selected.size||[...selected.values()].some(x=>x.kind==='folder');
  if(aggregated){batchMove.disabled=!selected.size||new Set([...selected.values()].map(x=>x.space_id)).size!==1;batchCopy.disabled=!selected.size||new Set([...selected.values()].map(x=>x.space_id)).size!==1;}
 }
 function pickTypes(xs){return xs.filter(x=>matchesType(x,filter.value)).filter(x=>!aggregated||!search.value.trim()||x.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));}
 function draw(){if(!isAlive())return;
  listBtn.classList.toggle('active',view==='list');gridBtn.classList.toggle('active',view==='grid');selectionState();
  const shown=pickTypes(currentItems);itemsBox.replaceChildren();
  if(!shown.length){itemsBox.append(el('div','p-5 text-center text-secondary',nextPage?'本批次没有可见项目，可继续翻页查看。':'没有符合条件的文件。'));return}
  if(view==='grid'){
   const grid=el('div','cd-files-grid p-3');for(const item of shown)grid.append(makeGrid(item));itemsBox.append(grid);
  }else{
   const scroller=el('div','table-responsive');const table=el('table','table table-hover align-middle mb-0 cd-file-table');
   const head=el('thead');const hr=el('tr');for(const t of ['','名称','大小','修改时间','位置','操作'])hr.append(el('th','',t));head.append(hr);const body=el('tbody');for(const item of shown)body.append(makeRow(item));table.append(head,body);scroller.append(table);itemsBox.append(scroller);
  }
  pageState.textContent=aggregated?`${recent?'最近文件':'收藏夹'} · 第 ${pageNo+1} 页`:`第 ${Math.floor(offset/50)+1} 页`;
 }
 function checkbox(item){const cb=el('input','form-check-input');cb.type='checkbox';cb.setAttribute('aria-label',`选择 ${item.name}`);cb.checked=selected.has(fileKey(item));
  cb.onchange=()=>{if(cb.checked)selected.set(fileKey(item),item);else selected.delete(fileKey(item));selectionState()};return cb}
 function locateItem(item){window.dispatchEvent(new CustomEvent('clouddrive:locate',{detail:{spaceId:item.space_id,folderId:item.kind==='folder'?item.id:item.folder_id}}))}
 function itemButton(item){return btn(`${fileIcon(item)} ${item.name}`,()=>item.kind==='folder'?(aggregated?locateItem(item):openFolder(item)):canPreview(item)?preview(item):download(item),'btn btn-link text-start text-decoration-none cd-file-name');}
 async function toggleFavorite(item){const key=fileKey(item),was=favoriteIds.has(key);try{
   if(was)await requestJSON(`/api/v1/favorites/${item.kind}/${item.id}`,{method:'DELETE'});
   else await requestJSON('/api/v1/favorites',{method:'POST',body:{kind:item.kind,id:item.id}});
   if(was)favoriteIds.delete(key);else favoriteIds.add(key);
   if(favorites&&was){await load();return}draw();
  }catch(err){note(err.message)}
 }
 async function refreshFavorites(items){const keys=new Set();if(favorites){for(const item of items)keys.add(fileKey(item));return keys}
  for(let i=0;i<items.length;i+=40){const result=await requestJSON('/api/v1/favorites/check',{method:'POST',body:{items:items.slice(i,i+40).map(x=>({kind:x.kind,id:x.id}))}});for(const key of result.keys)keys.add(key)}return keys;
 }
 function actionButtons(item){const wrap=el('div','d-flex flex-wrap gap-1 cd-file-actions');
  wrap.append(btn(favoriteIds.has(fileKey(item))?'★ 已收藏':'☆ 收藏',()=>toggleFavorite(item)));
  if(downloadable(item)){if(canPreview(item))wrap.append(btn('预览',()=>preview(item)));wrap.append(btn('下载',()=>download(item)));}
  wrap.append(btn('分享 / 管理',()=>share(item),'btn btn-sm btn-outline-primary'));
  if(downloadable(item)&&canEditText(item))wrap.append(btn('在线编辑',()=>editText(item),'btn btn-sm btn-outline-primary'));
  if(downloadable(item))wrap.append(btn('历史版本',()=>viewVersions(item))); 
  wrap.append(btn('移动',()=>move(item)));
  if(downloadable(item))wrap.append(btn('复制',()=>copy(item)));
  wrap.append(btn('重命名',()=>rename(item)));
  wrap.append(btn('删除',()=>remove(item),'btn btn-sm btn-outline-danger'));
  return wrap;
 }
 function makeRow(item){const row=el('tr');const ch=el('td');ch.append(checkbox(item));row.append(ch);
  const name=el('td','cd-file-title');name.append(itemButton(item));row.append(name);
  row.append(el('td','text-secondary small text-nowrap',item.kind==='file'?size(item.size_bytes):'—'));
  row.append(el('td','text-secondary small text-nowrap',date(item.updated_at||item.created_at)));
  row.append(el('td','text-secondary small',aggregated?(item.space_name||'共享空间'):'—'));
  const acts=el('td');acts.append(actionButtons(item));row.append(acts);
  if(item.kind==='folder')bindFolderDoubleClick(row,()=>aggregated?locateItem(item):openFolder(item));return row;
 }
 function makeGrid(item){const card=el('div','cd-file-card border rounded-3 p-3');const head=el('div','d-flex gap-2 align-items-start');head.append(el('div','fs-3',fileIcon(item)));
  const check=checkbox(item);head.append(el('div','ms-auto'),check);const name=itemButton(item);name.classList.add('fw-semibold','w-100');
  const meta=el('div','small text-secondary mt-1',`${item.kind==='file'?size(item.size_bytes):'文件夹'} · ${date(item.updated_at||item.created_at)}`);
  card.append(head,name,meta);if(aggregated)card.append(el('div','small text-secondary',item.space_name||''));card.append(actionButtons(item));
  if(item.kind==='folder')bindFolderDoubleClick(card,()=>aggregated?locateItem(item):openFolder(item));return card;
 }
 async function load(){if(!isAlive())return;const run=++seq;message.replaceChildren();itemsBox.replaceChildren(el('div','p-4 text-secondary','正在读取文件…'));
  try{
   let data,loaded=[];
   if(aggregated){const p=new URLSearchParams({limit:'30'});if(aggregateCursors[pageNo])p.set('cursor',aggregateCursors[pageNo]);
    data=await requestJSON(`${recent?'/api/v1/files/recent':'/api/v1/favorites'}?${p}`);
    loaded=recent?data.files.map(x=>({...x,kind:'file'})):data.items;
    nextPage=data.has_more;if(data.cursor)aggregateCursors[pageNo+1]=data.cursor;
   }else if(search.value.trim()){
    const p=new URLSearchParams({space_id:spaceId,q:search.value.trim()});data=await requestJSON(`/api/v1/search?${p}`);
    loaded=[...data.folders.map(x=>({...x,kind:'folder',space_id:spaceId})),...data.files.map(x=>({...x,kind:'file',space_id:spaceId}))];loaded=sortedLocal(loaded,sort.value);nextPage=false;
   }else{
    const p=new URLSearchParams({limit:'50',offset:String(offset),sort:sort.value,filter:filter.value});if(parentId)p.set('parent_id',parentId);
    data=await requestJSON(`/api/v1/spaces/${spaceId}/contents?${p}`);loaded=[...data.folders.map(x=>({...x,kind:'folder',space_id:spaceId})),...data.files.map(x=>({...x,kind:'file',space_id:spaceId}))];nextPage=data.has_more;
   }
   if(run!==seq||!isAlive())return;
   currentItems=loaded;selected.clear();favoriteIds=await refreshFavorites(loaded);if(run!==seq||!isAlive())return;
   if(!aggregated)breadcrumb();draw();prev.disabled=aggregated?pageNo===0:offset===0;next.disabled=!nextPage;
   if(!aggregated)folderTree?.select(parentId);
   if(!aggregated&&search.value.trim())pageState.textContent='搜索结果（最多显示前 100 项）';
  }catch(err){if(run!==seq)return;itemsBox.replaceChildren();note(err.message);next.disabled=true;}
 }
 function openFolder(item){parentId=item.id;history.push(item);offset=0;search.value='';selected.clear();saveLocation();load();folderTree?.select(parentId)}
 function saveLocation(){try{if(spaceId)sessionStorage.setItem('cd-last-folder',JSON.stringify({spaceId,parentId}))}catch{}}
 async function browseFolder(id){parentId=id;history=[];offset=0;selected.clear();search.value='';
  if(id){try{const result=await requestJSON(`/api/v1/folders/${id}/path`);if(result.space_id!==spaceId)throw Error('空间不匹配');history=result.path;await folderTree?.expandPath(history)}catch(err){parentId=null;history=[];note(`目录不可访问，已返回根目录：${err.message}`,'warning')}}
  saveLocation();await load();folderTree?.select(parentId);
 }
 function makeTree(){folderTree?.dispose();treePanel.replaceChildren();if(spaceId)folderTree=mountFolderTree(treePanel,{spaceId,spaceName:currentSpace()?.name||'当前空间',onNavigate:id=>void browseFolder(id)});} 
 async function goPage(direction){if(aggregated){pageNo=Math.max(0,pageNo+direction)}else{offset=Math.max(0,offset+50*direction)}await load()}
 function preview(item){openPreview(item,currentItems.filter(x=>x.kind==='file'),{onError:err=>note(err)});}
 function download(item){try{downloadNative(item);note(`已交给浏览器下载：${item.name}。大文件不会载入网页内存。`,'info')}catch(err){note(err.message)}}
 async function editText(item){try{await openTextEditor(item,{onSaved:async()=>{await load()}})}catch(e){note(e.message)}}
 async function viewVersions(item){try{await openVersionDialog(item,{onRestored:async()=>{await load();note('已生成新的当前修订；原有分享链接继续有效。','success')}})}catch(e){note(e.message)}}
 async function share(item){try{const me=await requestJSON('/api/v1/auth/me');await openShareDialog(item,{isAdmin:me.user.role==='super_admin',onCreated:()=>note('分享已创建，请在弹窗中复制并保存新链接。','success')})}catch(err){note(err.message)}}
 async function rename(item){try{const name=await askName({title:`重命名${displayName(item)}`,value:item.name});if(name===null||name===item.name)return;
  await requestJSON(`/api/v1/${item.kind==='folder'?'folders':'files'}/${item.id}`,{method:'PATCH',body:{name}});note('重命名完成','success');await load();}catch(err){note(err.message)}}
 async function move(item){try{const dest=await pickFolder({spaceId:spaceFor(item),spaceName:currentSpace()?.name||item.space_name});if(dest===null)return;const destinationId=dest.folderId;
  const path=item.kind==='folder'?`/api/v1/folders/${item.id}`:`/api/v1/files/${item.id}/move`;
  try{
   await requestJSON(path,{method:item.kind==='folder'?'PATCH':'POST',body:item.kind==='folder'?{parent_id:destinationId}:{target_folder_id:destinationId}});
  }catch(e){
   if(item.kind!=='folder'||e.code!=='ACL_CHANGE_CONFIRMATION_REQUIRED')throw e;
   if(!confirm('移动文件夹可能改变子目录的继承权限。确认由空间管理员移动并重新检查共享范围？'))return;
   await requestJSON(path,{method:'PATCH',body:{parent_id:destinationId,confirm_acl_change:true}});
  }
  note('移动完成','success');await load();}catch(err){note(err.message)}}
 async function copy(item){if(!downloadable(item))return;try{const name=await askName({title:'复制文件',label:'副本名称',value:`副本-${item.name}`});if(name===null)return;
  const dest=await pickFolder({spaceId:spaceFor(item),spaceName:currentSpace()?.name||item.space_name,title:'选择副本存放目录'});if(dest===null)return;
  await requestJSON(`/api/v1/files/${item.id}/copy`,{method:'POST',body:{name,target_folder_id:dest.folderId}});note('副本已创建（共享不可变 R2 对象）','success');await load();}catch(err){note(err.message)}}
 async function remove(item){if(!confirm(`将${displayName(item)}「${item.name}」移入回收站？`))return;try{
  await requestJSON('/api/v1/trash',{method:'POST',body:{target_type:item.kind,target_id:item.id}});note('已移入回收站','success');await load();}catch(err){note(err.message)}}
 const chunks=(arr)=>{const out=[];for(let i=0;i<arr.length;i+=BATCH)out.push(arr.slice(i,i+BATCH));return out;};
 async function batchOperation(op){if(batchRunning||uploadRunning)return note('请先完成当前批量任务','warning');const chosen=[...selected.values()];if(!chosen.length)return note('请先勾选文件或文件夹','warning');
  if(aggregated&&new Set(chosen.map(x=>x.space_id)).size!==1)return note('跨空间项目请分别进行批量操作','warning');
  if(op==='copy'&&chosen.some(x=>x.kind==='folder'))return note('批量复制暂只支持文件','warning');
  if(op==='delete'&&!confirm(`将所选 ${chosen.length} 项移入回收站？`))return;
  let dest=null;if(op!=='delete'){
   try{dest=await pickFolder({spaceId:spaceFor(chosen[0]),spaceName:currentSpace()?.name||chosen[0].space_name,title:op==='copy'?'批量复制到':'批量移动到'});}catch(err){return note(err.message)}
   if(dest===null)return;dest=dest.folderId;
  }
  const confirmAclChange=op==='move'&&chosen.some(x=>x.kind==='folder')
    ?confirm('移动目录可能改变子目录继承的访问权限。此操作仅允许空间管理员执行，是否继续？'):false;
  if(op==='move'&&chosen.some(x=>x.kind==='folder')&&!confirmAclChange)return;
  const label={move:'移动',copy:'复制',delete:'删除'}[op];batchRunning=true;progressTasks.start(`批量${label}`,chosen.length);
  for(const batch of chunks(chosen)){
   if(progressTasks.stopped)break;
   try{
    const data=op==='delete'?await requestJSON('/api/v1/trash/batch',{method:'POST',body:{items:batch.map(x=>({kind:x.kind,id:x.id}))}}):
     await requestJSON('/api/v1/files/batch',{method:'POST',body:{operation:op,file_ids:batch.filter(x=>x.kind==='file').map(x=>x.id),folder_ids:batch.filter(x=>x.kind==='folder').map(x=>x.id),target_folder_id:dest,confirm_acl_change:confirmAclChange}});
    const byKey=new Map((data.results||[]).map(r=>[`${r.kind}:${r.id}`,r]));
    for(const item of batch){const r=byKey.get(fileKey(item));progressTasks.item({success:!!r?.success,name:item.name,message:r?.error||'未返回操作结果'})}
   }catch(err){for(const item of batch)progressTasks.item({success:false,name:item.name,message:err.message})}
  }
  const outcome=progressTasks.finish();selected.clear();await load();folderTree?.refresh();
  batchRunning=false;note(`批量${label}：成功 ${outcome.success} 项，失败 ${outcome.failed} 项${outcome.stopped?'（用户停止）':''}`,outcome.failed?'warning':'success');
 }
 const input=el('input','d-none');input.type='file';input.multiple=true;host.append(input);
 const folderInput=el('input','d-none');folderInput.type='file';folderInput.multiple=true;folderInput.webkitdirectory=true;host.append(folderInput);
 const bigUploads=aggregated?{start:async()=>{throw Error('请从文件管理页面上传')}}:multipartUploadWidget(host,{space:()=>spaceId,folder:()=>parentId,onFinished:()=>load(),onProgress:(done,total)=>progressTasks.itemProgress(done,total),onMessage:m=>note(m)});
 const syncFolders=folderSyncClient({space:()=>spaceId,folder:()=>parentId,smallUpload:uploadSmall,multipart:(file,sid,did,replace)=>bigUploads.start(file,sid,did,replace),onNotice:(message,level)=>note(message,level),onFinished:()=>{void load();folderTree?.refresh()},progress:progressTasks});
 async function resolveUploadFolder(root,parts,cache,targetSpace){let at=root;
  for(const name of parts){if(name.length>100)throw Error('文件夹名称超过 100 字符');const key=`${at||'root'}::${name.toLocaleLowerCase()}`;if(cache.has(key)){at=cache.get(key);continue}
   let id=null;
   try{const made=await requestJSON('/api/v1/folders',{method:'POST',body:{space_id:targetSpace,parent_id:at,name}});id=made.id;}
   catch(err){if(err.code!=='NAME_CONFLICT')throw err;let offset=0,found=null;
    for(let page=0;page<100;page++){const p=new URLSearchParams({limit:'100',offset:String(offset)});if(at)p.set('parent_id',at);
     const data=await requestJSON(`/api/v1/spaces/${targetSpace}/folders?${p}`);found=data.items.find(f=>f.name.toLocaleLowerCase()===name.toLocaleLowerCase());if(found||!data.has_more)break;offset+=100}
    if(!found||!found.can_write)throw Error(`无法写入已存在的文件夹：${name}`);id=found.id;
   }
   cache.set(key,id);at=id;
  }return at;
 }
 function uploadSmall(file,toFolder,progress,targetSpace,replace=null){return new Promise((resolve,reject)=>{
  const p=new URLSearchParams({space_id:targetSpace,name:file.name});if(toFolder)p.set('folder_id',toFolder);if(replace){p.set('replace_file_id',replace.id);p.set('expected_revision',String(replace.revision))}
  const xhr=new XMLHttpRequest();xhr.open('POST',`/api/v1/storage/upload?${p}`);xhr.withCredentials=true;xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');
  xhr.upload.onprogress=e=>{if(e.lengthComputable)progress(e.loaded,e.total)};
  xhr.onerror=()=>reject(Error('上传连接失败'));xhr.onabort=()=>reject(Error('上传中断'));
  xhr.onload=()=>{let payload;try{payload=JSON.parse(xhr.responseText)}catch{return reject(Error(`服务器响应无效：HTTP ${xhr.status}`))}
   if(xhr.status<200||xhr.status>=300||!payload.success){const err=Error(payload.error?.message||`HTTP ${xhr.status}`);err.code=payload.error?.code;reject(err)}else resolve(payload.data)};
  xhr.send(file);
 })}
 async function findSameNameFile(space,folder,name){
  for(let offset=0;offset<10000;offset+=100){
   const qs=new URLSearchParams({limit:'100',offset:String(offset)});if(folder)qs.set('parent_id',folder);
   const data=await requestJSON(`/api/v1/spaces/${space}/contents?${qs}`);
   const hit=(data.files||data.items||[]).find(x=>x.kind!=='folder'&&x.name.toLocaleLowerCase()===name.toLocaleLowerCase());
   if(hit)return hit;if(!data.has_more)break;
  }return null;
 }
 function autoRename(name,index){const dot=name.lastIndexOf('.');const stem=dot>0?name.slice(0,dot):name;const suffix=dot>0?name.slice(dot):'';return `${stem} (${index})${suffix}`;}
 let uploadRunning=false,batchRunning=false;
 async function uploadEntries(entries){entries=entries.filter(e=>e.file);if(batchRunning)return note('请先完成批量任务','warning');if(aggregated)return note('请先进入具体空间，再上传文件','warning');if(uploadRunning)return note('已有上传任务正在进行','warning');
  if(!spaceId)return note('请先选择目标空间','warning');if(!entries?.length)return;
  if(entries.length>500)return note('每次最多上传 500 个文件，请分批进行','warning');
  const targetSpace=spaceId,targetRoot=parentId,cache=new Map();uploadRunning=true;spaceSelect.disabled=true;progressTasks.start('上传文件',entries.length);
  for(const {file,path} of entries){if(progressTasks.stopped)break;
   if(!safeUploadPath(path)){progressTasks.item({success:false,name:file.name,message:'文件路径不合法'});continue}
   // Upload destination is captured at queue start; navigation cannot change it.
   try{const dirs=path.replaceAll('\\','/').split('/').slice(0,-1);const toFolder=await resolveUploadFolder(targetRoot,dirs,cache,targetSpace);
    const existing=await findSameNameFile(targetSpace,toFolder,file.name);
    let candidate=file,replace=null;
    if(existing){
     const choice=await chooseUploadConflict(file.name,existing);
     if(choice==='skip'){progressTasks.item({success:true,name:path,message:'跳过同名文件'});continue;}
     if(choice==='replace'){
      const data=await requestJSON(`/api/v1/files/${existing.id}/replacement-target`);
      replace={id:data.id,revision:data.revision};
     }else{
      let newName=null;
      for(let i=1;i<=100;i++){const proposed=autoRename(file.name,i);if(!await findSameNameFile(targetSpace,toFolder,proposed)){newName=proposed;break}}
      if(!newName)throw Error('无法分配不重复的文件名');
      candidate=new File([file],newName,{type:file.type,lastModified:file.lastModified});
     }
    }
    if(candidate.size>8*1024*1024)await bigUploads.start(candidate,targetSpace,toFolder,replace);
    else await uploadSmall(candidate,toFolder,(done,total)=>progressTasks.itemProgress(done,total),targetSpace,replace);
    progressTasks.item({success:true,name:path});
   }catch(err){progressTasks.item({success:false,name:path,message:err.message})}
  }
  const out=progressTasks.finish();uploadRunning=false;spaceSelect.disabled=false;folderTree?.refresh();await load();note(`上传完成：成功 ${out.success} 项，失败 ${out.failed} 项`,out.failed?'warning':'success');
 }
 async function mixedUpload(entries){
  if(uploadRunning||batchRunning)return note('已有上传或批量任务进行中','warning');
  const parsed=groupFolderEntries(entries);
  if(!parsed.groups.length)return uploadEntries(parsed.loose);
  if(aggregated||!spaceId)return note('请先进入具体空间后再更新文件夹','warning');
  uploadRunning=true;spaceSelect.disabled=true;let folderTasksFinished=true;
  try{
   for(const group of parsed.groups){
    const result=await syncFolders.sync(group);
    if(result?.cancelled){note('未执行此次文件夹更新','info');folderTasksFinished=false;break}
    if(result?.pending){note('文件夹更新尚未完成。重新选择相同文件夹可安全续跑；镜像旧文件未提前删除。','warning');folderTasksFinished=false;break}
    note(`文件夹「${group.root}」同步完成，原有文件 ID 和分享保留。`,'success');
   }
  }catch(e){folderTasksFinished=false;note(`文件夹同步失败：${e.message}`)}finally{uploadRunning=false;spaceSelect.disabled=false;await load();folderTree?.refresh();}
  // Do not silently upload unrelated files after a folder mirror was cancelled or interrupted.
  if(folderTasksFinished&&parsed.loose.length)await uploadEntries(parsed.loose);
 }
 input.onchange=()=>{const entries=[...input.files].map(file=>({file,path:file.name}));input.value='';void uploadEntries(entries)};
 folderInput.onchange=()=>{const entries=[...folderInput.files].map(file=>({file,path:file.webkitRelativePath||file.name}));folderInput.value='';void mixedUpload(entries)};
 if(!aggregated)enableDragUpload(host,entries=>mixedUpload(entries),err=>note(err.message));
 if(!aggregated){actions.append(btn('＋ 上传文件',()=>input.click(),'btn btn-sm btn-primary'),btn('📁 合并/镜像更新文件夹',()=>folderInput.click()),btn('＋ 新建文件夹',async()=>{try{const name=await askName({title:'创建文件夹',confirm:'创建'});if(!name)return;
  await requestJSON('/api/v1/folders',{method:'POST',body:{space_id:spaceId,parent_id:parentId,name}});await load();folderTree?.refresh();}catch(err){note(err.message)}}));}
 actions.append(selectedInfo,chooseAll,clear,batchMove,batchCopy,batchTrash);
 try{
  if(!aggregated){const data=await requestJSON('/api/v1/spaces');if(!isAlive())return;spaceList=data.items||[];
   for(const s of spaceList)spaceSelect.append(option(s.id,`${s.type==='personal'?'个人':'团队'} · ${s.name}`));spaceId=spaceList[0]?.id||null;
   if(!spaceId){itemsBox.replaceChildren(el('p','p-4 text-secondary','没有可访问的空间'));for(const b of actions.querySelectorAll('button'))b.disabled=true;return}
   spaceSelect.onchange=()=>{spaceId=spaceSelect.value;parentId=null;history=[];selected.clear();offset=0;search.value='';makeTree();saveLocation();load()};
   let initial=window.history.state?.cloudDriveLocation;
   if(!initial)try{initial=JSON.parse(sessionStorage.getItem('cd-last-folder')||'null')}catch{}
   if(initial&&spaceList.some(x=>x.id===initial.spaceId)){spaceId=initial.spaceId;spaceSelect.value=spaceId;}
   makeTree();
   if(initial?.folderId&&initial.spaceId===spaceId)await browseFolder(initial.folderId);
   else{parentId=null;history=[];}
   if(window.history.state?.cloudDriveLocation)window.history.replaceState({},'',location.pathname);
  }
  let debounce;search.oninput=()=>{if(aggregated){draw();return}clearTimeout(debounce);debounce=setTimeout(()=>{offset=0;load()},250)};
  filter.onchange=()=>{offset=0;if(aggregated)draw();else load()};sort.onchange=()=>{offset=0;if(aggregated){currentItems=sortedLocal(currentItems,sort.value);draw()}else load()};
  setView(view);await load();
 }catch(err){note(err.message)}
}
