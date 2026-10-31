// RC14.10: explicit, three-step share wizard. No implicit exposure or silent folder sync.
import {requestJSON} from '../api.js';
const api='/api/v1/admin/onedrive';
const el=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const button=(text,handler,cls='btn btn-sm btn-outline-secondary')=>{const x=el('button',cls,text);x.type='button';x.addEventListener('click',handler);return x;};
const abs=x=>new URL(x,location.origin).href;
export function availableShareModes(items){if(!items?.length)return [];
 const modes=[];if(items.every(x=>!x.folder)&&items.length<=25)modes.push('individual');
 if(items.length===1&&items[0].folder)modes.push('folder');
 if(items.length<=30)modes.push('collection');
 return modes;
}
export function defaultShareMode(items){const modes=availableShareModes(items);return items.length>1&&modes.includes('collection')?'collection':modes[0]||null;}
function formField(parent,label,value,multiline=false,max=140){const wrap=el('div','od-edit-field');const l=el('label','form-label small fw-semibold',label);const input=el(multiline?'textarea':'input','form-control form-control-sm');input.maxLength=max;input.value=value||'';if(multiline)input.rows=3;l.htmlFor=input.id='od-wizard-'+crypto.randomUUID();wrap.append(l,input);parent.append(wrap);return input;}
export function openShareWizard(host,items,{onComplete=()=>{}}={}){
 const selection=[...items];const modes=availableShareModes(selection);if(!modes.length)return;
 const dialog=el('dialog','od-editor od-wizard');const body=el('div','od-editor-form');dialog.append(body);host.append(dialog);
 const title=el('h2','h5 mb-0','创建 OneDrive 分享');const close=button('关闭',()=>dialog.close());const header=el('div','d-flex align-items-center justify-content-between gap-2');header.append(title,close);body.append(header);
 const stepStatus=el('p','small text-secondary m-0');body.append(stepStatus);
 const section=el('div','od-wizard-body');body.append(section);
 const feedback=el('div','small text-secondary');feedback.setAttribute('role','status');body.append(feedback);
 const actions=el('div','d-flex justify-content-end gap-2 flex-wrap');const prev=button('上一步',()=>{saveInputs();if(step>0){step--;draw();}});const next=button('下一步',()=>{saveInputs();if(step===0&&mode==='folder'&&!(selection.length===1&&selection[0].folder)){feedback.textContent='文件夹分享只能选择一个文件夹。';return;}if(step===1){if(mode!=='individual'&&(!nameInput.value.trim()||nameInput.value.length>140)){feedback.textContent='请输入 1–140 字的分享标题。';return;}if(descriptionInput.value.length>1200){feedback.textContent='介绍不能超过 1200 字。';return;}}step=Math.min(step+1,2);draw();},'btn btn-sm btn-primary');
 const submit=button('确认公开并发布',()=>void publish(),'btn btn-sm btn-primary');actions.append(prev,next,submit);body.append(actions);
 const wizardId=crypto.randomUUID();let mode=defaultShareMode(selection),step=0,nameInput=null,descriptionInput=null,confirmation=null;
 let storedTitle=selection.length===1?selection[0].name:`OneDrive 文件合集（${selection.length} 项）`,storedDesc='';
 function saveInputs(){if(nameInput)storedTitle=nameInput.value;if(descriptionInput)storedDesc=descriptionInput.value;}
 function draw(){feedback.textContent='';section.replaceChildren();stepStatus.textContent=`第 ${step+1} / 3 步 · ${['选择分享形式','编辑分享内容','确认发布'][step]}`;
  prev.hidden=step===0;next.hidden=step===2;submit.hidden=step!==2;
  if(step===0){section.append(el('p','small text-secondary','本次选择：'+selection.map(x=>x.name).join('、')));
   const opts=[['individual','分别发布为多个文件直链（最多25个）'],['folder','单个文件夹的目录快照'],['collection','将选中的文件和文件夹合并为合集']];
   for(const [value,label] of opts){if(!modes.includes(value))continue;const row=el('label','d-flex gap-2 align-items-center py-2');const radio=el('input','form-check-input');radio.type='radio';radio.name='od-share-mode-'+wizardId;radio.value=value;radio.checked=mode===value;radio.addEventListener('change',()=>{mode=value;});row.append(radio,el('span','small',label));section.append(row);}
   section.append(el('p','small text-secondary','文件夹和合集只发布创建时读取的静态文件清单。以后 OneDrive 新增文件不会自动公开。每个快照最多 180 项、最多 8 层。'));
  }else if(step===1){if(mode!=='individual'){nameInput=formField(section,'分享标题',storedTitle,false,140);descriptionInput=formField(section,'简介（可选）',storedDesc,true,1200);}else section.append(el('p','small','每个文件单独生成 /s/odf_* 分享页面和 /r/odf_* 下载直链。'));
   section.append(el('p','small text-secondary','本阶段为静态快照；自动同步由后续版本提供。重要文件建议在发布前确认授权范围和目录内容。'));
  }else{
   section.append(el('p','fw-semibold',mode==='folder'?'文件夹分享':mode==='collection'?'文件合集分享':'批量发布独立文件'));
   if(mode!=='individual')section.append(el('p','small',storedTitle));
   section.append(el('p','small text-secondary',`${selection.length} 个选中来源。公开后，任何持有链接者都可通过管理员授权获取文件，即使原始 OneDrive 文件并非公共共享。`));
   const wrap=el('label','d-flex gap-2 align-items-start');confirmation=el('input','form-check-input mt-1');confirmation.type='checkbox';wrap.append(confirmation,el('span','small fw-semibold','我确认所选内容可以公开分享，并理解该行为会授予链接持有者下载权限。'));section.append(wrap);
  }
 }
 async function publish(){if(!confirmation?.checked){feedback.textContent='请先勾选确认公开分享。';return;}
  submit.disabled=true;feedback.textContent=mode==='individual'?'正在逐项发布（失败不会取消已成功的项目）…':'正在验证文件夹内容并建立静态快照…';
  try{const result=mode==='individual'
    ?await requestJSON(`${api}/drive/batch-publish`,{method:'POST',body:{confirm_public:true,item_ids:selection.map(x=>x.id)}})
    :await requestJSON(`${api}/groups`,{method:'POST',body:{confirm_public:true,kind:mode,item_ids:selection.map(x=>x.id),title:storedTitle.trim(),description:storedDesc,sync_mode:'snapshot'}});
   if(!host.isConnected)return;section.replaceChildren();stepStatus.textContent='分享结果';prev.hidden=next.hidden=submit.hidden=true;
   if(mode==='individual'){
    section.append(el('p','fw-semibold',`成功 ${result.succeeded} / ${result.total} 项；失败 ${result.failed} 项`));
    for(const r of result.results){
     const row=el('div','od-batch-result');row.append(el('span','small',selection.find(x=>x.id===r.item_id)?.name||r.item_id));
     if(r.success){
      const preview=el('a','btn btn-sm btn-outline-primary','分享页面');preview.href=abs(r.share_url);preview.target='_blank';preview.rel='noopener noreferrer';
      const download=el('a','btn btn-sm btn-outline-secondary','下载直链');download.href=abs(r.url);download.target='_blank';download.rel='noopener noreferrer';
      const copy=button('复制链接',async()=>{try{await navigator.clipboard.writeText(abs(r.share_url));feedback.textContent='分享链接已复制。';}catch{feedback.textContent='复制失败，请检查浏览器剪贴板权限。';}});
      row.append(preview,download,copy);
     }else row.append(el('span','small text-danger',r.error||'发布失败'));
     section.append(row);
    }
   }else{section.append(el('p','fw-semibold',`${result.title} · ${result.item_count} 个文件`));const a=el('a','btn btn-sm btn-primary','查看目录分享页面');a.href=abs(result.share_url);a.target='_blank';a.rel='noopener noreferrer';section.append(a);}
   feedback.textContent='发布完成。撤销可在“文件夹与合集分享”或“已发布直链”中操作。';onComplete(result,mode);
  }catch(e){feedback.textContent=e?.message||'分享失败，请稍后重试。';}finally{submit.disabled=false;}
 }
 dialog.addEventListener('close',()=>dialog.remove(),{once:true});draw();dialog.showModal();
}
export function openGroupEditor(host,group,{onSaved=()=>{}}={}){
 const dialog=el('dialog','od-editor');const form=el('div','od-editor-form');dialog.append(form);form.append(el('h2','h5','编辑文件夹 / 合集分享'));
 const title=formField(form,'标题',group.title,false,140);const desc=formField(form,'简介',group.description,true,1200);const feedback=el('div','small text-secondary');form.append(feedback);
 const actions=el('div','d-flex justify-content-end gap-2');actions.append(button('取消',()=>dialog.close()),button('保存',async()=>{try{await requestJSON(`${api}/groups/${group.id}`,{method:'PATCH',body:{title:title.value,description:desc.value}});dialog.close();onSaved();}catch(e){feedback.textContent=e.message||'保存失败';}},'btn btn-sm btn-primary'));form.append(actions);host.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
}
