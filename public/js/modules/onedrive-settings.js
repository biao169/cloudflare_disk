import {requestJSON} from '../api.js';
const el=(tag,text='',cls='')=>{const x=document.createElement(tag);x.textContent=text;x.className=cls;return x;};
const hint=(container,value)=>container.append(el('p',value,'small text-secondary mb-2'));
const button=(label,fn)=>{const b=el('button',label,'btn btn-outline-primary btn-sm me-2 mb-2');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){alert(e.message||'请求失败');}finally{b.disabled=false;}};return b;};
export async function addOneDriveSettings(host){const card=el('section','','card border-0 shadow-sm mb-3'),body=el('div','','card-body');card.append(body);host.append(card);body.append(el('h2','Microsoft OneDrive 账户与文件直链','h5'));
 hint(body,'仅超级管理员可以连接、浏览和发布授权账户中的文件。发布后任何持有固定链接的人都可以下载对应文件，请仅选择允许公开分发的内容。');
 const steps=el('details','','mb-3');steps.open=true;steps.append(el('summary','接入配置教程（请逐项完成）','fw-semibold mb-2'));body.append(steps);
 const help=[
 ['1. 注册 Microsoft 应用','打开 https://entra.microsoft.com/ → Microsoft Entra ID → 应用注册 → 新注册。需要个人 OneDrive 时，支持的账户类型必须包含“个人 Microsoft 账户”。'],
 ['2. 配置 Web 回调','在应用“身份验证”中添加 Web 重定向 URI：https://你的CloudDrive域名/api/v1/admin/onedrive/oauth/callback。域名必须与实际访问站点相同，使用 HTTPS。'],
 ['3. 配置 Microsoft Graph 权限','在 API 权限中添加委托权限 User.Read、Files.ReadWrite、offline_access。Files.ReadWrite 的权限较宽，建议使用专门用于公开分享的 OneDrive 账户，不要将管理员授权令牌交给访客。'],
 ['4. 获取 MS_CLIENT_ID','在应用注册 → 概述 → “应用程序(客户端) ID”复制 GUID，填写到当前 CloudDrive Worker 的 MS_CLIENT_ID。不要用“目录(租户) ID”替代。'],
 ['5. 获取 MS_CLIENT_SECRET','在应用注册 → 证书和密码 → 客户端密码 → 新建，复制新密码的“值（Value）”，不是“机密 ID（Secret ID）”。此密码属于 Microsoft 创建的凭据，会按设置的有效期到期。'],
 ['6. 自行生成 MS_TOKEN_KEY','这个密钥并非微软提供。使用 32 字节加密安全随机值，推荐填写 64 个十六进制字符；也支持 32 字节的 Base64。不要填写 Microsoft 客户端密码、Secret ID、SHARE_LINK_KEY 或字符串占位符。密钥用于 AES-256-GCM 加密 D1 中的 OAuth Token，换密钥会导致旧令牌无法解密，需重新授权。'],
 ['7. 在正确的 Cloudflare Worker 中配置','Cloudflare Dashboard → Workers & Pages → 当前实际部署的 Worker → Settings → Variables and Secrets。依次添加 MS_CLIENT_ID、MS_CLIENT_SECRET、MS_TOKEN_KEY；敏感值选择 Secret。MS_TENANT 可选填 common。检查生产环境与预览环境是否一致；不要把密钥只填在 Build 环境或其他 Worker。保存后重新部署，使运行时绑定生效。'],
 ['8. 检查与授权','点击下方“重新检查配置”，查看每项是“有效”“缺失”还是“格式错误”；全部有效后点击“连接 Microsoft 账户”。如提示 MICROSOFT_TOKEN_KEY_MISSING 表示实际 Worker 没有读取到变量；INVALID 表示已读取到但格式不符合要求。'],
 ['9. 发布固定直链','部署并应用已有迁移 0025 和 0027；管理员完成微软授权后浏览“我的文件”，选择文件并明确确认公开，再获取 /r/odf_* 固定直链。文件若被删除、管理员授权失效或微软限流，固定入口也可能无法下载。']
 ];
 for(const [t,d] of help){steps.append(el('div',t,'fw-semibold small mt-2'));hint(steps,d);}
 const command=el('pre',`# Windows PowerShell：生成 32 字节 / 64 位十六进制随机密钥
$b = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($b); [BitConverter]::ToString($b).Replace('-', '').ToLowerInvariant() }
finally { $rng.Dispose() }`,'small bg-body-tertiary p-2 rounded text-break');steps.append(command);
 hint(steps,'命令只在本地生成密钥，不会将密钥发送到网站。生成后安全保管；已经授权并保存令牌的生产站点不要重新生成并覆盖旧密钥。');
 const status=el('div','正在读取连接状态…','small mb-2');body.append(status);
 const configPanel=el('div','','mb-3');body.append(configPanel);
 const controls=el('div','','mb-3');body.append(controls);
 const filePanel=el('div','','border rounded p-3 mb-3');body.append(filePanel);filePanel.hidden=true;
 const shares=el('div','','border rounded p-3');body.append(shares);shares.hidden=true;
 async function refresh(){
  const r=await requestJSON('/api/v1/admin/onedrive/oauth');
  const configuration=r.configuration;
  status.textContent=r.connected?'已连接 Microsoft 账户（更新时间：'+(r.updated_at||'未知')+'）':r.configured?'授权尚未完成，可以连接 Microsoft 账户':'当前运行环境的 Microsoft 配置不完整';
  configPanel.replaceChildren();
  if(configuration){
   configPanel.append(el('div',configuration.ready?'Worker 运行时配置：全部通过':'Worker 运行时配置：需要处理','fw-semibold small mb-2'));
   const names={MS_CLIENT_ID:'Microsoft 应用程序（客户端）ID',MS_CLIENT_SECRET:'Microsoft 客户端密码 Value',MS_TOKEN_KEY:'CloudDrive Token 加密密钥'};
   for(const [name,description] of Object.entries(names)){
    const field=configuration.fields?.[name]||{status:'missing'};
    const label={ready:'有效',missing:'未读取到',invalid:'格式错误',conflict:'配置冲突'}[field.status]||'待检查';
    const line=el('div',`${name} — ${label} · ${description}`,'small mb-1 '+(field.status==='ready'?'text-success':'text-danger'));configPanel.append(line);
    if(name==='MS_TOKEN_KEY'&&field.source==='MICROSOFT_TOKEN_KEY')hint(configPanel,'检测到兼容名称 MICROSOFT_TOKEN_KEY。建议使用 MS_TOKEN_KEY 且保持原密钥值不变。');
   }
   for(const issue of configuration.issues||[])configPanel.append(el('p',issue.message,'small text-danger mb-1'));
   for(const warning of configuration.warnings||[])configPanel.append(el('p',warning,'small text-warning mb-1'));
   hint(configPanel,'上述检查只返回是否配置及格式检查结果，不会返回任何 Secret 值。若你刚保存了 Cloudflare 变量，请确认当前访问的是同一个 Worker，并重新部署。');
  }else hint(configPanel,'当前服务暂不提供逐项诊断，请更新 Worker 至包含本修复的版本。');
  controls.replaceChildren();
  controls.append(button('重新检查配置',refresh));
  const connect=button('连接 Microsoft 账户',async()=>{const x=await requestJSON('/api/v1/admin/onedrive/oauth/start');location.assign(x.authorization_url);});
  connect.disabled=!r.configured;controls.append(connect);
  if(r.connected){
   if(r.configured){controls.append(button('浏览已授权文件',()=>browse('root')));controls.append(button('查看已发布直链',loadPublications));}
   controls.append(button('断开账户',async()=>{if(!confirm('断开 Microsoft 账户？已发布直链将无法下载，直到重新授权。'))return;await requestJSON('/api/v1/admin/onedrive/oauth',{method:'DELETE'});filePanel.hidden=true;shares.hidden=true;await refresh();}));
  }
 }
 const path=[];
 async function browse(parent){const result=await requestJSON('/api/v1/admin/onedrive/drive/items?parent='+encodeURIComponent(parent));filePanel.hidden=false;filePanel.replaceChildren(el('h3','已授权账户的文件','h6'));hint(filePanel,'仅显示本次连接账户的我的文件；不会遍历其他用户的私人共享。选择文件发布后，CloudDrive 固定链接将以管理员授权动态获取下载地址。');
 if(path.length)filePanel.append(button('返回根目录',async()=>{path.length=0;await browse('root');}));
 for(const item of result.items){const row=el('div','','d-flex align-items-center justify-content-between border-bottom py-2 gap-2');row.append(el('span',(item.folder?'📁 ':'📄 ')+item.name,'small text-break'));
 row.append(button(item.folder?'打开':'发布直链',async()=>{if(item.folder){path.push(item.id);await browse(item.id);return;}
 if(!confirm(`确定公开分享文件“${item.name}”？\n任何持有链接的人都能下载文件，即使其原本在 OneDrive 中为私人文件。`))return;
 const out=await requestJSON('/api/v1/admin/onedrive/drive/publish',{method:'POST',body:{item_id:item.id,confirm_public:true}});alert('已创建固定直链：'+new URL(out.url,location.origin).href);await loadPublications();}));filePanel.append(row);}
 if(result.truncated)hint(filePanel,result.message||'仅显示前100项');if(!result.items.length)hint(filePanel,'文件夹为空');}
 async function loadPublications(){const data=await requestJSON('/api/v1/admin/onedrive/drive/publications');shares.hidden=false;shares.replaceChildren(el('h3','已发布文件直链','h6'));hint(shares,'固定 URL 不随微软临时下载地址过期而改变；若文件被删除、授权失效或微软限流，将暂时无法下载。');for(const item of data.items){const row=el('div','','border-bottom py-2'),text=el('div',`${item.file_name} · ${item.status} · 访问 ${item.access_count} 次`,'small');row.append(text);if(item.status==='active'){const a=el('a',new URL(item.url,location.origin).href,'small d-block text-break');a.href=item.url;a.target='_blank';a.rel='noopener noreferrer';row.append(a);row.append(button('复制链接',()=>navigator.clipboard.writeText(a.textContent)));row.append(button('撤销',async()=>{if(!confirm('撤销此公开链接？'))return;await requestJSON('/api/v1/admin/onedrive/drive/publications/'+item.id,{method:'DELETE'});await loadPublications();}));}shares.append(row);}if(!data.items.length)hint(shares,'尚未发布文件。');}
 try{await refresh();}catch(e){status.textContent='无法查询 Microsoft 授权状态：'+e.message;}
}
