import {resolveUser} from '../services/auth.js';
import {initiate,status,list,part,complete,cancel} from '../services/multipart.js';
import {error} from '../utils/response.js';
export async function uploadRoute(req,env,path){
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 if(path==='/api/v1/uploads'){
  if(req.method==='POST')return initiate(req,env,user);
  if(req.method==='GET')return list(env,user);
 }
 const m=/^\/api\/v1\/uploads\/([0-9a-f-]{36})(?:\/(parts\/([1-9]\d{0,4})|complete))?$/.exec(path);
 if(!m)return error('NOT_FOUND','接口不存在',404);
 if(m[2]?.startsWith('parts/')&&req.method==='PUT')return part(req,env,user,m[1],m[3]);
 if(m[2]==='complete'&&req.method==='POST')return complete(env,user,m[1]);
 if(!m[2]&&req.method==='GET')return status(env,user,m[1]);
 if(!m[2]&&req.method==='DELETE')return cancel(env,user,m[1]);
 return error('METHOD_NOT_ALLOWED','请求方法不支持',405);
}
