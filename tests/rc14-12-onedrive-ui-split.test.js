import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const read=(path)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

class FakeElement {
 constructor(tag='div') {this.tag=tag;this.children=[];this.listeners={};this.disabled=false;this.hidden=false;this.parent=null;this.textContent='';this.value='';}
 append(...nodes){for(const child of nodes){this.children.push(child);if(child&&typeof child==='object')child.parent=this;}}
 appendChild(child){this.append(child);return child;}
 replaceChildren(...children){this.children=[];this.append(...children);}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(item=>item!==this);this.parent=null;}}
 after(child){if(this.parent){const i=this.parent.children.indexOf(this);this.parent.children.splice(i+1,0,child);child.parent=this.parent;}}
 addEventListener(name,cb){this.listeners[name]=cb;}
 setAttribute(){}
 querySelector(selector){return selector==='button[type="submit"]'?this.submit:null;}
}

async function toolScenario({authenticated=false,anonymous=true,disabled=false}={}){
 const main=new FakeElement('main'),form=new FakeElement('form'),out=new FakeElement('section'),urlInput=new FakeElement('textarea'),submit=new FakeElement('button');
 form.submit=submit;urlInput.value='https://1drv.ms/t/c/45ed996b079ab860/IQAeA-nNpMauRrmN5IV1xpzKAXimIbqgCf7nDAH0HGlZzVk?e=Cbjrip';
 main.append(form,out);
 const requests=[];
 const fetch=async(uri,opts={})=>{
  requests.push({uri,method:opts.method||'GET'});
  if(uri.endsWith('/status'))return {ok:!disabled,status:disabled?(anonymous?403:401):200,async json(){return disabled?{success:false,error:{message:anonymous?'工具已关闭':'请先登录'}}:{success:true,data:{enabled:true,authenticated,anonymous_enabled:anonymous}};}};
  if(uri.endsWith('/links'))return {ok:true,status:200,async json(){return {success:true,data:{links:[]}};}};
  if(uri.endsWith('/resolve'))return {ok:true,status:200,async json(){return {success:true,data:{link_kind:'personal',message:'已识别',share_token:'u!example'}};}};
  throw Error('Unexpected call '+uri);
 };
 const document={getElementById:id=>({'od-form':form,'od-result':out,'od-url':urlInput})[id],querySelector:selector=>selector==='main'?main:null,createElement:tag=>new FakeElement(tag),createTextNode:text=>String(text)};
 const context={document,fetch,location:{origin:'https://disk.example.test'},navigator:{clipboard:{writeText:()=>{}}},confirm:()=>true};
 runInNewContext(read('public/js/onedrive-tool.js'),context);
 // Let the initial async status + subsequent list call complete.
 await new Promise(resolve=>setTimeout(resolve,10));
 return {main,form,out,submit,requests};
}

test('anonymous tool renders only the upper format parser, never extra controls',async()=>{
 const app=await toolScenario();
 assert.equal(app.submit.disabled,false);
 assert.equal(app.main.children.length,2,'guest cannot see buttons below parser');
 assert.equal(app.requests.some(r=>r.uri.includes('/links')||r.uri.includes('/oauth')||r.uri.includes('/public-check')),false);
 await app.form.listeners.submit({preventDefault(){}});
 assert.ok(app.out.children.length>0,'guest may parse a public OneDrive URL');
 assert.equal(app.main.children.length,2,'a successful parse must not reveal account controls');
});

test('disabled anonymous tool has no management controls and cannot submit',async()=>{
 const app=await toolScenario({anonymous:false,disabled:true});
 assert.equal(app.submit.disabled,true);
 assert.equal(app.main.children.length,2);
 assert.equal(app.requests.some(r=>r.uri.includes('/links')),false);
});

test('authenticated users may manage fixed links but cannot manage Microsoft OAuth from the public tool',async()=>{
 const app=await toolScenario({authenticated:true});
 assert.equal(app.submit.disabled,false);
 assert.equal(app.main.children.length,3);
 assert.equal(app.main.children[2].id,'onedrive-authenticated-controls');
 assert.ok(app.requests.some(r=>r.uri.endsWith('/links')));
 assert.equal(app.requests.some(r=>r.uri.includes('/admin/onedrive/oauth')),false);
});

test('OneDrive configuration has its own settings tab, and account settings are not in site form',()=>{
 const admin=read('public/js/modules/admin.js');
 assert.match(admin,/\['onedrive','OneDrive 配置'\]/);
 assert.match(admin,/addOneDriveSettings\(slots\.onedrive\)/);
 assert.match(admin,/addOneDriveToolSettings\(slots\.onedrive/);
 assert.doesNotMatch(admin,/addOneDriveSettings\(slots\.settings\)/);
 const site=admin.slice(admin.indexOf('function addSettingsTab('),admin.indexOf('function addOneDriveToolSettings('));
 assert.ok(!site.includes('onedrive_tool_enabled'));
 assert.ok(!site.includes('onedrive_anonymous_enabled'));
 assert.ok(!site.includes('onedrive_guest_minute_limit'));
 assert.match(read('public/js/modules/onedrive-browser.js'),/settings\.href='\/settings\?tab=onedrive'/);
 assert.match(read('public/js/main.js'),/target\.pathname\+target\.search/);
});

test('OAuth callback now navigates to the dedicated OneDrive configuration tab',()=>{
 const admin=read('worker/api/admin.js');
 assert.match(admin,/Location:'\/settings\?tab=onedrive&connected=1'/);
 assert.match(admin,/Location:'\/settings\?'\+p\.toString\(\)/);
 const adminUI=read('public/js/modules/admin.js');
 assert.match(adminUI,/let initializing=true/,'initial tab activation must preserve OAuth feedback query parameters');
});
