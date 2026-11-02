import {requestJSON} from '../api.js';
import {bindFolderDoubleClick} from '../utils/folder-open.js';
import {formatUtc} from '../utils/time.js';
import {canPreview,openPreview} from './preview.js';
import {downloadUrl} from './file-manager.js';

const E=(t,c='',text)=>{const e=document.createElement(t);e.className=c;if(text!==undefined)e.textContent=text;return e};
const notice=(host,message,kind='info')=>{const m=E('div',`alert alert-${kind} py-2`,message);host.prepend(m);setTimeout(()=>m.remove(),5000)};
const CONTENT_PAGE_SIZE=50;
const fileIcon=f=>f.mime_type?.startsWith('image/')?'🖼️':f.mime_type?.startsWith('video/')?'🎬':f.mime_type==='application/pdf'?'📕':'📄';
const fileSize=value=>{const n=Number(value);if(!Number.isFinite(n)||n<0||value==null)return '—';if(n>=1073741824)return `${(n/1073741824).toFixed(2)} GB`;if(n>=1048576)return `${(n/1048576).toFixed(1)} MB`;if(n>=1024)return `${(n/1024).toFixed(1)} KB`;return `${n} B`};

// /personal and /spaces use the same ACL-aware contents API as /files.
// Both folders AND ready files must be rendered: folders alone are not a valid empty-state check.
export function normalizeSpaceContents(data){
 return {
  folders:Array.isArray(data?.folders)?data.folders:[],
  files:Array.isArray(data?.files)?data.files:[],
  hasMore:data?.has_more===true
 };
}

export async function renderSpaces(host,onlyPersonal=false){
 host.replaceChildren(E('h1','h3 mb-3',onlyPersonal?'个人空间':'共享空间'));
 const region=E('div','row g-3'),side=E('div','col-lg-4'),detail=E('div','col-lg-8'),sideBox=E('div','panel p-3'),body=E('div','panel p-3');
 side.append(sideBox);detail.append(body);region.append(side,detail);host.append(region);
 let selected=null,spaceButtons=new Map(),viewGeneration=0;
 async function load(){try{
  const r=await requestJSON('/api/v1/spaces');
  const spaces=r.items.filter(s=>onlyPersonal?s.type==='personal':s.type==='team');
  sideBox.replaceChildren(E('h2','h6 mb-3',onlyPersonal?'我的个人空间':'可访问的团队空间'));spaceButtons=new Map();
  if(!onlyPersonal){const me=await requestJSON('/api/v1/auth/me');if(me.user.role==='super_admin'){
   const form=E('form','d-flex gap-2 mb-3'),input=E('input','form-control form-control-sm');input.placeholder='新团队空间名称';input.required=true;input.maxLength=100;
   const btn=E('button','btn btn-sm btn-primary','创建');form.append(input,btn);
   form.onsubmit=async e=>{e.preventDefault();try{await requestJSON('/api/v1/spaces',{method:'POST',body:{name:input.value}});await load()}catch(err){notice(host,err.message,'danger')}};sideBox.append(form);
  }}
  for(const s of spaces){const b=E('button','btn w-100 text-start mb-2',s.name+' · '+(s.membership_role||'admin'));b.type='button';b.onclick=()=>void show(s);spaceButtons.set(s.id,b);sideBox.append(b)}
  if(!spaces.length)sideBox.append(E('p','text-muted small','暂无可访问的空间'));
  const active=spaces.find(s=>s.id===selected)||spaces[0];if(active)await show(active);else body.replaceChildren(E('p','text-muted','暂无空间'));
 }catch(err){notice(host,err.message,'danger')}}
 async function show(s){
  selected=s.id;const view=++viewGeneration;
  for(const [id,b] of spaceButtons){b.classList.toggle('btn-primary',id===selected);b.classList.toggle('btn-outline-secondary',id!==selected)}
  body.replaceChildren(E('h2','h5 mb-3',s.name));
  body.append(E('p','text-muted small',`类型：${s.type==='personal'?'个人':'团队'} · 当前身份：${s.membership_role||'admin'}`));
  const folderForm=E('form','d-flex gap-2 mb-3'),folderName=E('input','form-control');folderName.placeholder='新建文件夹';folderName.required=true;folderName.maxLength=100;
  const create=E('button','btn btn-outline-primary','新建文件夹');folderForm.append(folderName,create);
  if(s.membership_role!=='viewer')body.append(folderForm);
  const contentsHost=E('section','mb-4');contentsHost.setAttribute('aria-label','文件和文件夹');
  contentsHost.append(E('h3','h6 mb-2','文件和文件夹'));
  const trail=E('nav','d-flex flex-wrap gap-1 align-items-center small mb-2');trail.setAttribute('aria-label','文件夹路径');
  const status=E('div','small text-secondary mb-2');status.setAttribute('role','status');
  const entriesHost=E('div','');
  const more=E('button','btn btn-sm btn-outline-secondary mt-3','加载更多文件和文件夹');more.type='button';more.hidden=true;
  contentsHost.append(trail,status,entriesHost,more);body.append(contentsHost);
  let folderParent=null,crumbs=[],offset=0,loadedFolders=0,loadedFiles=0,hasMore=false,requestGeneration=0;
  const active=()=>selected===s.id&&view===viewGeneration;
  const directoryUrl=(pageOffset)=>{const q=new URLSearchParams({limit:String(CONTENT_PAGE_SIZE),offset:String(pageOffset)});if(folderParent)q.set('parent_id',folderParent);return `/api/v1/spaces/${s.id}/contents?${q}`;};
  function showTrail(){trail.replaceChildren();const root=E('button','btn btn-sm btn-link px-0','根目录');root.type='button';root.onclick=()=>void navigate(-1);trail.append(root);
   crumbs.forEach((f,i)=>{trail.append(E('span','text-muted','/'));const b=E('button','btn btn-sm btn-link px-0',f.name);b.type='button';b.onclick=()=>void navigate(i);trail.append(b)});
  }
  function folderRow(f){const row=E('div','d-flex flex-wrap gap-2 justify-content-between align-items-center border-bottom py-2');
   const name=E('button','btn btn-sm btn-link text-start text-decoration-none','📁 '+f.name);name.type='button';name.onclick=()=>void enterFolder(f);row.append(name);
   bindFolderDoubleClick(row,()=>void enterFolder(f));
   if(s.membership_role==='owner'||s.membership_role==='admin'){
    const acl=E('button','btn btn-sm btn-outline-secondary','权限');acl.type='button';acl.onclick=()=>editPermissions(f);row.append(acl);
   }
   return row;
  }
  function fileRow(f){const row=E('div','d-flex flex-wrap gap-2 justify-content-between align-items-center border-bottom py-2');
   const detail=E('div','d-flex flex-column flex-grow-1');
   const previewable=canPreview(f);
   const name=E(previewable?'button':'a','btn btn-sm btn-link text-start text-decoration-none p-0',`${fileIcon(f)} ${f.name}`);
   if(previewable){name.type='button';name.onclick=()=>openPreview(f,visibleFiles,{onError:message=>notice(host,message,'danger')})}
   else{name.href=downloadUrl(f.id);name.setAttribute('download','')}
   detail.append(name);
   detail.append(E('span','text-secondary small',`${fileSize(f.size_bytes)} · ${formatUtc(f.updated_at||f.created_at)}`));row.append(detail);
   const actions=E('div','d-flex gap-2 flex-wrap');
   if(previewable){const preview=E('button','btn btn-sm btn-outline-secondary','预览');preview.type='button';preview.onclick=()=>openPreview(f,visibleFiles,{onError:message=>notice(host,message,'danger')});actions.append(preview)}
   const download=E('a','btn btn-sm btn-outline-primary','下载');download.href=downloadUrl(f.id);download.setAttribute('download','');actions.append(download);row.append(actions);
   return row;
  }
  const visibleFiles=[];
  async function displayContents(append=false){
   const run=++requestGeneration,pageOffset=append?offset:0;
   if(!append){entriesHost.replaceChildren();offset=0;loadedFolders=0;loadedFiles=0;visibleFiles.length=0;status.textContent='正在加载文件和文件夹…';showTrail()}
   more.disabled=true;more.hidden=true;
   try{
    const data=normalizeSpaceContents(await requestJSON(directoryUrl(pageOffset)));
    if(run!==requestGeneration||!active())return;
    if(!append)entriesHost.replaceChildren();
    for(const f of data.folders)entriesHost.append(folderRow(f));
    for(const f of data.files){visibleFiles.push(f);entriesHost.append(fileRow(f))}
    loadedFolders+=data.folders.length;loadedFiles+=data.files.length;hasMore=data.hasMore;
    offset=pageOffset+CONTENT_PAGE_SIZE;
    status.textContent=`已显示 ${loadedFolders} 个文件夹、${loadedFiles} 个文件${hasMore?' · 还有更多项目':''}`;
    if(!loadedFolders&&!loadedFiles&&!hasMore)entriesHost.append(E('p','text-muted small','当前目录暂无文件或文件夹'));
    if(!data.folders.length&&!data.files.length&&hasMore)entriesHost.append(E('p','text-muted small','当前批次没有可见项目，请继续加载更多'));
    more.textContent='加载更多文件和文件夹';more.hidden=!hasMore;more.disabled=!hasMore;
   }catch(err){if(run!==requestGeneration||!active())return;status.textContent='读取目录失败';
    notice(host,err.message,'danger');if(!loadedFolders&&!loadedFiles)entriesHost.replaceChildren(E('p','text-danger small','无法加载当前目录，请重新打开文件夹或刷新页面'));
    more.hidden=false;more.disabled=false;more.textContent='重试加载';
   }
  }
  async function enterFolder(f){crumbs.push({id:f.id,name:f.name});folderParent=f.id;await displayContents()}
  async function navigate(index){crumbs=crumbs.slice(0,index+1);folderParent=crumbs.at(-1)?.id||null;await displayContents()}
  more.onclick=()=>void displayContents(true);
  folderForm.onsubmit=async e=>{e.preventDefault();try{await requestJSON('/api/v1/folders',{method:'POST',body:{space_id:s.id,parent_id:folderParent,name:folderName.value}});folderName.value='';await displayContents()}catch(err){notice(host,err.message,'danger')}};
  async function editPermissions(f){const panel=E('div','border rounded p-3 mb-3');panel.append(E('h3','h6','文件夹权限：'+f.name));
   const select=E('select','form-select form-select-sm mb-2');for(const [value,title] of [['viewer','只读成员'],['editor','编辑成员']]){const op=E('option','',title);op.value=value;select.append(op)}
   const mask=E('select','form-select form-select-sm mb-2');for(const [value,title] of [['0','禁止访问'],['1','仅查看'],['3','查看与编辑'],['15','查看、编辑、删除、分享']]){const op=E('option','',title);op.value=value;mask.append(op)}
   const save=E('button','btn btn-sm btn-primary','保存角色覆盖');save.type='button';save.onclick=async()=>{try{await requestJSON(`/api/v1/folders/${f.id}/permissions`,{method:'PUT',body:{principal_type:'role',principal_id:select.value,permission_mask:Number(mask.value)}});notice(host,'目录权限已保存','success')}catch(err){notice(host,err.message,'danger')}};
   panel.append(select,mask,save);body.prepend(panel);
  }
  await displayContents();
  if(!active())return;
  if(s.type==='team'&&(s.membership_role==='admin'||s.membership_role==='owner')){
   const title=E('h3','h6 mt-3','空间成员');body.append(title);const membersHost=E('div','mb-3');body.append(membersHost);
   const form=E('form','row g-2 mb-3'),name=E('input','form-control form-control-sm'),roleSelect=E('select','form-select form-select-sm');name.placeholder='成员用户名（至少2字符）';name.required=true;
   for(const [v,n] of [['viewer','只读'],['editor','编辑'],['admin','管理员']]){let op=E('option','',n);op.value=v;roleSelect.append(op)}
   const col=(control,cls)=>{const box=E('div',cls);box.append(control);return box};let add=E('button','btn btn-sm btn-primary','添加/更新');form.append(col(name,'col-5'),col(roleSelect,'col-4'),col(add,'col-3'));body.append(form);
   async function refreshMembers(){const m=await requestJSON(`/api/v1/spaces/${s.id}/members`);membersHost.replaceChildren();for(const u of m.items){const r=E('div','d-flex justify-content-between align-items-center py-1 border-bottom');r.append(E('span','small',`${u.username} · ${u.role}`));if(u.id!==s.owner_id){const del=E('button','btn btn-sm btn-outline-danger','移除');del.type='button';del.onclick=async()=>{if(!confirm('确认移除此成员？'))return;try{await requestJSON(`/api/v1/spaces/${s.id}/members/${u.id}`,{method:'DELETE'});await refreshMembers()}catch(err){notice(host,err.message,'danger')}};r.append(del)}membersHost.append(r)}}
   try{await refreshMembers()}catch(err){notice(host,err.message,'danger')}
   form.onsubmit=async e=>{e.preventDefault();try{const candidates=await requestJSON(`/api/v1/spaces/${s.id}/candidates?q=${encodeURIComponent(name.value)}`);const exact=candidates.items.find(u=>u.username.toLowerCase()===name.value.toLowerCase());if(!exact)throw new Error('未找到完全匹配的用户名');await requestJSON(`/api/v1/spaces/${s.id}/members/${exact.id}`,{method:'PUT',body:{role:roleSelect.value}});name.value='';await refreshMembers()}catch(err){notice(host,err.message,'danger')}};
  }
 }
 await load();
}
