import {ensurePersonal} from '../services/spaces.js';
import {one,many,execute,dbFromEnv} from '../services/database.js';
import {validUsername,validPassword,passwordHash,checkPassword,randomToken,sha256,resolveUser,safeUser,cookies,newSession,blocked,failed,clearFailures,jsonBody,sessionCookie} from '../services/auth.js';
import {ok,error,json} from '../utils/response.js';
const deny=()=>error('UNAUTHORIZED','请先登录',401);
const admin=u=>u?.role==='super_admin';
function ipKey(request){const ip=request.headers.get('CF-Connecting-IP')||'local';return ip.substring(0,100);}
export async function authRoute(request,env,path){
 const db=dbFromEnv(env),method=request.method;
 if(path==='/api/v1/auth/setup-status'&&method==='GET'){
   const row=await one(db,'SELECT COUNT(*) AS count FROM users');return ok({setup_required:row.count===0});
 }
 if(path==='/api/v1/auth/setup'&&method==='POST'){
   const body=await jsonBody(request);if(!body)return error('BAD_REQUEST','请求数据不合法',400);
   if(!validBootstrapToken(env.BOOTSTRAP_TOKEN)||typeof body.bootstrap_token!=='string'||!(await equalHash(body.bootstrap_token,env.BOOTSTRAP_TOKEN)))return error('FORBIDDEN','初始化令牌未设置或无效',403);
   if(!validUsername(body.username)||!validPassword(body.password))return error('INVALID_INPUT','用户名需为 3–40 位字符，登录密码为 6–128 字符',400);
   const hash=await passwordHash(body.password);
   // Concurrent setup attempts are serialized by database's conditional insert.
   const id=crypto.randomUUID();
   const result=await execute(db,`INSERT INTO users(id,username,password_hash,role) SELECT ?,?,?,'super_admin' WHERE NOT EXISTS(SELECT 1 FROM users)`,[id,body.username,hash]);
   if(result.meta?.changes!==1)return error('SETUP_COMPLETE','管理员已初始化',409);
   await ensurePersonal(db,{id});return ok({id,username:body.username},201);
 }
 if(path==='/api/v1/auth/login'&&method==='POST'){
   const body=await jsonBody(request);if(!validUsername(body?.username)||!validPassword(body?.password))return error('INVALID_CREDENTIALS','用户名或密码错误',401);
   const ip=ipKey(request),key=await sha256(`login:user-ip:${ip}:${body.username.toLowerCase()}`),ipBucket=await sha256(`login:ip:${ip}`);
   if(await blocked(db,key)||await blocked(db,ipBucket))return error('TOO_MANY_ATTEMPTS','登录尝试过多，请稍后再试',429);
   const user=await one(db,'SELECT * FROM users WHERE username=? COLLATE NOCASE',[body.username]);
   if(!user || user.status!=='active' || !(await checkPassword(body.password,user.password_hash))){await failed(db,key);await failed(db,ipBucket,30);return error('INVALID_CREDENTIALS','用户名或密码错误',401);}
   await ensurePersonal(db,user);await clearFailures(db,key);const cookie=await newSession(db,user.id,request);return json({success:true,data:{user:safeUser(user)}},200,{'Set-Cookie':cookie});
 }
 const user=await resolveUser(request,env);
 if(path==='/api/v1/auth/me'&&method==='GET')return user?ok({user:safeUser(user)}):deny();
 if(path==='/api/v1/auth/logout'&&method==='POST'){
   if(cookies(request))await execute(db,'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=?',[await sha256(cookies(request))]);
   return json({success:true,data:{logged_out:true}},200,{'Set-Cookie':sessionCookie('',request,0)});
 }
 if(path==='/api/v1/auth/password'&&method==='POST'){
   if(!user)return deny();const body=await jsonBody(request);if(!validPassword(body?.current_password)||!validPassword(body?.new_password))return error('INVALID_INPUT','登录密码为 6–128 字符',400);
   if(!(await checkPassword(body.current_password,user.password_hash)))return error('INVALID_CREDENTIALS','原密码错误',403);
   await execute(db,'UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[await passwordHash(body.new_password),user.id]);
   await execute(db,'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=?',[user.id]);
   return json({success:true,data:{password_changed:true}},200,{'Set-Cookie':sessionCookie('',request,0)});
 }
 if(path==='/api/v1/users'&&method==='GET'){
   if(!admin(user))return error('FORBIDDEN','仅管理员可访问',403);
   const rows=await many(db,'SELECT id,username,role,status,quota_bytes,created_at FROM users ORDER BY created_at DESC LIMIT 100');return ok({items:rows});
 }
 if(path==='/api/v1/users'&&method==='POST'){
   if(!admin(user))return error('FORBIDDEN','仅管理员可访问',403);
   const body=await jsonBody(request);if(!validUsername(body?.username)||!validPassword(body?.password)||!['member','super_admin'].includes(body?.role||'member'))return error('INVALID_INPUT','账号参数不合法',400);
   if(await one(db,'SELECT id FROM users WHERE username=? COLLATE NOCASE',[body.username]))return error('USER_EXISTS','用户名已存在',409);
   const id=crypto.randomUUID();await execute(db,'INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)',[id,body.username,await passwordHash(body.password),body.role||'member']);await ensurePersonal(db,{id});return ok({id,username:body.username},201);
 }
 const m=path.match(/^\/api\/v1\/users\/([0-9a-f-]{36})$/);
 if(m&&method==='PATCH'){
   if(!admin(user))return error('FORBIDDEN','仅管理员可访问',403);
   const body=await jsonBody(request);if(!body||!['active','disabled'].includes(body.status)||!['member','super_admin'].includes(body.role))return error('INVALID_INPUT','角色和状态不合法',400);
   const target=await one(db,'SELECT id,role,status FROM users WHERE id=?',[m[1]]);if(!target)return error('NOT_FOUND','用户不存在',404);
   if(target.id===user.id&&(body.status==='disabled'||body.role!=='super_admin'))return error('FORBIDDEN','不能停用自己或撤销自身管理员权限',403);
   if(target.role==='super_admin'&&(body.role!=='super_admin'||body.status==='disabled')){
      const n=await one(db,"SELECT COUNT(*) AS n FROM users WHERE role='super_admin' AND status='active'");if(n.n<=1)return error('LAST_ADMIN','不能停用最后一个管理员',409);
   }
   await execute(db,'UPDATE users SET role=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[body.role,body.status,m[1]]);
   if(body.status==='disabled'||body.role!==target.role)await execute(db,'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=?',[m[1]]);
   return ok({id:m[1],role:body.role,status:body.status});
 }
 return error('NOT_FOUND','接口不存在',404);
}
async function equalHash(a,b){return (await sha256(a))===(await sha256(b));}

function validBootstrapToken(s){return typeof s==='string'&&s.length>=32&&!/CHANGE_ME|REPLACE_WITH|EXAMPLE|YOUR_SECRET/i.test(s);}
