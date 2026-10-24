import {requestJSON} from './api.js';

const form = document.getElementById('auth-form');
const notice = document.getElementById('message');
const subtitle = document.getElementById('subtitle');
const submit = document.getElementById('submit');
const bootstrapWrap = document.getElementById('bootstrap-wrap');
let setup = false;

function show(message) {
  notice.textContent = message;
  notice.classList.remove('d-none');
}
function clearNotice() {
  notice.textContent = '';
  notice.classList.add('d-none');
}

// /login is public HTML even before a D1 schema exists. Readiness diagnostics
// explain whether the database migration or bootstrap Secret is still needed.
async function init() {
  form.hidden = true;
  submit.disabled = true;
  clearNotice();
  try {
    const response = await fetch('/api/v1/health/ready', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store'
    });
    const body = await response.json();
    const code = body?.data?.code;
    if (code === 'READY' || code === 'ADMIN_SETUP_REQUIRED') {
      setup = code === 'ADMIN_SETUP_REQUIRED';
      bootstrapWrap.classList.toggle('d-none', !setup);
      subtitle.textContent = setup ? '首次安装：创建超级管理员' : '账号登录';
      submit.textContent = setup ? '初始化管理员' : '登录';
      form.hidden = false;
      submit.disabled = false;
      return;
    }
    subtitle.textContent = '部署尚未完成';
    if (code === 'D1_MIGRATIONS_REQUIRED') {
      show('CloudDrive 已部署，但 D1 数据库尚未建立表结构。请在 Cloudflare Worker 的 Build/Deploy 设置中运行 npm run deploy:upgrade，或者对现有 DB 执行 wrangler d1 migrations apply DB --remote。无需删除 R2 桶或 Cookie。');
    } else if (code === 'BOOTSTRAP_SECRET_REQUIRED') {
      show('数据库已就绪，但还没有配置首次初始化密钥。请在 Cloudflare Worker → Settings → Variables and Secrets 中添加 Secret：BOOTSTRAP_TOKEN（至少 32 个随机字符），然后刷新页面。');
    } else if (code === 'BINDING_MISSING') {
      show('CloudDrive 所需的 D1/R2/ASSETS Binding 不完整。请检查 Worker 资源绑定，然后刷新页面。');
    } else if (code === 'D1_QUERY_FAILED') {
      show('D1 查询失败。请检查 Worker 对应的 D1 数据库是否正确绑定，以及数据库迁移执行日志。');
    } else {
      show('暂时无法检查网盘初始化状态。请访问 /api/v1/health/ready 查看诊断信息。');
    }
  } catch (error) {
    subtitle.textContent = '无法连接初始化状态接口';
    show('无法读取服务器初始化状态。请检查网络、Worker 部署和 /api/v1/health/ready。');
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearNotice();
  submit.disabled = true;
  try {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const count = Array.from(password).length;
    if (count < 6 || count > 128) {
      show('登录密码长度应为 6–128 个字符');
      return;
    }
    if (setup) {
      await requestJSON('/api/v1/auth/setup', {
        method: 'POST',
        body: {username, password, bootstrap_token: document.getElementById('bootstrap-token').value}
      });
      await init();
      show('初始化完成，请使用刚刚创建的账号登录。');
    } else {
      await requestJSON('/api/v1/auth/login', {method:'POST', body:{username,password}});
      location.replace('/files');
    }
  } catch (error) {
    show(error.message);
  } finally {
    if (!form.hidden) submit.disabled = false;
  }
});

init();
