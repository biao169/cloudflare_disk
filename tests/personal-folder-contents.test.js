import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSpaceContents,renderSpaces} from '../public/js/modules/spaces.js';
import {makeTestEnv,api,initialize} from './integration/support.js';

// Minimal DOM adapter: drive the actual /personal renderer through authenticated
// Worker API responses without depending on a browser or third-party DOM package.
class Node {
 constructor(tag){this.tagName=tag;this.children=[];this._text='';this.className='';this.attributes={};this.style={};this.listeners={};this.classList={add(){},toggle(){},remove(){}};}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(x=>x.textContent??'').join('');}
 append(...children){this.children.push(...children);}
 prepend(...children){this.children.unshift(...children);}
 replaceChildren(...children){this._text='';this.children=[...children];}
 setAttribute(key,value){this.attributes[key]=String(value);}
 addEventListener(key,callback){this.listeners[key]=callback;}
 remove(){}
 find(predicate){if(predicate(this))return this;for(const child of this.children){const match=child.find?.(predicate);if(match)return match;}return null;}
 findAll(predicate){return [...(predicate(this)?[this]:[]),...this.children.flatMap(n=>n.findAll?.(predicate)||[])];}
}
const uuid=()=>crypto.randomUUID();
const findButton=(host,text)=>host.find(node=>node.tagName==='button'&&node.textContent.includes(text));
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('UI did not reach expected state');}

async function newFolder(env,session,parentId,name){const r=await api(env,'/api/v1/folders',{method:'POST',cookie:session.cookie,body:{space_id:session.spaceId,parent_id:parentId,name}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;}
async function upload(env,session,parentId,name,content,mime='text/plain'){const q=new URLSearchParams({space_id:session.spaceId,name});if(parentId)q.set('folder_id',parentId);
 const r=await api(env,`/api/v1/storage/upload?${q}`,{method:'POST',cookie:session.cookie,body:new TextEncoder().encode(content),headers:{'Content-Type':mime}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.data.id;
}

test('personal directory response normalizes BOTH file and folder records',()=>{
 const files=[{id:'a',name:'file.txt'}],folders=[{id:'b',name:'dir'}];
 assert.deepEqual(normalizeSpaceContents({files,folders,has_more:true}),{files,folders,hasMore:true});
 assert.deepEqual(normalizeSpaceContents({files,folders:[],has_more:false}).files,files);
 assert.deepEqual(normalizeSpaceContents({files:[],folders:[],has_more:false}),{files:[],folders:[],hasMore:false});
});

test('/personal renders nested ready files, preview/download affordances, breadcrumbs and more pages',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const session=await initialize(env);
 const dir=await newFolder(env,session,null,'我的资料'),nested=await newFolder(env,session,dir,'课程');
 const rootFile=await upload(env,session,null,'根目录文件.txt','root file content');
 const inFolder=await upload(env,session,dir,'目录中文件.txt','text in a folder');
 await upload(env,session,dir,'图纸.pdf','%PDF-1.7\n1 0 obj\n','application/pdf');
 const nestedFile=await upload(env,session,nested,'讲义.txt','text in nested folder');
 // Insert 54 additional real SQL rows to ensure "加载更多" does not hide files >50.
 const object=env.DB.native.prepare("INSERT INTO storage_objects (id,bucket_type,object_key,size_bytes,status) VALUES (?,'private',?,4,'ready')");
 const file=env.DB.native.prepare("INSERT INTO files (id,space_id,folder_id,name,object_id,size_bytes,mime_type,status) VALUES (?,?,?,?,?,4,'text/plain','ready')");
 for(let i=0;i<54;i++){const o=uuid();object.run(o,`test/${o}`);file.run(uuid(),session.spaceId,dir,`extra-${String(i).padStart(2,'0')}.txt`,o);}
 const originalDocument=globalThis.document,originalFetch=globalThis.fetch;
 globalThis.document={createElement:tag=>new Node(tag)};
 globalThis.fetch=async(url,opts={})=>(await api(env,String(url),{method:opts.method||'GET',cookie:session.cookie,body:opts.body})).response;
 t.after(()=>{globalThis.document=originalDocument;globalThis.fetch=originalFetch;});
 const host=new Node('main');await renderSpaces(host,true);
 assert.ok(host.textContent.includes('我的资料'));
 assert.ok(host.textContent.includes('根目录文件.txt'),'root-level files must also be visible');
 assert.ok(!host.textContent.includes('目录中文件.txt'),'nested content must not leak into root listing');
 findButton(host,'📁 我的资料').onclick();
 await until(()=>host.textContent.includes('extra-00.txt'));
 assert.ok(host.textContent.includes('extra-49.txt'));
 assert.ok(!host.textContent.includes('extra-53.txt'),'only first page is loaded');
 assert.ok(host.textContent.includes('文件和文件夹'));
 assert.ok(!host.textContent.includes('当前目录暂无文件或文件夹'),'files-only pages must not be reported empty');
 assert.ok(findButton(host,'加载更多文件和文件夹'));
 findButton(host,'加载更多文件和文件夹').onclick();
 await until(()=>host.textContent.includes('extra-53.txt')&&host.textContent.includes('目录中文件.txt'));
 const downloads=host.findAll(node=>node.tagName==='a'&&node.textContent==='下载');
 assert.ok(downloads.some(node=>node.href===`/api/v1/files/${inFolder}/content`));
 assert.ok(host.textContent.includes('56 个文件'));
 assert.ok(host.textContent.includes('图纸.pdf'));
 assert.ok(findButton(host,'预览'),'supported files should offer preview');
 findButton(host,'📁 课程').onclick();
 await until(()=>host.textContent.includes('讲义.txt'));
 assert.ok(!host.textContent.includes('当前目录暂无文件或文件夹'),'a files-only directory is not empty');
 assert.ok(host.findAll(node=>node.tagName==='a'&&node.href===`/api/v1/files/${nestedFile}/content`).length);
 findButton(host,'根目录').onclick();
 await until(()=>!host.textContent.includes('讲义.txt')&&host.textContent.includes('📁 我的资料'));
 assert.ok(host.findAll(node=>node.tagName==='a'&&node.href===`/api/v1/files/${rootFile}/content`).length);
});

test('personal contents endpoint enforces isolation and lists files alongside folders',async t=>{
 const env=makeTestEnv();t.after(()=>env.DB.close());const owner=await initialize(env);
 const folder=await newFolder(env,owner,null,'带文件的文件夹');await upload(env,owner,folder,'不能误报为空.txt','hello');
 const result=await api(env,`/api/v1/spaces/${owner.spaceId}/contents?parent_id=${folder}`,{cookie:owner.cookie});
 assert.equal(result.status,200);assert.equal(result.data.data.files.length,1);assert.equal(result.data.data.folders.length,0);
 const user=await api(env,'/api/v1/users',{method:'POST',cookie:owner.cookie,body:{username:'otherperson01',password:'safe-password-123456'}});assert.equal(user.status,201);
 const login=await api(env,'/api/v1/auth/login',{method:'POST',body:{username:'otherperson01',password:'safe-password-123456'}});const outsiderCookie=login.response.headers.get('set-cookie').split(';')[0];
 assert.equal((await api(env,`/api/v1/spaces/${owner.spaceId}/contents?parent_id=${folder}`,{cookie:outsiderCookie})).status,404);
});
