import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const zip = require('../assets/vendor/fflate/fflate.cjs');

export async function testBackupService() {
  const { BACKUP_IMPORT_ACCEPT } = await import('../assets/views/settings.js');
  assert.equal(BACKUP_IMPORT_ACCEPT.includes('.json'), true);
  assert.equal(BACKUP_IMPORT_ACCEPT.includes('.zip'), true);
  const {
    BACKUP_STORES,
    createLegacyJsonBackup,
    createZipBackup,
    parseLegacyJsonBackupFile,
    restoreLegacyJsonBackup,
    restoreZipBackup,
  } = await import('../assets/services/backupService.js');

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

  const badSchemaEntries = cloneEntries(entries);
  badSchemaEntries['backup.json'] = new TextEncoder().encode(JSON.stringify({ quota_items: {} }));
  await assert.rejects(() => restoreZipBackup(new Blob([zip.zipSync(badSchemaEntries)]), target, { zip }), error => error.code === 'BACKUP_STORE_INVALID');
  assert.deepEqual(await target.getStore('resource_items'), before);

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
  return {
    getStore: async name => structuredClone(stores.get(name) || []),
    setStore: async (name, value) => {
      const remaining = failureCounts.get(name) || 0;
      if (remaining > 0) { failureCounts.set(name, remaining - 1); throw new Error('injected repeated store failure'); }
      if (name === failingStore) { failingStore = ''; throw new Error('injected store failure'); }
      stores.set(name, structuredClone(value));
    },
    getAttachment: async meta => blobs.get(meta.id) || null,
    setAttachment: async (meta, blob) => blobs.set(meta.id, blob),
    removeAttachment: async meta => blobs.delete(meta.id),
    failStoreOnce: name => { failingStore = name; },
    failStoreTimes: (name, count) => failureCounts.set(name, count),
  };
}
