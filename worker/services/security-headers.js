// Sensitive application HTML is served without shared caches or framing.
// Binary preview responses are NOT given frame-ancestors/X-Frame-Options,
// otherwise the in-app PDF iframe would stop working.
const HTML_CSP=[
 "default-src 'self'",
 "script-src 'self'",
 "style-src 'self' 'unsafe-inline'",
 "img-src 'self' data: blob:",
 "media-src 'self' blob:",
 "font-src 'self' data:",
 "connect-src 'self'",
 "frame-src 'self'",
 "object-src 'none'",
 "base-uri 'none'",
 "form-action 'self'",
 "frame-ancestors 'none'"
].join('; ');
export function protectHtml(response){
 const headers=new Headers(response.headers);
 headers.set('Content-Security-Policy',HTML_CSP);
 headers.set('Cache-Control','private, no-store');
 headers.set('Referrer-Policy','no-referrer');
 headers.set('X-Content-Type-Options','nosniff');
 headers.set('X-Frame-Options','DENY');
 headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
