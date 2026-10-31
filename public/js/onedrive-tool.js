// The public OneDrive tool must never render account or link-management controls
// until the Worker confirms an authenticated CloudDrive session. Anonymous
// visitors see only the link format parser when the admin allows guest access.
const form=document.getElementById('od-form');
const out=document.getElementById('od-result');
const submit=form.querySelector('button[type="submit"]');
const main=document.querySelector('main');
submit.disabled=true;
let enabled=false;
let authenticated=false;
let extraControls=null;

function message(text,kind='secondary'){
 out.replaceChildren();
 const p=document.createElement('div');p.className=`alert alert-${kind}`;p.textContent=text;out.append(p);
}
async function json(url,init={}){
 const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...init});
 const data=await response.json();
 return {response,data};
}
function addButton(parent,label,action,style='btn btn-outline-secondary btn-sm'){
 const b=document.createElement('button');b.type='button';b.className=style;b.textContent=label;b.addEventListener('click',action);parent.append(b);return b;
}
function hideLoggedInControls(){
 extraControls?.remove();extraControls=null;authenticated=false;
}
function getUrl(){return document.getElementById('od-url').value.trim();}

form.addEventListener('submit',async event=>{
 event.preventDefault();
 if(!enabled||submit.disabled)return;
 submit.disabled=true;message('正在检查链接格式……');
 try{
  const {data}=await json('/api/v1/tools/onedrive/resolve',{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:getUrl()})
  });
  if(!data.success)return message(data.error?.message||'解析失败','warning');
  message(`格式有效：${data.data.link_kind}。${data.data.message}`,'success');
  const code=document.createElement('textarea');code.className='form-control mt-2';code.rows=3;code.readOnly=true;
  code.value=data.data.share_token;code.setAttribute('aria-label','Graph 分享令牌');out.append(code);
  addButton(out,'复制 Graph 分享令牌',()=>navigator.clipboard?.writeText(data.data.share_token),'btn btn-outline-secondary btn-sm mt-2');
 }catch{message('网络异常，请稍后重试','danger');}
 finally{submit.disabled=!enabled;}
});

async function loadLinks(list,wrap){
 try{
  const {response,data}=await json('/api/v1/tools/onedrive/links');
  if(response.status===401){hideLoggedInControls();message('登录状态已过期，请重新登录后管理固定链接。','warning');return;}
  if(!data.success){list.textContent=data.error?.message||'固定链接加载失败';return;}
  list.replaceChildren();
  for(const item of data.data.links||[]){
   const row=document.createElement('div');row.className='border-top py-2';
   const a=document.createElement('a');a.href=item.url;a.textContent=`${location.origin}${item.url}`;
   a.rel='noopener noreferrer';a.target='_blank';row.append(a,document.createTextNode(` (${item.status}; ${item.access_count} 次访问) `));
   if(item.status==='active'){
    addButton(row,item.delivery==='public_direct'?'关闭直链尝试':'尝试公开直链',async()=>{
     const {response,data}=await json('/api/v1/tools/onedrive/links/'+item.id,{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({delivery_mode:item.delivery==='public_direct'?'source_page_redirect':'public_direct'})
     });
     if(response.status===401){hideLoggedInControls();return;}
     if(!data.success)message(data.error?.message||'更新失败','warning');
     await loadLinks(list,wrap);
    },'btn btn-outline-secondary btn-sm ms-2');
    addButton(row,'撤销',async()=>{
     if(!confirm('撤销此固定入口？'))return;
     const {response,data}=await json('/api/v1/tools/onedrive/links/'+item.id,{method:'DELETE'});
     if(response.status===401){hideLoggedInControls();return;}
     if(!data.success)message(data.error?.message||'撤销失败','warning');
     await loadLinks(list,wrap);
    },'btn btn-outline-danger btn-sm ms-2');
   }
   list.append(row);
  }
 }catch{list.textContent='固定入口列表加载失败';}
}
function mountLoggedInControls(){
 if(extraControls)return;
 const root=document.createElement('section');root.id='onedrive-authenticated-controls';
 // No public-probe or fixed-link buttons are appended before the status API
 // confirms authenticated === true.
 const checkPublic=addButton(root,'验证公开文件直链（无需微软登录）',async()=>{
  const url=getUrl();if(!url)return message('请先填写分享链接','warning');
  checkPublic.disabled=true;
  try{
   const {response,data}=await json('/api/v1/tools/onedrive/public-check',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})
   });
   if(response.status===401){hideLoggedInControls();return;}
   if(!data.success)return message(data.error?.message||'检查失败','warning');
   const result=data.data;
   message(result.anonymous_direct_verified?'已取得无需微软登录的短期有效直链。':'未能确认公开下载能力：'+result.reason+'。仍可使用原分享页入口。',result.anonymous_direct_verified?'success':'warning');
   if(result.anonymous_direct_verified&&result.download_url){
    const a=document.createElement('a');a.href=result.download_url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='打开当前临时下载直链';out.append(a);
   }
  }catch{message('公开直链探测请求失败','danger');}
  finally{checkPublic.disabled=false;}
 },'btn btn-outline-secondary btn-sm mt-2');
 const panel=document.createElement('section');panel.className='card p-3 mt-4';
 const title=document.createElement('h2');title.className='h5';title.textContent='固定入口管理（登录用户）';panel.append(title);
 const info=document.createElement('p');info.className='small text-secondary';info.textContent='固定入口默认打开原分享页；也可为自己的链接启用公开直链尝试。';panel.append(info);
 const list=document.createElement('div');list.className='mt-3';
 addButton(panel,'为当前链接创建固定入口',async()=>{
  const url=getUrl();if(!url)return message('请先填写分享链接','warning');
  try{
   const {response,data}=await json('/api/v1/tools/onedrive/links',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})
   });
   if(response.status===401){hideLoggedInControls();return;}
   if(!data.success)return message(data.error?.message||'创建失败','warning');
   message(data.data.message||'固定入口已创建','success');await loadLinks(list,panel);
  }catch{message('网络异常','danger');}
 },'btn btn-outline-primary btn-sm');
 panel.append(list);root.append(panel);main.append(root);extraControls=root;
 void loadLinks(list,panel);
}

async function checkStatus(){
 try{
  const {response,data}=await json('/api/v1/tools/onedrive/status');
  if(!response.ok||!data.success){
   enabled=false;submit.disabled=true;hideLoggedInControls();
   message(data.error?.message||'OneDrive 工具当前不可用','warning');return;
  }
  const status=data.data||{};
  enabled=Boolean(status.enabled&&(status.authenticated||status.anonymous_enabled));
  authenticated=Boolean(status.authenticated);
  submit.disabled=!enabled;
  if(!enabled){hideLoggedInControls();message('当前不允许使用 OneDrive 解析工具。','warning');return;}
  if(authenticated)mountLoggedInControls();else hideLoggedInControls();
 }catch{
  enabled=false;submit.disabled=true;hideLoggedInControls();message('无法读取工具状态，请稍后刷新','warning');
 }
}
void checkStatus();
