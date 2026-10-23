import {requestJSON} from '../api.js';
const E=(t,c='',text)=>{const e=document.createElement(t);e.className=c;if(text!==undefined)e.textContent=text;return e};
const notice=(host,message,kind='info')=>{const m=E('div',`alert alert-${kind} py-2`,message);host.prepend(m);setTimeout(()=>m.remove(),5000)};
export async function renderSpaces(host,onlyPersonal=false){
 host.replaceChildren(E('h1','h3 mb-3',onlyPersonal?'个人空间':'共享空间'));
 const region=E('div','row g-3'),side=E('div','col-lg-4'),detail=E('div','col-lg-8'),sideBox=E('div','panel p-3'),body=E('div','panel p-3');
 side.append(sideBox);detail.append(body);region.append(side,detail);host.append(region);
 let selected=null,users=[];
 async function load(){try{const r=await requestJSON('/api/v1/spaces');const spaces=r.items.filter(s=>onlyPersonal?s.type==='personal':s.type==='team');sideBox.replaceChildren(E('h2','h6 mb-3',onlyPersonal?'我的个人空间':'可访问的团队空间'));
 if(!onlyPersonal){const me=await requestJSON('/api/v1/auth/me');if(me.user.role==='super_admin'){const form=E('form','d-flex gap-2 mb-3');const input=E('input','form-control form-control-sm');input.placeholder='新团队空间名称';input.required=true;input.maxLength=100;const btn=E('button','btn btn-sm btn-primary','创建');form.append(input,btn);form.onsubmit=async e=>{e.preventDefault();try{await requestJSON('/api/v1/spaces',{method:'POST',body:{name:input.value}});await load()}catch(err){notice(host,err.message,'danger')}};sideBox.append(form)}}
 for(const s of spaces){const b=E('button',`btn w-100 text-start mb-2 ${selected===s.id?'btn-primary':'btn-outline-secondary'}`,s.name+' · '+(s.membership_role||'admin'));b.onclick=()=>show(s);sideBox.append(b)}
 if(!spaces.length)sideBox.append(E('p','text-muted small','暂无可访问的空间'));
 const active=spaces.find(s=>s.id===selected)||spaces[0];if(active)await show(active);else body.replaceChildren(E('p','text-muted','暂无空间'));
 }catch(err){notice(host,err.message,'danger')}}
 async function show(s){selected=s.id;body.replaceChildren(E('h2','h5 mb-3',s.name));
 const description=E('p','text-muted small',`类型：${s.type==='personal'?'个人':'团队'} · 当前身份：${s.membership_role||'admin'}`);body.append(description);
 const folderForm=E('form','d-flex gap-2 mb-3'),folderName=E('input','form-control');folderName.placeholder='新建文件夹';folderName.required=true;folderName.maxLength=100;const create=E('button','btn btn-outline-primary','新建文件夹');folderForm.append(folderName,create);body.append(folderForm);
 const foldersHost=E('div','mb-4');body.append(foldersHost);let folderParent=null;
 async function displayFolders(){const url=`/api/v1/spaces/${s.id}/contents`+(folderParent?'?parent_id='+encodeURIComponent(folderParent):'');const r=await requestJSON(url);foldersHost.replaceChildren();const back=E('button','btn btn-sm btn-link px-0 mb-2','返回根目录');back.onclick=()=>{folderParent=null;displayFolders()};if(folderParent)foldersHost.append(back);
 for(const f of r.folders){const item=E('div','d-flex justify-content-between align-items-center border-bottom py-2');const b=E('button','btn btn-sm btn-link text-start','📁 '+f.name);b.onclick=()=>{folderParent=f.id;displayFolders()};item.append(b);
 if(s.membership_role==='owner'||s.membership_role==='admin'){const acl=E('button','btn btn-sm btn-outline-secondary','权限');acl.onclick=()=>editPermissions(f);item.append(acl)}foldersHost.append(item)}
 if(!r.folders.length)foldersHost.append(E('p','text-muted small','当前目录暂无文件夹'));}
 folderForm.onsubmit=async e=>{e.preventDefault();try{await requestJSON('/api/v1/folders',{method:'POST',body:{space_id:s.id,parent_id:folderParent,name:folderName.value}});folderName.value='';await displayFolders()}catch(err){notice(host,err.message,'danger')}};
 async function editPermissions(f){const panel=E('div','border rounded p-3 mb-3');panel.append(E('h3','h6','文件夹权限：'+f.name));const select=E('select','form-select form-select-sm mb-2');for(const [value,title] of [['viewer','只读成员'],['editor','编辑成员']]){const op=E('option','',title);op.value=value;select.append(op)};const mask=E('select','form-select form-select-sm mb-2');for(const [value,title] of [['0','禁止访问'],['1','仅查看'],['3','查看与编辑'],['15','查看、编辑、删除、分享']]){const op=E('option','',title);op.value=value;mask.append(op)};const save=E('button','btn btn-sm btn-primary','保存角色覆盖');save.onclick=async()=>{try{await requestJSON(`/api/v1/folders/${f.id}/permissions`,{method:'PUT',body:{principal_type:'role',principal_id:select.value,permission_mask:Number(mask.value)}});notice(host,'目录权限已保存','success')}catch(err){notice(host,err.message,'danger')}};panel.append(select,mask,save);body.prepend(panel)}
 try{await displayFolders()}catch(err){notice(host,err.message,'danger')}
 if(s.type==='team'&&(s.membership_role==='admin'||s.membership_role==='owner')){
 const title=E('h3','h6 mt-3','空间成员');body.append(title);const membersHost=E('div','mb-3');body.append(membersHost);
 const form=E('form','row g-2 mb-3'),name=E('input','form-control form-control-sm'),roleSelect=E('select','form-select form-select-sm');name.placeholder='成员用户名（至少2字符）';name.required=true;
 for(const [v,n] of [['viewer','只读'],['editor','编辑'],['admin','管理员']]){let op=E('option','',n);op.value=v;roleSelect.append(op)}
 const col=(control,cls)=>{const box=E('div',cls);box.append(control);return box};let add=E('button','btn btn-sm btn-primary','添加/更新');form.append(col(name,'col-5'),col(roleSelect,'col-4'),col(add,'col-3'));body.append(form);
 async function refreshMembers(){const m=await requestJSON(`/api/v1/spaces/${s.id}/members`);membersHost.replaceChildren();for(const u of m.items){const r=E('div','d-flex justify-content-between align-items-center py-1 border-bottom');r.append(E('span','small',`${u.username} · ${u.role}`));if(u.id!==s.owner_id){const del=E('button','btn btn-sm btn-outline-danger','移除');del.onclick=async()=>{if(!confirm('确认移除此成员？'))return;try{await requestJSON(`/api/v1/spaces/${s.id}/members/${u.id}`,{method:'DELETE'});await refreshMembers()}catch(err){notice(host,err.message,'danger')}};r.append(del)}membersHost.append(r)}}
 try{await refreshMembers()}catch(err){notice(host,err.message,'danger')}
 form.onsubmit=async e=>{e.preventDefault();try{const candidates=await requestJSON(`/api/v1/spaces/${s.id}/candidates?q=${encodeURIComponent(name.value)}`);const exact=candidates.items.find(u=>u.username.toLowerCase()===name.value.toLowerCase());if(!exact)throw new Error('未找到完全匹配的用户名');await requestJSON(`/api/v1/spaces/${s.id}/members/${exact.id}`,{method:'PUT',body:{role:roleSelect.value}});name.value='';await refreshMembers()}catch(err){notice(host,err.message,'danger')}};
 }
 }
 await load();
}
