// Integration harness for real SQLite SQL + an in-memory R2 API adapter.
// This is intentionally NOT a replacement for Wrangler/Miniflare integration.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..','..');
export const ORIGIN='http://localhost:8787';
export class SqliteD1 {
 constructor(){
  this.native=new DatabaseSync(':memory:');
  this.native.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(join(ROOT,'migrations')).filter(n=>/\.sql$/.test(n)).sort())this.native.exec(readFileSync(join(ROOT,'migrations',file),'utf8'));
 }
 prepare(sql){
  const stmt=this.native.prepare(sql);
  const wrap=(values=[])=>({
   bind:(...v)=>wrap(v),
   first:async()=>stmt.get(...values)??null,
   all:async()=>({results:stmt.all(...values)}),
   run:async()=>{const r=stmt.run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},
   _run:()=>{const r=stmt.run(...values);return {meta:{changes:Number(r.changes)}};}
  });
  return wrap();
 }
 async batch(stmts){
  this.native.exec('BEGIN IMMEDIATE');
  try{const results=stmts.map(s=>s._run());this.native.exec('COMMIT');return results;}
  catch(e){this.native.exec('ROLLBACK');throw e;}
 }
 close(){this.native.close()}
 query(sql,...args){return this.native.prepare(sql).get(...args)}
}

async function bytesFrom(body){
 if(body===undefined||body===null)return new Uint8Array(0);
 return new Uint8Array(await new Response(body).arrayBuffer());
}
const etagOf=b=>`test-etag-${b.length}`;
export class MemoryR2 {
 constructor(){this.objects=new Map();this.multipart=new Map();this.failDelete=false;}
 async put(key,body,opts={}){
  const bytes=await bytesFrom(body);this.objects.set(key,{bytes,mime:opts?.httpMetadata?.contentType||'application/octet-stream',cacheControl:opts?.httpMetadata?.cacheControl||null});
  return {key,size:bytes.length,etag:etagOf(bytes),httpEtag:`"${etagOf(bytes)}"`};
 }
 async get(key,opts={}){
  const item=this.objects.get(key);if(!item)return null;
  const r=opts?.range;
  const bytes=r?item.bytes.slice(r.offset,r.offset+r.length):item.bytes;
  return {key,size:item.bytes.length,etag:etagOf(item.bytes),httpEtag:`"${etagOf(item.bytes)}"`,body:new Blob([bytes]).stream(),httpMetadata:{contentType:item.mime,cacheControl:item.cacheControl}};
 }
 async head(key){const i=this.objects.get(key);return i?{key,size:i.bytes.length,etag:etagOf(i.bytes)}:null;}
 async list({limit=1000,cursor}={}){
  const keys=[...this.objects.keys()].sort();
  const offset=cursor?Number(cursor):0;const batch=keys.slice(offset,offset+limit);
  const next=offset+batch.length;
  return {objects:batch.map(key=>({key,size:this.objects.get(key).bytes.length,uploaded:new Date(0)})),truncated:next<keys.length,cursor:next<keys.length?String(next):undefined};
 }
 async delete(key){if(this.failDelete)throw Error('R2 simulated outage');this.objects.delete(key);}
 async createMultipartUpload(key,opts={}){
  const uploadId=crypto.randomUUID();this.multipart.set(uploadId,{key,parts:new Map(),opts});
  return {key,uploadId,abort:async()=>{this.multipart.delete(uploadId)}};
 }
 resumeMultipartUpload(key,uploadId){
  const self=this;
  return {
   async uploadPart(n,body){const u=self.multipart.get(uploadId);if(!u||u.key!==key)throw Error('R2 upload missing');const data=await bytesFrom(body);u.parts.set(n,data);return {partNumber:n,etag:`part-${n}-${data.length}`}},
   async complete(parts){const u=self.multipart.get(uploadId);if(!u)throw Error('R2 multipart missing');const chunks=parts.map(p=>{const chunk=u.parts.get(p.partNumber);if(!chunk||p.etag!==`part-${p.partNumber}-${chunk.length}`)throw Error('Missing or bad R2 part');return chunk;});const total=chunks.reduce((n,b)=>n+b.length,0),bytes=new Uint8Array(total);let offset=0;for(const b of chunks){bytes.set(b,offset);offset+=b.length;}self.multipart.delete(uploadId);return self.put(key,bytes,u.opts);},
   async abort(){self.multipart.delete(uploadId)}
  };
 }
}
export function makeTestEnv(){
 const db=new SqliteD1(),priv=new MemoryR2(),pub=new MemoryR2();
 return {DB:db,PRIVATE_BUCKET:priv,PUBLIC_BUCKET:pub,ASSETS:{fetch:async r=>new Response('<!doctype html><html lang="zh-CN"></html>',{headers:{'Content-Type':'text/html'}})},BOOTSTRAP_TOKEN:'integration-only-initialization-token-12345678',APP_NAME:'CloudDrive',APP_STAGE:'stage-12',PUBLIC_BASE_URL:'https://cdn.example.test'};
}
export async function api(env,path,{method='GET',cookie='',body,headers={}}={}){
 const head={...headers};if(cookie)head.Cookie=cookie;
 if(method!=='GET'&&method!=='HEAD'&&!head.Origin)head.Origin=ORIGIN;
 let payload=body;
 if(body!==undefined&&!(body instanceof Uint8Array)&&typeof body!=='string'&&!(body instanceof ReadableStream)){
  payload=JSON.stringify(body);head['Content-Type']='application/json';
 }
 if(payload!==undefined&&method!=='GET'&&method!=='HEAD'&&head['Content-Length']===undefined)head['Content-Length']=String(payload instanceof Uint8Array?payload.byteLength:new TextEncoder().encode(payload).length);
 const req=new Request(new URL(path,ORIGIN),{method,headers:head,body:payload});
 const response=await worker.fetch(req,env);
 const ct=response.headers.get('content-type')||'';
 const data=ct.includes('application/json')?await response.clone().json():null;
 return {status:response.status,response,data};
}
export async function initialize(env,username='adminuser',password='integration-password-123456'){
 const r=await api(env,'/api/v1/auth/setup',{method:'POST',body:{username,password,bootstrap_token:env.BOOTSTRAP_TOKEN}});
 assert.equal(r.status,201,JSON.stringify(r.data));
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username,password}});
 assert.equal(login.status,200,JSON.stringify(login.data));
 const cookie=login.response.headers.get('set-cookie').split(';')[0];
 const spaces=await api(env,'/api/v1/spaces',{cookie});
 const personal=spaces.data.data.items.find(x=>x.type==='personal');
 assert.ok(personal?.id);
 return {cookie,userId:r.data.data.id,spaceId:personal.id};
}
