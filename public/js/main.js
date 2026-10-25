import {renderAdmin} from './modules/admin.js';
import {renderTrash} from './modules/trash.js';
import {renderShares} from './modules/shares.js';
import {renderFileManager} from './modules/file-manager.js';
import {renderSpaces} from './modules/spaces.js';
import {renderUsers} from './modules/users.js';
import {requestJSON} from './api.js';
import { renderFiles, renderPlaceholder } from './modules/dashboard.js';
import { notify } from './components/toast.js';
const known = new Set(['files','personal','spaces','recent','shares','trash','users','settings']);
const titles = {files:'全部文件',personal:'个人空间',spaces:'共享空间',recent:'最近文件',shares:'我的分享',trash:'回收站',users:'成员管理',settings:'系统设置'};
const host = document.getElementById('app-content');
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('mobile-backdrop');
function closeMenu() {sidebar.classList.remove('open');backdrop.hidden=true;}
function page() {const key=location.pathname.split('/')[1]||'files';return known.has(key)?key:'files';}
function render() {
 host.dataset.fileView='';
 const key=page();document.title=`${titles[key]} · CloudDrive`;document.getElementById('topbar-title').textContent=titles[key];
 document.querySelectorAll('#app-nav [data-route], .app-nav [data-route]').forEach(a=>{const active=a.dataset.route===key;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
 if(key==='personal'||key==='spaces')renderSpaces(host,key==='personal');else if(['files','recent'].includes(key))renderFileManager(host,key);else if(key==='users')renderUsers(host);else if(key==='shares')renderShares(host);else if(key==='trash')renderTrash(host);else if(key==='settings')renderAdmin(host);else renderPlaceholder(host,key);
 closeMenu();
}
document.addEventListener('click',e=>{const a=e.target.closest('a[data-route]');if(!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)return;e.preventDefault();const target=new URL(a.href,location.href);if(target.origin!==location.origin)return;history.pushState({},'',target.pathname);render();});
window.addEventListener('popstate',render);
document.getElementById('menu-button').addEventListener('click',()=>{sidebar.classList.toggle('open');backdrop.hidden=!sidebar.classList.contains('open')});
backdrop.addEventListener('click',closeMenu);
document.getElementById('theme-button').addEventListener('click',()=>{const root=document.documentElement;const next=root.getAttribute('data-bs-theme')==='light'?'dark':'light';root.setAttribute('data-bs-theme',next);localStorage.setItem('clouddrive-theme',next);});
try {const theme=localStorage.getItem('clouddrive-theme');if(['dark','light'].includes(theme))document.documentElement.setAttribute('data-bs-theme',theme);}catch{}
render();

// Stage 3: protect initial UI rendering from unauthenticated users and show account actions.
(async()=>{try{const {user}=await requestJSON('/api/v1/auth/me');const avatar=document.querySelector('.avatar');avatar.textContent=user.username[0].toUpperCase();avatar.title=`${user.username} (${user.role})`;const bar=document.querySelector('.topbar .d-flex.gap-2.align-items-center');const btn=document.createElement('button');btn.className='btn btn-sm btn-outline-secondary';btn.textContent='退出';btn.addEventListener('click',async()=>{await requestJSON('/api/v1/auth/logout',{method:'POST'});location.replace('/login')});bar.appendChild(btn);document.getElementById('secure-shell').style.visibility='visible';if(user.role!=='super_admin')document.querySelector('[data-route="users"]')?.classList.add('d-none');}catch{location.replace('/login')}})();
