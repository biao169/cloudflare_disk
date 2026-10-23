export function notify(message, tone = 'secondary') {
  const host = document.getElementById('toast-container');
  const item = document.createElement('div');
  item.className = 'toast show border-0 shadow-sm';
  item.setAttribute('role','status');
  const body = document.createElement('div'); body.className = 'toast-body d-flex justify-content-between gap-2';
  const text = document.createElement('span'); text.textContent = message;
  const close = document.createElement('button'); close.className='btn-close'; close.type='button'; close.setAttribute('aria-label','关闭提示'); close.addEventListener('click', () => item.remove());
  body.append(text, close); item.append(body); host.append(item);
  setTimeout(() => item.remove(), 4400);
}
