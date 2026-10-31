// OAuth completion is a top-level navigation; show actionable, sanitized feedback.
// Server never forwards the authorization code, state, token or raw Microsoft description.
const hints={
 MICROSOFT_CONSENT_DENIED:'本次授权被取消或拒绝。请重新连接并同意授权；组织账户可能需要管理员同意。',
 MICROSOFT_REDIRECT_URI_MISMATCH:'回调地址与 Microsoft Entra 中的 Web 重定向 URI 不一致，请按下面的完整地址逐字核对。',
 MICROSOFT_APP_NOT_FOUND:'请检查 MS_CLIENT_ID、MS_TENANT 及微软应用注册是否存在。',
 MICROSOFT_INVALID_CLIENT_SECRET:'请检查 MS_CLIENT_SECRET 是客户端密码的 Value，而非 Secret ID；确认密码没有过期。',
 MICROSOFT_ACCOUNT_TYPE_MISMATCH:'当前 Microsoft 账号不在应用允许的账户类型内。个人 OneDrive 要勾选支持个人 Microsoft 账户。',
 MICROSOFT_ADMIN_CONSENT_REQUIRED:'微软需要管理员同意或组织策略阻止了授权。请在 Entra 的 API 权限页面检查授权策略。',
 MICROSOFT_INVALID_SCOPE:'微软拒绝请求的 Graph 权限。请核对 Files.ReadWrite、User.Read 的委托权限。',
 MICROSOFT_SIGNIN_FAILED:'Microsoft 没有返回授权码。请核对账户类型、API 授权策略、回调地址，并参考 AADSTS 错误码。',
 MICROSOFT_TOKEN_EXCHANGE_FAILED:'微软拒绝换取令牌。请检查客户端密码 Value、回调地址以及服务器时钟和 PKCE 流程。',
 MICROSOFT_TOKEN_TIMEOUT:'微软登录服务暂时超时，请稍后重试。',
 MICROSOFT_TOKEN_BAD_RESPONSE:'微软登录服务返回异常结果，请稍后重试。',
 OAUTH_STATE_INVALID:'授权流程可能超过十分钟、已被使用或不属于当前管理员。请重新发起连接。',
 OAUTH_STATE_MISSING:'回调缺少 state。不要直接打开回调地址，请从 CloudDrive 点击“连接 Microsoft 账户”。',
 OAUTH_CODE_MISSING:'回调缺少授权码。请检查微软授权页面是否出现拒绝提示。',
 OAUTH_SESSION_LOST:'授权返回时 CloudDrive 登录状态丢失。请使用同一个浏览器及网站域名完成授权。',
 OFFLINE_ACCESS_NOT_GRANTED:'未收到离线刷新令牌，请确认 offline_access 授权并重新连接。',
 MS_REDIRECT_URI_INVALID:'MS_REDIRECT_URI 必须填写完整的 HTTPS 回调 URL，不能有 query 或 fragment。',
 MS_REDIRECT_ORIGIN_MISMATCH:'当前网页域名与 MS_REDIRECT_URI 不一致，请从设定的域名进入 CloudDrive 后重试。',
 MICROSOFT_TOKEN_KEY_MISSING:'当前 Worker 未读取到 MS_TOKEN_KEY，请检查生产/预览环境的 Secret。',
 MICROSOFT_TOKEN_KEY_INVALID:'MS_TOKEN_KEY 格式错误，推荐使用 64 位随机十六进制字符。',
 OAUTH_CALLBACK_ERROR:'OAuth 回调处理失败，请检查应用配置和服务器日志中的脱敏错误类别。'
};
export function microsoftOauthFeedback(search=location.search){
 const p=new URLSearchParams(search),code=p.get('oauth_error');
 if(!code||!/^[A-Z_]{4,75}$/.test(code))return null;
 const aadsts=/^AADSTS\d{4,8}$/.test(p.get('aadsts')||'')?p.get('aadsts'):null;
 const microsoftError=/^[a-z_]{1,50}$/.test(p.get('ms_error')||'')?p.get('ms_error'):null;
 return {code,aadsts,microsoftError,message:hints[code]||hints.OAUTH_CALLBACK_ERROR};
}
export function addMicrosoftOauthNotice(parent,{search=location.search}={}){
 const result=microsoftOauthFeedback(search);
 if(!result)return false;
 const box=document.createElement('div');box.className='alert alert-warning small mb-3';box.setAttribute('role','alert');
 const headline=document.createElement('strong');headline.textContent='Microsoft 授权未完成：'+result.code;
 const description=document.createElement('p');description.className='mb-1 mt-1';description.textContent=result.message;
 box.append(headline,description);
 if(result.aadsts){const p=document.createElement('p');p.className='mb-1';p.textContent='微软错误代码：'+result.aadsts+'（可在 Microsoft Entra 登录日志中进一步排查）';box.append(p);}
 if(result.microsoftError){const p=document.createElement('p');p.className='mb-1';p.textContent='Microsoft 错误类别：'+result.microsoftError;box.append(p);}
 const advice=document.createElement('p');advice.className='mb-0';advice.textContent='请勿复制完整回调 URL；其中可能包含敏感的 code 或 state。';box.append(advice);
 parent.prepend(box);
 return true;
}
