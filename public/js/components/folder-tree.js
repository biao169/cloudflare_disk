// RC12: lazy, ACL-filtered navigation. Directory names are always DOM text, not HTML.
import {requestJSON} from '../api.js';
const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n};
export function mountFolderTree(host,{spaceId,spaceName,onNavigate}){
 const title=el('div','fw-semibold small px-2 py-2','文件夹导航');const tree=el('nav','cd-folder-tree small');tree.setAttribute('aria-label','文件夹树');
 host.replaceChildren(title,tree);
 let selected=null,disposed=false;const nodes=new Map();
 const makeItem=(id,name,depth,parentHost)=>{
  const row=el('div','cd-tree-row d-flex align-items-center gap-1');row.style.paddingLeft=`${Math.min(depth,14)*11}px`;
  const exp=el('button','btn btn-sm cd-tree-toggle','▸');exp.type='button';exp.setAttribute('aria-label',`展开 ${name}`);
  const label=el('button','btn btn-sm text-start flex-grow-1 text-truncate cd-tree-name',name);label.type='button';label.title=name;
  row.append(exp,label);const kids=el('div','cd-tree-children');kids.hidden=true;parentHost.append(row,kids);
  const entry={id,name,depth,row,kids,label,exp,loaded:false,expanded:false,next:0,hasMore:true,loading:null};nodes.set(id??'root',entry);
  label.onclick=()=>{if(disposed)return;select(id);onNavigate(id)};
  exp.onclick=()=>{entry.expanded=!entry.expanded;kids.hidden=!entry.expanded;exp.textContent=entry.expanded?'▾':'▸';if(entry.expanded&&!entry.loaded)load(entry).catch(()=>{});};
  return entry;
 };
 const root=makeItem(null,spaceName,0,tree);root.expanded=true;root.exp.textContent='▾';root.kids.hidden=false;
 function select(id){selected=id;for(const entry of nodes.values())entry.label.classList.toggle('active',entry.id===id)}
 async function load(entry){
  if(entry.loading)return entry.loading;
  entry.loading=(async()=>{
  const generation=spaceId;
  const offset=entry.next;entry.loaded=true;
  const params=new URLSearchParams({limit:'100',offset:String(offset)});if(entry.id)params.set('parent_id',entry.id);
  try{
   const data=await requestJSON(`/api/v1/spaces/${spaceId}/folders?${params}`);
   if(disposed||generation!==spaceId)return;
   if(offset===0)entry.kids.replaceChildren();
   for(const f of data.items)makeItem(f.id,f.name,entry.depth+1,entry.kids);
   entry.next+=100;entry.hasMore=data.has_more;
   entry.exp.disabled=false;
   const oldMore=entry.kids.querySelector(':scope > .cd-tree-more');oldMore?.remove();
   if(data.has_more){const more=el('button','btn btn-sm btn-link cd-tree-more','加载更多…');more.type='button';more.style.marginLeft=`${(entry.depth+1)*11}px`;more.onclick=()=>load(entry).catch(()=>{});entry.kids.append(more)}
   select(selected);
  }catch(err){if(!disposed){const warning=el('div','small text-danger px-2',err.message);entry.kids.append(warning);entry.loaded=false;}}
  })().finally(()=>{entry.loading=null});
  return entry.loading;
 }
 void load(root);
 return {
  select,
  async expandPath(path){for(const f of path){const parent=nodes.get(f.parent_id??'root');if(parent){if(parent.loading)await parent.loading;else if(!parent.loaded)await load(parent);parent.expanded=true;parent.kids.hidden=false;parent.exp.textContent='▾';} }select(path.at(-1)?.id??null)},
  refresh(){nodes.clear();tree.replaceChildren();const refreshed=makeItem(null,spaceName,0,tree);refreshed.expanded=true;refreshed.exp.textContent='▾';refreshed.kids.hidden=false;void load(refreshed);select(selected)},
  dispose(){disposed=true;host.replaceChildren()}
 };
}
