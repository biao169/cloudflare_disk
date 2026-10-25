// RC8: Recover new share links without placing plaintext bearer tokens in D1.
// The optional SHARE_LINK_KEY is a stable 32-byte hex secret stored ONLY in
// Cloudflare Worker runtime Secrets, never in wrangler.jsonc or the repository.
const enc=new TextEncoder(),dec=new TextDecoder();
function fromHex(s){return Uint8Array.from(s.match(/.{2}/g),v=>parseInt(v,16));}
function encode64(arr){return btoa(String.fromCharCode(...arr)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decode64(s){if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error('Bad cipher');const binary=atob(s.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(binary,ch=>ch.charCodeAt(0));}
export function linkKeyStatus(env){return !env?.SHARE_LINK_KEY?'not_configured':/^[a-fA-F0-9]{64}$/.test(env.SHARE_LINK_KEY)?'ready':'invalid';}
async function secretKey(env){if(linkKeyStatus(env)!=='ready')throw Error('SHARE_LINK_KEY unavailable or invalid');return crypto.subtle.importKey('raw',fromHex(env.SHARE_LINK_KEY),{name:'AES-GCM'},false,['encrypt','decrypt']);}
const aad=id=>enc.encode(`CloudDrive:share-link:v1:${id}`);
export async function encryptShareCode(env,id,code){
 if(linkKeyStatus(env)==='not_configured')return null;
 const key=await secretKey(env),iv=crypto.getRandomValues(new Uint8Array(12));
 const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id)},key,enc.encode(code)));
 const packed=new Uint8Array(iv.length+ciphertext.length);packed.set(iv);packed.set(ciphertext,iv.length);
 return `v1.${encode64(packed)}`;
}
export async function decryptShareCode(env,id,packed){
 if(!packed)return null;
 if(!packed.startsWith('v1.'))throw Error('Unsupported share cipher');
 const bytes=decode64(packed.slice(3));if(bytes.length<28)throw Error('Invalid share cipher');
 const key=await secretKey(env),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:aad(id)},key,bytes.slice(12));
 return dec.decode(plain);
}
export function sharePath(origin,type,code){return `${origin}/${type==='page'?'s':'t'}/${code}`;}
