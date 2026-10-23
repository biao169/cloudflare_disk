import {requestJSON} from '../api.js';
function el(tag,cls='',text=''){const e=document.createElement(tag);e.className=cls;e.textContent=text;return e;}
export async function renderTrash(host){host.replaceChildren();host.append(el('h1','h3 mb-3','回收站'));const notice=el('div','alert alert-secondary','文件保留 7 天；回收站仍占用存储空间。恢复不会自动恢复已撤销的分享链接。');host.append(notice);
 const selector=el('select','form-select mb-3');const list=el('div','list-group');host.append(selector,list);
 try{const data=await requestJSON('/api/v1/spaces');const spaces=data.items||[];for(const s of spaces){const op=el('option','',s.name);op.value=s.id;selector.append(op);}if(!spaces.length){list.textContent='没有可访问的空间';return;}}
 catch(e){list.textContent=e.message;return;}
 async function refresh(){list.replaceChildren(el('div','list-group-item text-secondary','正在读取…'));try{const data=await requestJSON('/api/v1/trash?space_id='+encodeURIComponent(selector.value));list.replaceChildren();if(!data.entries.length){list.append(el('div','list-group-item text-secondary','回收站为空'));return;}for(const t of data.entries){const row=el('div','list-group-item d-flex align-items-center flex-wrap gap-2');const title=el('div','flex-grow-1');title.append(el('div','fw-semibold',t.name||t.target_id),el('small','text-secondary',`${t.target_type==='folder'?'文件夹':'文件'} · 删除：${t.deleted_at} · 到期：${t.purge_at}`));row.append(title);
 const restore=el('button','btn btn-sm btn-outline-primary','恢复');restore.onclick=async()=>{try{await requestJSON(`/api/v1/trash/${t.id}/restore`,{method:'POST',body:{}});await refresh();}catch(e){if(confirm(e.message+'。是否尝试恢复到当前空间根目录？')){try{await requestJSON(`/api/v1/trash/${t.id}/restore`,{method:'POST',body:{target_folder_id:null}});await refresh();}catch(e2){alert(e2.message)}}}};
 const purge=el('button','btn btn-sm btn-outline-danger','永久删除');purge.onclick=async()=>{if(!confirm(`永久删除「${t.name}」？此操作无法撤销。`))return;try{await requestJSON(`/api/v1/trash/${t.id}/purge`,{method:'DELETE'});await refresh();}catch(e){alert(e.message)}};
 row.append(restore,purge);list.append(row);}}
 catch(e){list.replaceChildren(el('div','alert alert-danger',e.message))}}
 selector.onchange=refresh;await refresh();}
