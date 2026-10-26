import {multipartUploadWidget} from './multipart-upload.js';
import {requestJSON} from '../api.js';
import {openPreview,canPreview} from './preview.js';
import {pickFolder,askName} from '../components/folder-picker.js';
import {openShareDialog} from '../components/share-dialog.js';

const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const fileKey=x=>`${x.kind}:${x.id}`;
const fileIcon=x=>x.kind==='folder'?'📁':x.mime_type?.startsWith('image/')?'🖼️':x.mime_type?.startsWith('video/')?'🎬':x.mime_type==='application/pdf'?'📕':'📄';
const size=n=>!Number.isFinite(Number(n))?'—':Number(n)>=1073741824?`${(n/1073741824).toFixed(2)} GB`:n>=1048576?`${(n/1048576).toFixed(1)} MB`:n>=1024?`${(n/1024).toFixed(1)} KB`:`${n} B`;
const date=v=>{if(!v)return '—';const stamp=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v)?v.replace(' ','T')+'Z':v;const d=new Date(stamp);return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):v;};
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
 const recent=mode==='recent',viewId=crypto.randomUUID();host.dataset.fileView=viewId;
 host.replaceChildren();const isAlive=()=>host.isConnected&&host.dataset.fileView===viewId;
 const heading=el('div','d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3');
 const title=el('div');title.append(el('h1','h3 mb-1',recent?'最近文件':'文件管理'),el('p','text-secondary small mb-0',recent?'按最近修改时间排列所有你有权访问的文件':'个人及团队空间 · 文件列表、网格与安全分享'));
 const refresh=btn('↻ 刷新',()=>load(),'btn btn-sm btn-outline-primary');heading.append(title,refresh);host.append(heading);
 const message=el('div','mb-2');host.append(message);
 function note(text,kind='danger'){if(!isAlive())return;message.replaceChildren(el('div',`alert alert-${kind} py-2 small`,text));}
 const control=el('div','cd-file-toolbar panel p-3 mb-3');const first=el('div','d-flex flex-wrap gap-2 align-items-center');
 const spaceSelect=el('select','form-select form-select-sm');spaceSelect.style.maxWidth='260px';spaceSelect.setAttribute('aria-label','选择空间');
 if(!recent)first.append(spaceSelect);
 const search=el('input','form-control form-control-sm');search.type='search';search.placeholder=recent?'筛选当前页的文件':'搜索当前空间中的文件';search.setAttribute('aria-label','文件搜索');search.style.maxWidth='250px';first.append(search);
 const filter=el('select','form-select form-select-sm');filter.setAttribute('aria-label','文件类型');filter.style.maxWidth='150px';
 for(const [v,t] of [['all','所有类型'],['images','图片'],['videos','视频'],['documents','文档'],['other','其他']])filter.append(option(v,t));first.append(filter);
 const sort=el('select','form-select form-select-sm');sort.setAttribute('aria-label','排序方式');sort.style.maxWidth='168px';
 for(const [v,t] of [['name_asc','名称 A→Z'],['name_desc','名称 Z→A'],['updated_desc','最近修改'],['size_desc','文件大小']])sort.append(option(v,t));if(recent){sort.value='updated_desc';sort.disabled=true;sort.title='最近文件始终按最新修改时间排序';}first.append(sort);
 const layout=el('div','btn-group btn-group-sm');layout.setAttribute('role','group');layout.setAttribute('aria-label','文件视图');const listBtn=btn('☰ 列表',()=>setView('list'),'btn btn-sm btn-outline-secondary');const gridBtn=btn('▦ 网格',()=>setView('grid'),'btn btn-sm btn-outline-secondary');layout.append(listBtn,gridBtn);first.append(layout);control.append(first);host.append(control);
 const trail=el('nav','d-flex flex-wrap align-items-center gap-1 mb-2 small');trail.setAttribute('aria-label','面包屑');if(!recent)host.append(trail);
 const actions=el('div','d-flex align-items-center flex-wrap gap-2 mb-3');host.append(actions);
 const selectedInfo=el('span','small text-secondary');const chooseAll=btn('选择本页',()=>{for(const x of currentItems)selected.set(fileKey(x),x);draw()});
 const clear=btn('清除选择',()=>{selected.clear();draw()});const batchMove=btn('移动所选',()=>batchOperation('move'),'btn btn-sm btn-outline-primary');const batchCopy=btn('复制所选文件',()=>batchOperation('copy'));
 const batchTrash=btn('删除所选',()=>batchOperation('delete'),'btn btn-sm btn-outline-danger');
 const itemsBox=el('section','panel cd-file-results');itemsBox.setAttribute('aria-label','文件列表');host.append(itemsBox);
 const paging=el('div','d-flex align-items-center justify-content-between gap-2 my-3');const pageState=el('span','small text-secondary');const pageButtons=el('div','d-flex gap-2');
 const prev=btn('上一页',()=>goPage(-1)),next=btn('下一页',()=>goPage(1));pageButtons.append(prev,next);paging.append(pageState,pageButtons);host.append(paging);
 let spaceId=null,parentId=null,history=[],spaceList=[],offset=0,nextPage=false,recentCursors=[null],pageNo=0,currentItems=[],selected=new Map(),sortValue=sort.value,view='list',seq=0,searchDelay;
 try{const v=localStorage.getItem('cloudDrive.fileView');if(v==='grid'||v==='list')view=v;}catch{}
 function setView(value){view=value;try{localStorage.setItem('cloudDrive.fileView',value)}catch{}draw()}
 function currentSpace(){return spaceList.find(s=>s.id===spaceId)}
 const spaceFor=x=>recent?x.space_id:spaceId;
 const displayName=x=>x.kind==='folder'?'文件夹':'文件';
 function breadcrumb(){trail.replaceChildren();const root=btn((currentSpace()?.name||'当前空间')+' / 根目录',()=>{parentId=null;history=[];offset=0;selected.clear();load()},'btn btn-sm btn-link text-decoration-none');trail.append(root);
  history.forEach((f,i)=>{trail.append(el('span','text-secondary','/'));trail.append(btn(f.name,()=>{parentId=f.id;history=history.slice(0,i+1);offset=0;selected.clear();load()},'btn btn-sm btn-link text-decoration-none'))});
 }
 function selectionState(){selectedInfo.textContent=`已选 ${selected.size} 项`;
  for(const b of [batchMove,batchTrash,clear])b.disabled=!selected.size;
  batchCopy.disabled=!selected.size||[...selected.values()].some(x=>x.kind==='folder');
  if(recent){batchMove.disabled=!selected.size||new Set([...selected.values()].map(x=>x.space_id)).size!==1;batchCopy.disabled=!selected.size||new Set([...selected.values()].map(x=>x.space_id)).size!==1;}
 }
 function pickTypes(xs){return xs.filter(x=>matchesType(x,filter.value)).filter(x=>!recent||!search.value.trim()||x.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));}
 function draw(){if(!isAlive())return;
  listBtn.classList.toggle('active',view==='list');gridBtn.classList.toggle('active',view==='grid');selectionState();
  const shown=pickTypes(currentItems);itemsBox.replaceChildren();
  if(!shown.length){itemsBox.append(el('div','p-5 text-center text-secondary','没有符合条件的文件。'));return}
  if(view==='grid'){
   const grid=el('div','cd-files-grid p-3');for(const item of shown)grid.append(makeGrid(item));itemsBox.append(grid);
  }else{
   const scroller=el('div','table-responsive');const table=el('table','table table-hover align-middle mb-0 cd-file-table');
   const head=el('thead');const hr=el('tr');for(const t of ['','名称','大小','修改时间','位置','操作'])hr.append(el('th','',t));head.append(hr);const body=el('tbody');for(const item of shown)body.append(makeRow(item));table.append(head,body);scroller.append(table);itemsBox.append(scroller);
  }
  pageState.textContent=recent?`最近文件 · 第 ${pageNo+1} 页`:`第 ${Math.floor(offset/50)+1} 页`;
 }
 function checkbox(item){const cb=el('input','form-check-input');cb.type='checkbox';cb.setAttribute('aria-label',`选择 ${item.name}`);cb.checked=selected.has(fileKey(item));
  cb.onchange=()=>{if(cb.checked)selected.set(fileKey(item),item);else selected.delete(fileKey(item));selectionState()};return cb}
 function itemButton(item){return btn(`${fileIcon(item)} ${item.name}`,()=>item.kind==='folder'?openFolder(item):canPreview(item)?preview(item):download(item),'btn btn-link text-start text-decoration-none cd-file-name');}
 function actionButtons(item){const wrap=el('div','d-flex flex-wrap gap-1 cd-file-actions');
  if(downloadable(item)){if(canPreview(item))wrap.append(btn('预览',()=>preview(item)));wrap.append(btn('下载',()=>download(item)));}
  wrap.append(btn('分享 / 管理',()=>share(item),'btn btn-sm btn-outline-primary'));
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
  row.append(el('td','text-secondary small',recent?(item.space_name||'共享空间'):'—'));
  const acts=el('td');acts.append(actionButtons(item));row.append(acts);return row;
 }
 function makeGrid(item){const card=el('div','cd-file-card border rounded-3 p-3');const head=el('div','d-flex gap-2 align-items-start');head.append(el('div','fs-3',fileIcon(item)));
  const check=checkbox(item);head.append(el('div','ms-auto'),check);const name=itemButton(item);name.classList.add('fw-semibold','w-100');
  const meta=el('div','small text-secondary mt-1',`${item.kind==='file'?size(item.size_bytes):'文件夹'} · ${date(item.updated_at||item.created_at)}`);
  card.append(head,name,meta);if(recent)card.append(el('div','small text-secondary',item.space_name||''));card.append(actionButtons(item));return card;
 }
 async function load(){if(!isAlive())return;const run=++seq;message.replaceChildren();itemsBox.replaceChildren(el('div','p-4 text-secondary','正在读取文件…'));
  try{
   let data,loaded=[];
   if(recent){const p=new URLSearchParams({limit:'30'});if(recentCursors[pageNo])p.set('cursor',recentCursors[pageNo]);
    data=await requestJSON(`/api/v1/files/recent?${p}`);loaded=data.files.map(x=>({...x,kind:'file'}));nextPage=data.has_more;if(data.cursor)recentCursors[pageNo+1]=data.cursor;
   }else if(search.value.trim()){
    const p=new URLSearchParams({space_id:spaceId,q:search.value.trim()});data=await requestJSON(`/api/v1/search?${p}`);
    loaded=[...data.folders.map(x=>({...x,kind:'folder',space_id:spaceId})),...data.files.map(x=>({...x,kind:'file',space_id:spaceId}))];loaded=sortedLocal(loaded,sort.value);nextPage=false;
   }else{
    const p=new URLSearchParams({limit:'50',offset:String(offset),sort:sort.value,filter:filter.value});if(parentId)p.set('parent_id',parentId);
    data=await requestJSON(`/api/v1/spaces/${spaceId}/contents?${p}`);loaded=[...data.folders.map(x=>({...x,kind:'folder',space_id:spaceId})),...data.files.map(x=>({...x,kind:'file',space_id:spaceId}))];nextPage=data.has_more;
   }
   if(run!==seq||!isAlive())return;
   currentItems=loaded;selected.clear();if(!recent)breadcrumb();draw();prev.disabled=recent?pageNo===0:offset===0;next.disabled=!nextPage;
   if(!recent&&search.value.trim())pageState.textContent='搜索结果（最多显示前 100 项）';
  }catch(err){if(run!==seq)return;itemsBox.replaceChildren();note(err.message);next.disabled=true;}
 }
 function openFolder(item){parentId=item.id;history.push(item);offset=0;search.value='';selected.clear();load()}
 async function goPage(direction){if(recent){pageNo=Math.max(0,pageNo+direction)}else{offset=Math.max(0,offset+50*direction)}await load()}
 function preview(item){openPreview(item,currentItems.filter(x=>x.kind==='file'),{onError:err=>note(err)});}
 function download(item){try{downloadNative(item);note(`已交给浏览器下载：${item.name}。大文件不会载入网页内存。`,'info')}catch(err){note(err.message)}}
 async function share(item){try{const me=await requestJSON('/api/v1/auth/me');await openShareDialog(item,{isAdmin:me.user.role==='super_admin',onCreated:()=>note('分享已创建，请在弹窗中复制并保存新链接。','success')})}catch(err){note(err.message)}}
 async function rename(item){try{const name=await askName({title:`重命名${displayName(item)}`,value:item.name});if(name===null||name===item.name)return;
  await requestJSON(`/api/v1/${item.kind==='folder'?'folders':'files'}/${item.id}`,{method:'PATCH',body:{name}});note('重命名完成','success');await load();}catch(err){note(err.message)}}
 async function move(item){try{const dest=await pickFolder({spaceId:spaceFor(item),spaceName:currentSpace()?.name||item.space_name});if(dest===null)return;const destinationId=dest.folderId;
  const path=item.kind==='folder'?`/api/v1/folders/${item.id}`:`/api/v1/files/${item.id}/move`;
  await requestJSON(path,{method:item.kind==='folder'?'PATCH':'POST',body:item.kind==='folder'?{parent_id:destinationId}:{target_folder_id:destinationId}});note('移动完成','success');await load();}catch(err){note(err.message)}}
 async function copy(item){if(!downloadable(item))return;try{const name=await askName({title:'复制文件',label:'副本名称',value:`副本-${item.name}`});if(name===null)return;
  const dest=await pickFolder({spaceId:spaceFor(item),spaceName:currentSpace()?.name||item.space_name,title:'选择副本存放目录'});if(dest===null)return;
  await requestJSON(`/api/v1/files/${item.id}/copy`,{method:'POST',body:{name,target_folder_id:dest.folderId}});note('副本已创建（共享不可变 R2 对象）','success');await load();}catch(err){note(err.message)}}
 async function remove(item){if(!confirm(`将${displayName(item)}「${item.name}」移入回收站？`))return;try{
  await requestJSON('/api/v1/trash',{method:'POST',body:{target_type:item.kind,target_id:item.id}});note('已移入回收站','success');await load();}catch(err){note(err.message)}}
 const chunks=(arr)=>{const out=[];for(let i=0;i<arr.length;i+=BATCH)out.push(arr.slice(i,i+BATCH));return out;};
 async function batchOperation(op){const chosen=[...selected.values()];if(!chosen.length)return note('请先勾选文件或文件夹','warning');
  if(recent&&new Set(chosen.map(x=>x.space_id)).size!==1)return note('跨空间项目请分别进行批量操作','warning');
  if(op==='copy'&&chosen.some(x=>x.kind==='folder'))return note('批量复制暂只支持文件','warning');
  if(op==='delete'&&!confirm(`将所选 ${chosen.length} 项移入回收站？`))return;
  let dest=null;if(op!=='delete'){
   try{dest=await pickFolder({spaceId:spaceFor(chosen[0]),spaceName:currentSpace()?.name||chosen[0].space_name,title:op==='copy'?'批量复制到':'批量移动到'});}catch(err){return note(err.message)}
   if(dest===null)return;dest=dest.folderId;
  }
  let success=0,failed=0;for(const batch of chunks(chosen)){try{
   const data=op==='delete'?await requestJSON('/api/v1/trash/batch',{method:'POST',body:{items:batch.map(x=>({kind:x.kind,id:x.id}))}}):
    await requestJSON('/api/v1/files/batch',{method:'POST',body:{operation:op,file_ids:batch.filter(x=>x.kind==='file').map(x=>x.id),folder_ids:batch.filter(x=>x.kind==='folder').map(x=>x.id),target_folder_id:dest}});
   success+=data.results.filter(x=>x.success).length;failed+=data.results.filter(x=>!x.success).length;
  }catch{failed+=batch.length;}}
  selected.clear();await load();note(`批量${op==='move'?'移动':op==='copy'?'复制':'删除'}：成功 ${success} 项，失败 ${failed} 项`,failed?'warning':'success');
 }
 const input=el('input','d-none');input.type='file';input.multiple=true;host.append(input);
 const bigUploads=multipartUploadWidget(host,{space:()=>spaceId,folder:()=>parentId,onFinished:()=>load(),onMessage:m=>note(m)});
 input.onchange=async()=>{const files=[...input.files];for(const f of files){if(f.size>8*1024*1024){try{await bigUploads.start(f,spaceId,parentId)}catch(e){note(e.message)}continue;}
  try{note(`上传 ${f.name} 中…`,'info');const p=new URLSearchParams({space_id:spaceId,name:f.name});if(parentId)p.set('folder_id',parentId);
   const resp=await fetch(`/api/v1/storage/upload?${p}`,{method:'POST',body:f,headers:{'Content-Type':f.type||'application/octet-stream'},credentials:'same-origin'});const result=await resp.json();if(!resp.ok||!result.success)throw Error(result.error?.message||`HTTP ${resp.status}`);note(`${f.name} 上传成功`,'success');
  }catch(e){note(`${f.name}: ${e.message}`)}}input.value='';await load()};
 if(!recent){actions.append(btn('＋ 上传文件',()=>input.click(),'btn btn-sm btn-primary'),btn('＋ 新建文件夹',async()=>{try{const name=await askName({title:'创建文件夹',confirm:'创建'});if(!name)return;
  await requestJSON('/api/v1/folders',{method:'POST',body:{space_id:spaceId,parent_id:parentId,name}});await load();}catch(err){note(err.message)}}));}
 actions.append(selectedInfo,chooseAll,clear,batchMove,batchCopy,batchTrash);
 try{
  if(!recent){const data=await requestJSON('/api/v1/spaces');if(!isAlive())return;spaceList=data.items||[];
   for(const s of spaceList)spaceSelect.append(option(s.id,`${s.type==='personal'?'个人':'团队'} · ${s.name}`));spaceId=spaceList[0]?.id||null;
   if(!spaceId){itemsBox.replaceChildren(el('p','p-4 text-secondary','没有可访问的空间'));for(const b of actions.querySelectorAll('button'))b.disabled=true;return}
   spaceSelect.onchange=()=>{spaceId=spaceSelect.value;parentId=null;history=[];selected.clear();offset=0;search.value='';load()};
  }
  let debounce;search.oninput=()=>{if(recent){draw();return}clearTimeout(debounce);debounce=setTimeout(()=>{offset=0;load()},250)};
  filter.onchange=()=>{offset=0;if(recent)draw();else load()};sort.onchange=()=>{offset=0;if(recent){currentItems=sortedLocal(currentItems,sort.value);draw()}else load()};
  setView(view);await load();
 }catch(err){note(err.message)}
}
