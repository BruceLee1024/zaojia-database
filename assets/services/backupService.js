import { STORES } from '../data/repository.js?v=6.11';
import { restoreBackupSafeAIConfig, toBackupSafeAIConfig } from './aiService.js?v=6.11';

export const BACKUP_STORES = Object.freeze(Object.values(STORES));
export const MAX_BACKUP_SIZE = 500 * 1024 * 1024;
export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_MIMES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const BACKUP_APP = 'wastewater-cost-db';
const BACKUP_SCHEMA_VERSION = 3;
const SUPPORTED_BACKUP_SCHEMA_VERSIONS = new Set([2, 3]);

export function createRepositoryBackupAdapter({ getStore, setStore, getAttachment, setAttachment, removeAttachment }) {
  return { getStore, setStore, getAttachment, setAttachment, removeAttachment };
}

export async function createLegacyJsonBackup(adapter, aiConfig = {}) {
  const data = { app: BACKUP_APP, schemaVersion: BACKUP_SCHEMA_VERSION };
  for (const store of BACKUP_STORES) data[store] = await adapter.getStore(store);
  data.ai_config = toBackupSafeAIConfig(aiConfig);
  validateBackupJson(data);
  return data;
}

export async function parseLegacyJsonBackupFile(file, maxSize = MAX_BACKUP_SIZE) {
  if (!(file instanceof Blob)) throw backupError('BACKUP_FILE_INVALID', '请选择 JSON 备份文件。');
  if (file.size > maxSize) throw backupError('BACKUP_TOO_LARGE', '备份文件不能超过 500MB。');
  try { return JSON.parse(await file.text()); }
  catch { throw backupError('BACKUP_JSON_INVALID', 'JSON 备份无法解析。'); }
}

export async function restoreLegacyJsonBackup(data, adapter, options = {}) {
  validateBackupJson(data);
  const normalized = normalizeStores(data);
  normalized.resource_attachments = normalized.resource_attachments.map(meta => ({ ...meta, status: 'missing' }));
  const aiHooks = restoreAIHooks(data, options);
  await replaceWithRollback(normalized, new Map(), adapter, aiHooks);
  return { format: 'json', stores: BACKUP_STORES.length };
}

export async function createZipBackup(adapter, aiConfig = {}, options = {}) {
  const zip = requireZip(options.zip, 'zip');
  const backup = await createLegacyJsonBackup(adapter, aiConfig);
  const files = {};
  const attachmentEntries = [];
  let total = 0;
  for (const meta of backup.resource_attachments) {
    validateAttachmentMetadata(meta);
    const blob = await adapter.getAttachment(meta);
    if (!blob?.size) {
      if (meta.status === 'missing') continue;
      throw backupError('BACKUP_ATTACHMENT_MISSING', `附件缺失：${meta.fileName || meta.id}`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    validateAttachmentBytes(meta, bytes);
    const actualHash = await sha256(bytes);
    if (actualHash !== meta.sha256) throw backupError('BACKUP_ATTACHMENT_HASH', `附件校验失败：${meta.fileName || meta.id}`);
    const path = attachmentPath(meta);
    files[path] = bytes;
    attachmentEntries.push({ path, sha256: actualHash, size: bytes.byteLength, mime: meta.mimeType });
    total += bytes.byteLength;
    if (total > MAX_BACKUP_SIZE) throw backupError('BACKUP_TOO_LARGE', '备份未压缩内容超过 500MB。');
  }
  files['backup.json'] = textEncoder.encode(JSON.stringify(backup, null, 2));
  files['manifest.json'] = textEncoder.encode(JSON.stringify({
    app: BACKUP_APP, schemaVersion: BACKUP_SCHEMA_VERSION, createdAt: new Date().toISOString(),
    attachments: attachmentEntries,
  }, null, 2));
  total += files['backup.json'].byteLength + files['manifest.json'].byteLength;
  if (total > MAX_BACKUP_SIZE) throw backupError('BACKUP_TOO_LARGE', '备份未压缩内容超过 500MB。');
  const archive = await zipFiles(zip, files);
  if (archive.byteLength > (options.maxArchiveSize ?? MAX_BACKUP_SIZE)) throw backupError('BACKUP_TOO_LARGE', '压缩后备份文件超过 500MB。');
  return new Blob([archive], { type: 'application/zip' });
}

export async function restoreZipBackup(file, adapter, options = {}) {
  if (!(file instanceof Blob)) throw backupError('BACKUP_FILE_INVALID', '请选择 ZIP 备份文件。');
  if (file.size > MAX_BACKUP_SIZE) throw backupError('BACKUP_TOO_LARGE', '备份文件不能超过 500MB。');
  const zip = requireZip(options.zip, 'unzip');
  const archiveBytes = new Uint8Array(await file.arrayBuffer());
  validateArchiveDirectory(archiveBytes);
  let entries;
  try { entries = await unzipFiles(zip, archiveBytes); }
  catch { throw backupError('BACKUP_ZIP_INVALID', 'ZIP 备份无法解析。'); }
  const parsed = await validateZipEntries(entries);
  await replaceWithRollback(normalizeStores(parsed.backup), parsed.blobs, adapter, restoreAIHooks(parsed.backup, options));
  return { format: 'zip', stores: BACKUP_STORES.length, attachments: parsed.blobs.size };
}

export async function clearBackupData(adapter) {
  const metadata = await adapter.getStore(STORES.resource_attachments);
  const snapshot = Object.fromEntries(await Promise.all(BACKUP_STORES.map(async store => [store, await adapter.getStore(store)])));
  const blobs = new Map();
  for (const meta of metadata) {
    const blob = await adapter.getAttachment(meta);
    if (blob) blobs.set(meta.id, { meta, blob });
  }
  try {
    for (const meta of metadata) await adapter.removeAttachment(meta);
    for (const store of BACKUP_STORES) await adapter.setStore(store, []);
  } catch (cause) {
    try {
      for (const store of BACKUP_STORES) await adapter.setStore(store, snapshot[store]);
      for (const { meta, blob } of blobs.values()) await adapter.setAttachment(meta, blob);
    } catch (rollbackCause) {
      throw Object.assign(backupError('BACKUP_RECOVERY_PARTIAL', '清理失败，且原数据未能完全恢复。'), { cause, rollbackCause });
    }
    throw Object.assign(backupError('BACKUP_CLEAR_FAILED', '清理失败，原数据已恢复。'), { cause });
  }
}

export async function resetWithGenerator(adapter, generator) {
  const originalStores = Object.fromEntries(await Promise.all(BACKUP_STORES.map(async store => [store, await adapter.getStore(store)])));
  const originalBlobs = new Map();
  for (const meta of originalStores.resource_attachments) {
    const blob = await adapter.getAttachment(meta);
    if (blob) originalBlobs.set(meta.id, { meta, blob });
  }
  let generatedStores = Object.fromEntries(BACKUP_STORES.map(store => [store, []]));
  try {
    for (const meta of originalStores.resource_attachments) await adapter.removeAttachment(meta);
    for (const store of BACKUP_STORES) await adapter.setStore(store, []);
    const runCacheOnly = adapter.runCacheOnly || (operation => operation());
    await runCacheOnly(generator);
    const readGenerated = adapter.getCacheStore || adapter.getStore;
    generatedStores = Object.fromEntries(await Promise.all(BACKUP_STORES.map(async store => [store, (await readGenerated(store)) || []])));
    validateBackupJson({ app: BACKUP_APP, schemaVersion: BACKUP_SCHEMA_VERSION, ...generatedStores });
    for (const store of BACKUP_STORES) await adapter.setStore(store, generatedStores[store]);
    return { stores: BACKUP_STORES.length };
  } catch (cause) {
    try {
      for (const meta of generatedStores.resource_attachments || []) await adapter.removeAttachment(meta);
      for (const store of BACKUP_STORES) await adapter.setStore(store, originalStores[store]);
      for (const { meta, blob } of originalBlobs.values()) await adapter.setAttachment(meta, blob);
    } catch (rollbackCause) {
      throw Object.assign(backupError('BACKUP_RECOVERY_PARTIAL', '重置失败，且原数据未能完全恢复。'), { cause, rollbackCause });
    }
    throw Object.assign(backupError('BACKUP_RESET_FAILED', '重置失败，原数据已恢复。'), { cause });
  }
}

async function validateZipEntries(entries) {
  const names = Object.keys(entries);
  if (!names.includes('backup.json') || !names.includes('manifest.json')) {
    throw backupError('BACKUP_SCHEMA_INVALID', 'ZIP 必须包含 backup.json 和 manifest.json。');
  }
  let total = 0;
  for (const name of names) {
    total += entries[name].byteLength;
    if (total > MAX_BACKUP_SIZE) throw backupError('BACKUP_TOO_LARGE', '备份未压缩内容超过 500MB。');
    if (!isSafeEntry(name) || !(['backup.json', 'manifest.json'].includes(name) || name.startsWith('attachments/'))) {
      throw backupError('BACKUP_ENTRY_INVALID', `ZIP 包含不允许的路径：${name}`);
    }
  }
  const backup = parseJsonEntry(entries['backup.json'], 'backup.json');
  const manifest = parseJsonEntry(entries['manifest.json'], 'manifest.json');
  validateBackupJson(backup);
  if (backup.app !== BACKUP_APP || backup.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw backupError('BACKUP_SCHEMA_INVALID', 'backup.json 的应用标识或 schemaVersion 无效。');
  }
  if (!isRecord(manifest) || manifest.app !== BACKUP_APP || manifest.schemaVersion !== BACKUP_SCHEMA_VERSION || !Array.isArray(manifest.attachments)) {
    throw backupError('BACKUP_SCHEMA_INVALID', 'manifest.json 必须使用 schemaVersion 2。');
  }
  const metadata = new Map(backup.resource_attachments.map(meta => [meta.id, meta]));
  const resources = new Set(backup.resource_items.map(resource => resource.id));
  const declared = new Set();
  const blobs = new Map();
  for (const item of manifest.attachments) {
    if (!isRecord(item) || typeof item.path !== 'string' || !Number.isInteger(item.size) || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !ALLOWED_ATTACHMENT_MIMES.has(item.mime)) {
      throw backupError('BACKUP_SCHEMA_INVALID', '附件清单格式无效。');
    }
    if (declared.has(item.path)) throw backupError('BACKUP_ENTRY_DUPLICATE', '附件清单包含重复路径。');
    declared.add(item.path);
    const meta = [...metadata.values()].find(value => attachmentPath(value) === item.path);
    if (!meta || !resources.has(meta.resourceId) || item.mime !== meta.mimeType) throw backupError('BACKUP_ATTACHMENT_OWNERSHIP', '附件路径或所属关系无效。');
    const bytes = entries[item.path];
    if (!bytes) throw backupError('BACKUP_ATTACHMENT_MISSING', `ZIP 缺少附件：${item.path}`);
    if (bytes.byteLength !== item.size || bytes.byteLength !== meta.size) throw backupError('BACKUP_ATTACHMENT_SIZE', `附件大小不匹配：${item.path}`);
    if (await sha256(bytes) !== item.sha256 || item.sha256 !== meta.sha256) throw backupError('BACKUP_ATTACHMENT_HASH', `附件校验失败：${item.path}`);
    validateAttachmentBytes(meta, bytes);
    blobs.set(meta.id, new Blob([bytes], { type: meta.mimeType }));
  }
  for (const meta of metadata.values()) {
    validateAttachmentMetadata(meta);
    if (meta.status !== 'missing' && !declared.has(attachmentPath(meta))) {
      throw backupError('BACKUP_ATTACHMENT_MISSING', `ZIP 缺少附件：${attachmentPath(meta)}`);
    }
  }
  for (const name of names.filter(name => name.startsWith('attachments/'))) {
    if (!declared.has(name)) throw backupError('BACKUP_ENTRY_INVALID', `ZIP 包含未声明的附件：${name}`);
  }
  return { backup, blobs };
}

async function replaceWithRollback(nextStores, nextBlobs, adapter, hooks = {}) {
  const oldStores = {};
  const oldBlobs = new Map();
  for (const store of BACKUP_STORES) oldStores[store] = await adapter.getStore(store);
  for (const meta of oldStores.resource_attachments) {
    const blob = await adapter.getAttachment(meta);
    if (blob) oldBlobs.set(meta.id, { meta, blob });
  }
  try {
    for (const meta of oldStores.resource_attachments) await adapter.removeAttachment(meta);
    for (const store of BACKUP_STORES) await adapter.setStore(store, nextStores[store]);
    for (const meta of nextStores.resource_attachments) {
      const blob = nextBlobs.get(meta.id);
      if (blob) await adapter.setAttachment(meta, blob);
    }
    await hooks.afterApply?.();
  } catch (cause) {
    try {
      for (const meta of nextStores.resource_attachments) await adapter.removeAttachment(meta);
      for (const store of BACKUP_STORES) await adapter.setStore(store, oldStores[store]);
      for (const { meta, blob } of oldBlobs.values()) await adapter.setAttachment(meta, blob);
      await hooks.afterRollback?.();
    } catch (rollbackCause) {
      throw Object.assign(backupError('BACKUP_RECOVERY_PARTIAL', '恢复失败，且当前数据未能完全补偿。'), { cause, rollbackCause });
    }
    throw Object.assign(backupError('BACKUP_RESTORE_FAILED', '恢复失败，当前数据已恢复。'), { cause });
  }
}

function restoreAIHooks(data, options) {
  if (!options.setAI || !data.ai_config) return {};
  const current = { ...(options.currentAI || {}) };
  return {
    afterApply: () => options.setAI(restoreBackupSafeAIConfig(data.ai_config, current)),
    afterRollback: () => options.setAI(current),
  };
}

function normalizeStores(data) {
  return Object.fromEntries(BACKUP_STORES.map(store => [store, data[store] || []]));
}

function validateBackupJson(data) {
  if (!isRecord(data)) throw backupError('BACKUP_SCHEMA_INVALID', '备份根对象无效。');
  if ((data.app != null && data.app !== BACKUP_APP) || (data.schemaVersion != null && !SUPPORTED_BACKUP_SCHEMA_VERSIONS.has(Number(data.schemaVersion)))) {
    throw backupError('BACKUP_SCHEMA_INVALID', '备份的应用标识或 schemaVersion 无效。');
  }
  for (const store of BACKUP_STORES) {
    if (data[store] != null && !Array.isArray(data[store])) throw backupError('BACKUP_STORE_INVALID', `数据表 ${store} 必须是数组。`);
    if (Array.isArray(data[store]) && data[store].some(item => !isRecord(item))) throw backupError('BACKUP_STORE_INVALID', `数据表 ${store} 包含无效记录。`);
  }
  if (data.ai_config != null && !isRecord(data.ai_config)) throw backupError('BACKUP_SCHEMA_INVALID', 'AI 配置格式无效。');
  validateBusinessSemantics(normalizeStores(data));
}

function validateBusinessSemantics(stores) {
  for (const [store, records] of Object.entries(stores)) {
    const seen = new Set();
    for (const record of records) {
      if (record.id == null || record.id === '') throw backupError('BACKUP_SEMANTIC_INVALID', `数据表 ${store} 包含缺少 ID 的记录。`);
      const id = String(record.id);
      validateCanonicalId(id, `数据表 ${store} 的 ID`);
      if (seen.has(id)) throw backupError('BACKUP_SEMANTIC_INVALID', `数据表 ${store} 包含重复 ID：${id}`);
      seen.add(id);
      validateRecordReferences(record, `数据表 ${store}`);
    }
  }
  for (const record of stores.resource_items) validateCanonicalId(record.id, '资源 ID');
  for (const price of stores.resource_prices) {
    validateCanonicalId(price.id, '价格 ID');
    validateCanonicalId(price.resourceId, '价格资源引用');
  }
  for (const usage of stores.quota_resource_usages) {
    validateCanonicalId(usage.id, '用量 ID');
    validateCanonicalId(usage.resourceId, '用量资源引用');
    validateCanonicalId(usage.quotaItemId, '用量定额引用');
    if (usage.selectedPriceId) validateCanonicalId(usage.selectedPriceId, '用量价格引用');
  }
  for (const meta of stores.resource_attachments) {
    validateCanonicalId(meta.id, '附件 ID');
    validateCanonicalId(meta.resourceId, '附件资源引用');
    if (meta.priceId) validateCanonicalId(meta.priceId, '附件价格引用');
  }
  const resourceIds = new Set(stores.resource_items.map(record => record.id));
  const quotaIds = new Set(stores.quota_items.map(record => record.id));
  const libraryIds = new Set(stores.boq_library_items.map(record => record.id));
  const projectBoqIds = new Set(stores.project_boq.map(record => record.id));
  const prices = new Map(stores.resource_prices.map(record => [record.id, record]));
  for (const resource of stores.resource_items) {
    if (!resource.preferredPriceId) continue;
    const preferred = prices.get(resource.preferredPriceId);
    if (!preferred || preferred.resourceId !== resource.id || preferred.status === 'withdrawn') {
      throw backupError('BACKUP_SEMANTIC_INVALID', `资源 ${resource.id} 的首选价格引用无效。`);
    }
  }
  for (const price of stores.resource_prices) {
    if (!resourceIds.has(price.resourceId)) throw backupError('BACKUP_SEMANTIC_INVALID', `资源价格 ${price.id} 引用了不存在的资源。`);
  }
  for (const usage of stores.quota_resource_usages) {
    if (!resourceIds.has(usage.resourceId) || !quotaIds.has(usage.quotaItemId)) {
      throw backupError('BACKUP_SEMANTIC_INVALID', `定额资源用量 ${usage.id} 存在无效引用。`);
    }
    if (usage.selectedPriceId) {
      const price = prices.get(usage.selectedPriceId);
      if (!price || price.resourceId !== usage.resourceId) {
        throw backupError('BACKUP_SEMANTIC_INVALID', `定额资源用量 ${usage.id} 的价格引用无效。`);
      }
    }
  }
  for (const relation of stores.boq_library_quota_relations) {
    if (!libraryIds.has(relation.boqLibraryItemId)) throw backupError('BACKUP_SEMANTIC_INVALID', `清单定额关系 ${relation.id} 引用了不存在的清单。`);
    if (relation.quotaItemId && !quotaIds.has(relation.quotaItemId) && relation.referenceStatus !== 'missing') throw backupError('BACKUP_SEMANTIC_INVALID', `清单定额关系 ${relation.id} 引用了不存在的定额。`);
    if ((!relation.quotaItemId || relation.referenceStatus === 'missing') && !isRecord(relation.quotaSnapshot)) throw backupError('BACKUP_SEMANTIC_INVALID', `清单定额关系 ${relation.id} 缺少价格快照。`);
  }
  for (const relation of stores.project_boq_quota_relations) {
    if (!projectBoqIds.has(relation.projectBoqLineId)) throw backupError('BACKUP_SEMANTIC_INVALID', `项目定额关系 ${relation.id} 引用了不存在的项目清单。`);
    if (relation.quotaItemId && !quotaIds.has(relation.quotaItemId) && relation.referenceStatus !== 'missing') throw backupError('BACKUP_SEMANTIC_INVALID', `项目定额关系 ${relation.id} 引用了不存在的定额。`);
    if ((!relation.quotaItemId || relation.referenceStatus === 'missing') && !isRecord(relation.quotaSnapshot)) throw backupError('BACKUP_SEMANTIC_INVALID', `项目定额关系 ${relation.id} 缺少价格快照。`);
  }
  const attachmentPaths = new Set();
  for (const meta of stores.resource_attachments) {
    validateAttachmentMetadata(meta);
    if (!resourceIds.has(meta.resourceId)) throw backupError('BACKUP_SEMANTIC_INVALID', `附件 ${meta.id} 引用了不存在的资源。`);
    if (meta.priceId) {
      const price = prices.get(meta.priceId);
      if (!price || price.resourceId !== meta.resourceId) throw backupError('BACKUP_SEMANTIC_INVALID', `附件 ${meta.id} 的价格引用无效。`);
    }
    const path = attachmentPath(meta);
    if (attachmentPaths.has(path)) throw backupError('BACKUP_SEMANTIC_INVALID', `附件包含重复路径：${path}`);
    attachmentPaths.add(path);
  }
}

const REFERENCE_FIELDS = new Set([
  'projectId', 'quotaItemId', 'resourceId', 'resourceItemId', 'resourcePriceId', 'selectedPriceId', 'priceId',
  'boqLibraryItemId', 'projectBoqLineId', 'sourceLibraryRelationId',
  'linkedResourceItemId', 'linkedEquipmentLineId', 'installationResourceItemId', 'manualInstallationResourceId',
  'versionId', 'indicatorId', 'sessionId', 'cardId', 'jobId', 'reportId', 'preferredPriceId',
]);
const REFERENCE_ARRAY_FIELDS = new Set(['projectIds', 'quotaItemIds', 'resourceIds', 'priceIds', 'versionIds']);

function validateRecordReferences(record, label) {
  for (const [field, value] of Object.entries(record)) {
    if (REFERENCE_FIELDS.has(field) && value != null && value !== '') validateCanonicalId(value, `${label} 的 ${field}`);
    if (REFERENCE_ARRAY_FIELDS.has(field) && value != null) {
      if (!Array.isArray(value)) throw backupError('BACKUP_SEMANTIC_INVALID', `${label} 的 ${field} 必须是数组。`);
      value.forEach(item => validateCanonicalId(item, `${label} 的 ${field}`));
    }
  }
  if (Array.isArray(record.lines)) record.lines.forEach(line => {
    if (!isRecord(line)) throw backupError('BACKUP_SEMANTIC_INVALID', `${label} 的版本行无效。`);
    if (line.id) validateCanonicalId(line.id, `${label} 的版本行 ID`);
    validateRecordReferences(line, `${label} 的版本行`);
  });
}

function validateAttachmentMetadata(meta) {
  if (!isRecord(meta) || !safeSegment(meta.id) || !safeSegment(meta.resourceId) || !safeFileName(meta.safeFileName) || !ALLOWED_ATTACHMENT_MIMES.has(meta.mimeType) || !Number.isInteger(meta.size) || meta.size <= 0 || meta.size > MAX_ATTACHMENT_SIZE || !/^[a-f0-9]{64}$/.test(meta.sha256 || '') || meta.storagePath !== attachmentPath(meta)) {
    throw backupError('BACKUP_ATTACHMENT_METADATA', '附件元数据无效。');
  }
}

function validateAttachmentBytes(meta, bytes) {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_ATTACHMENT_SIZE) throw backupError('BACKUP_ATTACHMENT_SIZE', '单个附件必须大于 0 且不超过 20MB。');
  if (bytes.byteLength !== meta.size) throw backupError('BACKUP_ATTACHMENT_SIZE', '附件实际大小与元数据不匹配。');
  const signatures = {
    'application/pdf': [[0x25, 0x50, 0x44, 0x46, 0x2d]],
    'image/jpeg': [[0xff, 0xd8, 0xff]],
    'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    'application/vnd.ms-excel': [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [[0x50, 0x4b, 0x03, 0x04]],
  };
  if (!signatures[meta.mimeType]?.some(signature => signature.every((byte, index) => bytes[index] === byte))) {
    throw backupError('BACKUP_ATTACHMENT_TYPE', '附件内容与声明类型不匹配。');
  }
}

function validateArchiveDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new Set();
  let total = 0;
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw backupError('BACKUP_ZIP_INVALID', 'ZIP 目录结构无效。');
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff || offset + directorySize > eocd) {
    throw backupError('BACKUP_ZIP_INVALID', '不支持 ZIP64 或损坏的 ZIP 目录。');
  }
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw backupError('BACKUP_ZIP_INVALID', 'ZIP 目录结构无效。');
    }
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) throw backupError('BACKUP_ZIP_INVALID', 'ZIP 目录结构无效。');
    const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (names.has(name)) throw backupError('BACKUP_ENTRY_DUPLICATE', `ZIP 包含重复路径：${name}`);
    names.add(name);
    total += size;
    if (total > MAX_BACKUP_SIZE) throw backupError('BACKUP_TOO_LARGE', '备份未压缩内容超过 500MB。');
    offset = end;
  }
  if (count < 2 || offset !== view.getUint32(eocd + 16, true) + directorySize) throw backupError('BACKUP_ZIP_INVALID', 'ZIP 目录结构无效。');
}

function attachmentPath(meta) { return `attachments/${meta.resourceId}/${meta.id}-${meta.safeFileName}`; }
function validateCanonicalId(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(value || ''))) {
    throw backupError('BACKUP_SEMANTIC_INVALID', `${label}包含不安全字符或长度超限。`);
  }
}
function safeSegment(value) { return /^[a-zA-Z0-9_-]+$/.test(String(value || '')); }
function safeFileName(value) { const text = String(value || ''); return Boolean(text) && !/[\\/]/.test(text) && !text.includes('..'); }
function isSafeEntry(name) { return !name.startsWith('/') && !name.includes('\\') && !name.split('/').some(part => part === '..' || part === '.'); }
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function parseJsonEntry(bytes, name) { try { return JSON.parse(textDecoder.decode(bytes)); } catch { throw backupError('BACKUP_JSON_INVALID', `${name} 无法解析。`); } }
function requireZip(injected, operation) {
  const zip = injected || globalThis.fflate;
  const available = operation === 'zip' ? (zip?.zip || zip?.zipSync) : (zip?.unzip || zip?.unzipSync);
  if (!available) throw backupError('BACKUP_ZIP_UNAVAILABLE', 'ZIP 组件未加载。');
  return zip;
}
function zipFiles(zip, files) {
  if (zip.zip) return new Promise((resolve, reject) => zip.zip(files, { level: 6 }, (error, bytes) => error ? reject(error) : resolve(bytes)));
  return Promise.resolve(zip.zipSync(files, { level: 6 }));
}
function unzipFiles(zip, bytes) {
  if (zip.unzip) return new Promise((resolve, reject) => zip.unzip(bytes, (error, files) => error ? reject(error) : resolve(files)));
  return Promise.resolve(zip.unzipSync(bytes));
}
async function sha256(bytes) { const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''); }
function backupError(code, message) { return Object.assign(new Error(message), { code }); }
