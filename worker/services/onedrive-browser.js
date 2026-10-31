// RC14.8: authenticated OneDrive explorer (never an unauthenticated Graph proxy).
import {getAccessToken} from './onedrive-oauth.js';
import {requireMicrosoftConfig} from './microsoft-config.js';

const GRAPH_ORIGIN='https://graph.microsoft.com';
const GRAPH_ROOT='/v1.0/me/drive/';
const ID=/^(?!\.{1,2}$)[A-Za-z0-9_!.-]{1,220}$/;
const PAGE_SIZE=60;
const CURSOR_AGE_MS=15*60*1000;
const SORTS=new Map([
 ['name_asc','name asc'],['name_desc','name desc'],
 ['updated_desc','lastModifiedDateTime desc'],['updated_asc','lastModifiedDateTime asc'],
 ['size_desc','size desc'],['size_asc','size asc']
]);
const textBytes=x=>new TextEncoder().encode(x);
const b64=bytes=>btoa(Array.from(bytes,x=>String.fromCharCode(x)).join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function un64(s){if(!/^[a-zA-Z0-9_-]+$/.test(s)||s.length>16000)throw Error('INVALID_CURSOR');try{return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));}catch{throw Error('INVALID_CURSOR');}}
function secureEqual(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;}
async function cursorKey(env){const {tokenKey}=requireMicrosoftConfig(env);const hkdf=await crypto.subtle.importKey('raw',tokenKey,'HKDF',false,['deriveKey']);return crypto.subtle.deriveKey({name:'HKDF',salt:textBytes('clouddrive:onedrive:browser:v1'),info:textBytes('pagination cursor'),hash:'SHA-256'},hkdf,{name:'HMAC',hash:'SHA-256',length:256},false,['sign']);}
async function hmac(env,s){return new Uint8Array(await crypto.subtle.sign('HMAC',await cursorKey(env),textBytes(s)));}
export function validGraphNextLink(value){
 if(typeof value!=='string'||value.length>7000)return false;
 try{const u=new URL(value);if(u.origin!==GRAPH_ORIGIN||u.username||u.password||u.hash||u.port||!u.pathname.startsWith(GRAPH_ROOT))return false;
  const tail=u.pathname.slice(GRAPH_ROOT.length);
  return tail==='root/children'||/^items\/(?!\.{1,2}\/)[A-Za-z0-9_!.-]{1,220}\/children$/.test(tail)||tail.startsWith('root/search(')&&tail.endsWith(')');
 }catch{return false;}
}
export async function sealBrowserCursor(env,{next,parent,query,sort}){
 if(!validGraphNextLink(next))throw Error('INVALID_GRAPH_NEXT_LINK');
 const payload=b64(textBytes(JSON.stringify({v:1,next,parent,query,sort,issued:Date.now()})));
 return `${payload}.${b64(await hmac(env,payload))}`;
}
export async function unsealBrowserCursor(env,cursor,{parent,query,sort}){
 if(typeof cursor!=='string'||cursor.length>12500)throw Error('INVALID_CURSOR');
 const parts=cursor.split('.');if(parts.length!==2)throw Error('INVALID_CURSOR');
 const actual=await hmac(env,parts[0]);if(!secureEqual(actual,un64(parts[1])))throw Error('INVALID_CURSOR');
 let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(un64(parts[0])));}catch{throw Error('INVALID_CURSOR');}
 if(data?.v!==1||data.parent!==parent||data.query!==query||data.sort!==sort||!Number.isSafeInteger(data.issued)||data.issued>Date.now()+30000||Date.now()-data.issued>CURSOR_AGE_MS||!validGraphNextLink(data.next))throw Error('INVALID_CURSOR');
 return data.next;
}
function itemPath(parent){if(parent==='root')return '/me/drive/root';if(!ID.test(parent))throw Error('INVALID_ITEM_ID');return `/me/drive/items/${encodeURIComponent(parent)}`;}
function graphError(resp){const e=new Error((resp.status===429||resp.status===503)?'MICROSOFT_THROTTLED':resp.status===401?'MICROSOFT_REAUTHORIZE':resp.status===403?'MICROSOFT_ACCESS_DENIED':resp.status===404?'MICROSOFT_NOT_FOUND':resp.status===400?'MICROSOFT_QUERY_UNSUPPORTED':'MICROSOFT_GRAPH_FAILED');e.status=resp.status;e.retryAfter=resp.headers.get('Retry-After');return e;}
async function requestGraph(env,url){
 const token=await getAccessToken(env);
 const resp=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(!resp.ok)throw graphError(resp);
 return resp.json();
}
export function validatedThumbnailUrl(value){
 if(typeof value!=='string'||value.length>6000)return null;
 try{const u=new URL(value);if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash)return null;
 const host=u.hostname.toLowerCase();
 if(host==='onedrive.live.com'||host==='public.dm.files.1drv.com'||host.endsWith('.files.1drv.com')||host.endsWith('.sharepoint.com')||host.endsWith('.sharepointonline.com')||host.endsWith('.onedrive.com'))return u.href;
 }catch{}return null;
}
function itemType(j){const mime=String(j.file?.mimeType||'').toLowerCase();if(j.folder||j.package)return 'folder';if(mime.startsWith('image/'))return 'image';if(mime.startsWith('video/'))return 'video';if(mime.startsWith('audio/'))return 'audio';if(mime==='application/pdf'||mime.startsWith('text/')||mime.includes('document')||mime.includes('word')||mime.includes('presentation')||mime.includes('spreadsheet')||mime.includes('excel'))return 'document';return 'other';}
export function normalizeDriveItem(j){
 const thumbs=Array.isArray(j.thumbnails)?j.thumbnails[0]:null;
 const thumb=validatedThumbnailUrl(thumbs?.medium?.url)||validatedThumbnailUrl(thumbs?.small?.url);
 return {id:String(j.id||''),name:String(j.name||''),folder:!!(j.folder||j.package),type:itemType(j),mime_type:j.file?.mimeType||null,
  size:Number.isSafeInteger(j.size)&&j.size>=0?j.size:0,updated_at:j.lastModifiedDateTime||null,
  parent_id:j.parentReference?.id||null,thumbnail_url:thumb,child_count:Number.isInteger(j.folder?.childCount)?j.folder.childCount:null};
}
function searchPath(query){ // OData quoted literal: escape embedded apostrophe, then URI-encode.
 const literal=query.replace(/'/g,"''");
 return `/me/drive/root/search(q='${encodeURIComponent(literal).replace(/'/g,'%27')}')`;
}
export function validateBrowseParams({parent='root',query='',sort='name_asc'}={}){
 if(typeof parent!=='string'||(parent!=='root'&&!ID.test(parent)))throw Error('INVALID_ITEM_ID');
 if(typeof query!=='string'||query.length>120||/[\u0000-\u001f\u007f]/.test(query))throw Error('INVALID_SEARCH_QUERY');
 if(!SORTS.has(sort))throw Error('INVALID_SORT');
 return {parent,query:query.trim(),sort};
}
export async function browseDrivePage(env,options={}){
 const {parent,query,sort}=validateBrowseParams(options);
 const cursor=options.cursor||'';
 let url,usingExpand=false;
 if(cursor)url=await unsealBrowserCursor(env,cursor,{parent,query,sort});
 else{
  const p=query?searchPath(query):`${itemPath(parent)}/children`;
  const params=new URLSearchParams({$top:String(PAGE_SIZE),$select:'id,name,size,file,folder,package,parentReference,lastModifiedDateTime,eTag,webUrl'});
  if(!query){params.set('$orderby',SORTS.get(sort));params.set('$expand','thumbnails');usingExpand=true;}
  url=`${GRAPH_ORIGIN}/v1.0${p}?${params}`;
 }
 let result,thumbExpandSupported=true,graphSortSupported=true;
 try{result=await requestGraph(env,url);}catch(e){
  if(e.status!==400||!!cursor||!!query)throw e;
  // Business tenants may reject $expand=thumbnails. Other providers may reject $orderby.
  const fallback=new URL(url);
  if(usingExpand){fallback.searchParams.delete('$expand');thumbExpandSupported=false;}
  try{result=await requestGraph(env,fallback.href);}catch(second){
   if(second.status!==400)throw second;
   fallback.searchParams.delete('$orderby');graphSortSupported=false;
   result=await requestGraph(env,fallback.href);
  }
 }
 const items=(Array.isArray(result?.value)?result.value:[]).filter(x=>x&&ID.test(x.id)&&typeof x.name==='string').map(normalizeDriveItem);
 const next=result?.['@odata.nextLink'];
 const next_cursor=next?await sealBrowserCursor(env,{next,parent,query,sort}):null;
 return {items,next_cursor,has_more:!!next_cursor,scope:query?'drive_search':'folder',parent,query,sort,thumbnail_expand_supported:thumbExpandSupported,page_size:PAGE_SIZE,
  sort_scope:query||!graphSortSupported?'client_loaded_results':'graph_folder',note:query?'搜索整个 OneDrive；搜索结果按当前已加载记录排序。':null};
}
export async function driveThumbnail(env,itemId){
 if(!ID.test(itemId))throw Error('INVALID_ITEM_ID');
 const result=await requestGraph(env,`${GRAPH_ORIGIN}/v1.0${itemPath(itemId)}/thumbnails`);
 const thumbnail=Array.isArray(result.value)?result.value[0]:null;
 return {url:validatedThumbnailUrl(thumbnail?.medium?.url)||validatedThumbnailUrl(thumbnail?.small?.url)};
}
