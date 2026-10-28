// RC14.1: strictly offline parsing. No remote content requests and no privilege delegation.
const ONEDRIVE_HOSTS=new Set(['1drv.ms','onedrive.live.com']);
const CID_PATTERN=/^[0-9a-f]{16}$/i;
const PATH_PATTERN=/^\/(?:[a-z]\/c\/[0-9a-f]{16}\/[A-Za-z0-9_-]+|[a-z]\/s![A-Za-z0-9_-]+|[a-z]\/[^?#]+|(?:redir|download|view|embed)(?:\/[^?#]*)?)\/?$/i;
export function parseOneDriveUrl(value){
 if(typeof value!=='string'||value.length>4096||value.trim()!==value)throw new TypeError('INVALID_URL');
 let url;try{url=new URL(value);}catch{throw new TypeError('INVALID_URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!ONEDRIVE_HOSTS.has(url.hostname.toLowerCase()))throw new TypeError('INVALID_URL');
 const host=url.hostname.toLowerCase();
 if(host==='1drv.ms'){
  if(!PATH_PATTERN.test(url.pathname)||url.pathname.includes('..'))throw new TypeError('UNSUPPORTED_LINK');
 }else{
  if(!['/','/redir','/download','/view','/embed'].some(p=>url.pathname===p||url.pathname.startsWith(p+'/')) && !url.searchParams.has('id')&&!url.searchParams.has('resid'))throw new TypeError('UNSUPPORTED_LINK');
 }
 const segments=url.pathname.split('/').filter(Boolean);
 const isKnownCid=host==='1drv.ms'&&segments[1]==='c'&&CID_PATTERN.test(segments[2]||'');
 // Use the exact input for encoding: Microsoft sharing URL tokens are not path IDs.
 const bytes=new TextEncoder().encode(value);let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
 const shareToken='u!'+btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 return {provider:'onedrive',url:value,host,link_kind:isKnownCid?'personal_cid_share':'onedrive_share',type_hint:host==='1drv.ms'?segments[0]||null:null,account_cid:isKnownCid?segments[2].toLowerCase():null,share_token:shareToken,format_valid:true,content_checked:false,download_verified:false,expiration_known:false};
}
