import assert from 'node:assert/strict';
import { resourceAttachmentRepo, resourcePriceRepo, resourceRepo } from '../assets/data/repository.js';
import { storageGetAttachment, storageRemoveAttachment, storageSetAttachment } from '../assets/data/storage.js';
import { resourceAttachmentService } from '../assets/services/resourceAttachmentService.js';
import { attachmentListHtml, shouldDownloadAttachment } from '../assets/views/resourceAttachments.js';

const MB = 1024 * 1024;

export async function testResourceAttachments() {
  assert.equal(storageSetAttachment.length, 2);
  assert.equal(storageGetAttachment.length, 1);
  assert.equal(storageRemoveAttachment.length, 1);

  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const idb = memoryIdb();
  globalThis.localStorage = memoryLocalStorage();
  globalThis.window = { idbKeyval: idb };
  try {
    await resetStores();
    await testValidationAndBoundary();
    await resetStores();
    await testAllowedSignatures();
    await resetStores();
    await testHashDedupeAndOwnership();
    await resetStores();
    await testCompensation(idb);
    await resetStores();
    await testFolderMirrorAndFallback(idb);
    await resetStores();
    await testMissingBlobDegradation(idb);
    testSafeAttachmentListHtml();
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
  }
}

async function testAllowedSignatures() {
  await resourceRepo.replaceAll([{ id: 'r1' }]);
  const fixtures = [
    ['photo.jpg', 'image/jpeg', [0xff, 0xd8, 0xff, 0xe0]],
    ['photo.jpeg', 'image/jpeg', [0xff, 0xd8, 0xff, 0xe1]],
    ['drawing.png', 'image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['prices.xls', 'application/vnd.ms-excel', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    ['prices.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', [0x50, 0x4b, 0x03, 0x04]],
  ];
  for (const [name, type, signature] of fixtures) {
    const saved = await resourceAttachmentService.add({ resourceId: 'r1', file: file(new Uint8Array(16), name, type, signature) });
    assert.equal(saved.mimeType, type);
  }
}

function testSafeAttachmentListHtml() {
  assert.equal(shouldDownloadAttachment('application/pdf'), false);
  assert.equal(shouldDownloadAttachment('image/png'), false);
  assert.equal(shouldDownloadAttachment('application/vnd.ms-excel'), true);
  const html = attachmentListHtml([{
    id: 'a1', fileName: '<img src=x onerror=alert(1)>.pdf', size: 1024,
    mimeType: 'application/pdf', status: 'missing', createdAt: '2026-07-15T08:00:00.000Z',
  }]);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('&lt;img src=x onerror=alert(1)&gt;.pdf'), true);
  assert.equal(html.includes('文件缺失'), true);
  assert.equal(html.includes('data-attachment-id="a1"'), true);
}

async function testValidationAndBoundary() {
  await resourceRepo.replaceAll([{ id: 'r1', name: '潜水泵' }]);
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-1.7', 'quote.jpg', 'application/pdf') }),
    error => error.code === 'ATTACHMENT_TYPE_INVALID',
  );
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', file: file('not-a-pdf', 'quote.pdf', 'application/pdf') }),
    error => error.code === 'ATTACHMENT_SIGNATURE_INVALID',
  );
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', file: file('', 'empty.pdf', 'application/pdf') }),
    error => error.code === 'ATTACHMENT_EMPTY',
  );
  const exactLimit = file(new Uint8Array(20 * MB), 'limit.png', 'image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const saved = await resourceAttachmentService.add({ resourceId: 'r1', file: exactLimit });
  assert.equal(saved.size, 20 * MB);
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', file: file(new Uint8Array(20 * MB + 1), 'too-large.png', 'image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
    error => error.code === 'ATTACHMENT_TOO_LARGE',
  );
}

async function testHashDedupeAndOwnership() {
  await resourceRepo.replaceAll([{ id: 'r1' }, { id: 'r2' }]);
  await resourcePriceRepo.replaceAll([{ id: 'p1', resourceId: 'r1' }, { id: 'p2', resourceId: 'r2' }]);
  const first = await resourceAttachmentService.add({
    resourceId: 'r1', priceId: 'p1', file: file('%PDF-1.7 quote', '../unsafe/<quote>.pdf', 'application/pdf'),
  });
  assert.equal(first.fileName, '../unsafe/<quote>.pdf');
  assert.equal(first.safeFileName, '_quote_.pdf');
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.status, 'available');
  assert.equal(first.storagePath, `attachments/r1/${first.id}-_quote_.pdf`);
  const dotted = await resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-dotted', 'quote..final.pdf', 'application/pdf') });
  assert.equal(dotted.safeFileName.includes('..'), false);
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-1.7 quote', 'copy.pdf', 'application/pdf') }),
    error => error.code === 'ATTACHMENT_DUPLICATE' && error.attachmentId === first.id,
  );
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', priceId: 'p2', file: file('%PDF-new', 'other.pdf', 'application/pdf') }),
    error => error.code === 'ATTACHMENT_PRICE_MISMATCH',
  );
  assert.equal((await resourceAttachmentService.listByResource('r1'))[0].id, first.id);
}

async function testCompensation(idb) {
  await resourceRepo.replaceAll([{ id: 'r1' }]);
  const binaryCount = [...idb.keys()].filter(key => String(key).startsWith('__costdb_attachment:')).length;
  idb.failNextSet('resource_attachments');
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-rollback', 'rollback.pdf', 'application/pdf') }),
    error => error.code === 'ATTACHMENT_SAVE_FAILED',
  );
  assert.equal([...idb.keys()].filter(key => String(key).startsWith('__costdb_attachment:')).length, binaryCount);
  assert.deepEqual(await resourceAttachmentRepo.all(), []);

  const saved = await resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-remove-rollback', 'remove.pdf', 'application/pdf') });
  idb.failNextSet('resource_attachments');
  await assert.rejects(
    () => resourceAttachmentService.remove(saved.id),
    error => error.code === 'ATTACHMENT_REMOVE_FAILED',
  );
  assert.equal((await resourceAttachmentRepo.findById(saved.id)).id, saved.id);
  assert.equal((await storageGetAttachment(saved)).size, saved.size);
}

async function testFolderMirrorAndFallback(idb) {
  const root = memoryDirectory('root');
  await idb.set('__costdb_directory_handle', root);
  await idb.set('__costdb_storage_mode', 'folder');
  await resourceRepo.replaceAll([{ id: 'folder-resource' }]);
  const saved = await resourceAttachmentService.add({
    resourceId: 'folder-resource', file: file('%PDF-folder', 'site/../quote?.pdf', 'application/pdf'),
  });
  assert.equal(root.read(`attachments/folder-resource/${saved.id}-quote_.pdf`).size, saved.size);
  root.delete(`attachments/folder-resource/${saved.id}-quote_.pdf`);
  const opened = await resourceAttachmentService.open(saved.id);
  assert.equal(await opened.blob.text(), '%PDF-folder');
  await resourceAttachmentService.remove(saved.id);
  assert.equal(await resourceAttachmentRepo.findById(saved.id), null);
  assert.equal(await storageGetAttachment(saved), null);
}

async function testMissingBlobDegradation(idb) {
  await idb.set('__costdb_storage_mode', 'indexeddb');
  await resourceRepo.replaceAll([{ id: 'r1' }]);
  const saved = await resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-missing', 'missing.pdf', 'application/pdf') });
  await idb.del(`__costdb_attachment:${saved.id}`);
  await assert.rejects(
    () => resourceAttachmentService.open(saved.id),
    error => error.code === 'ATTACHMENT_MISSING' && error.attachmentId === saved.id,
  );
  assert.equal((await resourceAttachmentRepo.findById(saved.id)).status, 'missing');
  assert.equal((await resourceAttachmentService.listByResource('r1')).length, 1);
}

async function resetStores() {
  await resourceRepo.replaceAll([]);
  await resourcePriceRepo.replaceAll([]);
  await resourceAttachmentRepo.replaceAll([]);
}

function file(body, name, type, signature = []) {
  const content = body instanceof Uint8Array ? body.slice() : new TextEncoder().encode(body);
  content.set(signature.slice(0, content.length));
  const blob = new Blob([content], { type });
  Object.defineProperties(blob, {
    name: { value: name },
    lastModified: { value: 1 },
  });
  return blob;
}

function memoryIdb() {
  const values = new Map();
  let failingKey = '';
  return {
    get: async key => values.get(key),
    set: async (key, value) => {
      if (key === failingKey) {
        failingKey = '';
        throw new Error(`simulated write failure: ${key}`);
      }
      values.set(key, value);
    },
    del: async key => values.delete(key),
    keys: () => values.keys(),
    failNextSet: key => { failingKey = key; },
  };
}

function memoryLocalStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function memoryDirectory(name) {
  const entries = new Map();
  const root = directory(name, '');
  root.read = path => entries.get(path);
  root.delete = path => entries.delete(path);
  return root;

  function directory(directoryName, prefix) {
    return {
      name: directoryName,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      async getDirectoryHandle(child) { return directory(child, `${prefix}${child}/`); },
      async getFileHandle(fileName) {
        const path = `${prefix}${fileName}`;
        if (!entries.has(path)) entries.set(path, new Blob());
        return {
          async getFile() { return entries.get(path); },
          async createWritable() {
            return {
              async write(value) { entries.set(path, value instanceof Blob ? value : new Blob([value])); },
              async close() {},
            };
          },
        };
      },
      async removeEntry(fileName) {
        const path = `${prefix}${fileName}`;
        if (!entries.delete(path)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      },
    };
  }
}
