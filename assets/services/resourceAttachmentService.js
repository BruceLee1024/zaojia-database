import { resourceAttachmentRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=6.12';
import { storageGetAttachment, storageRemoveAttachment, storageSetAttachment } from '../data/storage.js?v=6.12';

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
const FILE_TYPES = {
  pdf: { mime: 'application/pdf', signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  jpg: { mime: 'image/jpeg', signature: [0xff, 0xd8, 0xff] },
  jpeg: { mime: 'image/jpeg', signature: [0xff, 0xd8, 0xff] },
  png: { mime: 'image/png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  xls: { mime: 'application/vnd.ms-excel', signature: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signature: [0x50, 0x4b, 0x03, 0x04] },
};

export const resourceAttachmentService = {
  add(input) {
    return serializeAttachmentAdd(input?.resourceId, () => addAttachment(input));
  },

  async listByResource(resourceId) {
    return (await resourceAttachmentRepo.byResource(resourceId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },

  async open(id) {
    const metadata = await resourceAttachmentRepo.findById(id);
    if (!metadata) throw attachmentError('ATTACHMENT_NOT_FOUND', '附件记录不存在。');
    const blob = await storageGetAttachment(metadata);
    if (!blob?.size) {
      await resourceAttachmentRepo.update(id, { status: 'missing', updatedAt: new Date().toISOString() });
      const error = attachmentError('ATTACHMENT_MISSING', '附件文件已丢失，请重新上传。');
      error.attachmentId = id;
      throw error;
    }
    if (metadata.status === 'missing') {
      await resourceAttachmentRepo.update(id, { status: 'available', updatedAt: new Date().toISOString() });
    }
    return { attachment: metadata, blob };
  },

  async remove(id) {
    const metadata = await resourceAttachmentRepo.findById(id);
    if (!metadata) return false;
    const blob = await storageGetAttachment(metadata);
    try {
      await storageRemoveAttachment(metadata);
      await resourceAttachmentRepo.remove(id);
      return true;
    } catch (cause) {
      if (cause?.code === 'ATTACHMENT_FOLDER_PERMISSION') throw cause;
      if (blob?.size) {
        try { await storageSetAttachment(metadata, blob); } catch {}
      }
      const error = attachmentError('ATTACHMENT_REMOVE_FAILED', '附件删除失败，已尽量恢复原数据。');
      error.cause = cause;
      throw error;
    }
  },
};

const attachmentAddQueues = new Map();

async function addAttachment({ resourceId, priceId = '', file }) {
  const resource = await resourceRepo.findById(resourceId);
  if (!resource) throw attachmentError('ATTACHMENT_RESOURCE_MISSING', '关联的材料或设备不存在。');
  if (priceId) {
    const price = await resourcePriceRepo.findById(priceId);
    if (!price || price.resourceId !== resourceId) {
      throw attachmentError('ATTACHMENT_PRICE_MISMATCH', '附件关联的价格快照不属于该资源。');
    }
  }
  const validated = await validateAttachment(file);
  const existing = (await resourceAttachmentRepo.byResource(resourceId))
    .find(item => item.sha256 === validated.sha256);
  if (existing) {
    const error = attachmentError('ATTACHMENT_DUPLICATE', '该附件已上传。');
    error.attachmentId = existing.id;
    throw error;
  }
  const id = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  const createdAt = new Date().toISOString();
  const metadata = {
    id,
    resourceId,
    priceId: priceId || '',
    fileName: String(file.name || ''),
    safeFileName: validated.safeFileName,
    mimeType: validated.mimeType,
    extension: validated.extension,
    size: file.size,
    sha256: validated.sha256,
    storagePath: `attachments/${resourceId}/${id}-${validated.safeFileName}`,
    status: 'available',
    createdAt,
    updatedAt: createdAt,
  };
  try {
    await storageSetAttachment(metadata, file);
    await resourceAttachmentRepo.upsert(metadata);
    return metadata;
  } catch (cause) {
    if (cause?.code === 'ATTACHMENT_FOLDER_PERMISSION') throw cause;
    try { await storageRemoveAttachment(metadata); } catch {}
    try { await resourceAttachmentRepo.remove(metadata.id); } catch {}
    const error = attachmentError('ATTACHMENT_SAVE_FAILED', '附件保存失败，未保留不完整数据。');
    error.cause = cause;
    throw error;
  }
}

function serializeAttachmentAdd(resourceId, operation) {
  const key = String(resourceId || '');
  const previous = attachmentAddQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  attachmentAddQueues.set(key, current);
  return current.finally(() => {
    if (attachmentAddQueues.get(key) === current) attachmentAddQueues.delete(key);
  });
}

async function validateAttachment(file) {
  if (!(file instanceof Blob) || typeof file.name !== 'string') {
    throw attachmentError('ATTACHMENT_FILE_REQUIRED', '请选择要上传的附件。');
  }
  if (file.size <= 0) throw attachmentError('ATTACHMENT_EMPTY', '不能上传空文件。');
  if (file.size > MAX_ATTACHMENT_SIZE) throw attachmentError('ATTACHMENT_TOO_LARGE', '单个附件不能超过 20MB。');
  const extension = extensionOf(file.name);
  const expected = FILE_TYPES[extension];
  if (!expected || file.type !== expected.mime) {
    throw attachmentError('ATTACHMENT_TYPE_INVALID', '仅支持 PDF、JPG、JPEG、PNG、XLS 和 XLSX 文件。');
  }
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!expected.signature.every((byte, index) => header[index] === byte)) {
    throw attachmentError('ATTACHMENT_SIGNATURE_INVALID', '文件内容与扩展名不匹配。');
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  return { extension, mimeType: expected.mime, safeFileName: sanitizeFileName(file.name, extension), sha256 };
}

function extensionOf(name) {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function sanitizeFileName(name, extension) {
  const normalized = String(name || '').normalize('NFKC').split(/[\\/]/).pop() || `attachment.${extension}`;
  const base = normalized.slice(0, -(extension.length + 1))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .trim()
    .slice(0, 120) || 'attachment';
  return `${base}.${extension}`;
}

function attachmentError(code, message) {
  return Object.assign(new Error(message), { code });
}
