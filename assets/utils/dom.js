// 通用工具函数
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const fmt = n => (n == null || isNaN(n)) ? '-' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export const fmtMoney = n => '¥' + fmt(n);
export const uid = () => Math.random().toString(36).slice(2, 10);

export const esc = s => (s ?? '').toString().replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `fixed top-4 right-4 z-[100] px-4 py-2 rounded-md text-sm text-white border border-white/20 ${
    type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-emerald-600' : 'bg-slate-700'
  }`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

export function openModal(title, bodyHtml, footHtml = '') {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalFoot').innerHTML = footHtml;
  $('#modal').classList.remove('hidden');
}

export function closeModal() {
  $('#modal').classList.add('hidden');
}
