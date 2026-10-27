import {one,execute,batch} from './database.js';
import {target,validExpiry,shareIsActive,shareSummary} from './sharing.js';
import {randomToken,sha256,passwordHash} from './auth.js';
import {encryptShareCode,decryptShareCode,linkKeyStatus,sharePath} from './share-links.js';
import {ok,error} from '../utils/response.js';
import {many} from './database.js';
import {canFolder,canSpace} from './spaces.js';
import {folderAccessBatch,spaceAccessBatch} from './permission-batch.js';

const uuidRE=/^[0-9a-f-]{36}$/i;
const owns=(share,user)=>share&&share.created_by===user.id;
export async function ownedShare(db,id,user){
 if(!uuidRE.test(id))return null;
 return one(db,'SELECT * FROM shares WHERE id=? AND created_by=?',[id,user.id]);
}
export async function stateForShare(db,share){
 if(share.revoked_at)return 'revoked';
 if(share.expires_at&&Date.parse(share.expires_at)<=Date.now())return 'expired';
 if(share.max_downloads&&share.download_count>=share.max_downloads)return 'download_limit';
 const creator=await one(db,'SELECT id,role,status FROM users WHERE id=?',[share.created_by]);
 if(!creator||creator.status!=='active')return 'creator_disabled';
 const check=share.target_type==='file'?
  await one(db,'SELECT id FROM files WHERE id=? AND deleted_at IS NULL AND status=\'ready\'',[share.target_id]):
  await one(db,'SELECT id FROM folders WHERE id=? AND deleted_at IS NULL',[share.target_id]);
 if(!check)return 'target_unavailable';
 if(!await target(db,creator,share.target_type,share.target_id))return 'permission_revoked';
 return 'active';
}
export async function summarized(db,share){return shareSummary({...share,status:await stateForShare(db,share)});}

// RC11: summarize owned shares in bounded batches. The old per-row implementation
// issued multiple D1 queries per share, easily exceeding Workers Free limits.
export async function summarizedOwnedBatch(db,shares,user){
 if(!shares.length)return [];
 const unique=ids=>[...new Set(ids)];
 const queryTargets=async(table,ids)=>{
  const result=new Map(),all=unique(ids);
  for(let i=0;i<all.length;i+=40){const group=all.slice(i,i+40);
   const columns=table==='files'?'id,space_id,folder_id,deleted_at,status':'id,space_id,parent_id,deleted_at';
   const rows=await many(db,`SELECT ${columns} FROM ${table} WHERE id IN (${group.map(()=>'?').join(',')})`,group);
   for(const row of rows)result.set(row.id,row);
  }
  return result;
 };
 const active=shares.filter(s=>!s.revoked_at&&(!s.expires_at||Date.parse(s.expires_at)>Date.now())&&!(s.max_downloads&&s.download_count>=s.max_downloads));
 const [files,folders]=await Promise.all([
  queryTargets('files',active.filter(s=>s.target_type==='file').map(s=>s.target_id)),
  queryTargets('folders',active.filter(s=>s.target_type==='folder').map(s=>s.target_id))
 ]);
 const fileRows=[...files.values()].filter(f=>!f.deleted_at&&f.status==='ready');
 const [folderRights,spaceRights]=await Promise.all([
  folderAccessBatch(db,user,[...folders.keys(),...fileRows.map(f=>f.folder_id)]),
  spaceAccessBatch(db,user,fileRows.filter(f=>!f.folder_id).map(f=>f.space_id))
 ]);
 return shares.map(s=>{
  let status='active';
  if(s.revoked_at)status='revoked';
  else if(s.expires_at&&Date.parse(s.expires_at)<=Date.now())status='expired';
  else if(s.max_downloads&&s.download_count>=s.max_downloads)status='download_limit';
  else if(!user||user.status!=='active')status='creator_disabled';
  else if(s.target_type==='folder'){
   const target=folders.get(s.target_id);
   if(!target||target.deleted_at)status='target_unavailable';
   else if(!canFolder(folderRights.get(s.target_id),'share')||!canFolder(folderRights.get(s.target_id),'read'))status='permission_revoked';
  }else{
   const target=files.get(s.target_id);
   if(!target||target.deleted_at||target.status!=='ready')status='target_unavailable';
   else if(target.folder_id){
    const a=folderRights.get(target.folder_id);
    if(!canFolder(a,'share')||!canFolder(a,'read'))status='permission_revoked';
   }else{
    const a=spaceRights.get(target.space_id);
    if(!canSpace(a,'share')||!canSpace(a,'read'))status='permission_revoked';
   }
  }
  return shareSummary({...s,status});
 });
}
export async function recoverOwnedShare(req,env,db,user,share){
 if(!owns(share,user))return error('NOT_FOUND','分享不存在',404);
 const state=await stateForShare(db,share);
 // Owners may recover the SAME URL for expired / download-limited shares to
 // renew their validity without changing previously distributed bookmarks.
 // Explicitly re-check permissions because status calculation stops at expiry.
 if(!['active','expired','download_limit'].includes(state))return error('SHARE_NOT_ACCESSIBLE','分享已撤销、源文件不可用或权限失效，无法获取链接',409);
 const creator=await one(db,'SELECT id,role,status FROM users WHERE id=?',[share.created_by]);
 if(!creator||creator.status!=='active'||!await target(db,creator,share.target_type,share.target_id))return error('PERMISSION_REVOKED','没有此文件的有效分享权限',403);
 if(!share.link_ciphertext)return error('LINK_ROTATION_REQUIRED','旧链接仅存哈希，无法还原；请使用「轮换链接」生成新地址，原链接随即失效',409);
 if(linkKeyStatus(env)!=='ready')return error('SHARE_LINK_KEY_REQUIRED','重新获取链接需要已配置且保持不变的 SHARE_LINK_KEY',503);
 try{
  const code=await decryptShareCode(env,share.id,share.link_ciphertext);
  if(!/^[a-f0-9]{64}$/.test(code)||await sha256(code)!==share.share_code_hash)throw Error('Share key mismatch');
  return ok({url:sharePath(share.link_origin||new URL(req.url).origin,share.type,code),rotated:false});
 }catch{return error('LINK_DECRYPT_FAILED','原链接无法解密，请检查加密密钥是否发生变更；不要随意删除旧密钥',503);}
}
export async function rotateOwnedShare(req,env,db,user,share){
 if(!owns(share,user))return error('NOT_FOUND','分享不存在',404);
 if(await stateForShare(db,share)!=='active')return error('SHARE_NOT_ACTIVE','请先修复过期或权限状态，再轮换链接',409);
 if(linkKeyStatus(env)==='invalid')return error('LINK_KEY_INVALID','SHARE_LINK_KEY 必须是 64 位十六进制密钥',503);
 const code=randomToken(32),digest=await sha256(code),encrypted=await encryptShareCode(env,share.id,code),origin=new URL(req.url).origin;
 const result=await batch(db,[
  db.prepare('UPDATE shares SET share_code_hash=?,link_ciphertext=?,link_origin=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND created_by=? AND revoked_at IS NULL').bind(digest,encrypted,origin,share.id,user.id),
  db.prepare('DELETE FROM share_access WHERE share_id=?').bind(share.id)
 ]);
 if(!result[0].meta?.changes)return error('SHARE_NOT_ACTIVE','分享已撤销',409);
 return ok({url:sharePath(new URL(req.url).origin,share.type,code),rotated:true,old_url_revoked:true,link_recovery:encrypted?'recoverable':'rotation_only'});
}
export async function editOwnedShare(env,db,user,share,data){
 if(!owns(share,user))return error('NOT_FOUND','分享不存在',404);
 if(share.revoked_at)return error('SHARE_REVOKED','已撤销分享不可编辑',409);
 const actor=await one(db,'SELECT id,role,status FROM users WHERE id=?',[user.id]);
 if(!actor||!await target(db,actor,share.target_type,share.target_id))return error('PERMISSION_REVOKED','已经没有此文件的分享权限',403);
 if(!data||typeof data!=='object'||Array.isArray(data))return error('INVALID_SHARE','无效的分享设置',400);
 const keys=Object.keys(data),allowed=['expires_at','allow_download','password_action','password','max_downloads'];
 if(!keys.length||keys.some(k=>!allowed.includes(k)))return error('INVALID_SHARE','不支持修改分享目标或模式',400);
 const set=[],bindings=[];let passwordChanged=false;
 if(Object.hasOwn(data,'expires_at')){
  if(!validExpiry(data.expires_at)||(share.type==='temporary'&&data.expires_at===null))return error('INVALID_EXPIRY','临时直链必须具有未来有效期；分享页面可以永久有效',400);
  set.push('expires_at=?');bindings.push(data.expires_at);
 }
 if(Object.hasOwn(data,'allow_download')){
  if(share.type!=='page'||typeof data.allow_download!=='boolean')return error('INVALID_SHARE','只有分享页面支持修改下载权限',400);
  set.push('allow_download=?');bindings.push(data.allow_download?1:0);
 }
 if(Object.hasOwn(data,'max_downloads')){
  const x=data.max_downloads;
  if(x!==null&&(!Number.isSafeInteger(x)||x<1||x>100000))return error('INVALID_SHARE','下载限制应为 1–100000 或无限制',400);
  set.push('max_downloads=?');bindings.push(x);
 }
 if(Object.hasOwn(data,'password')&&!['replace'].includes(data.password_action))return error('INVALID_SHARE','请明确选择设置新密码',400);
 if(Object.hasOwn(data,'password_action')){
  if(share.type!=='page'||!['keep','clear','replace'].includes(data.password_action))return error('INVALID_SHARE','仅分享页面支持修改密码',400);
  if(data.password_action==='replace'){
   if(typeof data.password!=='string'||Array.from(data.password).length<12||Array.from(data.password).length>128)return error('INVALID_PASSWORD','分享密码长度应为 12–128 字符',400);
   set.push('password_hash=?');bindings.push(await passwordHash(data.password));passwordChanged=true;
  }else if(data.password_action==='clear'){
   set.push('password_hash=NULL');passwordChanged=true;
  }
 }
 if(!set.length)return error('INVALID_SHARE','没有可更新的字段',400);
 const changes=[db.prepare(`UPDATE shares SET ${set.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=? AND created_by=? AND revoked_at IS NULL`).bind(...bindings,share.id,user.id)];
 if(passwordChanged)changes.push(db.prepare('DELETE FROM share_access WHERE share_id=?').bind(share.id));
 const result=await batch(db,changes);
 if(!result[0].meta?.changes)return error('SHARE_NOT_ACTIVE','分享已撤销',409);
 const updated=await ownedShare(db,share.id,user);
 return ok({share:await summarized(db,updated),password_sessions_revoked:passwordChanged});
}
