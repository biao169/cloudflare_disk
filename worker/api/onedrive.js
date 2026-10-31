import {resolveAnonymousDownload} from '../services/onedrive-public.js';
import {oneDriveLinkApi} from '../services/onedrive-links.js';
import {dbFromEnv} from '../services/database.js';
import {enforceOneDriveQuota} from '../services/onedrive-quota.js';
import {settings} from '../services/admin.js';
import {resolveUser} from '../services/auth.js';
import {parseOneDriveUrl} from '../services/onedrive.js';
import {ok,error} from '../utils/response.js';
export async function onedriveRoute(req,env,path){
 if(path==='/api/v1/tools/onedrive/links'||path.startsWith('/api/v1/tools/onedrive/links/'))return oneDriveLinkApi(req,env,path);
 if(path!=='/api/v1/tools/onedrive/status'&&path!=='/api/v1/tools/onedrive/resolve'&&path!=='/api/v1/tools/onedrive/public-check')return error('NOT_FOUND','接口不存在',404);
 if((path.endsWith('/status')&&req.method!=='GET')||((path.endsWith('/resolve')||path.endsWith('/public-check'))&&req.method!=='POST'))return error('METHOD_NOT_ALLOWED','请求方法不支持',405);
 const db=dbFromEnv(env);
 const s=await settings(db);
 if(!s.onedrive_tool_enabled)return error('TOOL_DISABLED','管理员已关闭 OneDrive 直链工具',403);
 const user=await resolveUser(req,env);
 if(!s.onedrive_anonymous_enabled&&!user)return error('LOGIN_REQUIRED','管理员已关闭匿名使用，请先登录',401);
 if(path.endsWith('/status'))return ok({enabled:true,anonymous_enabled:s.onedrive_anonymous_enabled,authenticated:!!user,capability:user?'format_and_best_effort_anonymous_probe':'format_only',requires_graph_authorization_for_download:true,limits:user?{minute:s.onedrive_user_minute_limit,hour:s.onedrive_user_hour_limit,day:s.onedrive_user_day_limit}:{minute:s.onedrive_guest_minute_limit,hour:s.onedrive_guest_hour_limit,day:s.onedrive_guest_day_limit}});
 // RC14.12 UI policy: anonymous users may parse format only. Public-download probing
 // is reserved for authenticated sessions, even if someone calls the API directly.
 if(path.endsWith('/public-check')&&!user)return error('LOGIN_REQUIRED','公开直链探测需要先登录 CloudDrive',401);
 const type=req.headers.get('Content-Type')||'';
 if(!/^application\/json(?:\s*;|$)/i.test(type))return error('INVALID_CONTENT_TYPE','请提交 JSON 数据',415);
 const length=Number(req.headers.get('Content-Length')||0);
 if(length>8192)return error('PAYLOAD_TOO_LARGE','请求内容过大',413);
 let body;try{const raw=await req.text();if(raw.length>8192)return error('PAYLOAD_TOO_LARGE','请求内容过大',413);body=JSON.parse(raw);}catch{return error('INVALID_JSON','JSON 数据格式错误',400);}
 if(!body||Array.isArray(body)||typeof body.url!=='string')return error('INVALID_INPUT','请提供分享链接 url',400);
 const quota=await enforceOneDriveQuota(db,req,user,s,env);
 if(!quota.allowed)return error('RATE_LIMITED','解析次数超过限制，请稍后再试',429);
 try{
  const data=parseOneDriveUrl(body.url);
  if(path.endsWith('/public-check')){const checked=await resolveAnonymousDownload(data.url);return ok({format_valid:true,anonymous_direct_verified:checked.verified,reason:checked.verified?null:checked.reason,download_url:checked.verified?checked.location:null,source_url:data.url,confirmation_method:'independent_unauthenticated_redirect',warning:'公开下载探测为尽力而为；微软可能随时改变公开接口或撤销分享。'});}
  return ok({...data,download_url:null,status:'authorization_required_for_download',message:'已识别分享链接格式；文件元数据和真实下载直链需要经授权的 Microsoft Graph 解析，当前 RC14.1 不会生成未经验证的下载链接。'});
 }catch(e){return error(e.message==='UNSUPPORTED_LINK'?'UNSUPPORTED_LINK':'INVALID_URL','仅支持已识别的 HTTPS OneDrive 分享链接',400);}
}
