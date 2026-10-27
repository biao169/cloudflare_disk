// RC12: global name lookup with per-request ACL filtering and bounded D1 work.
// A search result never grants additional rights; every returned record has been
// checked against current (not cached) membership and folder permissions.
import {dbFromEnv,many} from '../services/database.js';
import {resolveUser} from '../services/auth.js';
import {spaceAccessBatch,folderAccessBatch} from '../services/permission-batch.js';
import {canFolder,canSpace} from '../services/spaces.js';
import {ok,error} from '../utils/response.js';
const ID=/^[0-9a-f-]{36}$/;
const TYPES=new Set(['all','file','folder','images','videos','documents']);
function parseCursor(s){
 if(!s)return null;if(s.length>280||!/^[\w-]+$/.test(s))return false;
 try{const [date,kind,id]=JSON.parse(atob(s.replace(/-/g,'+').replace(/_/g,'/')));return typeof date==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(date)&&['file','folder'].includes(kind)&&ID.test(id)?{date,kind,id}:false;}catch{return false;}
}
const encodeCursor=r=>btoa(JSON.stringify([r.updated_at,r.kind,r.id])).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const patternOf=s=>'%'+s.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%';
export async function globalSearchRoute(req,env){
 const user=await resolveUser(req,env);if(!user)return error('UNAUTHORIZED','请先登录',401);
 if(req.method!=='GET')return error('METHOD_NOT_ALLOWED','方法不允许',405);
 const q=new URL(req.url).searchParams,term=(q.get('q')||'').trim(),type=q.get('type')||'all',space=q.get('space_id');
 const limitValue=q.get('limit'),limit=limitValue===null?30:/^[1-9]\d*$/.test(limitValue)?Math.min(Number(limitValue),40):null,cursor=parseCursor(q.get('cursor'));
 if(!term||new TextEncoder().encode(term).length>46||!TYPES.has(type)||limit===null||cursor===false||(space&&!ID.test(space)))return error('INVALID_INPUT','请输入有效关键词、筛选条件和分页参数',400);
 const db=dbFromEnv(env),pattern=patternOf(term),searchFiles=type!=='folder',searchFolders=['all','folder'].includes(type);
 const mimeClause=type==='images'?" AND f.mime_type LIKE 'image/%'":type==='videos'?" AND f.mime_type LIKE 'video/%'":type==='documents'?" AND (f.mime_type='application/pdf' OR f.mime_type LIKE 'text/%' OR f.mime_type LIKE '%document%' OR f.mime_type LIKE '%spreadsheet%')":'';
 const membership=(alias)=>`(s.owner_id=? OR ?=1 OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=?))`;
 const select=[],baseArgs=[];
 if(searchFiles){select.push(`SELECT 'file' AS kind,f.id,f.name,f.space_id,f.folder_id,NULL AS parent_id,f.mime_type,f.size_bytes,f.created_at,f.updated_at,s.name AS space_name FROM files f JOIN spaces s ON s.id=f.space_id WHERE f.status='ready' AND f.deleted_at IS NULL AND f.name LIKE ? ESCAPE '\\' ${mimeClause} AND ${membership()}`);baseArgs.push(pattern,user.id,user.role==='super_admin'?1:0,user.id)}
 if(searchFolders){select.push(`SELECT 'folder' AS kind,d.id,d.name,d.space_id,NULL AS folder_id,d.parent_id,NULL AS mime_type,NULL AS size_bytes,d.created_at,d.updated_at,s.name AS space_name FROM folders d JOIN spaces s ON s.id=d.space_id WHERE d.deleted_at IS NULL AND d.name LIKE ? ESCAPE '\\' AND ${membership()}`);baseArgs.push(pattern,user.id,user.role==='super_admin'?1:0,user.id)}
 const visible=[],maxScan=240,chunkSize=40;let seen=0,last=cursor,hasMore=false;
 while(visible.length<limit&&seen<maxScan){
  const args=[...baseArgs],where=[];
  if(space){where.push('r.space_id=?');args.push(space)}
  if(last){where.push('(r.updated_at < ? OR (r.updated_at = ? AND (r.kind < ? OR (r.kind = ? AND r.id < ?))))');args.push(last.date,last.date,last.kind,last.kind,last.id)}
  const cap=Math.min(chunkSize,maxScan-seen);args.push(cap);
  const rows=await many(db,`SELECT * FROM (${select.join(' UNION ALL ')}) r ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY r.updated_at DESC,r.kind DESC,r.id DESC LIMIT ?`,args);
  if(!rows.length){hasMore=false;break}
  seen+=rows.length;
  const [folders,spaces]=await Promise.all([
   folderAccessBatch(db,user,rows.map(r=>r.kind==='folder'?r.id:r.folder_id)),
   spaceAccessBatch(db,user,rows.filter(r=>r.kind==='file'&&!r.folder_id).map(r=>r.space_id))
  ]);
  let full=false;
  for(let i=0;i<rows.length;i++){
   const r=rows[i];last=r;
   const readable=r.kind==='folder'?canFolder(folders.get(r.id),'read'):r.folder_id?canFolder(folders.get(r.folder_id),'read'):canSpace(spaces.get(r.space_id),'read');
   if(readable)visible.push(r);
   if(visible.length>=limit){hasMore=i<rows.length-1||rows.length===cap;full=true;break}
  }
  if(full)break;hasMore=rows.length===cap;if(!hasMore)break;
 }
 return ok({items:visible,cursor:hasMore&&last?encodeCursor(last):null,has_more:hasMore,limit});
}
