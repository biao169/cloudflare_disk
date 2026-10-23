export class DatabaseError extends Error { constructor(message,cause){super(message,{cause});this.name='DatabaseError';} }
export function dbFromEnv(env){
 if(!env?.DB || typeof env.DB.prepare!=='function') throw new DatabaseError('D1 binding DB unavailable');
 return env.DB;
}
export async function one(db,sql,bindings=[]){try{return await db.prepare(sql).bind(...bindings).first();}catch(cause){throw new DatabaseError('Database read failed',cause);}}
export async function many(db,sql,bindings=[]){try{const r=await db.prepare(sql).bind(...bindings).all();return r.results??[];}catch(cause){throw new DatabaseError('Database list failed',cause);}}
export async function execute(db,sql,bindings=[]){try{return await db.prepare(sql).bind(...bindings).run();}catch(cause){throw new DatabaseError('Database write failed',cause);}}
export async function batch(db,statements){try{return await db.batch(statements);}catch(cause){throw new DatabaseError('Database batch failed',cause);}}
