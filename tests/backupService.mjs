import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const zip = require('../assets/vendor/fflate/fflate.cjs');

export async function testBackupService() {
  const { BACKUP_IMPORT_ACCEPT, backupOperationErrorMessage, downloadBackupBlob, runBackupExport, runDestructiveDataAction } = await import('../assets/views/settings.js');
  assert.equal(BACKUP_IMPORT_ACCEPT.includes('.json'), true);
  assert.equal(BACKUP_IMPORT_ACCEPT.includes('.zip'), true);
  const {
    BACKUP_STORES,
    createLegacyJsonBackup,
    createZipBackup,
    parseLegacyJsonBackupFile,
    resetWithGenerator,
    restoreLegacyJsonBackup,
    restoreZipBackup,
  } = await import('../assets/services/backupService.js');

  let invalidDownloadCount = 0;
  const invalidExportAdapter = memoryAdapter({ resource_items: [{ id: 'duplicate' }, { id: 'duplicate' }] });
  await assert.rejects(() => createLegacyJsonBackup(invalidExportAdapter), error => error.code === 'BACKUP_SEMANTIC_INVALID');
  await assert.rejects(() => createZipBackup(invalidExportAdapter, {}, {
    zip: { zip() { invalidDownloadCount += 1; } },
  }), error => error.code === 'BACKUP_SEMANTIC_INVALID');
  assert.equal(invalidDownloadCount, 0);

  const exportCalls = [];
  const exportResult = await runBackupExport({
    label: 'JSON',
    create: async () => { throw Object.assign(new Error('数据引用无效'), { code: 'BACKUP_SEMANTIC_INVALID' }); },
    download: () => exportCalls.push('download'),
    notify: (message, type) => exportCalls.push([message, type]),
  });
  assert.equal(exportResult, false);
  assert.equal(exportCalls.includes('download'), false);
  assert.equal(exportCalls[0][0].includes('导出失败'), true);

  assert.equal(backupOperationErrorMessage({ code: 'BACKUP_CLEAR_FAILED' }, '清空').includes('原数据已恢复'), true);
  assert.equal(backupOperationErrorMessage({ code: 'BACKUP_RECOVERY_PARTIAL' }, '重置').includes('部分恢复'), true);
  const urlCalls = [];
  let clicked = false;
  downloadBackupBlob(new Blob(['x']), 'x.json', {
    document: { createElement: () => ({ click: () => { clicked = true; } }) },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: url => urlCalls.push(url) },
    schedule: callback => callback(),
  });
  assert.equal(clicked, true);
  assert.deepEqual(urlCalls, ['blob:test']);
  const destructiveCalls = [];
  const clearResult = await runDestructiveDataAction({
    action: '清空',
    clear: async () => { throw Object.assign(new Error('failed'), { code: 'BACKUP_CLEAR_FAILED' }); },
    afterClear: async () => destructiveCalls.push('reload'),
    notify: (message, type) => destructiveCalls.push([message, type]),
  });
  assert.equal(clearResult, false);
  assert.equal(destructiveCalls.includes('reload'), false);
  assert.equal(destructiveCalls[0][0].includes('原数据已恢复'), true);
  const resetCalls = [];
  const resetResult = await runDestructiveDataAction({
    action: '重置',
    clear: async () => { throw Object.assign(new Error('partial'), { code: 'BACKUP_RECOVERY_PARTIAL' }); },
    afterClear: async () => resetCalls.push('load-demo'),
    notify: message => resetCalls.push(message),
  });
  assert.equal(resetResult, false);
  assert.equal(resetCalls.includes('load-demo'), false);
  assert.equal(resetCalls[0].includes('部分恢复'), true);

  await assert.rejects(() => parseLegacyJsonBackupFile(new Blob(['{}']), 1), error => error.code === 'BACKUP_TOO_LARGE');
  assert.deepEqual(await parseLegacyJsonBackupFile(new Blob(['{"quota_items":[]}'])), { quota_items: [] });

  assert.equal(BACKUP_STORES.includes('resource_attachments'), true);
  const adapter = memoryAdapter({
    quota_items: [{ id: 'q1' }],
    resource_items: [{ id: 'r1' }],
    resource_attachments: [attachment()],
  }, new Map([['a1', pdfBlob()]]));
  const legacy = await createLegacyJsonBackup(adapter, { provider: 'openai', api_key: 'never-export', model: 'gpt-test' });
  assert.deepEqual(legacy.resource_items, [{ id: 'r1' }]);
  assert.equal(legacy.ai_config.api_key, undefined);

  const old = memoryAdapter(Object.fromEntries(BACKUP_STORES.map(name => [name, [{ id: `old-${name}` }]])));
  let restoredAI;
  await restoreLegacyJsonBackup({ quota_items: [{ id: 'legacy' }], ai_config: { api_key: 'stolen', model: 'legacy-model' } }, old, {
    currentAI: { api_key: 'device-key', model: 'current' },
    setAI: value => { restoredAI = value; },
  });
  assert.deepEqual(await old.getStore('quota_items'), [{ id: 'legacy' }]);
  assert.deepEqual(await old.getStore('resource_items'), []);
  assert.equal(restoredAI.api_key, 'device-key');
  assert.equal(restoredAI.model, 'legacy-model');

  const aiFailure = memoryAdapter({ quota_items: [{ id: 'safe-before-ai' }] });
  let aiAfterFailure;
  await assert.rejects(() => restoreLegacyJsonBackup({ quota_items: [{ id: 'incoming' }], ai_config: { model: 'incoming' } }, aiFailure, {
    currentAI: { api_key: 'device', model: 'safe-model' },
    setAI: value => {
      if (value.model === 'incoming') throw new Error('injected AI config failure');
      aiAfterFailure = value;
    },
  }), error => error.code === 'BACKUP_RESTORE_FAILED');
  assert.deepEqual(await aiFailure.getStore('quota_items'), [{ id: 'safe-before-ai' }]);
  assert.equal(aiAfterFailure.model, 'safe-model');

  const metadataOnly = memoryAdapter({ resource_items: [{ id: 'old' }] }, new Map([['old-blob', pdfBlob()]]));
  await restoreLegacyJsonBackup(legacy, metadataOnly);
  assert.equal((await metadataOnly.getStore('resource_attachments'))[0].status, 'missing');
  assert.equal(await metadataOnly.getAttachment(attachment()), null);

  const archive = await createZipBackup(adapter, { provider: 'openai', api_key: 'secret' }, { zip });
  const entries = zip.unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.keys(entries).sort(), ['attachments/r1/a1-quote.pdf', 'backup.json', 'manifest.json']);
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.attachments[0].sha256, attachment().sha256);

  let asyncZipCalled = false;
  let asyncUnzipCalled = false;
  const asyncZip = {
    zip(files, options, callback) { asyncZipCalled = true; callback(null, zip.zipSync(files, options)); },
    unzip(bytes, callback) { asyncUnzipCalled = true; callback(null, zip.unzipSync(bytes)); },
  };
  const asyncArchive = await createZipBackup(adapter, {}, { zip: asyncZip });
  await restoreZipBackup(asyncArchive, memoryAdapter(), { zip: asyncZip });
  assert.equal(asyncZipCalled, true);
  assert.equal(asyncUnzipCalled, true);

  await assert.rejects(() => createZipBackup(adapter, {}, {
    zip: { zip(_files, _options, callback) { callback(null, new Uint8Array(2)); } },
    maxArchiveSize: 1,
  }), error => error.code === 'BACKUP_TOO_LARGE');

  const target = memoryAdapter({ quota_items: [{ id: 'before' }] }, new Map());
  await restoreZipBackup(archive, target, { zip, currentAI: { api_key: 'device' } });
  assert.deepEqual(await target.getStore('resource_items'), [{ id: 'r1' }]);
  assert.equal(await (await target.getAttachment(attachment())).text(), '%PDF-backup');

  const badPath = zip.zipSync({
    'backup.json': entries['backup.json'],
    'manifest.json': entries['manifest.json'],
    '../escape.txt': new Uint8Array([1]),
  });
  const before = structuredClone(await target.getStore('resource_items'));
  await assert.rejects(() => restoreZipBackup(new Blob([badPath]), target, { zip }), error => error.code === 'BACKUP_ENTRY_INVALID');
  assert.deepEqual(await target.getStore('resource_items'), before);

  const wrongApp = cloneEntries(entries);
  const wrongAppManifest = JSON.parse(new TextDecoder().decode(wrongApp['manifest.json']));
  wrongAppManifest.app = 'other-app';
  wrongApp['manifest.json'] = new TextEncoder().encode(JSON.stringify(wrongAppManifest));
  await assert.rejects(() => restoreZipBackup(new Blob([zip.zipSync(wrongApp)]), target, { zip }), error => error.code === 'BACKUP_SCHEMA_INVALID');
  assert.deepEqual(await target.getStore('resource_items'), before);

  const wrongBackupIdentity = cloneEntries(entries);
  const wrongBackup = JSON.parse(new TextDecoder().decode(wrongBackupIdentity['backup.json']));
  wrongBackup.schemaVersion = 1;
  wrongBackupIdentity['backup.json'] = new TextEncoder().encode(JSON.stringify(wrongBackup));
  await assert.rejects(() => restoreZipBackup(new Blob([zip.zipSync(wrongBackupIdentity)]), target, { zip }), error => error.code === 'BACKUP_SCHEMA_INVALID');
  assert.deepEqual(await target.getStore('resource_items'), before);

  const badSchemaEntries = cloneEntries(entries);
  badSchemaEntries['backup.json'] = new TextEncoder().encode(JSON.stringify({ quota_items: {} }));
  await assert.rejects(() => restoreZipBackup(new Blob([zip.zipSync(badSchemaEntries)]), target, { zip }), error => error.code === 'BACKUP_STORE_INVALID');
  assert.deepEqual(await target.getStore('resource_items'), before);

  const semanticTarget = memoryAdapter({ quota_items: [{ id: 'untouched' }] });
  const semanticBase = {
    quota_items: [{ id: 'q1' }],
    resource_items: [{ id: 'r1' }, { id: 'r2' }],
    resource_prices: [{ id: 'p1', resourceId: 'r1' }],
    quota_resource_usages: [{ id: 'u1', quotaItemId: 'q1', resourceId: 'r1' }],
    resource_attachments: [{ ...attachment(), status: 'missing', priceId: 'p1' }],
  };
  const invalidSemanticBackups = [
    { ...semanticBase, resource_items: [{ id: 'r1' }, { id: 'r1' }] },
    { ...semanticBase, resource_prices: [{ id: 'p1', resourceId: 'r1' }, { id: 'p1', resourceId: 'r1' }] },
    { ...semanticBase, quota_resource_usages: [{ id: 'u1', quotaItemId: 'q1', resourceId: 'r1' }, { id: 'u1', quotaItemId: 'q1', resourceId: 'r1' }] },
    { ...semanticBase, resource_attachments: [{ ...attachment(), status: 'missing' }, { ...attachment(), status: 'missing' }] },
    { ...semanticBase, resource_prices: [{ id: 'p1', resourceId: 'missing' }] },
    { ...semanticBase, resource_attachments: [{ ...attachment(), status: 'missing', resourceId: 'missing', storagePath: 'attachments/missing/a1-quote.pdf' }] },
    { ...semanticBase, resource_attachments: [{ ...attachment(), status: 'missing', resourceId: 'r2', priceId: 'p1', storagePath: 'attachments/r2/a1-quote.pdf' }] },
    { ...semanticBase, resource_attachments: [{ ...attachment(), status: 'missing', priceId: 'missing' }] },
    { ...semanticBase, quota_resource_usages: [{ id: 'u1', quotaItemId: 'missing', resourceId: 'r1' }] },
    { ...semanticBase, quota_resource_usages: [{ id: 'u1', quotaItemId: 'q1', resourceId: 'missing' }] },
    { ...semanticBase, quota_resource_usages: [{ id: 'u1', quotaItemId: 'q1', resourceId: 'r1', selectedPriceId: 'missing' }] },
  ];
  for (const invalid of invalidSemanticBackups) {
    await assert.rejects(() => restoreLegacyJsonBackup(invalid, semanticTarget), error => error.code === 'BACKUP_SEMANTIC_INVALID');
    assert.deepEqual(await semanticTarget.getStore('quota_items'), [{ id: 'untouched' }]);
  }
  for (const hostileId of ['x\" onclick=alert(1)', '<script>alert(1)</script>', '../escape', 'x'.repeat(129)]) {
    const hostile = { ...semanticBase, resource_items: [{ id: hostileId }] };
    await assert.rejects(() => restoreLegacyJsonBackup(hostile, semanticTarget), error => error.code === 'BACKUP_SEMANTIC_INVALID');
    assert.deepEqual(await semanticTarget.getStore('quota_items'), [{ id: 'untouched' }]);
    await assert.rejects(() => createLegacyJsonBackup(memoryAdapter(hostile)), error => error.code === 'BACKUP_SEMANTIC_INVALID');
  }

  const lifecycleAdapter = memoryAdapter({
    resource_items: [{ id: 'r-life', status: 'inactive' }],
    resource_prices: [{ id: 'p-life', resourceId: 'r-life', status: 'withdrawn', unitPrice: 88 }],
    resource_attachments: [],
  });
  const lifecycleJson = await createLegacyJsonBackup(lifecycleAdapter);
  const lifecycleTarget = memoryAdapter();
  await restoreLegacyJsonBackup(lifecycleJson, lifecycleTarget);
  assert.equal((await lifecycleTarget.getStore('resource_prices'))[0].status, 'withdrawn');
  assert.equal((await lifecycleTarget.getStore('resource_items'))[0].status, 'inactive');
  const lifecycleArchive = await createZipBackup(lifecycleAdapter, {}, { zip });
  const lifecycleZipTarget = memoryAdapter();
  await restoreZipBackup(lifecycleArchive, lifecycleZipTarget, { zip });
  assert.equal((await lifecycleZipTarget.getStore('resource_prices'))[0].status, 'withdrawn');
  assert.equal((await lifecycleZipTarget.getStore('resource_items'))[0].status, 'inactive');

  const missingEntries = cloneEntries(entries);
  delete missingEntries['attachments/r1/a1-quote.pdf'];
  await assert.rejects(() => restoreZipBackup(new Blob([zip.zipSync(missingEntries)]), target, { zip }), error => error.code === 'BACKUP_ATTACHMENT_MISSING');
  assert.deepEqual(await target.getStore('resource_items'), before);

  const corrupt = zip.unzipSync(new Uint8Array(await archive.arrayBuffer()));
  corrupt['attachments/r1/a1-quote.pdf'] = new TextEncoder().encode('%PDF-tamper');
  await assert.rejects(() => restoreZipBackup(new Blob([zip.zipSync(corrupt)]), target, { zip }), error => error.code === 'BACKUP_ATTACHMENT_HASH');
  assert.deepEqual(await target.getStore('resource_items'), before);

  const rollback = memoryAdapter({ quota_items: [{ id: 'safe' }], resource_items: [{ id: 'safe-resource' }] });
  rollback.failStoreOnce('resource_items');
  await assert.rejects(() => restoreZipBackup(archive, rollback, { zip }), error => error.code === 'BACKUP_RESTORE_FAILED');
  assert.deepEqual(await rollback.getStore('quota_items'), [{ id: 'safe' }]);
  assert.deepEqual(await rollback.getStore('resource_items'), [{ id: 'safe-resource' }]);

  const partial = memoryAdapter({ quota_items: [{ id: 'safe' }], resource_items: [{ id: 'safe-resource' }] });
  partial.failStoreTimes('resource_items', 2);
  await assert.rejects(() => restoreZipBackup(archive, partial, { zip }), error => error.code === 'BACKUP_RECOVERY_PARTIAL');

  const missingMeta = attachment();
  missingMeta.status = 'missing';
  const missingPolicyAdapter = memoryAdapter({ resource_items: [{ id: 'r1' }], resource_attachments: [missingMeta] });
  const missingPolicyArchive = await createZipBackup(missingPolicyAdapter, {}, { zip });
  const missingPolicyEntries = zip.unzipSync(new Uint8Array(await missingPolicyArchive.arrayBuffer()));
  assert.equal(Object.keys(missingPolicyEntries).some(name => name.startsWith('attachments/')), false);

  const resetOriginal = {
    quota_items: [{ id: 'original-quota' }],
    resource_items: [{ id: 'original-resource' }],
    resource_attachments: [attachment()],
  };
  const generatorFailure = memoryAdapter(resetOriginal, new Map([['a1', pdfBlob()]]));
  await assert.rejects(() => resetWithGenerator(generatorFailure, async () => {
    await generatorFailure.setCacheStore('quota_items', [{ id: 'generated-before-failure' }]);
    throw new Error('injected generator failure');
  }), error => error.code === 'BACKUP_RESET_FAILED');
  assert.deepEqual(await generatorFailure.getStore('quota_items'), resetOriginal.quota_items);
  assert.deepEqual(await generatorFailure.getStore('resource_items'), resetOriginal.resource_items);
  assert.equal(await (await generatorFailure.getAttachment(attachment())).text(), '%PDF-backup');

  const persistFailure = memoryAdapter(resetOriginal, new Map([['a1', pdfBlob()]]));
  persistFailure.failStoreOnCall('resource_items', 2);
  await assert.rejects(() => resetWithGenerator(persistFailure, async () => {
    await persistFailure.setCacheStore('quota_items', [{ id: 'demo-quota' }]);
    await persistFailure.setCacheStore('resource_items', [{ id: 'demo-resource' }]);
    await persistFailure.setCacheStore('resource_attachments', []);
  }), error => error.code === 'BACKUP_RESET_FAILED');
  assert.deepEqual(await persistFailure.getStore('quota_items'), resetOriginal.quota_items);
  assert.deepEqual(await persistFailure.getStore('resource_items'), resetOriginal.resource_items);
  assert.equal(await (await persistFailure.getAttachment(attachment())).text(), '%PDF-backup');

  const resetSuccess = memoryAdapter(resetOriginal, new Map([['a1', pdfBlob()]]));
  await resetWithGenerator(resetSuccess, async () => {
    await resetSuccess.setCacheStore('quota_items', [{ id: 'demo-quota' }]);
    await resetSuccess.setCacheStore('resource_items', [{ id: 'demo-resource' }]);
    await resetSuccess.setCacheStore('resource_attachments', []);
  });
  assert.deepEqual(await resetSuccess.getStore('quota_items'), [{ id: 'demo-quota' }]);
  assert.deepEqual(await resetSuccess.getStore('resource_items'), [{ id: 'demo-resource' }]);
  assert.equal(await resetSuccess.getAttachment(attachment()), null);
}

function cloneEntries(entries) {
  return Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, bytes.slice()]));
}

function attachment() {
  return {
    id: 'a1', resourceId: 'r1', safeFileName: 'quote.pdf', fileName: 'quote.pdf',
    storagePath: 'attachments/r1/a1-quote.pdf', mimeType: 'application/pdf', size: 11,
    sha256: '50329ade570a6760a8512e3b53f4f6c06022a63d6d10e82250e641dea7e34916', status: 'available',
  };
}

function pdfBlob() {
  return new Blob(['%PDF-backup'], { type: 'application/pdf' });
}

function memoryAdapter(initial = {}, initialBlobs = new Map()) {
  const stores = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  const blobs = new Map(initialBlobs);
  let failingStore = '';
  const failureCounts = new Map();
  const failOnCalls = new Map();
  const storeCallCounts = new Map();
  return {
    getStore: async name => structuredClone(stores.get(name) || []),
    setStore: async (name, value) => {
      const callCount = (storeCallCounts.get(name) || 0) + 1;
      storeCallCounts.set(name, callCount);
      if (failOnCalls.get(name) === callCount) throw new Error('injected store call failure');
      const remaining = failureCounts.get(name) || 0;
      if (remaining > 0) { failureCounts.set(name, remaining - 1); throw new Error('injected repeated store failure'); }
      if (name === failingStore) { failingStore = ''; throw new Error('injected store failure'); }
      stores.set(name, structuredClone(value));
    },
    getAttachment: async meta => blobs.get(meta.id) || null,
    setAttachment: async (meta, blob) => blobs.set(meta.id, blob),
    removeAttachment: async meta => blobs.delete(meta.id),
    getCacheStore: async name => structuredClone(stores.get(name) || []),
    setCacheStore: async (name, value) => stores.set(name, structuredClone(value)),
    runCacheOnly: operation => operation(),
    failStoreOnce: name => { failingStore = name; },
    failStoreTimes: (name, count) => failureCounts.set(name, count),
    failStoreOnCall: (name, call) => failOnCalls.set(name, call),
  };
}
