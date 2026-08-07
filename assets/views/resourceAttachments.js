import { resourcePriceService } from '../services/resourcePriceService.js?v=6.13';
import { resourceAttachmentService } from '../services/resourceAttachmentService.js?v=6.13';
import { esc, toast } from '../utils/dom.js?v=6.13';

export function attachmentPanelShell(resourceId, generation) {
  return `<section data-resource-attachment-root data-resource-id="${esc(resourceId)}" data-render-generation="${esc(generation)}" class="p-4 border-b border-slate-200" aria-labelledby="resourceAttachmentTitle">
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1"><h3 id="resourceAttachmentTitle" class="font-semibold text-slate-900">报价与资料附件</h3><p class="mt-1 text-xs leading-5 text-slate-500">PDF、图片或 Excel，单个不超过 20MB</p></div>
      <label class="inline-flex h-8 cursor-pointer items-center gap-1 border border-teal-300 bg-white px-3 text-xs text-teal-700 focus-within:ring-2 focus-within:ring-teal-500">
        <span class="material-symbols-outlined text-[16px]" aria-hidden="true">upload_file</span>上传
        <input data-attachment-input type="file" class="sr-only" accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx,application/pdf,image/jpeg,image/png,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      </label>
    </div>
    <div data-attachment-panel class="mt-3 text-xs text-slate-500" aria-live="polite" aria-busy="true">正在读取附件…</div>
  </section>`;
}

export async function loadAttachmentPanel(resourceId, generation, options = {}) {
  const doc = options.document || document;
  const attachmentService = options.attachmentService || resourceAttachmentService;
  const priceService = options.priceService || resourcePriceService;
  const root = doc.querySelector('[data-resource-attachment-root]');
  const host = root?.querySelector('[data-attachment-panel]');
  const input = root?.querySelector('[data-attachment-input]');
  if (!isCurrentPanel(root, doc, resourceId, generation) || !host || !input) return false;
  host.setAttribute('aria-busy', 'true');
  try {
    const [attachments, prices] = await Promise.all([
      attachmentService.listByResource(resourceId),
      priceService.listByResource(resourceId),
    ]);
    if (!isCurrentPanel(root, doc, resourceId, generation)) return false;
    host.innerHTML = `<label class="block text-xs text-slate-500">关联价格（可选）<select data-attachment-price class="mt-1 h-8 w-full border border-slate-300 bg-white px-2 text-xs text-slate-700"><option value="">仅关联主数据</option>${prices.map(price => `<option value="${esc(price.id)}">${esc(price.priceDate || '未标日期')} · ${esc(String(price.unitPrice ?? '-'))}</option>`).join('')}</select></label>${attachmentListHtml(attachments)}`;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !isCurrentPanel(root, doc, resourceId, generation)) return;
      input.disabled = true;
      try {
        const priceId = root.querySelector('[data-attachment-price]')?.value || '';
        await attachmentService.add({ resourceId, priceId, file });
        if (!isCurrentPanel(root, doc, resourceId, generation)) return;
        toast('附件已上传', 'success');
        await loadAttachmentPanel(resourceId, generation, options);
      } catch (error) {
        if (isCurrentPanel(root, doc, resourceId, generation)) toast(error?.message || '附件上传失败', 'error');
      } finally {
        if (isCurrentPanel(root, doc, resourceId, generation)) {
          input.value = '';
          input.disabled = false;
        }
      }
    };
    host.onclick = event => handleAttachmentAction(event, resourceId, generation, options);
    return true;
  } catch {
    if (!isCurrentPanel(root, doc, resourceId, generation)) return false;
    host.innerHTML = `<div role="alert" class="border border-amber-300 bg-amber-50 p-3 text-amber-800"><div class="font-medium">附件加载失败</div><p class="mt-1 leading-5">请检查存储连接后重试，资源其他信息不受影响。</p><button type="button" data-attachment-action="retry" class="mt-2 border border-amber-400 bg-white px-2 py-1 font-medium">重试</button></div>`;
    host.onclick = event => handleAttachmentAction(event, resourceId, generation, options);
    return false;
  } finally {
    if (isCurrentPanel(root, doc, resourceId, generation)) host.setAttribute('aria-busy', 'false');
  }
}

export function attachmentListHtml(attachments) {
  if (!attachments.length) {
    return '<div class="mt-3 border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-slate-500">暂无附件，可上传报价单、合同或图纸作为价格依据。</div>';
  }
  return `<ul class="mt-3 space-y-2" role="list">${attachments.map(item => {
    const missing = item.status === 'missing';
    return `<li class="border ${missing ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'} p-2.5">
      <div class="flex items-start gap-2"><span class="material-symbols-outlined mt-0.5 text-[18px] ${missing ? 'text-amber-600' : 'text-slate-400'}" aria-hidden="true">${missing ? 'broken_image' : attachmentIcon(item.mimeType)}</span><div class="min-w-0 flex-1"><div class="break-all font-medium text-slate-800">${esc(item.fileName || '未命名附件')}</div><div class="mt-1 text-slate-500">${formatBytes(item.size)} · ${esc(formatDate(item.createdAt))}${missing ? ' · <span class="font-medium text-amber-700">文件缺失</span>' : ''}</div></div></div>
      <div class="mt-2 flex justify-end gap-3"><button type="button" data-attachment-action="open" data-attachment-id="${esc(item.id)}" ${missing ? 'disabled' : ''} class="text-teal-700 disabled:cursor-not-allowed disabled:text-slate-400">打开</button><button type="button" data-attachment-action="remove" data-attachment-id="${esc(item.id)}" class="text-red-600">删除</button></div>
    </li>`;
  }).join('')}</ul>`;
}

async function handleAttachmentAction(event, resourceId, generation, options) {
  const button = event.target.closest('button[data-attachment-action]');
  if (!button || button.disabled) return;
  if (button.dataset.attachmentAction === 'retry') {
    await loadAttachmentPanel(resourceId, generation, options);
    return;
  }
  const attachmentService = options.attachmentService || resourceAttachmentService;
  const id = button.dataset.attachmentId;
  try {
    if (button.dataset.attachmentAction === 'remove') {
      if (!confirm('删除这个附件？')) return;
      await attachmentService.remove(id);
      toast('附件已删除', 'success');
      await loadAttachmentPanel(resourceId, generation, options);
      return;
    }
    const { attachment, blob } = await attachmentService.open(id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    if (shouldDownloadAttachment(attachment.mimeType)) link.download = attachment.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    toast(error?.message || '附件打开失败', 'error');
    await loadAttachmentPanel(resourceId, generation, options);
  }
}

function isCurrentPanel(root, doc, resourceId, generation) {
  return Boolean(root?.isConnected
    && doc.querySelector('[data-resource-attachment-root]') === root
    && root.dataset.resourceId === String(resourceId)
    && root.dataset.renderGeneration === String(generation));
}

export function shouldDownloadAttachment(mimeType) {
  return !/^(application\/pdf|image\/)/.test(String(mimeType));
}

function attachmentIcon(mimeType) {
  if (mimeType === 'application/pdf') return 'picture_as_pdf';
  if (String(mimeType).startsWith('image/')) return 'image';
  return 'table_view';
}

function formatBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('zh-CN');
}
