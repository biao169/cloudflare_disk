import {multipartUploadWidget} from './multipart-upload.js';
import {requestJSON} from '../api.js';
import {openPreview,canPreview} from './preview.js';
const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const fmt=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
export async function renderFileManager(host,mode='files'){
 host.replaceChildren(el('h1','h3 mb-3',mode==='recent'?'最近文件':'全部文件'));
 const alert=el('div','');host.append(alert);function note(message,kind='danger'){alert.replaceChildren(el('div',`alert alert-${kind}`,message))}
 const toolbar=el('div','d-flex flex-wrap gap-2 mb-3'),sel=el('select','form-select form-select-sm'),search=el('input','form-control form-control-sm');sel.style.maxWidth='240px';search.style.maxWidth='220px';search.type='search';search.placeholder='搜索当前空间文件';toolbar.append(sel,search);host.append(toolbar);
 const trail=el('div','mb-3 d-flex flex-wrap gap-2'),actions=el('div','d-flex gap-2 mb-3 flex-wrap'),listing=el('div','panel p-3');host.append(trail,actions,listing);
 let space=null,parent=null,history=[],items=[],selected=new Set();
 const button=(title,fn,cls='btn btn-sm btn-outline-secondary')=>{const b=el('button',cls,title);b.type='button';b.onclick=fn;return b};
 async function spaces(){try{const data=await requestJSON('/api/v1/spaces');const ss=data.items;sel.replaceChildren();for(const s of ss){const o=el('option','',`${s.type==='personal'?'个人':'团队'} · ${s.name}`);o.value=s.id;sel.append(o)}space=ss[0]?.id||null;if(space){sel.value=space;await load()}else listing.replaceChildren(el('p','text-muted','没有可访问空间'))}catch(e){note(e.message)}}
 function draw(){listing.replaceChildren();const folders=items.filter(x=>x.kind==='folder'),files=items.filter(x=>x.kind==='file');
 for(const item of [...folders,...files]){const row=el('div','d-flex align-items-center gap-2 py-2 border-bottom');if(item.kind==='file'){const chk=el('input','form-check-input');chk.type='checkbox';chk.checked=selected.has(item.id);chk.onchange=()=>{if(chk.checked)selected.add(item.id);else selected.delete(item.id)};row.append(chk)}const title=button(`${item.kind==='folder'?'📁':'📄'} ${item.name}`,()=>item.kind==='folder'?openFolder(item):canPreview(item)?showPreview(item):downloadFile(item),'btn btn-link text-start flex-grow-1 text-decoration-none');row.append(title);row.append(el('small','text-muted',item.kind==='file'?fmt(item.size_bytes):''));row.append(button('重命名',()=>rename(item)));if(item.kind==='folder')row.append(button('移动',()=>moveFolder(item)));else {if(canPreview(item))row.append(button('预览',()=>showPreview(item)));row.append(button('下载',()=>downloadFile(item)));row.append(button('复制',()=>copyFile(item)));row.append(button('分享',()=>shareFile(item)));}row.append(button('删除',()=>removeItem(item),'btn btn-sm btn-outline-danger'));listing.append(row)}
 if(!items.length)listing.append(el('p','text-muted m-0','此目录暂无文件。可点击上传文件添加内容。'));
 }
 function breadcrumb(){trail.replaceChildren(button('根目录',()=>{parent=null;history=[];selected.clear();load()}));for(let i=0;i<history.length;i++){const idx=i;trail.append(el('span','text-muted','/'));trail.append(button(history[i].name,()=>{parent=history[idx].id;history=history.slice(0,idx+1);selected.clear();load()}))}}
 async function load(){if(!space)return;try{const res=await requestJSON(`/api/v1/spaces/${space}/contents${parent?'?parent_id='+encodeURIComponent(parent):''}`);items=[...res.folders.map(f=>({...f,kind:'folder'})),...res.files.map(f=>({...f,kind:'file'}))];breadcrumb();draw()}catch(e){note(e.message)}}
 function openFolder(item){parent=item.id;history.push(item);selected.clear();load()}
 async function removeItem(item){if(!confirm(`将「${item.name}」移入回收站？`))return;try{await requestJSON('/api/v1/trash',{method:'POST',body:{target_type:item.kind,target_id:item.id}});selected.delete(item.id);note('已移入回收站','success');await load()}catch(e){note(e.message)}}
 async function rename(item){const name=prompt('新名称',item.name);if(name===null||name===item.name)return;try{await requestJSON(`/api/v1/${item.kind==='folder'?'folders':'files'}/${item.id}`,{method:'PATCH',body:{name}});await load()}catch(e){note(e.message)}}
 async function moveFolder(item){const target=prompt('目标文件夹 ID（留空移至根目录）','');if(target===null)return;try{await requestJSON(`/api/v1/folders/${item.id}`,{method:'PATCH',body:{parent_id:target||null}});await load()}catch(e){note(e.message)}}
 function showPreview(item){openPreview(item,items.filter(x=>x.kind==='file'),{onError:m=>note(m)});}
 async function downloadFile(item){try{const r=await fetch(`/api/v1/files/${item.id}/content`,{credentials:'same-origin'});if(!r.ok)throw Error(`下载失败 (${r.status})`);const blob=await r.blob();const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download=item.name;document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url)}catch(e){note(e.message)}}
 const bigUploads=multipartUploadWidget(host,{space:()=>space,folder:()=>parent,onFinished:load,onMessage:m=>note(m)});
 const uploader=el('input','d-none');uploader.type='file';uploader.multiple=true;host.append(uploader);
 uploader.onchange=async()=>{const uploads=[...uploader.files];for(const file of uploads){
  if(file.size>8*1024*1024){try{await bigUploads.start(file,space,parent)}catch(e){note(e.message)}continue;}
  try{note(`正在上传 ${file.name} ...`,'info');const p=new URLSearchParams({space_id:space,name:file.name});if(parent)p.set('folder_id',parent);
   const r=await fetch(`/api/v1/storage/upload?${p}`,{method:'POST',body:file,headers:{'Content-Type':file.type||'application/octet-stream'},credentials:'same-origin'});
   const result=await r.json();if(!r.ok||!result.success)throw Error(result.error?.message||`HTTP ${r.status}`);
   note(`${file.name} 上传成功`,'success');
  }catch(e){note(`${file.name}: ${e.message}`)}}uploader.value='';await load()};
 actions.append(button('上传文件',()=>uploader.click(),'btn btn-sm btn-primary'));
 async function shareFile(item){try{const type=confirm('确定创建分享页面？取消将创建 7 天临时直链。')?'page':'temporary';const data=await requestJSON('/api/v1/shares',{method:'POST',body:{type,target_type:'file',target_id:item.id,expires_at:type==='temporary'?new Date(Date.now()+7*86400000).toISOString():null}});await navigator.clipboard.writeText(data.url);note('分享链接已复制：'+data.url,'success')}catch(e){note(e.message)}}
 async function copyFile(item){const name=prompt('副本名称',`副本-${item.name}`);if(!name)return;try{await requestJSON(`/api/v1/files/${item.id}/copy`,{method:'POST',body:{name}});await load()}catch(e){note(e.message)}}
 actions.append(button('新建文件夹',async()=>{const name=prompt('文件夹名称');if(!name)return;try{await requestJSON('/api/v1/folders',{method:'POST',body:{space_id:space,parent_id:parent,name}});await load()}catch(e){note(e.message)}}));
 actions.append(button('批量删除已选文件',async()=>{if(!selected.size)return note('请先选择文件','warning');if(!confirm(`将 ${selected.size} 个文件移入回收站？`))return;let success=0;for(const id of [...selected]){try{await requestJSON('/api/v1/trash',{method:'POST',body:{target_type:'file',target_id:id}});success++;}catch(e){note(e.message)}}selected.clear();note(`已移入回收站：${success} 项`,'success');await load()},'btn btn-sm btn-outline-danger'));
 actions.append(button('批量移动已选文件',async()=>{if(!selected.size){note('请先选择文件','warning');return}const id=prompt('目标文件夹 ID（留空移至根目录）','');if(id===null)return;try{const r=await requestJSON('/api/v1/files/batch',{method:'POST',body:{operation:'move',file_ids:[...selected],target_folder_id:id||null}});note(r.partial_failure?'部分文件移动失败':'批量移动完成',r.partial_failure?'warning':'success');selected.clear();await load()}catch(e){note(e.message)}}));
 sel.onchange=()=>{space=sel.value;parent=null;history=[];selected.clear();search.value='';load()};
 let seq=0;search.oninput=async()=>{const num=++seq,term=search.value.trim();if(!term){await load();return}if(!space)return;try{const r=await requestJSON(`/api/v1/search?space_id=${encodeURIComponent(space)}&q=${encodeURIComponent(term)}`);if(num!==seq)return;items=[...r.folders.map(f=>({...f,kind:'folder'})),...r.files.map(f=>({...f,kind:'file'}))];draw()}catch(e){note(e.message)}};
 await spaces();
}
