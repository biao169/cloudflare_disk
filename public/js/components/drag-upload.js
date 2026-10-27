// RC12: browser-side file/folder drag extraction. No server path is trusted.
const LIMIT=500,DEPTH=12;
export function safeUploadPath(path){
 if(typeof path!=='string')return false;
 const p=path.replaceAll('\\','/');const parts=p.split('/');
 return parts.length<=DEPTH+1&&parts.every(s=>s.length>0&&s.length<=100&&!['.','..'].includes(s)&&!/[\x00-\x1f]/.test(s));
}
async function entryFile(entry){return new Promise((resolve,reject)=>entry.file(resolve,reject));}
async function entriesOf(reader){const out=[];while(true){const chunk=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!chunk.length)break;out.push(...chunk);if(out.length>LIMIT)throw Error('每次最多上传 500 个文件');}return out;}
export async function filesFromDrop(transfer){
 const output=[];
 async function walk(entry,trail,depth){
  if(depth>DEPTH)throw Error('文件夹层级过深，最多支持 12 层');
  if(entry.isFile){const file=await entryFile(entry),path=[...trail,file.name].join('/');if(!safeUploadPath(path))throw Error(`非法文件路径：${path}`);output.push({file,path});if(output.length>LIMIT)throw Error('每次最多上传 500 个文件');return}
  if(entry.isDirectory){const prefix=[...trail,entry.name];if(!safeUploadPath(prefix.join('/')))throw Error('文件夹名称无效');
   // Preserve empty directories and intentional directory structure.
   output.push({kind:'folder',path:prefix.join('/')});if(output.length>LIMIT*2)throw Error('文件夹项目过多，请分批上传');
   const list=await entriesOf(entry.createReader());for(const next of list)await walk(next,prefix,depth+1);}
 }
 const entries=[...(transfer.items||[])].filter(i=>i.kind==='file').map(i=>i.webkitGetAsEntry?.()).filter(Boolean);
 if(entries.length){for(const entry of entries)await walk(entry,[],0)}
 else for(const file of transfer.files||[]){const path=file.webkitRelativePath||file.name;if(!safeUploadPath(path))throw Error(`非法文件路径：${path}`);output.push({file,path});if(output.length>LIMIT)throw Error('每次最多上传 500 个文件')}
 return output;
}
/** Works on Chrome/Edge and gracefully falls back to flat files. */
export function enableDragUpload(host,onFiles,onError){
 let depth=0,disposed=false;
 const zone=document.createElement('div');zone.className='cd-drop-overlay';zone.textContent='拖拽文件或文件夹到此处上传';zone.hidden=true;host.append(zone);
 const accepts=e=>[...(e.dataTransfer?.types||[])].includes('Files');
 function enter(e){if(!accepts(e))return;e.preventDefault();depth++;zone.hidden=false;}
 function over(e){if(!accepts(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';zone.hidden=false}
 function leave(e){if(!accepts(e))return;e.preventDefault();depth=Math.max(0,depth-1);if(!depth)zone.hidden=true}
 async function drop(e){if(!accepts(e))return;e.preventDefault();depth=0;zone.hidden=true;try{const files=await filesFromDrop(e.dataTransfer);if(files.length&&!disposed)await onFiles(files)}catch(err){if(!disposed)onError?.(err)}}
 host.addEventListener('dragenter',enter);host.addEventListener('dragover',over);host.addEventListener('dragleave',leave);host.addEventListener('drop',drop);
 return ()=>{disposed=true;host.removeEventListener('dragenter',enter);host.removeEventListener('dragover',over);host.removeEventListener('dragleave',leave);host.removeEventListener('drop',drop);zone.remove()};
}
