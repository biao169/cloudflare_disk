# Stage 5 — file metadata management

API (authenticated):

- `GET /api/v1/spaces/:uuid/contents?parent_id=...&limit=50&offset=0` lists readable folders and ready file metadata.
- `GET /api/v1/search?space_id=:uuid&q=keyword` searches metadata with folder ACL filtering.
- `POST /api/v1/folders` `{space_id,parent_id,name}` creates a folder.
- `PATCH /api/v1/folders/:uuid` `{name?,parent_id?}` renames or moves within the same space; cycles rejected.
- `GET /api/v1/files/:uuid` reads metadata only.
- `PATCH /api/v1/files/:uuid` `{name?,target_folder_id?}` renames/moves within one space.
- `POST /api/v1/files/:uuid/copy` `{name,target_folder_id?}` creates a new metadata entry referencing the same immutable storage object. **No R2 copy is performed.** Future deletion must check all references.
- `POST /api/v1/files/batch` `{operation:"move"|"copy",file_ids:[...],target_folder_id}` handles up to 100 ids with per-item results.

The upload pipeline is deliberately not implemented. Only files already marked `ready` in D1 are listed. Cross-space moves, real object duplication, deletion, download and upload remain future work. Folder ACLs are checked on reads and writes. Search is limited to 100 results; folder listings currently page by offset. Metadata writes are not atomic across concurrent clients; SQLite unique constraints resolve name collisions but may surface as generic database errors in V1. Do not deploy as a production-ready file service.
