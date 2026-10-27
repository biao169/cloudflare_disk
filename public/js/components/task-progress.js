// RC12: lightweight, accessible progress for sequential/batched operations.
const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
export function taskProgress(host){
 const box=el('section','card p-3 mb-3 cd-task-progress');box.hidden=true;
 const head=el('div','d-flex flex-wrap align-items-center gap-2');const title=el('strong','flex-grow-1');const count=el('span','small text-secondary');
 const stop=el('button','btn btn-outline-secondary btn-sm','停止后续任务');stop.type='button';head.append(title,count,stop);
 const progress=el('progress','w-100 mt-2');progress.max=100;progress.value=0;
 const status=el('div','small text-secondary mt-2');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const details=el('details','mt-2');const summary=el('summary','small','失败明细');const items=el('ul','small mt-2 mb-0');details.append(summary,items);details.hidden=true;
 box.append(head,progress,status,details);host.append(box);
 let aborted=false,total=0,done=0,passed=0,failed=0;
 function render(){progress.value=total?Math.min(100,Math.round(done/total*100)):100;count.textContent=`${done}/${total} 项`;status.textContent=`完成 ${passed} · 失败 ${failed} · ${progress.value}%`}
 stop.onclick=()=>{aborted=true;stop.disabled=true;status.textContent='当前操作结束后停止后续任务…'};
 return {
  start(name,length){aborted=false;total=length;done=passed=failed=0;box.hidden=false;title.textContent=name;stop.disabled=false;progress.value=0;items.replaceChildren();details.hidden=true;render()},
  item({success,name='',message=''}){done++;if(success)passed++;else{failed++;const li=el('li','',`${name||'未命名项目'}：${message||'操作失败'}`);items.append(li);details.hidden=false;}render()},
  itemProgress(bytes,length){if(total>0){const pct=length?Math.round(bytes/length*100):0;status.textContent=`${done}/${total} 项 · 当前文件上传 ${Math.max(0,Math.min(100,pct))}%`}},
  finish(){stop.disabled=true;render();status.textContent=`${aborted?'已停止后续操作':'任务结束'} · 成功 ${passed}，失败 ${failed}`;return {success:passed,failed,stopped:aborted}},
  get stopped(){return aborted},
  get processed(){return done},
  get failed(){return failed},
  hide(){box.hidden=true},
  element:box
 };
}
