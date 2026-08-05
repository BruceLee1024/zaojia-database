// 通用工具函数
import { formatCurrency } from './currency.js?v=6.7';
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const fmt = n => (n == null || isNaN(n)) ? '-' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export const fmtMoney = (n, currency = 'CNY') => formatCurrency(n, currency);
export const uid = () => Math.random().toString(36).slice(2, 10);

export function scopedDom(root) {
  return {
    getElementById(id) {
      const value = String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return root?.querySelector(`[id="${value}"]`) || null;
    },
    querySelector: selector => root?.querySelector(selector) || null,
    querySelectorAll: selector => root?.querySelectorAll(selector) || [],
  };
}

export const esc = s => (s ?? '').toString().replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

let modalReturnFocus = null;

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
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalFoot').innerHTML = footHtml;
  const modal = $('#modal');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    const focusable = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    (focusable || $('#modalPanel') || modal).focus();
  }, 0);
}

export function closeModal() {
  const modal = $('#modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.__modalClose = closeModal;
  document.addEventListener('keydown', e => {
    const modal = $('#modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = $$('#modal button:not([disabled]), #modal [href], #modal input:not([disabled]), #modal select:not([disabled]), #modal textarea:not([disabled]), #modal [tabindex]:not([tabindex="-1"])')
      .filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}
