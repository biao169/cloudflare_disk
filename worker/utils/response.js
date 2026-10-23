export function json(data,status=200,extra={}) {
 return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});
}
export function ok(data,status=200){return json({success:true,data},status);}
export function error(code,message,status=500){return json({success:false,error:{code,message}},status);}
