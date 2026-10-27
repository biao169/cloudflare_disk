import {resolveUser,jsonBody} from '../services/auth.js';
import {dbFromEnv} from '../services/database.js';
import {evaluateFolderSync,createFolderSyncJob,folderSyncJob,acknowledgeFolderItem,finishFolderSync,cancelFolderSync} from '../services/folder-sync.js';
import {ok,error} from '../utils/response.js';
const ID=/^[0-9a-f-]{36}$/;
const respond=x=>x?.error?error(x.error,x.message,x.status):ok(x);
export async function folderSyncRoute(req,env,path){
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 const db=dbFromEnv(env);
 if(path==='/api/v1/folder-sync/plan'&&req.method==='POST'){
  const result=await evaluateFolderSync(db,user,await jsonBody(req));if(result.error)return respond(result);
  return ok({plan_hash:result.planHash,root_name:result.rootName,root_existing:!!result.rootId,mode:result.mode,counts:result.counts,
   changes:result.items.map(i=>({kind:i.kind,action:i.action,path:i.relative_path,existing_id:i.target_id,expected_revision:i.expected_revision}))});
 }
 if(path==='/api/v1/folder-sync/jobs'&&req.method==='POST')return respond(await createFolderSyncJob(db,user,await jsonBody(req)));
 const match=/^\/api\/v1\/folder-sync\/jobs\/([0-9a-f-]{36})(?:\/(finish|cancel|items\/([0-9a-f-]{36})\/ack))?$/.exec(path);
 if(!match)return error('NOT_FOUND','接口不存在',404);
 const job=await folderSyncJob(db,user,match[1]);if(!job)return error('NOT_FOUND','同步任务不存在或无权访问',404);
 const sub=match[2];
 if(!sub&&req.method==='GET'){const {_job,...result}=job;return ok(result);}
 if(sub==='cancel'&&req.method==='POST')return respond(await cancelFolderSync(db,user,job._job));
 if(sub==='finish'&&req.method==='POST')return respond(await finishFolderSync(env,user,job._job));
 if(match[3]&&req.method==='POST')return respond(await acknowledgeFolderItem(db,user,job._job,match[3],await jsonBody(req)));
 return error('METHOD_NOT_ALLOWED','请求方法不支持',405);
}
