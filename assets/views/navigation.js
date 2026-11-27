import { esc } from '../utils/dom.js?v=6.15';

export function navigationItemHtml(view = {}, active = false) {
  const label = String(view.label || '');
  const desc = String(view.desc || '');
  return `<button type="button" class="nav-item w-full px-3 py-2 flex items-center gap-3 text-left text-[13px] font-medium ${active ? 'active' : ''}" data-go="${esc(view.id || '')}" aria-label="${esc(`${label}：${desc}`)}" title="${esc(label)}"${active ? ' aria-current="page"' : ''}>
    <span class="material-symbols-outlined icon-nav shrink-0" aria-hidden="true">${esc(view.icon || '')}</span>
    <span class="min-w-0 flex-1">
      <span class="block leading-5 tracking-[-0.01em]">${esc(label)}</span>
      <span class="block text-[10px] leading-3.5 ${active ? 'text-teal-50/80' : 'text-slate-500'}">${esc(desc)}</span>
    </span>
    ${active ? '<span class="h-1.5 w-1.5 rounded-full bg-teal-100" aria-hidden="true"></span>' : ''}
  </button>`;
}
