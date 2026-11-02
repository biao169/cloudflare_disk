import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderFileManager,spacesForExplorer,explorerLocationKey} from '../public/js/modules/file-manager.js';
import {mountFolderTree} from '../public/js/components/folder-tree.js';
import {makeTestEnv,api,initialize} from './integration/support.js';

// Render the real shared file manager against the real Worker/SQLite API.
// A minimal DOM driver avoids adding browser-library dependencies to the project.
class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.parent=null;this._text='';this.className='';this.attributes={};this.style={};this.dataset={};this.listeners={};this.isConnected=true;this.hidden=false;this.value='';
  this.classList={add:()=>{},remove:()=>{},toggle:()=>{}};}
 set textContent(text){this._text=String(text??'');this.children=[];}
 get textContent(){return this._text+this.children.map(x=>x.textContent??'').join('');}
 append(...nodes){for(const n of nodes){if(this.tagName==='select'&&!this.children.length&&n?.tagName==='option'&&!this.value)this.value=n.value;if(typeof n==='object'&&n)n.parent=this;this.children.push(n)}}
 prepend(...nodes){for(const n of nodes){if(typeof n==='object'&&n)n.parent=this;}this.children.unshift(...nodes)}
 appendChild(node){this.append(node);return node;}
 replaceChildren(...nodes){this._text='';this.children=[];this.append(...nodes)}
 setAttribute(key,value){this.attributes[key]=String(value)}
 addEventListener(key,cb){this.listeners[key]=cb}
 removeEventListener(key){delete this.listeners[key]}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this)}
 querySelector(selector){if(selector===':scope > .cd-tree-more')return this.children.find(n=>n.className?.includes('cd-tree-more'))||null;return this.find(n=>n.tagName===selector)||null}
 querySelectorAll(selector){return this.findAll(n=>n.tagName===selector)}
 find(predicate){if(predicate(this))return this;for(const c of this.children){const match=c?.find?.(predicate);if(match)return match}return null}
 findAll(predicate){return [...(predicate(this)?[this]:[]),...this.children.flatMap(c=>c?.findAll?.(predicate)||[])]}
}
function memoryStorage(){const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)}}
const wait=()=>new Promise(resolve=>setTimeout(resolve,8));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await wait()}assert.fail('expected explorer state not reached')}
async function createFolder(env,session,parent,name){const res=await api(env,'/api/v1/folders',{cookie:session.cookie,method:'POST',body:{space_id:session.spaceId,parent_id:parent,name}});assert.equal(res.status,201,JSON.stringify(res.data));return res.data.data.id;}
async function createFile(env,session,parent,name){const qs=new URLSearchParams({space_id:session.spaceId,name});if(parent)qs.set('folder_id',parent);const res=await api(env,`/api/v1/storage/upload?${qs}`,{method:'POST',cookie:session.cookie,body:new TextEncoder().encode('content'),headers:{'Content-Type':'text/plain'}});assert.equal(res.status,201,JSON.stringify(res.data));return res.data.data.id;}

// Shared explorer must only expose the currently authenticated user's personal spaces.
test('personal scope filters team spaces, and last locations do not bleed across routes',()=>{
 const items=[{id:'team',type:'team'},{id:'my',type:'personal'}];
 assert.deepEqual(spacesForExplorer(items,'personal'),[items[1]]);
 assert.deepEqual(spacesForExplorer(items,'files'),items);
 assert.deepEqual(spacesForExplorer(null,'personal'),[]);
 assert.notEqual(explorerLocationKey('personal'),explorerLocationKey('files'));
 assert.match(readFileSync(new URL('../public/js/main.js',import.meta.url),'utf8'),/\['files','personal','recent','favorites'\]\.includes\(key\)\)void renderFileManager\(host,key\)/);
});

test('/personal uses the /files explorer tree, displays nested files and preserves personal folder location',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const owner=await initialize(env);
 const folder=await createFolder(env,owner,null,'个人资料');const nested=await createFolder(env,owner,folder,'工作资料');
 await createFile(env,owner,folder,'目录文件.txt');await createFile(env,owner,nested,'内部文件.txt');
 // A multi-page folder must remain navigable in the shared explorer.
 const obj=env.DB.native.prepare("INSERT INTO storage_objects (id,bucket_type,object_key,size_bytes,status) VALUES (?,'private',?,4,'ready')");
 const file=env.DB.native.prepare("INSERT INTO files (id,space_id,folder_id,name,object_id,size_bytes,mime_type,status) VALUES (?,?,?,?,?,4,'text/plain','ready')");
 for(let i=0;i<54;i++){const o=crypto.randomUUID();obj.run(o,`test/${o}`);file.run(crypto.randomUUID(),owner.spaceId,folder,`extra-${String(i).padStart(2,'0')}.txt`,o)}
 // A team with a similarly named file must never appear via the personal route.
 const team=await api(env,'/api/v1/spaces',{cookie:owner.cookie,method:'POST',body:{name:'其他团队空间'}});
 assert.equal(team.status,201,JSON.stringify(team.data));
 const teamSpace=team.data.data.id;assert.ok(teamSpace);
 const original={document:globalThis.document,fetch:globalThis.fetch,window:globalThis.window,location:globalThis.location,localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage};
 const sessionStorage=memoryStorage();sessionStorage.setItem('cd-last-folder',JSON.stringify({spaceId:teamSpace,folderId:'team-folder'}));
 globalThis.document={createElement:tag=>new Node(tag),body:new Node('body')};
 globalThis.window={history:{state:null,replaceState:()=>{}},bootstrap:{}};
 globalThis.location={pathname:'/personal'};
 globalThis.localStorage=memoryStorage();globalThis.sessionStorage=sessionStorage;
 globalThis.fetch=async(url,opts={})=>(await api(env,String(url),{method:opts.method||'GET',cookie:owner.cookie,body:opts.body})).response;
 t.after(()=>{Object.assign(globalThis,original)});
 const host=new Node('main');await renderFileManager(host,'personal');
 assert.equal(host.dataset.fileScope,'personal');
 assert.ok(host.find(n=>n.className?.includes('cd-explorer-layout')),'shared two-column layout must be present');
 assert.ok(host.find(n=>n.className?.includes('cd-explorer-tree')),'left tree must be present');
 assert.ok(host.find(n=>n.className?.includes('cd-explorer-content')),'right file list must be present');
 assert.ok(host.textContent.includes('个人资料'));
 assert.ok(!host.textContent.includes('其他团队空间'),'team spaces cannot enter personal selector');
 const dirButton=host.find(n=>n.tagName==='button'&&n.className?.includes('cd-file-name')&&n.textContent==='📁 个人资料');
 assert.ok(dirButton);dirButton.onclick();
 await until(()=>host.textContent.includes('extra-00.txt'));
 const next=host.find(n=>n.tagName==='button'&&n.textContent==='下一页');assert.ok(next&&!next.disabled);
 next.onclick();await until(()=>host.textContent.includes('extra-53.txt')&&host.textContent.includes('目录文件.txt'));
 const previous=host.find(n=>n.tagName==='button'&&n.textContent==='上一页');previous.onclick();await until(()=>host.textContent.includes('工作资料'));
 assert.ok(host.textContent.includes('工作资料'));
 assert.ok(host.textContent.includes('下载')&&host.textContent.includes('分享 / 管理'));
 assert.ok(host.textContent.includes('目录权限'),'old personal folder ACL entry stays available');
 const childButton=host.find(n=>n.tagName==='button'&&n.className?.includes('cd-file-name')&&n.textContent==='📁 工作资料');
 assert.ok(childButton);childButton.onclick();
 await until(()=>host.textContent.includes('内部文件.txt'));
 assert.ok(!host.textContent.includes('目录文件.txt'));
 const saved=JSON.parse(sessionStorage.getItem('cd-last-personal-folder'));
 assert.equal(saved.spaceId,owner.spaceId);assert.equal(saved.folderId,nested);
 assert.equal(JSON.parse(sessionStorage.getItem('cd-last-folder')).spaceId,teamSpace);
 assert.ok(host.find(n=>n.className?.includes('cd-tree-name')&&n.textContent==='工作资料'),'left tree should reveal nested folders from right-side navigation');
 const refreshed=new Node('main');await renderFileManager(refreshed,'personal');
 assert.ok(refreshed.textContent.includes('内部文件.txt'),'reload should restore last personal folder');
 assert.ok(!refreshed.textContent.includes('目录文件.txt'),'restoration stays scoped to current folder');
 const filesHost=new Node('main');await renderFileManager(filesHost,'files');
 assert.ok(filesHost.find(n=>n.className?.includes('cd-explorer-tree')),'/files and /personal use the same tree component');
 assert.ok(filesHost.textContent.includes('其他团队空间'),'the all-files view still offers team spaces');
});


test('shared lazy folder tree can reveal folders on later sibling pages',async t=>{
 const previousDocument=globalThis.document,previousFetch=globalThis.fetch;
 globalThis.document={createElement:tag=>new Node(tag)};
 globalThis.fetch=async uri=>{
  const u=new URL(String(uri),'https://example.test');const parent=u.searchParams.get('parent_id'),offset=Number(u.searchParams.get('offset')||0);
  const items=parent==='last'?[{id:'inner',name:'子目录',parent_id:'last'}]:offset===0
   ?Array.from({length:100},(_,i)=>({id:`sibling-${i}`,name:`sibling-${i}`,parent_id:null}))
   :[{id:'last',name:'末页目录',parent_id:null}];
  return new Response(JSON.stringify({success:true,data:{items,has_more:!parent&&offset===0}}),{headers:{'Content-Type':'application/json'}});
 };
 t.after(()=>{globalThis.document=previousDocument;globalThis.fetch=previousFetch});
 const host=new Node('aside'),tree=mountFolderTree(host,{spaceId:'personal-space',spaceName:'个人空间',onNavigate:()=>{}});
 await tree.expandPath([{id:'last',parent_id:null,name:'末页目录'},{id:'inner',parent_id:'last',name:'子目录'}]);
 assert.ok(host.find(n=>n.className?.includes('cd-tree-name')&&n.textContent==='末页目录'));
 assert.ok(host.find(n=>n.className?.includes('cd-tree-name')&&n.textContent==='子目录'));
 tree.dispose();
});
