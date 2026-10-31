import {requestJSON} from '../api.js';
const el=(tag,text='',cls='')=>{const x=document.createElement(tag);x.textContent=text;x.className=cls;return x;};
const hint=(container,value)=>container.append(el('p',value,'small text-secondary mb-2'));
const button=(label,fn)=>{const b=el('button',label,'btn btn-outline-primary btn-sm me-2 mb-2');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){alert(e.message||'请求失败');}finally{b.disabled=false;}};return b;};
export async function addOneDriveSettings(host){const card=el('section','','card border-0 shadow-sm mb-3'),body=el('div','','card-body');card.append(body);host.append(card);body.append(el('h2','Microsoft OneDrive 账户与文件直链','h5'));
 hint(body,'仅超级管理员可以连接、浏览和发布授权账户中的文件。发布后任何持有固定链接的人都可以下载对应文件，请仅选择允许公开分发的内容。');
 const steps=el('details','','mb-3');steps.open=true;steps.append(el('summary','接入配置教程（请逐项完成）','fw-semibold mb-2'));body.append(steps);
 const help=[
 ['1. 注册 Microsoft 应用','打开 https://entra.microsoft.com/ → Microsoft Entra ID → 应用注册 → 新注册；支持的账户类型选择“任何组织目录中的账户和个人 Microsoft 账户”（按实际需求选择）。'],
 ['2. 配置 Web 回调','在“身份验证”添加 Web 重定向 URI：https://你的CloudDrive域名/api/v1/admin/onedrive/oauth/callback。协议必须是 HTTPS，域名和实际访问域名完全一致。'],
 ['3. Microsoft Graph 权限','在 API 权限中配置委托权限 User.Read、Files.ReadWrite、offline_access。Files.ReadWrite 权限范围较宽，建议专用 OneDrive 账户；不得把管理员访问令牌提供给游客。'],
 ['4. 创建客户端凭据','在“证书和密码”创建客户端密码，复制其 Value（不是 Secret ID）。注意过期时间，过期后需要在 Cloudflare 更新 Secret。'],
 ['5. 配置 Cloudflare Secrets','通过 Cloudflare Workers 的设置或 wrangler secret put 配置 MS_CLIENT_ID、MS_CLIENT_SECRET、MS_TOKEN_KEY（64位十六进制随机值）；可设置 MS_TENANT=common。Secrets 不应填写在网页表单或 Git 仓库。'],
 ['6. 部署并授权','部署代码和 D1 0027 迁移，返回此处点击“连接 Microsoft 账户”，登录并同意授权；首次授权后再浏览和发布文件。'],
 ['7. 选择并分享文件','浏览授权账户“我的文件”，进入文件夹，单独选定一个文件并明确确认公开，系统生成 /r/odf_* 固定直链；失效或不再公开时可立即撤销。']
 ];
 for(const [t,d] of help){steps.append(el('div',t,'fw-semibold small mt-2'));hint(steps,d);}
 const status=el('div','正在读取连接状态…','small mb-3');body.append(status);
 const controls=el('div','','mb-3');body.append(controls);
 const filePanel=el('div','','border rounded p-3 mb-3');body.append(filePanel);filePanel.hidden=true;
 const shares=el('div','','border rounded p-3');body.append(shares);shares.hidden=true;
 async function refresh(){const r=await requestJSON('/api/v1/admin/onedrive/oauth');status.textContent=r.connected?'已连接 Microsoft 账户（更新时间：'+(r.updated_at||'未知')+'）':r.configured?'尚未连接 Microsoft 账户':'未配置 MS_CLIENT_ID / MS_TOKEN_KEY';controls.replaceChildren();controls.append(button('连接 Microsoft 账户',async()=>{const x=await requestJSON('/api/v1/admin/onedrive/oauth/start');location.assign(x.authorization_url);}));if(r.connected){controls.append(button('浏览已授权文件',()=>browse('root')));controls.append(button('查看已发布直链',loadPublications));controls.append(button('断开账户',async()=>{if(!confirm('断开 Microsoft 账户？已发布直链将无法下载，直到重新授权。'))return;await requestJSON('/api/v1/admin/onedrive/oauth',{method:'DELETE'});filePanel.hidden=true;shares.hidden=true;await refresh();}));}}
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
