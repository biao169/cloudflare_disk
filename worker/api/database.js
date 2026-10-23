import {dbFromEnv,one,many,execute} from '../services/database.js';
import {ok,error} from '../utils/response.js';
import {parsePage,isId} from '../utils/validation.js';

// Stage 2: read-only diagnostics. Never expose raw records, password hashes, tokens or SQL execution.
export async function databaseStatus(env){
 const db=dbFromEnv(env);
 const schema=await one(db,"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('users','spaces','files','shares','app_settings')");
 const migrations=await one(db,"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='d1_migrations'");
 return ok({connected:true,schema_ready:schema?.count===5,migrations_table:!!migrations?.count});
}
