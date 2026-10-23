export function parsePage(params){
 const limit=Number(params.get('limit')??50),offset=Number(params.get('offset')??0);
 if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0) return null;
 return {limit,offset};
}
export function isId(value){return typeof value==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);}
