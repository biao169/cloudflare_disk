import {resolveUser} from '../services/auth.js';
import {uploadFile,downloadFile} from '../services/storage.js';
import {error} from '../utils/response.js';
export async function storageRoute(req,env,path){
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 if(path==='/api/v1/storage/upload'&&req.method==='POST')return uploadFile(req,env,user);
 const match=/^\/api\/v1\/files\/([0-9a-f-]{36})\/(content|preview)$/.exec(path);
 if(match&&['GET','HEAD'].includes(req.method))return downloadFile(req,env,user,match[1],{preview:match[2]==='preview'});
 return error('NOT_FOUND','接口不存在',404);
}
