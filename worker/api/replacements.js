import {preparePublicVersions,abandonPreparedPublic,synchronizePublicationOnCommit,PublicationUpdateError} from '../services/public-versions.js';
import {resolveUser,jsonBody} from '../services/auth.js';
import {dbFromEnv,one} from '../services/database.js';
import {storageBinding,servePrivateObject} from '../services/storage.js';
import {targetForReplace,targetForView,versionsForFile,restoreVersion} from '../services/replacements.js';
import {error,ok} from '../utils/response.js';

export const versionRoutePattern=/^\/api\/v1\/files\/([0-9a-f-]{36})\/(versions(?:\/([1-9]\d{0,9})\/(restore|content|preview))?|replacement-target)$/;

export async function replacementRoute(req,env,path){
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 const m=versionRoutePattern.exec(path);if(!m)return error('NOT_FOUND','接口不存在',404);
 const [,id,action,revString,versionAction]=m;
 const readRequest=req.method==='GET'||req.method==='HEAD';
 if(!revString&&(!readRequest||req.method!=='GET'))return error('METHOD_NOT_ALLOWED','请求方式不支持',405);
 if(revString&&versionAction==='restore'&&req.method!=='POST')return error('METHOD_NOT_ALLOWED','请求方式不支持',405);
 if(revString&&versionAction!=='restore'&&!readRequest)return error('METHOD_NOT_ALLOWED','请求方式不支持',405);
 const db=dbFromEnv(env),needWrite=action==='replacement-target'||versionAction==='restore';
 const access=needWrite?await targetForReplace(db,user,id):await targetForView(db,user,id);
 if(access.error)return error(access.error,'文件不存在或没有相应权限',access.status);
 if(action==='replacement-target')return ok({id:access.file.id,name:access.file.name,revision:access.file.revision,size_bytes:access.file.size_bytes,space_id:access.file.space_id,folder_id:access.file.folder_id});
 if(!revString){const versions=await versionsForFile(db,id);return ok({current_revision:access.file.revision,current_size_bytes:access.file.size_bytes,current_mime_type:access.file.mime_type,versions});}
 const rev=Number(revString);if(!Number.isSafeInteger(rev)||rev<1)return error('INVALID_REVISION','修订号无效',400);
 const version=await one(db,`SELECT v.*,o.object_key,o.etag AS object_etag,o.status AS object_status FROM file_versions v
  JOIN storage_objects o ON o.id=v.object_id WHERE v.file_id=? AND v.revision=? AND o.bucket_type='private' AND o.status='ready'`,[id,rev]);
 if(!version)return error('VERSION_NOT_FOUND','历史版本不可用',404);
 if(versionAction==='restore'){
  const body=await jsonBody(req);
  if(body?.expected_revision!==undefined&&body.expected_revision!==access.file.revision)return error('VERSION_CONFLICT','文件已经被其他用户修改，请刷新历史记录后重试',409);
  const sourceHead=await storageBinding(env).head(version.object_key);
  if(!sourceHead||sourceHead.size!==version.size_bytes)return error('VERSION_UNAVAILABLE','历史对象丢失或大小不符',503);
  let prepared=null,committed=false;
  try{
   prepared=await preparePublicVersions(env,db,{file:access.file,newPrivateKey:version.object_key,size:version.size_bytes,mime:version.mime_type,revision:access.file.revision+1});
   const changed=await restoreVersion(db,{file:access.file,version,userId:user.id,preparedPublic:prepared});
   if(!changed)return error('VERSION_CONFLICT','文件已更新，请刷新后再试',409);
   committed=true;
   try{await synchronizePublicationOnCommit(env,prepared)}catch(e){console.warn('Deferred public alias update',e);}
   return ok({...changed,restored_from:rev});
  }catch(e){if(e instanceof PublicationUpdateError)return error(e.code,e.message,e.status);throw e;}
  finally{if(!committed&&prepared)await abandonPreparedPublic(env,db,prepared);}
 }
 return servePrivateObject(req,storageBinding(env),{
  object_key:version.object_key,object_etag:version.object_etag,size_bytes:version.size_bytes,
  mime_type:version.mime_type,name:access.file.name
 },{preview:versionAction==='preview'});
}
