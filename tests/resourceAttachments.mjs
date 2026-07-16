import assert from 'node:assert/strict';
import { resourceAttachmentRepo, resourcePriceRepo, resourceRepo } from '../assets/data/repository.js?v=6.2';
import { storageGet, storageGetAttachment, storageRemoveAttachment, storageSetAttachment, storageSetStrict, writeStoresToDirectory } from '../assets/data/storage.js?v=6.2';
import { restoreLegacyJsonBackup } from '../assets/services/backupService.js?v=6.2';
import { resourceAttachmentService } from '../assets/services/resourceAttachmentService.js?v=6.2';
import { attachmentListHtml, attachmentPanelShell, loadAttachmentPanel, shouldDownloadAttachment } from '../assets/views/resourceAttachments.js?v=6.2';

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
    await testStrictFolderStoreWrites(idb);
    await resetStores();
    await testUnifiedFolderMutationQueue(idb);
    await resetStores();
    await testRevokedFolderPermission(idb);
    await resetStores();
    await testMissingBlobDegradation(idb);
    await resetStores();
    await testConcurrentHashDedupe(idb);
    await testAttachmentPanelLoadScoping();
    await testAttachmentPanelLoadError();
    testSafeAttachmentListHtml();
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
  }
}

async function testUnifiedFolderMutationQueue(idb) {
  const root = memoryDirectory('queue-root');
  await idb.set('__costdb_directory_handle', root);
  await idb.set('__costdb_storage_mode', 'folder');
  await resourceRepo.replaceAll([{ id: 'queue-resource' }]);
  const pause = root.pauseWriteOnce('manifest.json');
  const attachmentPromise = resourceAttachmentService.add({
    resourceId: 'queue-resource', file: file('%PDF-queue', 'queue.pdf', 'application/pdf'),
  });
  await pause.reached;
  const storePromise = storageSetStrict('quota_items', [{ id: 'queue-quota' }]);
  const queueState = await Promise.race([
    storePromise.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('waiting'), 10)),
  ]);
  pause.release();
  assert.equal(queueState, 'waiting');
  const [saved] = await Promise.all([attachmentPromise, storePromise]);
  const manifest = JSON.parse(await root.read('manifest.json').text());
  assert.equal(manifest.stores.quota_items.file, 'stores/quota_items.json');
  assert.equal(manifest.attachments[saved.id].path, saved.storagePath);
}

async function testStrictFolderStoreWrites(idb) {
  const root = memoryDirectory('strict-root');
  await idb.set('__costdb_directory_handle', root);
  await idb.set('__costdb_storage_mode', 'folder');
  await idb.set('quota_items', [{ id: 'old' }]);
  await writeStoresToDirectory(root, { quota_items: [{ id: 'old' }] });

  root.failWriteOnce('manifest.json');
  await assert.rejects(() => storageSetStrict('quota_items', [{ id: 'new' }]), error => error.code === 'STORAGE_STRICT_WRITE_FAILED');
  assert.deepEqual(await idb.get('quota_items'), [{ id: 'old' }]);
  assert.deepEqual(JSON.parse(await root.read('stores/quota_items.json').text()).records, [{ id: 'old' }]);

  root.failWriteOnce('stores/quota_items.json');
  await assert.rejects(() => storageSetStrict('quota_items', [{ id: 'newer' }]), error => error.code === 'STORAGE_STRICT_WRITE_FAILED');
  assert.deepEqual(await idb.get('quota_items'), [{ id: 'old' }]);

  root.failWriteOnce('manifest.json');
  await assert.rejects(() => restoreLegacyJsonBackup({ quota_items: [{ id: 'restore-attempt' }] }, {
    getStore: storageGet,
    setStore: storageSetStrict,
    getAttachment: async () => null,
    setAttachment: async () => {},
    removeAttachment: async () => {},
  }), error => error.code === 'BACKUP_RESTORE_FAILED');
  assert.deepEqual(await idb.get('quota_items'), [{ id: 'old' }]);
  assert.deepEqual(JSON.parse(await root.read('stores/quota_items.json').text()).records, [{ id: 'old' }]);
}

async function testRevokedFolderPermission(idb) {
  const root = memoryDirectory('revoked-root');
  root.setPermission('denied');
  await idb.set('__costdb_directory_handle', root);
  await idb.set('__costdb_storage_mode', 'folder');
  await resourceRepo.replaceAll([{ id: 'r1' }]);
  const binaryCount = [...idb.keys()].filter(key => String(key).startsWith('__costdb_attachment:')).length;
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-denied', 'denied.pdf', 'application/pdf') }),
    error => error.code === 'ATTACHMENT_FOLDER_PERMISSION',
  );
  assert.deepEqual(await resourceAttachmentRepo.all(), []);
  assert.equal([...idb.keys()].filter(key => String(key).startsWith('__costdb_attachment:')).length, binaryCount);

  root.setPermission('granted');
  await resourceRepo.replaceAll([{ id: 'r1' }]);
  const saved = await resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-preserve', 'preserve.pdf', 'application/pdf') });
  const path = `attachments/r1/${saved.id}-preserve.pdf`;
  root.setPermission('denied');
  await assert.rejects(
    () => resourceAttachmentService.remove(saved.id),
    error => error.code === 'ATTACHMENT_FOLDER_PERMISSION',
  );
  assert.equal((await resourceAttachmentRepo.findById(saved.id)).id, saved.id);
  assert.equal((await idb.get(`__costdb_attachment:personal:${saved.id}`)).size, saved.size);
  assert.equal(root.read(path).size, saved.size);
}

async function testConcurrentHashDedupe(idb) {
  await idb.set('__costdb_storage_mode', 'indexeddb');
  await resourceRepo.replaceAll([{ id: 'r1' }]);
  const upload = () => resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-concurrent', 'same.pdf', 'application/pdf') });
  const results = await Promise.allSettled([upload(), upload()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'ATTACHMENT_DUPLICATE').length, 1);
  assert.equal((await resourceAttachmentRepo.byResource('r1')).length, 1);
}

async function testAttachmentPanelLoadScoping() {
  const firstAttachments = deferred();
  const firstPrices = deferred();
  const first = panelDom('A', '1');
  const second = panelDom('B', '2');
  let current = first;
  const document = { querySelector: () => current.root };
  const attachmentService = { listByResource: id => id === 'A' ? firstAttachments.promise : Promise.resolve([{ id: 'b1', fileName: 'B.pdf', size: 10, status: 'available' }]) };
  const priceService = { listByResource: id => id === 'A' ? firstPrices.promise : Promise.resolve([]) };
  const staleLoad = loadAttachmentPanel('A', '1', { document, attachmentService, priceService });
  first.root.isConnected = false;
  current = second;
  const currentLoad = loadAttachmentPanel('B', '2', { document, attachmentService, priceService });
  firstAttachments.resolve([{ id: 'a1', fileName: 'A.pdf', size: 10, status: 'available' }]);
  firstPrices.resolve([]);
  assert.equal(await staleLoad, false);
  assert.equal(await currentLoad, true);
  assert.equal(first.host.innerHTML.includes('A.pdf'), false);
  assert.equal(second.host.innerHTML.includes('B.pdf'), true);
  assert.equal(typeof second.host.onclick, 'function');
}

async function testAttachmentPanelLoadError() {
  const panel = panelDom('A', '3');
  const document = { querySelector: () => panel.root };
  const result = await loadAttachmentPanel('A', '3', {
    document,
    attachmentService: { listByResource: async () => { throw new Error('simulated load failure'); } },
    priceService: { listByResource: async () => [] },
  });
  assert.equal(result, false);
  assert.equal(panel.host.attributes.get('aria-busy'), 'false');
  assert.equal(panel.host.innerHTML.includes('role="alert"'), true);
  assert.equal(panel.host.innerHTML.includes('data-attachment-action="retry"'), true);
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
  const shell = attachmentPanelShell('resource&lt;', '7');
  assert.equal(shell.includes('data-resource-id="resource&amp;lt;"'), true);
  assert.equal(shell.includes('data-render-generation="7"'), true);
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
  assert.equal((await resourceAttachmentService.listByResource('r1')).some(item => item.id === first.id), true);
}

async function testCompensation(idb) {
  await resourceRepo.replaceAll([{ id: 'r1' }]);
  const binaryCount = [...idb.keys()].filter(key => String(key).startsWith('__costdb_attachment:')).length;
  idb.failNextSet('__costdb_profile:personal:resource_attachments');
  await assert.rejects(
    () => resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-rollback', 'rollback.pdf', 'application/pdf') }),
    error => error.code === 'ATTACHMENT_SAVE_FAILED',
  );
  assert.equal([...idb.keys()].filter(key => String(key).startsWith('__costdb_attachment:')).length, binaryCount);
  assert.deepEqual(await resourceAttachmentRepo.all(), []);

  const saved = await resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-remove-rollback', 'remove.pdf', 'application/pdf') });
  idb.failNextSet('__costdb_profile:personal:resource_attachments');
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
  const addedManifest = JSON.parse(await root.read('manifest.json').text());
  assert.equal(addedManifest.schemaVersion, 2);
  assert.equal(addedManifest.attachments[saved.id].path, saved.storagePath);
  root.delete(`attachments/folder-resource/${saved.id}-quote_.pdf`);
  const opened = await resourceAttachmentService.open(saved.id);
  assert.equal(await opened.blob.text(), '%PDF-folder');
  await resourceAttachmentService.remove(saved.id);
  assert.equal(await resourceAttachmentRepo.findById(saved.id), null);
  assert.equal(await storageGetAttachment(saved), null);
  const removedManifest = JSON.parse(await root.read('manifest.json').text());
  assert.equal(removedManifest.attachments[saved.id], undefined);
}

async function testMissingBlobDegradation(idb) {
  await idb.set('__costdb_storage_mode', 'indexeddb');
  await resourceRepo.replaceAll([{ id: 'r1' }]);
  const saved = await resourceAttachmentService.add({ resourceId: 'r1', file: file('%PDF-missing', 'missing.pdf', 'application/pdf') });
  await idb.del(`__costdb_attachment:personal:${saved.id}`);
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
  const directories = new Set(['']);
  const failingWrites = new Map();
  const pausedWrites = new Map();
  let permission = 'granted';
  const root = directory(name, '');
  root.read = path => entries.get(path);
  root.delete = path => entries.delete(path);
  root.setPermission = value => { permission = value; };
  root.failWriteOnce = path => failingWrites.set(path, 1);
  root.pauseWriteOnce = path => {
    const gate = deferredWithReject();
    pausedWrites.set(path, gate);
    return { reached: gate.reached, release: gate.resolve };
  };
  return root;

  function directory(directoryName, prefix) {
    return {
      name: directoryName,
      queryPermission: async () => permission,
      requestPermission: async () => permission,
      async getDirectoryHandle(child, options = {}) {
        const path = `${prefix}${child}/`;
        if (!directories.has(path) && !options.create) throw notFound();
        directories.add(path);
        return directory(child, path);
      },
      async getFileHandle(fileName, options = {}) {
        const path = `${prefix}${fileName}`;
        if (!entries.has(path) && !options.create) throw notFound();
        if (!entries.has(path)) entries.set(path, new Blob());
        return {
          async getFile() { return entries.get(path); },
          async createWritable() {
            return {
              async write(value) {
                const pause = pausedWrites.get(path);
                if (pause) {
                  pausedWrites.delete(path);
                  pause.markReached();
                  await pause.promise;
                }
                const remaining = failingWrites.get(path) || 0;
                if (remaining > 0) {
                  failingWrites.set(path, remaining - 1);
                  throw new Error(`simulated folder write failure: ${path}`);
                }
                entries.set(path, value instanceof Blob ? value : new Blob([value]));
              },
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

function deferredWithReject() {
  let resolve;
  let markReached;
  const promise = new Promise(done => { resolve = done; });
  const reached = new Promise(done => { markReached = done; });
  return { promise, reached, resolve, markReached };
}

function panelDom(resourceId, generation) {
  const host = fakeElement();
  const input = fakeElement();
  input.files = [];
  const root = {
    dataset: { resourceId, renderGeneration: generation },
    isConnected: true,
    querySelector: selector => selector === '[data-attachment-panel]' ? host : selector === '[data-attachment-input]' ? input : null,
  };
  return { root, host, input };
}

function fakeElement() {
  const attributes = new Map();
  return {
    attributes,
    innerHTML: '正在读取附件…',
    disabled: false,
    value: '',
    setAttribute: (key, value) => attributes.set(key, value),
    querySelector: () => null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function notFound() {
  return Object.assign(new Error('missing'), { name: 'NotFoundError' });
}
