// RC12: user-owned favorites; favorites never grant access to a file or folder.
import {dbFromEnv,many,one,execute} from '../services/database.js';
import {resolveUser,jsonBody} from '../services/auth.js';
import {spaceAccess,folderAccess,canFolder,canSpace} from '../services/spaces.js';
import {spaceAccessBatch,folderAccessBatch} from '../services/permission-batch.js';
import {ok,error} from '../utils/response.js';

const ID=/^[0-9a-f-]{36}$/;
const kindOK=k=>k==='file'||k==='folder';
const int=(v,fallback,cap)=>v===null?fallback:/^[1-9]\d*$/.test(v)?Math.min(Number(v),cap):null;
const cursorOf=r=>btoa(JSON.stringify([r.created_at,r.target_type,r.target_id])).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function parseCursor(s){
 if(!s)return null;if(s.length>280||!/^[A-Za-z0-9_-]+$/.test(s))return false;
 try{const [date,kind,id]=JSON.parse(atob(s.replace(/-/g,'+').replace(/_/g,'/')));return typeof date==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(date)&&kindOK(kind)&&ID.test(id)?{date,kind,id}:false;}catch{return false;}
}
export async function favoriteRoute(request,env,path){
 const user=await resolveUser(request,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 const db=dbFromEnv(env),q=new URL(request.url).searchParams,method=request.method;
 if(path==='/api/v1/favorites/check'&&method==='POST'){
  const body=await jsonBody(request),items=body?.items;
  if(!Array.isArray(items)||items.length>40||items.some(i=>!kindOK(i?.kind)||!ID.test(i?.id)))return error('INVALID_INPUT','一次最多检查 40 个有效文件或文件夹',400);
  const files=[...new Set(items.filter(i=>i.kind==='file').map(i=>i.id))],folders=[...new Set(items.filter(i=>i.kind==='folder').map(i=>i.id))];
  if(!files.length&&!folders.length)return ok({keys:[]});
  const clauses=[],values=[user.id];
  if(files.length){clauses.push(`(target_type='file' AND target_id IN (${files.map(()=>'?').join(',')}))`);values.push(...files)}
  if(folders.length){clauses.push(`(target_type='folder' AND target_id IN (${folders.map(()=>'?').join(',')}))`);values.push(...folders)}
  const rows=await many(db,`SELECT target_type,target_id FROM favorites WHERE user_id=? AND (${clauses.join(' OR ')})`,values);
  return ok({keys:rows.map(r=>`${r.target_type}:${r.target_id}`)});
 }
 if(path==='/api/v1/favorites'&&method==='GET'){
  const limit=int(q.get('limit'),30,40),cursor=parseCursor(q.get('cursor'));
  if(!limit||cursor===false)return error('INVALID_INPUT','收藏分页参数无效',400);
  const visible=[],maxScan=240,chunkSize=40;let seen=0,last=cursor,hasMore=false;
  while(visible.length<limit&&seen<maxScan){
   const args=[user.id],conditional=last?'AND (v.created_at < ? OR (v.created_at = ? AND (v.target_type < ? OR (v.target_type = ? AND v.target_id < ?))))':'';
   if(last)args.push(last.date,last.date,last.kind,last.kind,last.id);
   args.push(Math.min(chunkSize,maxScan-seen));
   const rows=await many(db,`SELECT v.target_type AS kind,v.target_id AS id,v.created_at AS favorited_at,
     v.created_at,f.name AS file_name,f.folder_id,f.mime_type,f.size_bytes,f.status,f.deleted_at AS file_deleted,
     d.name AS folder_name,d.parent_id,d.deleted_at AS folder_deleted,
     COALESCE(f.space_id,d.space_id) AS space_id,s.name AS space_name,
     COALESCE(f.updated_at,d.updated_at) AS updated_at
     FROM favorites v
     LEFT JOIN files f ON v.target_type='file' AND f.id=v.target_id
     LEFT JOIN folders d ON v.target_type='folder' AND d.id=v.target_id
     LEFT JOIN spaces s ON s.id=COALESCE(f.space_id,d.space_id)
     WHERE v.user_id=? ${conditional}
     ORDER BY v.created_at DESC,v.target_type DESC,v.target_id DESC LIMIT ?`,args);
   if(!rows.length){hasMore=false;break}
   seen+=rows.length;
   const available=rows.filter(r=>(r.kind==='file'&&r.file_name!==null&&r.status==='ready'&&r.file_deleted===null)||(r.kind==='folder'&&r.folder_name!==null&&r.folder_deleted===null));
   const [fa,sa]=await Promise.all([
    folderAccessBatch(db,user,available.map(r=>r.kind==='folder'?r.id:r.folder_id)),
    spaceAccessBatch(db,user,available.filter(r=>r.kind==='file'&&!r.folder_id).map(r=>r.space_id))
   ]);
   let filled=false;
   for(let i=0;i<rows.length;i++){
    const r=rows[i];last={date:r.created_at,kind:r.kind,id:r.id};
    if(available.includes(r)){
     const allowed=r.kind==='folder'?canFolder(fa.get(r.id),'read'):r.folder_id?canFolder(fa.get(r.folder_id),'read'):canSpace(sa.get(r.space_id),'read');
     if(allowed)visible.push({kind:r.kind,id:r.id,name:r.kind==='file'?r.file_name:r.folder_name,folder_id:r.folder_id,parent_id:r.parent_id,space_id:r.space_id,space_name:r.space_name,size_bytes:r.size_bytes,mime_type:r.mime_type,updated_at:r.updated_at,favorited_at:r.favorited_at});
    }
    if(visible.length>=limit){hasMore=i<rows.length-1||rows.length===args.at(-1);filled=true;break}
   }
   if(filled)break;hasMore=rows.length===args.at(-1);if(!hasMore)break;
  }
  return ok({items:visible,cursor:hasMore&&last?cursorOf({created_at:last.date,target_type:last.kind,target_id:last.id}):null,has_more:hasMore,limit});
 }
 if(path==='/api/v1/favorites'&&method==='POST'){
  const b=await jsonBody(request);if(!kindOK(b?.kind)||!ID.test(b?.id))return error('INVALID_INPUT','收藏对象无效',400);
  if(b.kind==='folder'){
   const access=await folderAccess(db,user,b.id);if(!canFolder(access,'read'))return error('NOT_FOUND','文件夹不存在或无权访问',404);
  }else{
   const file=await one(db,"SELECT id,space_id,folder_id FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL",[b.id]);
   if(!file)return error('NOT_FOUND','文件不存在',404);
   const access=file.folder_id?await folderAccess(db,user,file.folder_id):await spaceAccess(db,user,file.space_id);
   if(!(file.folder_id?canFolder(access,'read'):canSpace(access,'read')))return error('NOT_FOUND','文件不存在或无权访问',404);
  }
  await execute(db,'INSERT OR IGNORE INTO favorites(user_id,target_type,target_id) VALUES(?,?,?)',[user.id,b.kind,b.id]);
  return ok({kind:b.kind,id:b.id,is_favorite:true});
 }
 const removal=path.match(/^\/api\/v1\/favorites\/(file|folder)\/([0-9a-f-]{36})$/);
 if(removal&&method==='DELETE'){
  await execute(db,'DELETE FROM favorites WHERE user_id=? AND target_type=? AND target_id=?',[user.id,removal[1],removal[2]]);
  return ok({is_favorite:false});
 }
 return error('NOT_FOUND','接口不存在',404);
}
