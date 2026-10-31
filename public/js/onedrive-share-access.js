// RC14.11: password gate on public OneDrive share pages. Never save passwords in JS storage.
export async function requestShareMetadata(url,shareId,mount){
 const show=(title,description)=>{mount.replaceChildren();const panel=document.createElement('section');panel.className='ods-access-card';const h=document.createElement('h2');h.textContent=title;const p=document.createElement('p');p.textContent=description;panel.append(h,p);mount.append(panel);return panel;};
 for(let attempts=0;attempts<4;attempts++){
  let response,body;try{response=await fetch(url,{credentials:'same-origin',cache:'no-store'});body=await response.json();}catch{show('网络连接失败','无法读取分享信息，请刷新页面。');return null;}
  if(response.ok&&body.success){mount.replaceChildren();return body.data;}
  const code=body?.error?.code;
  if(code==='PASSWORD_REQUIRED'){
   const panel=show('此分享受密码保护','请输入分享者提供的访问密码。密码仅用于本次解锁，不会保存在浏览器本地存储中。');
   const form=document.createElement('form');form.className='ods-access-form';const input=document.createElement('input');input.type='password';input.required=true;input.minLength=6;input.maxLength=128;input.autocomplete='off';input.placeholder='分享访问密码';input.setAttribute('aria-label','分享访问密码');
   const button=document.createElement('button');button.type='submit';button.textContent='验证密码';
   const msg=document.createElement('p');msg.setAttribute('role','status');form.append(input,button,msg);panel.append(form);
   const submitted=await new Promise(resolve=>{form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;msg.textContent='正在验证…';try{
    const r=await fetch('/api/v1/public/onedrive/unlock',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:shareId,password:input.value})});const j=await r.json();input.value='';if(r.ok&&j.success){resolve(true);return;}msg.textContent=j?.error?.message||'验证失败';if(r.status===429){button.disabled=true;resolve(false);return;}
   }catch{msg.textContent='网络连接失败，请重新尝试。';}finally{if(!button.disabled||!msg.textContent.includes('15分钟'))button.disabled=false;}});});
   if(!submitted)return null;continue;
  }
  if(code==='LOGIN_REQUIRED'){
   const panel=show('需要登录 CloudDrive','管理员将此分享限制为网站登录用户访问。');const a=document.createElement('a');a.href='/login?next='+encodeURIComponent(location.pathname);a.className='ods-button ods-primary';a.textContent='前往登录';panel.append(a);return null;
  }
  const errors={SHARE_PAUSED:'分享已暂停',SHARE_EXPIRED:'分享已过期',VIEW_LIMIT_REACHED:'此分享的页面浏览次数已达上限',DOWNLOAD_LIMIT_REACHED:'下载次数已达上限',GONE:'分享已撤销',NOT_FOUND:'分享不存在'};
  show(errors[code]||'分享暂时无法访问',body?.error?.message||'请联系分享者或稍后重试。');return null;
 }
 show('解锁失败','请刷新页面后重新尝试。');return null;
}
