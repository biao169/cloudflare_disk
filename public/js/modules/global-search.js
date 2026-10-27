import {requestJSON} from '../api.js';
import {openPreview,canPreview} from './preview.js';
import {openShareDialog} from '../components/share-dialog.js';
const el=(tag,cls='',text='')=>{const e=document.createElement(tag);e.className=cls;e.textContent=text;return e};
const button=(label,fn,cls='btn btn-sm btn-outline-secondary')=>{const b=el('button',cls,label);b.type='button';b.onclick=fn;return b};
const size=n=>Number(n)>1048576?`${(n/1048576).toFixed(1)} MB`:Number(n)>1024?`${(n/1024).toFixed(1)} KB`:`${n||0} B`;
const favoriteKey=x=>`${x.kind}:${x.id}`;
export async function renderGlobalSearch(host){
 const view=crypto.randomUUID();host.dataset.searchView=view;const alive=()=>host.isConnected&&host.dataset.searchView===view;
 host.replaceChildren();host.append(el('h1','h3 mb-3','跨空间搜索'));
 const form=el('form','panel p-3 mb-3');const controls=el('div','d-flex flex-wrap gap-2 align-items-center');
 const input=el('input','form-control');input.type='search';input.required=true;input.maxLength=46;input.placeholder='搜索个人空间和团队空间中的文件或文件夹';input.setAttribute('aria-label','全局文件搜索');input.style.flex='1 1 260px';
 const filter=el('select','form-select');filter.style.maxWidth='155px';
 for(const [v,name] of [['all','全部'],['file','文件'],['folder','文件夹'],['images','图片'],['videos','视频'],['documents','文档']]){const opt=el('option','',name);opt.value=v;filter.append(opt)}
 const submit=button('搜索',()=>{},'btn btn-primary');submit.type='submit';controls.append(input,filter,submit);form.append(controls,el('p','small text-secondary mb-0 mt-2','仅展示你当前有权访问的内容。搜索不会修改文件或权限。'));host.append(form);
 const status=el('div','small text-secondary mb-2');const results=el('section','panel cd-global-results');const footer=el('div','d-flex justify-content-between align-items-center my-3');const count=el('span','small text-secondary');const next=button('加载更多',()=>load(false));next.hidden=true;footer.append(count,next);host.append(status,results,footer);
 let cursor=null,query='',type='all',running=0,busy=false,admin=false,shown=[],favs=new Set();
 try{admin=(await requestJSON('/api/v1/auth/me')).user.role==='super_admin'}catch{}
 function locate(item){window.dispatchEvent(new CustomEvent('clouddrive:locate',{detail:{spaceId:item.space_id,folderId:item.kind==='folder'?item.id:item.folder_id}}))}
 async function toggle(item){try{const yes=favs.has(favoriteKey(item));if(yes)await requestJSON(`/api/v1/favorites/${item.kind}/${item.id}`,{method:'DELETE'});else await requestJSON('/api/v1/favorites',{method:'POST',body:{kind:item.kind,id:item.id}});if(yes)favs.delete(favoriteKey(item));else favs.add(favoriteKey(item));draw()}catch(e){status.textContent=e.message}}
 async function fetchFavorites(items){
  const set=new Set();for(let i=0;i<items.length;i+=40){const r=await requestJSON('/api/v1/favorites/check',{method:'POST',body:{items:items.slice(i,i+40).map(x=>({kind:x.kind,id:x.id}))}});for(const key of r.keys)set.add(key)}return set;
 }
 function draw(){if(!alive())return;results.replaceChildren();
  if(!shown.length){results.append(el('div','p-4 text-secondary',cursor?'本批次没有授权可见的结果，可继续加载更多。':'没有符合条件的文件或文件夹。'));return}
  for(const item of shown){const row=el('div','d-flex flex-wrap align-items-center gap-2 border-bottom p-3');
   const name=el('div','flex-grow-1');name.append(el('div','fw-semibold',`${item.kind==='folder'?'📁':'📄'} ${item.name}`),el('div','small text-secondary',`${item.space_name||'空间'} · ${item.kind==='file'?size(item.size_bytes):'文件夹'}`));row.append(name);
   row.append(button('定位',()=>locate(item)));
   row.append(button(favs.has(favoriteKey(item))?'★ 已收藏':'☆ 收藏',()=>toggle(item)));
   if(item.kind==='file'){if(canPreview(item))row.append(button('预览',()=>openPreview(item,shown.filter(x=>x.kind==='file'),{onError:m=>status.textContent=m})));row.append(button('下载',()=>{const a=el('a');a.href=`/api/v1/files/${item.id}/content`;a.download='';a.click()}))}
   row.append(button('分享 / 管理',()=>openShareDialog(item,{isAdmin:admin}).catch(err=>status.textContent=err.message),'btn btn-sm btn-outline-primary'));results.append(row)}
 }
 async function load(reset){if(!query||(busy&&!reset))return;busy=true;const run=++running;next.disabled=true;status.textContent='正在搜索…';if(reset){shown=[];cursor=null;results.replaceChildren()}
  try{const p=new URLSearchParams({q:query,type,limit:'30'});if(cursor)p.set('cursor',cursor);
   const data=await requestJSON(`/api/v1/search/global?${p}`);if(!alive()||run!==running)return;
   shown.push(...data.items);cursor=data.cursor;const checked=await fetchFavorites(shown);if(!alive()||run!==running)return;favs=checked;
   draw();count.textContent=`已显示 ${shown.length} 项`;next.hidden=!cursor;status.textContent=`搜索完成 · ${shown.length} 条可见结果${cursor?'（还有更多）':''}`;
  }catch(err){if(alive())status.textContent=`搜索失败：${err.message}`}finally{if(run===running){busy=false;next.disabled=false}}
 }
 form.onsubmit=e=>{e.preventDefault();query=input.value.trim();type=filter.value;if(!query){status.textContent='请输入搜索关键词';return}try{const u=new URL(location.href);u.searchParams.set('q',query);window.history.replaceState(window.history.state,'',u.pathname+u.search)}catch{}void load(true)};
 const preset=new URL(location.href).searchParams.get('q');if(preset){input.value=preset;query=preset;void load(true)}
}
