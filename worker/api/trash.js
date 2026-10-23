import {resolveUser,jsonBody} from '../services/auth.js';
import {dbFromEnv} from '../services/database.js';
import {ok,error} from '../utils/response.js';
import {trashItem,listTrash,restoreItem,purgeItem,safeId} from '../services/trash.js';
export async function trashRoute(req,env,path){const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);dbFromEnv(env);
 if(path==='/api/v1/trash'&&req.method==='GET')return listTrash(env,user,new URL(req.url).searchParams.get('space_id'));
 if(path==='/api/v1/trash'&&req.method==='POST'){const b=await jsonBody(req);return trashItem(env,user,b?.target_type,b?.target_id);}
 const m=/^\/api\/v1\/trash\/([0-9a-f-]{36})(?:\/(restore|purge))?$/.exec(path);if(!m)return error('NOT_FOUND','接口不存在',404);
 if(m[2]==='restore'&&req.method==='POST'){const b=await jsonBody(req);return restoreItem(env,user,m[1],b?.target_folder_id);}
 if((m[2]==='purge'||!m[2])&&req.method==='DELETE')return purgeItem(env,user,m[1]);
 return error('METHOD_NOT_ALLOWED','请求方式错误',405);
}
