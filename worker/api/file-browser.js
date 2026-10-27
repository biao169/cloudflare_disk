// RC7: bounded, ACL-filtered directory picking and genuinely recent files.
import {dbFromEnv, many} from '../services/database.js';
import {resolveUser} from '../services/auth.js';
import {spaceAccess,folderAccess,canFolder,canSpace} from '../services/spaces.js';
import {folderAccessBatch,spaceAccessBatch} from '../services/permission-batch.js';
import {ok,error} from '../utils/response.js';

const ID=/^[0-9a-f-]{36}$/;
const max=(text,fallback,ceiling)=>text===null?fallback:(Number.isSafeInteger(Number(text))&&Number(text)>=0?Math.min(Number(text),ceiling):null);
export const recentCursor=(row)=>btoa(JSON.stringify([row.updated_at,row.id])).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function parseRecentCursor(value){
 if(!value)return null;
 if(value.length>256||!/^[a-zA-Z0-9_-]+$/.test(value))return false;
 try{
  const [date,id]=JSON.parse(atob(value.replace(/-/g,'+').replace(/_/g,'/')));
  return typeof date==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+Z)?$/.test(date)&&ID.test(id)?{date,id}:false;
 }catch{return false;}
}
export async function fileBrowserRoute(req,env,path){
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 const db=dbFromEnv(env),q=new URL(req.url).searchParams;
 if(path==='/api/v1/files/recent'&&req.method==='GET'){
  const limit=max(q.get('limit'),30,50),cursor=parseRecentCursor(q.get('cursor'));
  if(!limit||cursor===false)return error('INVALID_INPUT','分页参数无效',400);
  const visible=[],chunkSize=60,maxScan=240;let last=cursor,scanned=0,hasMore=false;
  while(visible.length<limit&&scanned<maxScan){
   const bound=[user.id,user.role==='super_admin'?1:0,user.id];
   let clause='';if(last){clause=' AND (f.updated_at < ? OR (f.updated_at = ? AND f.id < ?))';bound.push(last.date,last.date,last.id);}
   bound.push(Math.min(chunkSize,maxScan-scanned));
   const rows=await many(db,`SELECT f.id,f.name,f.folder_id,f.space_id,f.mime_type,f.size_bytes,f.created_at,f.updated_at,s.name AS space_name
      FROM files f JOIN spaces s ON s.id=f.space_id
      WHERE f.status='ready' AND f.deleted_at IS NULL
        AND (s.owner_id=? OR ?=1 OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=f.space_id AND m.user_id=?))
        ${clause} ORDER BY f.updated_at DESC,f.id DESC LIMIT ?`,bound);
   if(!rows.length){hasMore=false;break;}
   scanned+=rows.length;
   const [folders,spaces]=await Promise.all([folderAccessBatch(db,user,rows.map(r=>r.folder_id)),spaceAccessBatch(db,user,rows.filter(r=>!r.folder_id).map(r=>r.space_id))]);
   let reached=false;
   for(let i=0;i<rows.length;i++){
    const row=rows[i];last={date:row.updated_at,id:row.id};
    const canRead=row.folder_id?canFolder(folders.get(row.folder_id),'read'):canSpace(spaces.get(row.space_id),'read');
    if(canRead)visible.push(row);
    if(visible.length>=limit){hasMore=i<rows.length-1||rows.length===bound.at(-1);reached=true;break;}
   }
   if(reached)break;
   hasMore=rows.length===bound.at(-1);
   if(!hasMore)break;
  }
  return ok({files:visible,cursor:hasMore&&last?recentCursor({updated_at:last.date,id:last.id}):null,has_more:hasMore,limit});
 }
 // Resolve a folder's full breadcrumb under current ACL. No arbitrary path names
 // are returned if any ancestor or the target has become inaccessible.
 const breadcrumb=path.match(/^\/api\/v1\/folders\/([0-9a-f-]{36})\/path$/);
 if(breadcrumb&&req.method==='GET'){
  const chain=await many(db,`WITH RECURSIVE parents(id,name,parent_id,space_id,depth) AS (
    SELECT id,name,parent_id,space_id,0 FROM folders WHERE id=? AND deleted_at IS NULL
    UNION ALL
    SELECT f.id,f.name,f.parent_id,f.space_id,p.depth+1 FROM folders f JOIN parents p ON p.parent_id=f.id
      WHERE f.deleted_at IS NULL AND f.space_id=p.space_id AND p.depth<39
  ) SELECT * FROM parents ORDER BY depth DESC`,[breadcrumb[1]]);
  if(!chain.length||chain.at(0).parent_id!==null||chain.length>40||new Set(chain.map(f=>f.id)).size!==chain.length)return error('NOT_FOUND','文件夹不存在',404);
  const rights=await folderAccessBatch(db,user,chain.map(f=>f.id));
  if(chain.some(f=>!canFolder(rights.get(f.id),'read')))return error('NOT_FOUND','文件夹不存在',404);
  return ok({space_id:chain[0].space_id,path:chain.map(f=>({id:f.id,name:f.name,parent_id:f.parent_id}))});
 }
 const m=path.match(/^\/api\/v1\/spaces\/([0-9a-f-]{36})\/folders$/);
 if(m&&req.method==='GET'){
  const spaceId=m[1],parent=q.get('parent_id')||null,limit=max(q.get('limit'),50,100),offset=max(q.get('offset'),0,10000);
  if(!limit||offset===null||(parent&&!ID.test(parent)))return error('INVALID_INPUT','目录查询参数无效',400);
  const space=await spaceAccess(db,user,spaceId);if(!space||!canSpace(space,'read'))return error('NOT_FOUND','空间不存在',404);
  const parentAccess=parent?await folderAccess(db,user,parent):null;
  if(parent&&(!parentAccess||parentAccess.folder.space_id!==spaceId||!canFolder(parentAccess,'read')))return error('NOT_FOUND','目录不存在',404);
  const folders=await many(db,'SELECT id,name,parent_id FROM folders WHERE space_id=? AND parent_id IS ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?',[spaceId,parent,limit+1,offset]);
  const visible=[],rights=await folderAccessBatch(db,user,folders.slice(0,limit).map(f=>f.id));
  for(const f of folders.slice(0,limit)){
   const fa=rights.get(f.id);
   if(canFolder(fa,'read'))visible.push({...f,can_write:canFolder(fa,'write')});
  }
  return ok({items:visible,parent_id:parent,root_writable:canSpace(space,'write'),parent_writable:parent?canFolder(parentAccess,'write'):canSpace(space,'write'),has_more:folders.length>limit,offset,limit});
 }
 return error('NOT_FOUND','接口不存在',404);
}
