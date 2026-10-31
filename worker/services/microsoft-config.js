// Microsoft OAuth runtime configuration. Never return any secret value through a status API.
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_32=/^[0-9a-f]{64}$/i;
const BASE64_32=/^[A-Za-z0-9+/_-]{43}=?$/;

function value(env,name){return typeof env?.[name]==='string'?env[name].trim():'';}

export function decodeMicrosoftTokenKey(secret){
 const v=typeof secret==='string'?secret.trim():'';
 if(HEX_32.test(v))return Uint8Array.from(v.match(/.{2}/g),x=>parseInt(x,16));
 if(!BASE64_32.test(v))return null;
 try{
  const plain=v.replace(/-/g,'+').replace(/_/g,'/').replace(/=+$/,'');
  const binary=atob(plain.padEnd(44,'='));
  if(binary.length!==32||btoa(binary).replace(/=+$/,'')!==plain)return null;
  return Uint8Array.from(binary,x=>x.charCodeAt(0));
 }catch{return null;}
}

export function microsoftConfigStatus(env){
 const clientId=value(env,'MS_CLIENT_ID'),clientSecret=value(env,'MS_CLIENT_SECRET');
 const primary=value(env,'MS_TOKEN_KEY'),alias=value(env,'MICROSOFT_TOKEN_KEY');
 const fields={MS_CLIENT_ID:{status:clientId?(GUID.test(clientId)?'ready':'invalid'):'missing'},
  MS_CLIENT_SECRET:{status:clientSecret?'ready':'missing'},
  MS_TOKEN_KEY:{status:'missing',source:null}};
 const issues=[];
 function issue(field,code,message){issues.push({field,code,message});}
 if(fields.MS_CLIENT_ID.status!=='ready')issue('MS_CLIENT_ID',fields.MS_CLIENT_ID.status==='missing'?'MICROSOFT_CLIENT_ID_MISSING':'MICROSOFT_CLIENT_ID_INVALID',
  fields.MS_CLIENT_ID.status==='missing'?'当前 Worker 未读取到 MS_CLIENT_ID。':'MS_CLIENT_ID 不是有效的应用程序（客户端）ID（GUID）。');
 if(fields.MS_CLIENT_SECRET.status!=='ready')issue('MS_CLIENT_SECRET','MICROSOFT_CLIENT_SECRET_MISSING','当前 Worker 未读取到 MS_CLIENT_SECRET；应填写客户端密码的 Value，而非 Secret ID。');
 const primaryBytes=primary?decodeMicrosoftTokenKey(primary):null;
 const aliasBytes=alias?decodeMicrosoftTokenKey(alias):null;
 const differentKeys=primary&&alias&&primaryBytes&&aliasBytes&&!primaryBytes.every((v,i)=>v===aliasBytes[i]);
 if(differentKeys){
  fields.MS_TOKEN_KEY.status='conflict';
  issue('MS_TOKEN_KEY','MICROSOFT_TOKEN_KEY_CONFLICT','MS_TOKEN_KEY 与兼容别名 MICROSOFT_TOKEN_KEY 同时存在且值不同；请只保留正确的 MS_TOKEN_KEY。');
 }else{
  const secret=primary||alias;
  fields.MS_TOKEN_KEY.source=primary?'MS_TOKEN_KEY':alias?'MICROSOFT_TOKEN_KEY':null;
  if(!secret){issue('MS_TOKEN_KEY','MICROSOFT_TOKEN_KEY_MISSING','当前部署的 Worker 未读取到 MS_TOKEN_KEY。请确认 Secret 添加到了正在访问的 Worker 和正确的生产/预览环境。');}
  else if(!decodeMicrosoftTokenKey(secret)||(alias&&!aliasBytes)||(primary&&!primaryBytes)){
   fields.MS_TOKEN_KEY.status='invalid';
   issue('MS_TOKEN_KEY','MICROSOFT_TOKEN_KEY_INVALID','MS_TOKEN_KEY 格式无效：必须是 64 位十六进制字符（推荐）或编码后恰好 32 字节的 Base64；不要填写 Microsoft Secret ID、变量名或示例占位符。');
  }else fields.MS_TOKEN_KEY.status='ready';
 }
 const warnings=[];
 if(fields.MS_TOKEN_KEY.source==='MICROSOFT_TOKEN_KEY'&&fields.MS_TOKEN_KEY.status==='ready')
  warnings.push('当前使用兼容别名 MICROSOFT_TOKEN_KEY。建议统一为 MS_TOKEN_KEY，迁移时必须保持密钥值完全相同，否则原有授权无法解密。');
 return {ready:issues.length===0,fields,issues,warnings};
}

export function requireMicrosoftConfig(env){
 const status=microsoftConfigStatus(env);
 if(!status.ready)throw new Error(status.issues[0].code);
 return {clientId:value(env,'MS_CLIENT_ID'),clientSecret:value(env,'MS_CLIENT_SECRET'),
  tokenKey:decodeMicrosoftTokenKey(value(env,'MS_TOKEN_KEY')||value(env,'MICROSOFT_TOKEN_KEY'))};
}

export function microsoftConfigErrorMessage(code){
 const map={
  MICROSOFT_CLIENT_ID_MISSING:'当前 Worker 缺少 MS_CLIENT_ID。请到该 Worker 的 Variables and Secrets 中添加 Microsoft 应用程序（客户端）ID。',
  MICROSOFT_CLIENT_ID_INVALID:'MS_CLIENT_ID 格式错误：请填写 Microsoft Entra 应用概述中的应用程序（客户端）ID（GUID）。',
  MICROSOFT_CLIENT_SECRET_MISSING:'当前 Worker 缺少 MS_CLIENT_SECRET。请填 Microsoft Entra → 证书和密码 → 客户端密码的 Value。',
  MICROSOFT_TOKEN_KEY_MISSING:'当前 Worker 没有读取到 MS_TOKEN_KEY。请检查 Secret 名称、绑定的 Worker、生产/预览环境，并在更新后重新部署。',
  MICROSOFT_TOKEN_KEY_INVALID:'MS_TOKEN_KEY 已读取到，但格式错误。请使用 32 字节随机密钥（推荐 64 个十六进制字符；也支持 32 字节 Base64），不要包含变量名、引号或占位符。',
  MICROSOFT_TOKEN_KEY_CONFLICT:'同时设置了值不同的 MS_TOKEN_KEY 和 MICROSOFT_TOKEN_KEY。请仅保留正确的 MS_TOKEN_KEY，并保持原密钥值不变。'
 };
 return map[code]||null;
}
