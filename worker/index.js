import {redirectOneDriveLink} from './services/onedrive-links.js';
import {temporaryLink,publicPublishedFile,smartPublishedFile} from './api/shares.js';
import {runMaintenance,recordIncident} from './services/operations.js';
import {protectHtml} from './services/security-headers.js';
import {route,json} from './router.js';
import {resolveUser} from './services/auth.js';

const APP_PAGES=new Set(['/','/index.html','/files','/personal','/spaces','/recent','/favorites','/search','/shares','/trash','/users','/settings']);
// Static Assets default HTML canonicalization redirects /login.html -> /login.
// Since /login is Worker-routed, that would become an infinite redirect loop.
// wrangler.jsonc sets assets.html_handling='none' to serve these explicit files.
async function assetPage(request,env,page){
 const req=new Request(new URL(page,request.url),request);
 const response=await env.ASSETS.fetch(req);
 // Fail visibly rather than following a canonicalization redirect forever if the
 // Wrangler setting is accidentally reverted during a future deployment.
 if(response.status>=300&&response.status<400){
  console.error('Unexpected HTML asset redirect',page,response.headers.get('Location'));
  return new Response('CloudDrive HTML routing configuration error (assets.html_handling must be none)',{
   status:500,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}
  });
 }
 return protectHtml(response);
}
export default {
 async scheduled(event,env,ctx){ctx.waitUntil(runMaintenance(env,{source:'cron'}));},
 async fetch(request,env){
  try{
   const url=new URL(request.url),p=url.pathname;
   const response=await route(request,env);if(response){
    if(response.status>=500&&p!=='/api/v1/health/ready')await recordIncident(env,{source:'api.response',code:`HTTP_${response.status}`});
    return response;
   }
   if(p.startsWith('/api/'))return json({success:false,error:{code:'NOT_FOUND',message:'接口不存在'}},404);
   if(p.startsWith('/t/')){const result=await temporaryLink(request,env,p);if(result.status>=500)await recordIncident(env,{source:'share.response',code:`HTTP_${result.status}`});return result;}
   if(p.startsWith('/p/')){const result=await publicPublishedFile(request,env,p);if(result.status>=500)await recordIncident(env,{source:'share.response',code:`HTTP_${result.status}`});return result;}
   if(/^\/r\/od_[a-f0-9]{32}$/.test(p))return redirectOneDriveLink(request,env,p.slice(3));
   if(p.startsWith('/r/')){const result=await smartPublishedFile(request,env,p);if(result.status>=500)await recordIncident(env,{source:'share.response',code:`HTTP_${result.status}`});return result;}
   if(p==='/tools/onedrive')return assetPage(request,env,'/onedrive.html');
   if(p.startsWith('/s/'))return assetPage(request,env,'/share.html');
   if(p==='/login'||p==='/setup')return assetPage(request,env,'/login.html');
   if(APP_PAGES.has(p)){
    const user=await resolveUser(request,env);
    if(!user)return Response.redirect(new URL('/login',url),302);
    return assetPage(request,env,'/index.html');
   }
   // Other static paths (Bootstrap, CSS and JavaScript) are served directly.
   return env.ASSETS.fetch(request);
  }catch(e){console.error('Unhandled request failure',e);await recordIncident(env,{source:'worker',code:'UNHANDLED_REQUEST'});return json({success:false,error:{code:'INTERNAL_ERROR',message:'服务器请求失败'}},500);}
 }
};
