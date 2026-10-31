const form=document.getElementById('od-form'),out=document.getElementById('od-result');
function message(text,kind='secondary'){out.replaceChildren();const p=document.createElement('div');p.className=`alert alert-${kind}`;p.textContent=text;out.appendChild(p);}
async function checkStatus(){try{const r=await fetch('/api/v1/tools/onedrive/status',{credentials:'same-origin'}),data=await r.json();if(!data.success){message(data.error?.message||'工具当前不可用','warning');form.querySelector('button').disabled=true;}}catch{message('无法读取工具状态','warning');}}
form.addEventListener('submit',async e=>{e.preventDefault();message('正在检查链接格式……');try{
 const r=await fetch('/api/v1/tools/onedrive/resolve',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({url:document.getElementById('od-url').value.trim()})});const result=await r.json();if(!result.success)return message(result.error?.message||'解析失败','warning');
 const data=result.data;message(`格式有效：${data.link_kind}。${data.message}`,'success');
 const code=document.createElement('textarea');code.className='form-control mt-2';code.rows=3;code.readOnly=true;code.value=data.share_token;code.setAttribute('aria-label','Graph 分享令牌');out.appendChild(code);
 const copy=document.createElement('button');copy.className='btn btn-outline-secondary btn-sm mt-2';copy.textContent='复制 Graph 分享令牌';copy.addEventListener('click',()=>navigator.clipboard?.writeText(data.share_token));out.appendChild(copy);
 }catch{message('网络异常，请稍后重试','danger');}});
checkStatus();

// RC14.3: logged-in users may manage stable source-page links. These links are
// deliberately NOT advertised as direct file downloads until Graph is integrated.
const linkPanel=document.createElement('section');linkPanel.className='card p-3 mt-4';
linkPanel.innerHTML='<h2 class="h5">固定入口管理（登录用户）</h2><p class="small text-secondary">固定入口默认打开原分享页；可为自己的链接启用公开直链尝试。若微软不允许免登录下载，自动回退分享页。</p>';
const createButton=document.createElement('button');createButton.className='btn btn-outline-primary btn-sm';createButton.textContent='为当前链接创建固定入口';
const linkList=document.createElement('div');linkList.className='mt-3';
linkPanel.append(createButton,linkList);document.querySelector('main')?.append(linkPanel);
async function loadLinks(){
 try{const r=await fetch('/api/v1/tools/onedrive/links',{credentials:'same-origin'});if(r.status===401){linkPanel.hidden=true;return;}
 const j=await r.json();if(!j.success)return;linkList.replaceChildren();
 for(const item of j.data.links){const el=document.createElement('div');el.className='border-top py-2';const a=document.createElement('a');a.href=item.url;a.textContent=`${location.origin}${item.url}`;a.rel='noopener noreferrer';a.target='_blank';el.append(a,document.createTextNode(` (${item.status}; ${item.access_count} 次访问) `));
 if(item.status==='active'){const mode=document.createElement('button');mode.className='btn btn-outline-secondary btn-sm ms-2';mode.textContent=item.delivery==='public_direct'?'关闭直链尝试':'尝试公开直链';mode.onclick=async()=>{const r=await fetch('/api/v1/tools/onedrive/links/'+item.id,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({delivery_mode:item.delivery==='public_direct'?'source_page_redirect':'public_direct'})});const j=await r.json();if(!j.success)message(j.error?.message||'更新失败','warning');await loadLinks();};el.append(mode);const b=document.createElement('button');b.className='btn btn-outline-danger btn-sm ms-2';b.textContent='撤销';b.onclick=async()=>{if(!confirm('撤销此固定入口？'))return;await fetch('/api/v1/tools/onedrive/links/'+item.id,{method:'DELETE',credentials:'same-origin'});await loadLinks();};el.append(b);}linkList.append(el);}
 }catch{linkList.textContent='固定入口列表加载失败';}
}
createButton.onclick=async()=>{const url=document.getElementById('od-url').value.trim();if(!url)return message('请先填写分享链接','warning');
 try{const r=await fetch('/api/v1/tools/onedrive/links',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({url})});const j=await r.json();if(!j.success)return message(j.error?.message||'创建失败','warning');message(j.data.message,'success');await loadLinks();}
 catch{message('网络异常','danger');}};
loadLinks();

const checkPublic=document.createElement('button');checkPublic.className='btn btn-outline-secondary btn-sm mt-2';checkPublic.textContent='验证公开文件直链（无需微软登录）';checkPublic.onclick=async()=>{const url=document.getElementById('od-url').value.trim();if(!url)return message('请先填写分享链接','warning');checkPublic.disabled=true;try{const r=await fetch('/api/v1/tools/onedrive/public-check',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({url})});const j=await r.json();if(!j.success)return message(j.error?.message||'检查失败','warning');message(j.data.anonymous_direct_verified?'已取得无需微软登录的短期有效直链（可生成固定入口并开启直链尝试）。':'未能确认公开下载能力：'+j.data.reason+'。仍可使用原分享页入口。',j.data.anonymous_direct_verified?'success':'warning');if(j.data.anonymous_direct_verified){const a=document.createElement('a');a.href=j.data.download_url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='打开刚解析的临时下载直链';out.append(a);}}catch{message('公开直链探测请求失败','danger');}finally{checkPublic.disabled=false;}};form.after(checkPublic);

// RC14.4: Admin-only Microsoft connection panel (the backend checks admin role).
(async()=>{
 const root=document.querySelector('main');if(!root)return;
 const res=await fetch('/api/v1/admin/onedrive/oauth',{credentials:'same-origin'}).catch(()=>null);
 if(!res?.ok)return;
 const state=await res.json();if(!state.success)return;
 const panel=document.createElement('section');panel.className='card p-3 mt-4';
 const title=document.createElement('h2');title.className='h5';title.textContent='管理员 Microsoft OneDrive 授权';panel.append(title);
 const msg=document.createElement('p');msg.className='small text-secondary';msg.textContent=state.data.connected?'已连接 Microsoft 账户':'尚未连接 Microsoft 账户';panel.append(msg);
 const btn=(label,action)=>{const b=document.createElement('button');b.className='btn btn-outline-primary btn-sm me-2 mb-2';b.textContent=label;b.addEventListener('click',action);panel.append(b);};
 btn('连接 Microsoft 账户',async()=>{const r=await fetch('/api/v1/admin/onedrive/oauth/start');const j=await r.json();if(j.success&&j.data.authorization_url){location.assign(j.data.authorization_url);}else msg.textContent=j.error?.message||'授权启动失败';});
 btn('解析当前链接（管理员）',async()=>{const url=document.getElementById('od-url')?.value.trim();if(!url)return;msg.textContent='正在通过 Microsoft Graph 读取文件信息…';const r=await fetch('/api/v1/admin/onedrive/graph/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});const j=await r.json();if(!j.success){msg.textContent=j.error?.message||'Graph 解析失败';return;}
 msg.textContent=`文件：${j.data.name||'未知'}；大小：${j.data.size??'未知'}；下载链接：${j.data.download_verified?'已获得短期有效地址':'未返回'}`;
 if(j.data.download_url){const a=document.createElement('a');a.href=j.data.download_url;a.textContent='打开临时下载地址（仅管理员）';a.rel='noreferrer noopener';a.target='_blank';panel.append(a);}
 });
 btn('解除 Microsoft 连接',async()=>{if(!confirm('确定断开 OneDrive？此操作不撤销微软端授权，请按需在 Microsoft 账户中撤销。'))return;const r=await fetch('/api/v1/admin/onedrive/oauth',{method:'DELETE'});if(r.ok)msg.textContent='已断开，请刷新页面';});
 root.append(panel);
})();
