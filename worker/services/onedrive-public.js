import {parseOneDriveUrl} from './onedrive.js';
import {validMicrosoftDownloadUrl} from './onedrive-oauth.js';

// No admin tokens, cookies or browser credentials are sent. This optional
// compatibility endpoint is not guaranteed by the Microsoft Graph contract;
// absence of an independently verified redirect MUST fail closed.
export async function resolveAnonymousDownload(source,fetcher=fetch){
 const parsed=parseOneDriveUrl(source);
 const endpoint=`https://api.onedrive.com/v1.0/shares/${encodeURIComponent(parsed.share_token)}/root/content`;
 let r;
 try{r=await fetcher(endpoint,{method:'GET',redirect:'manual',headers:{Accept:'application/octet-stream'},signal:AbortSignal.timeout(9000)});}
 catch{return {verified:false,reason:'PUBLIC_PROBE_UNAVAILABLE'};}
 if(r.status===429||r.status===503)return {verified:false,reason:'MICROSOFT_THROTTLED',retry_after:r.headers.get('Retry-After')||null};
 if(![301,302,303,307,308].includes(r.status))return {verified:false,reason:'ANONYMOUS_DOWNLOAD_NOT_CONFIRMED'};
 const location=r.headers.get('Location');
 // Block login pages, private networks, redirected Graph resources and any
 // unexpected target. Do not make a second network request to that URL.
 if(!validMicrosoftDownloadUrl(location))return {verified:false,reason:'UNTRUSTED_DOWNLOAD_REDIRECT'};
 return {verified:true,location};
}
