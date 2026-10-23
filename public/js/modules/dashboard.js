import { notify } from '../components/toast.js';
const sample = [
  { name:'项目方案.pdf',type:'PDF 文档',size:'2.4 MB',updated:'今天 10:24',symbol:'▤' },
  { name:'介绍视频.mp4',type:'视频',size:'48.7 MB',updated:'昨天 16:32',symbol:'▶' },
  { name:'封面图片.png',type:'图片',size:'1.2 MB',updated:'10月19日',symbol:'▧' },
  { name:'资料归档.zip',type:'压缩包',size:'16.1 MB',updated:'10月17日',symbol:'▣' }
];
const esc = str => String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const card = (label,number,sub) => `<div class="col-6 col-xl-3"><div class="panel stat-card"><div class="label">${label}</div><div class="value">${number}</div><div class="tiny text-secondary">${sub}</div></div></div>`;
export function renderFiles(host, mode='files') {
 const label = ({files:'全部文件',personal:'个人空间',spaces:'共享空间',recent:'最近文件'})[mode] ?? '全部文件';
 host.innerHTML = `<section class="section-head"><div><h1 class="h3 fw-bold mb-2">${label}</h1><p class="muted-heading mb-0">文件集中管理、团队共享与安全链接 · 第一阶段界面预览</p></div><button class="btn btn-primary" data-demo="上传文件">＋ 上传文件</button></section>
 <div class="row g-3 mb-4">${card('总文件数','128','演示数据')}${card('文件夹','12','演示数据')}${card('共享链接','8','演示数据')}${card('占用空间','3.2 GB','演示数据')}</div>
 <div class="d-flex justify-content-between align-items-center mt-4 mb-3"><h2 class="h6 fw-bold mb-0">常用文件夹</h2><button class="btn btn-sm btn-outline-secondary" data-demo="新建文件夹">＋ 新建文件夹</button></div>
 <div class="row g-3 mb-4">${['设计素材','项目资料','团队文档'].map(n=>`<div class="col-12 col-md-6 col-xl-4"><div class="folder-tile"><span class="folder-icon">▰</span><div><div class="fw-semibold">${n}</div><div class="small text-secondary">示例文件夹</div></div></div></div>`).join('')}</div>
 <div class="panel overflow-hidden"><div class="p-3 d-flex justify-content-between align-items-center flex-wrap gap-2"><h2 class="h6 fw-bold mb-0">文件列表 <span class="badge text-bg-light">演示</span></h2><input id="file-filter" type="search" class="form-control form-control-sm" style="max-width:260px" placeholder="搜索演示文件" aria-label="搜索演示文件"></div><div class="table-responsive"><table class="table file-table"><thead><tr><th>文件名</th><th>类型</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead><tbody id="file-rows"></tbody></table></div></div>`;
 const tbody=host.querySelector('#file-rows');
 function draw(term='') {const items=sample.filter(f=>f.name.toLowerCase().includes(term.toLowerCase())); tbody.innerHTML = items.length?items.map(f=>`<tr><td><span class="file-symbol">${f.symbol}</span><span class="fw-medium">${esc(f.name)}</span></td><td>${esc(f.type)}</td><td>${esc(f.size)}</td><td>${esc(f.updated)}</td><td><button class="btn btn-sm btn-link text-decoration-none" data-demo="预览/分享">操作</button></td></tr>`).join(''):'<tr><td colspan="5" class="text-center text-secondary py-4">没有匹配的演示文件</td></tr>'}
 draw(); host.querySelector('#file-filter').addEventListener('input', e=>draw(e.target.value));
 host.querySelectorAll('[data-demo]').forEach(b=>b.addEventListener('click',()=>notify(`${b.dataset.demo}将在后续阶段实现，当前不操作真实文件。`)));
}
export function renderPlaceholder(host, key) {
 const meta={shares:['我的分享','管理公开直链、限时链接与密码分享','第 8 阶段'],trash:['回收站','恢复已删除文件、清理过期数据','第 9 阶段'],users:['成员管理','管理团队成员与共享权限','第 3 阶段'],settings:['系统设置','查看额度、站点与权限配置','第 9 阶段']};
 const [name,description,stage]=meta[key]??['模块建设中','正在准备此功能','后续阶段'];
 host.innerHTML=`<section class="section-head"><div><h1 class="h3 fw-bold">${name}</h1><p class="muted-heading">${description}</p></div></section><div class="panel empty-state"><div class="glyph mb-3">☁</div><h2 class="h5">此模块尚未启用</h2><p class="text-secondary">${stage}将实现完整功能。当前页面不连接数据库，不执行实际操作。</p><a href="/files" data-route="files" class="btn btn-outline-primary mt-2">返回文件管理</a></div>`;
}
