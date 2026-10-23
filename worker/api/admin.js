import {dbFromEnv,one,many,execute} from '../services/database.js';
import {resolveUser,jsonBody} from '../services/auth.js';
import {ok,error} from '../utils/response.js';
import {settings,metrics,validateSettings,audit} from '../services/admin.js';
export async function adminRoute(req,env,path){
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 if(user.role!=='super_admin')return error('FORBIDDEN','仅超级管理员可操作',403);
 const db=dbFromEnv(env),method=req.method;
 if(path==='/api/v1/admin/settings'){
  if(method==='GET')return ok(await settings(db));
  if(method==='PATCH'){
   const values=validateSettings(await jsonBody(req));if(!values)return error('INVALID_INPUT','设置内容无效',400);
   if(values.max_storage_bytes!==undefined){const totals=await one(db,'SELECT COALESCE(SUM(used_bytes+reserved_bytes),0) AS total FROM spaces');if(values.max_storage_bytes<totals.total)return error('QUOTA_CONFLICT','不能将配额设置为低于已占用及预留容量',409);}
   await db.batch(Object.entries(values).map(([key,value])=>db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP').bind(key,JSON.stringify(value))));
   await audit(db,user.id,'settings.update','settings',null,{keys:Object.keys(values)});
   return ok(await settings(db));
  }
 }
 if(path==='/api/v1/admin/storage'&&method==='GET')return ok({...(await metrics(db)),settings:await settings(db)});
 if(path==='/api/v1/admin/audit-logs'&&method==='GET'){
  const url=new URL(req.url),limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||30));
  const before=url.searchParams.get('before');if(before&&!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(before))return error('INVALID_CURSOR','时间游标无效',400);
  const rows=await many(db,`SELECT a.id,a.action,a.target_type,a.target_id,a.created_at,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE (? IS NULL OR a.created_at<?) ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,[before,before,limit]);return ok({items:rows,next_before:rows.at(-1)?.created_at??null});
 }
 const m=/^\/api\/v1\/admin\/spaces\/([0-9a-f-]{36})\/quota$/.exec(path);
 if(m&&method==='PATCH'){
  const body=await jsonBody(req),value=body?.quota_bytes;if(!Number.isSafeInteger(value)||value<0||value>1024**4)return error('INVALID_INPUT','容量必须为非负整数（0 表示继承全局上限）',400);
  const s=await one(db,'SELECT used_bytes,reserved_bytes FROM spaces WHERE id=?',[m[1]]);if(!s)return error('NOT_FOUND','空间不存在',404);
  if(value!==0&&value<s.used_bytes+s.reserved_bytes)return error('QUOTA_CONFLICT','新上限小于空间已使用与预留容量',409);
  await execute(db,'UPDATE spaces SET quota_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[value,m[1]]);await audit(db,user.id,'space.quota.update','space',m[1],{quota_bytes:value});return ok({space_id:m[1],quota_bytes:value});
 }
 if(path==='/api/v1/admin/health'&&method==='GET'){
  const database=await one(db,'SELECT 1 AS ok');return ok({database:database?.ok===1,r2_private:Boolean(env.PRIVATE_BUCKET?.get),r2_public:Boolean(env.PUBLIC_BUCKET?.get),worker_version:'stage-12',usage_source:'application_metadata',cloudflare_billing_verified:false});
 }
 if(path==='/api/v1/admin/reconcile'&&method==='GET'){
  const rows=await many(db,`SELECT s.id,s.name,s.used_bytes AS recorded,(COALESCE((SELECT SUM(o.size_bytes) FROM storage_objects o WHERE o.bucket_type='private' AND o.status='ready' AND EXISTS(SELECT 1 FROM files f WHERE f.object_id=o.id AND f.space_id=s.id AND f.status!='deleted')),0) + COALESCE((SELECT SUM(o.size_bytes) FROM publications p JOIN files f ON f.id=p.source_file_id JOIN storage_objects o ON o.id=p.public_object_id WHERE f.space_id=s.id AND p.status='ready' AND o.status='ready'),0)) AS referenced_bytes FROM spaces s LIMIT 100`);
  const cleanup=await one(db,'SELECT COUNT(*) AS jobs,COALESCE(SUM(size_bytes),0) AS pending_bytes FROM storage_cleanup_jobs');
  const stalled=await one(db,"SELECT COUNT(*) AS sessions,COALESCE(SUM(reserved_bytes),0) AS reserved_bytes FROM upload_sessions WHERE status IN ('verifying','failed')");
  return ok({mode:'read_only',cleanup_pending:cleanup,stalled_uploads:stalled,warning:'文件跨空间共享引用、回收站和进行中任务可能使此诊断不能直接用作账单计数；不会自动修改数据。',spaces:rows});
 }
 return error('NOT_FOUND','接口不存在',404);
}
