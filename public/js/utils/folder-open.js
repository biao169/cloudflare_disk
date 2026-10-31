// Shared folder affordance for R2, OneDrive and public folder-share views.
// Never treat a double-click on action buttons, links, checkboxes or editor fields as navigation.
export function bindFolderDoubleClick(container, open, {enabled=true}={}) {
 if(!enabled)return container;
 container.classList?.add('cd-folder-dblclick');
 container.title = container.title || '双击空白处打开文件夹';
 container.addEventListener('dblclick', event=>{
  if(event.button!==0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)return;
  if(event.target?.closest?.('button, a, input, select, textarea, label, [contenteditable="true"], .cd-file-actions, .od-actions, .odg-actions'))return;
  event.preventDefault();
  open();
 });
 return container;
}
