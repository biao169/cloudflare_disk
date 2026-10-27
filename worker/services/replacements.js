import {one,many} from './database.js';
import {folderAccess,spaceAccess,canSpace,canFolder,uuid} from './spaces.js';
import {publicationCommitStatements,publicationPrecondition} from './public-versions.js';

export async function targetForReplace(db,user,id,{spaceId=null,folderId=undefined,name=null,revision=null}={}){
 const file=await one(db,"SELECT * FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL",[id]);
 if(!file)return {error:'FILE_NOT_FOUND',status:404};
 if(spaceId!==null&&spaceId!==file.space_id || folderId!==undefined&&folderId!==file.folder_id || name!==null&&name.toLocaleLowerCase()!==file.name.toLocaleLowerCase())return {error:'REPLACE_TARGET_MISMATCH',status:409};
 const access=file.folder_id?await folderAccess(db,user,file.folder_id):await spaceAccess(db,user,file.space_id);
 if(!access||!(file.folder_id?canFolder(access,'write'):canSpace(access,'write')))return {error:'FORBIDDEN',status:403};
 if(revision!==null&&(!Number.isSafeInteger(revision)||revision!==file.revision))return {error:'VERSION_CONFLICT',status:409};
 return {file};
}
// History listing and historical downloads only need READ access. Editing/restoring
// still goes through targetForReplace which requires WRITE access.
export async function targetForView(db,user,id){
 const file=await one(db,"SELECT * FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL",[id]);
 if(!file)return {error:'FILE_NOT_FOUND',status:404};
 const access=file.folder_id?await folderAccess(db,user,file.folder_id):await spaceAccess(db,user,file.space_id);
 if(!access||!(file.folder_id?canFolder(access,'read'):canSpace(access,'read')))return {error:'FORBIDDEN',status:403};
 return {file};
}
// The file ID and all private share targets remain stable. A new R2 object is
// never written over an object shared by another logical file or history row.
// Public pointers are switched by the same D1 transaction as the file revision.
export async function commitReplacement(db,{file,newObjectId,key,etag,size,mime,userId,reservedBytes=0,preparedPublic=null}){
 const revision=file.revision+1,published=preparedPublic?.publicReservation||0;
 const gate=publicationPrecondition(preparedPublic);
 const statements=[
  db.prepare("INSERT INTO storage_objects(id,bucket_type,object_key,size_bytes,etag,status) VALUES(?,'private',?,?,?,'ready')").bind(newObjectId,key,size,etag??null),
  db.prepare(`INSERT OR IGNORE INTO file_versions(id,file_id,revision,object_id,size_bytes,mime_type,created_by)
    SELECT ?,id,revision,object_id,size_bytes,mime_type,? FROM files
    WHERE id=? AND revision=? AND object_id=? AND status='ready' AND deleted_at IS NULL`).bind(uuid(),userId,file.id,file.revision,file.object_id),
  db.prepare(`UPDATE files SET object_id=?,size_bytes=?,mime_type=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND revision=? AND object_id=? AND status='ready' AND deleted_at IS NULL ${gate.sql}`)
    .bind(newObjectId,size,mime,file.id,file.revision,file.object_id,...gate.bindings),
  db.prepare(`UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?),used_bytes=used_bytes+?
    WHERE id=? AND EXISTS(SELECT 1 FROM files WHERE id=? AND revision=? AND object_id=?)`)
    .bind(reservedBytes+published,size+published,file.space_id,file.id,revision,newObjectId),
  ...publicationCommitStatements(db,{file,newObjectId,revision,prepared:preparedPublic}),
  // A CAS conflict should never persist an unreferenced *metadata* row.
  db.prepare('DELETE FROM storage_objects WHERE id=? AND NOT EXISTS(SELECT 1 FROM files WHERE object_id=?)').bind(newObjectId,newObjectId)
 ];
 const results=await db.batch(statements);
 if(results[2]?.meta?.changes!==1)return {conflict:true};
 const count=preparedPublic?.items?.length||0;
 // Metadata changes are already committed at this point. Do not throw a
 // post-commit assertion: upload catch paths might wrongly delete live R2 data.
 const pointerChanges=results.slice(4,4+5*count).filter((r,i)=>i%5===3&&r.meta?.changes===1).length;
 if(pointerChanges!==count)console.error('CRITICAL RC13.2 publication pointer mismatch after D1 batch',file.id);
 return {file_id:file.id,revision,publications_updated:pointerChanges,legacy_sync_pending:count>0,
  ...(pointerChanges!==count?{warning:'PUBLICATION_POINTER_CHECK_REQUIRED'}:{})};
}
export async function versionsForFile(db,id){return many(db,`SELECT v.revision,v.size_bytes,v.mime_type,v.created_at,v.created_by FROM file_versions v WHERE v.file_id=? ORDER BY v.revision DESC LIMIT 100`,[id]);}
export async function restoreVersion(db,{file,version,userId,preparedPublic=null}){
 const revision=file.revision+1,published=preparedPublic?.publicReservation||0,gate=publicationPrecondition(preparedPublic);
 const statements=[
  db.prepare(`INSERT OR IGNORE INTO file_versions(id,file_id,revision,object_id,size_bytes,mime_type,created_by)
   SELECT ?,id,revision,object_id,size_bytes,mime_type,? FROM files WHERE id=? AND revision=? AND object_id=?`).bind(uuid(),userId,file.id,file.revision,file.object_id),
  db.prepare(`UPDATE files SET object_id=?,size_bytes=?,mime_type=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP
   WHERE id=? AND revision=? AND object_id=? AND status='ready' AND deleted_at IS NULL ${gate.sql}`)
   .bind(version.object_id,version.size_bytes,version.mime_type,file.id,file.revision,file.object_id,...gate.bindings),
  ...publicationCommitStatements(db,{file,newObjectId:version.object_id,revision,prepared:preparedPublic}),
  db.prepare(`UPDATE spaces SET reserved_bytes=MAX(0,reserved_bytes-?),used_bytes=used_bytes+?
   WHERE id=? AND EXISTS(SELECT 1 FROM files WHERE id=? AND revision=? AND object_id=?)`)
   .bind(published,published,file.space_id,file.id,revision,version.object_id)
 ];
 const results=await db.batch(statements);
 return results[1]?.meta?.changes===1?{file_id:file.id,revision,publications_updated:preparedPublic?.items?.length||0}:null;
}
