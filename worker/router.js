import {readinessResponse} from './services/readiness.js';
import {adminRoute} from './api/admin.js';
import {trashRoute} from './api/trash.js';
import {sharesRoute} from './api/shares.js';
import {uploadRoute} from './api/uploads.js';
import {storageRoute} from './api/storage.js';
import {fileManagementRoute} from './api/files.js';
import {spacesRoute} from './api/spaces.js';
import {json,ok,error} from './utils/response.js';
import {databaseStatus} from './api/database.js';
import {authRoute} from './api/auth.js';
import {DatabaseError} from './services/database.js';
import {csrfAllowed} from './services/auth.js';
export async function route(request,env){
 const {pathname}=new URL(request.url);
 if(pathname==='/api/v1/health/ready'&&request.method==='GET')return await readinessResponse(env);
 if(pathname==='/api/v1/health'&&request.method==='GET')return ok({status:'ok',application:env.APP_NAME??'CloudDrive',stage:env.APP_STAGE??'stage-12',database:env.DB?'binding-present':'not-configured'});
 if(!pathname.startsWith('/api/'))return null;
 try{
  if(!['GET','HEAD','OPTIONS'].includes(request.method)&&!(await csrfAllowed(request)))return error('INVALID_ORIGIN','跨站请求被拒绝',403);
  if(pathname.startsWith('/api/v1/admin/'))return await adminRoute(request,env,pathname);
  if(pathname==='/api/v1/trash'||pathname.startsWith('/api/v1/trash/'))return await trashRoute(request,env,pathname);
  if(pathname==='/api/v1/shares'||pathname.startsWith('/api/v1/shares/')||pathname==='/api/v1/publications'||pathname.startsWith('/api/v1/publications/')||pathname.startsWith('/api/v1/public/shares/'))return await sharesRoute(request,env,pathname);
  if(pathname==='/api/v1/uploads'||pathname.startsWith('/api/v1/uploads/'))return await uploadRoute(request,env,pathname);
  if(pathname==='/api/v1/storage/upload'||/^\/api\/v1\/files\/[0-9a-f-]{36}\/(?:content|preview)$/.test(pathname))return await storageRoute(request,env,pathname);
  if(pathname==='/api/v1/search'||pathname==='/api/v1/files/batch'||/^\/api\/v1\/files\/[0-9a-f-]{36}(?:\/(?:copy|move))?$/.test(pathname)||/^\/api\/v1\/folders\/[0-9a-f-]{36}$/.test(pathname)||/^\/api\/v1\/spaces\/[0-9a-f-]{36}\/contents$/.test(pathname)||(pathname==='/api/v1/folders'&&request.method==='POST'))return await fileManagementRoute(request,env,pathname);
  if(pathname==='/api/v1/spaces'||pathname.startsWith('/api/v1/spaces/')||pathname==='/api/v1/folders'||/^\/api\/v1\/folders\/[0-9a-f-]+\/permissions$/.test(pathname))return await spacesRoute(request,env,pathname);
  if(pathname.startsWith('/api/v1/auth/')||pathname==='/api/v1/users'||pathname.startsWith('/api/v1/users/'))return await authRoute(request,env,pathname);
  // Disable development fixture API when auth module is active to prevent unrestricted account insertion.
  if(pathname==='/api/v1/system/database'&&request.method==='GET'&&env.APP_ENV==='local')return await databaseStatus(env);
  if(pathname==='/api/v1/dev/fixtures')return error('NOT_FOUND','接口不存在',404);
  return error('NOT_IMPLEMENTED','此 API 将在后续开发阶段实现。',501);
 }catch(e){console.error('API failed',e instanceof DatabaseError?e.cause??e:e);if(e instanceof DatabaseError)return error('DATABASE_UNAVAILABLE','数据库操作失败，请检查迁移和绑定',503);return error('INTERNAL_ERROR','服务器请求失败',500);}
}
export {json};
