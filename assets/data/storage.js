// 存储适配层：默认 IndexedDB，用户授权后可镜像并读写本地文件夹 JSON。
import { idb } from './idb-bridge.js?v=6.8';

const STORAGE_MODE_KEY = '__costdb_storage_mode';
const DIRECTORY_HANDLE_KEY = '__costdb_directory_handle';
const PENDING_SYNC_KEY = 'costdb_folder_pending_sync';
const SYNC_META_KEY = 'costdb_folder_sync_meta';
const DATA_PROFILE_KEY = '__costdb_data_profile';
const DATA_PROFILES = new Set(['personal', 'demo']);
const STORE_DIR = 'stores';
const BACKUP_DIR = 'backups';
const ATTACHMENT_DIR = 'attachments';
const MANIFEST_FILE = 'manifest.json';
const ATTACHMENT_KEY_PREFIX = '__costdb_attachment:';

let folderMutationQueue = Promise.resolve();
let folderMirrorSuspension = 0;

export function isLocalFolderSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function getStorageMode() {
  return (await idb.get(STORAGE_MODE_KEY)) || 'indexeddb';
}

export function getDataProfile() {
  const profile = localStorage.getItem(DATA_PROFILE_KEY) || 'personal';
  return DATA_PROFILES.has(profile) ? profile : 'personal';
}

export function setDataProfile(profile) {
  if (!DATA_PROFILES.has(profile)) throw new Error('资料库类型无效');
  localStorage.setItem(DATA_PROFILE_KEY, profile);
  return profile;
}

function scopedStoreKey(store) { return `__costdb_profile:${getDataProfile()}:${store}`; }

async function readProfileStore(store, key = scopedStoreKey(store)) {
  if (typeof window === 'undefined') return await idb.get(store);
  const scoped = await idb.get(key);
  if (scoped !== undefined && scoped !== null) return scoped;
  if (getDataProfile() !== 'personal') return scoped;
  const legacy = await idb.get(store);
  if (legacy !== undefined && legacy !== null) await idb.set(key, legacy);
  return legacy;
}

export async function storageGet(store) {
  const key = scopedStoreKey(store);
  if (await getStorageMode() !== 'folder') return await readProfileStore(store, key);
  const handle = await getStoredDirectoryHandle();
  if (!handle || !(await hasPermission(handle, 'read'))) return await readProfileStore(store, key);
  try {
    const records = await readStoreFromDirectory(handle, store);
    if (records) await idb.set(key, records);
    return records || await readProfileStore(store, key);
  } catch (err) {
    console.warn(`[storage] read folder store failed: ${store}`, err);
    return await readProfileStore(store, key);
  }
}

export async function storageSet(store, value) {
  await idb.set(typeof window === 'undefined' ? store : scopedStoreKey(store), value);
  if (folderMirrorSuspension > 0) return;
  if (await getStorageMode() !== 'folder') return;
  const handle = await getStoredDirectoryHandle();
  if (!handle || !(await hasPermission(handle, 'readwrite'))) {
    markPendingSync(true, { error: '本地文件夹未授权，数据仅保存在浏览器镜像。', stores: [store] });
    return;
  }
  return enqueueFolderMutation(async () => {
    try {
      await writeStoreToDirectory(handle, store, value);
      await updateManifest(handle, [store]);
      markPendingSync(false, { stores: [store] });
    } catch (err) {
      markPendingSync(true, { error: String(err?.message || '写入本地文件夹失败'), stores: [store] });
      console.error(`[storage] write folder store failed: ${store}`, err);
    }
  });
}

export async function storageGetCache(store) {
  return await readProfileStore(store);
}

export async function withFolderMirrorSuspended(operation) {
  folderMirrorSuspension += 1;
  try { return await operation(); }
  finally { folderMirrorSuspension -= 1; }
}

// 备份恢复/清理专用：文件夹模式下必须同时写成 store、manifest 和 IDB，任一失败即回滚并向上抛出。
// 普通 CRUD 继续使用 storageSet 的最终一致/待同步语义。
export async function storageSetStrict(store, value) {
  return enqueueFolderMutation(async () => {
    const key = scopedStoreKey(store);
    const previousIdb = await readProfileStore(store, key);
    if (await getStorageMode() !== 'folder') {
      await idb.set(typeof window === 'undefined' ? store : key, value);
      return;
    }
    const handle = await getStoredDirectoryHandle();
    if (!handle || !(await hasPermission(handle, 'readwrite'))) {
      markPendingSync(true);
      throw strictStorageError('STORAGE_STRICT_WRITE_FAILED', '本地数据文件夹未授权读写。');
    }
    const storesDir = await handle.getDirectoryHandle(STORE_DIR, { create: true });
    const previousStoreFile = await readOptionalFile(storesDir, `${store}.json`);
    const previousManifestFile = await readOptionalFile(handle, MANIFEST_FILE);
    try {
      await writeStoreToDirectory(handle, store, value);
      await updateManifest(handle, [store]);
      await idb.set(typeof window === 'undefined' ? store : key, value);
      markPendingSync(false);
    } catch (cause) {
      markPendingSync(true);
      try {
        await restoreOptionalFile(storesDir, `${store}.json`, previousStoreFile);
        await restoreOptionalFile(handle, MANIFEST_FILE, previousManifestFile);
        if (previousIdb === undefined) await idb.del(key);
        else await idb.set(key, previousIdb);
      } catch (rollbackCause) {
        throw Object.assign(strictStorageError('STORAGE_STRICT_RECOVERY_PARTIAL', '严格写入失败，且文件夹与浏览器镜像未能完全恢复。'), { cause, rollbackCause });
      }
      throw Object.assign(strictStorageError('STORAGE_STRICT_WRITE_FAILED', '严格写入失败，原数据已恢复。'), { cause });
    }
  });
}

export async function storageSetAttachment(meta, blob) {
  const key = attachmentStorageKey(meta);
  const handle = await attachmentWritableFolderHandle();
  await idb.set(key, blob);
  if (!handle) return;
  try {
    await enqueueFolderMutation(async () => {
      const { directory, fileName } = await attachmentFileTarget(handle, meta, true);
      const fileHandle = await directory.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      await updateAttachmentManifest(handle, meta, false);
    });
  } catch (error) {
    await idb.del(key);
    throw normalizeAttachmentFolderError(error);
  }
}

export async function storageGetAttachment(meta) {
  const key = attachmentStorageKey(meta);
  if (await getStorageMode() === 'folder') {
    const handle = await getStoredDirectoryHandle();
    if (handle && await hasPermission(handle, 'read')) {
      try {
        const { directory, fileName } = await attachmentFileTarget(handle, meta, false);
        const fileHandle = await directory.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        if (file?.size) return file;
      } catch (error) {
        if (error?.name !== 'NotFoundError') console.warn('[storage] read folder attachment failed', error);
      }
    }
  }
  return await idb.get(key) || null;
}

export async function storageRemoveAttachment(meta) {
  const key = attachmentStorageKey(meta);
  const handle = await attachmentWritableFolderHandle();
  if (handle) {
    await enqueueFolderMutation(async () => {
      try {
        const { directory, fileName } = await attachmentFileTarget(handle, meta, false);
        await directory.removeEntry(fileName);
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw normalizeAttachmentFolderError(error);
      }
      await updateAttachmentManifest(handle, meta, true);
    });
  }
  await idb.del(key);
}

export async function getStorageStatus() {
  const mode = await getStorageMode();
  const handle = await getStoredDirectoryHandle();
  const permission = handle ? await permissionState(handle, 'readwrite') : 'missing';
  return {
    mode, profile: getDataProfile(),
    supported: isLocalFolderSupported(),
    hasHandle: Boolean(handle),
    directoryName: handle?.name || '',
    permission,
    connected: mode === 'folder' && Boolean(handle) && permission === 'granted',
    pendingSync: localStorage.getItem(PENDING_SYNC_KEY) === 'true',
    syncMeta: readSyncMeta(),
  };
}

export async function activateLocalFolderStorage(snapshotOrFactory) {
  if (!isLocalFolderSupported()) throw new Error('当前浏览器不支持选择本地数据文件夹，请使用 Chrome 或 Edge。');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  if (!(await requestPermission(handle, 'readwrite'))) throw new Error('未获得本地文件夹读写权限。');
  const snapshot = typeof snapshotOrFactory === 'function'
    ? await snapshotOrFactory()
    : snapshotOrFactory;
  await persistDirectoryHandle(handle);
  await writeStoresToDirectory(handle, snapshot, { backupLabel: 'initial-migration' });
  await idb.set(STORAGE_MODE_KEY, 'folder');
  markPendingSync(false);
  return await getStorageStatus();
}

export async function reconnectLocalFolderStorage() {
  const handle = await getStoredDirectoryHandle();
  if (!handle) throw new Error('没有找到已保存的数据文件夹授权，请重新选择文件夹。');
  if (!(await requestPermission(handle, 'readwrite'))) throw new Error('未获得本地文件夹读写权限。');
  await idb.set(STORAGE_MODE_KEY, 'folder');
  return await getStorageStatus();
}

export async function syncBrowserCacheToLocalFolder(snapshot) {
  const handle = await getStoredDirectoryHandle();
  if (!handle) throw new Error('没有找到已保存的数据文件夹授权，请重新选择文件夹。');
  if (!(await requestPermission(handle, 'readwrite'))) throw new Error('未获得本地文件夹读写权限。');
  await writeStoresToDirectory(handle, snapshot, { backupLabel: 'manual-sync' });
  await idb.set(STORAGE_MODE_KEY, 'folder');
  markPendingSync(false);
  return await getStorageStatus();
}

export async function switchToBrowserStorage() {
  await idb.set(STORAGE_MODE_KEY, 'indexeddb');
  markPendingSync(false);
  return await getStorageStatus();
}

export async function writeStoresToDirectory(rootHandle, snapshot, options = {}) {
  return enqueueFolderMutation(() => writeStoresToDirectoryNow(rootHandle, snapshot, options));
}

async function writeStoresToDirectoryNow(rootHandle, snapshot, options = {}) {
  await ensureFolderLayout(rootHandle);
  const stores = Object.keys(snapshot).filter(key => Array.isArray(snapshot[key]));
  if (options.backupLabel) {
    const existing = await readExistingStores(rootHandle, stores);
    await writeBackup(rootHandle, Object.keys(existing).length ? existing : snapshot, options.backupLabel);
  }
  for (const store of stores) {
    await writeStoreToDirectory(rootHandle, store, snapshot[store]);
  }
  await writeManifest(rootHandle, stores);
}

function enqueueFolderMutation(operation) {
  const queued = folderMutationQueue.catch(() => {}).then(operation);
  folderMutationQueue = queued.catch(() => {});
  return queued;
}

export async function readStoreFromDirectory(rootHandle, store) {
  const storesDir = await rootHandle.getDirectoryHandle(STORE_DIR, { create: true });
  try {
    const fileHandle = await storesDir.getFileHandle(`${store}.json`);
    const text = await (await fileHandle.getFile()).text();
    if (!text.trim()) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.records) ? parsed.records : []);
  } catch (err) {
    if (err?.name === 'NotFoundError') return [];
    throw err;
  }
}

async function writeStoreToDirectory(rootHandle, store, records) {
  const storesDir = await rootHandle.getDirectoryHandle(STORE_DIR, { create: true });
  await writeJsonFile(storesDir, `${store}.json`, {
    schemaVersion: 1,
    store,
    updatedAt: new Date().toISOString(),
    revision: Date.now(),
    records: Array.isArray(records) ? records : [],
  });
}

async function ensureFolderLayout(rootHandle) {
  await rootHandle.getDirectoryHandle(STORE_DIR, { create: true });
  await rootHandle.getDirectoryHandle(BACKUP_DIR, { create: true });
}

function attachmentStorageKey(meta) {
  const id = safePathSegment(meta?.id);
  if (!id) throw new Error('附件 ID 无效。');
  return `${ATTACHMENT_KEY_PREFIX}${getDataProfile()}:${id}`;
}

async function attachmentWritableFolderHandle() {
  if (await getStorageMode() !== 'folder') return null;
  const handle = await getStoredDirectoryHandle();
  if (!handle || !(await hasPermission(handle, 'readwrite'))) {
    markPendingSync(true);
    throw attachmentFolderPermissionError();
  }
  return handle;
}

function normalizeAttachmentFolderError(error) {
  if (error?.code === 'ATTACHMENT_FOLDER_PERMISSION') return error;
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return attachmentFolderPermissionError();
  return error;
}

function attachmentFolderPermissionError() {
  return Object.assign(new Error('本地数据文件夹未授权读写，请先在设置中重新连接。'), {
    code: 'ATTACHMENT_FOLDER_PERMISSION',
  });
}

async function attachmentFileTarget(rootHandle, meta, create) {
  const resourceId = safePathSegment(meta?.resourceId);
  const id = safePathSegment(meta?.id);
  const safeFileName = safeAttachmentFileName(meta?.safeFileName || meta?.fileName);
  if (!resourceId || !id || !safeFileName) throw new Error('附件存储路径无效。');
  const attachments = await rootHandle.getDirectoryHandle(ATTACHMENT_DIR, { create });
  const directory = await attachments.getDirectoryHandle(resourceId, { create });
  return { directory, fileName: `${id}-${safeFileName}` };
}

function safePathSegment(value) {
  const text = String(value || '');
  return /^[a-zA-Z0-9_-]+$/.test(text) ? text : '';
}

function safeAttachmentFileName(value) {
  const text = String(value || '');
  return text && !/[\\/]/.test(text) && !text.includes('..') ? text : '';
}

async function updateManifest(rootHandle, changedStores) {
  const manifest = await readManifest(rootHandle);
  const stores = { ...(manifest.stores || {}) };
  for (const store of changedStores) {
    stores[store] = { file: `${STORE_DIR}/${store}.json`, revision: Date.now() };
  }
  await writeJsonFile(rootHandle, MANIFEST_FILE, buildManifest(Object.keys(stores), stores, manifest.attachments));
}

async function writeManifest(rootHandle, storeNames) {
  const manifest = await readManifest(rootHandle);
  const stores = {};
  for (const store of storeNames) {
    stores[store] = { file: `${STORE_DIR}/${store}.json`, revision: Date.now() };
  }
  await writeJsonFile(rootHandle, MANIFEST_FILE, buildManifest(storeNames, stores, manifest.attachments));
}

async function updateAttachmentManifest(rootHandle, meta, remove) {
  const manifest = await readManifest(rootHandle);
  const attachments = { ...(manifest.attachments || {}) };
  if (remove) delete attachments[meta.id];
  else attachments[meta.id] = {
    path: `attachments/${meta.resourceId}/${meta.id}-${meta.safeFileName}`,
    resourceId: meta.resourceId,
    size: meta.size,
    mime: meta.mimeType,
    sha256: meta.sha256,
    revision: Date.now(),
  };
  const stores = { ...(manifest.stores || {}) };
  await writeJsonFile(rootHandle, MANIFEST_FILE, buildManifest(Object.keys(stores), stores, attachments));
}

async function readManifest(rootHandle) {
  try {
    const fileHandle = await rootHandle.getFileHandle(MANIFEST_FILE);
    const text = await (await fileHandle.getFile()).text();
    return text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    if (err?.name === 'NotFoundError') return {};
    throw err;
  }
}

function buildManifest(storeNames, stores, attachments = {}) {
  return {
    app: 'wastewater-cost-db',
    schemaVersion: 2,
    storage: 'local-folder-json',
    updatedAt: new Date().toISOString(),
    storeCount: storeNames.length,
    stores,
    attachments: attachments && typeof attachments === 'object' ? attachments : {},
  };
}

async function writeBackup(rootHandle, snapshot, label) {
  const backupsDir = await rootHandle.getDirectoryHandle(BACKUP_DIR, { create: true });
  const safeLabel = String(label || 'backup').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  await writeJsonFile(backupsDir, `${safeLabel}-${timestampForFile()}.json`, {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    reason: label,
    data: snapshot,
  });
}

async function readExistingStores(rootHandle, stores) {
  const existing = {};
  for (const store of stores) {
    const records = await readStoreFromDirectory(rootHandle, store);
    if (records.length) existing[store] = records;
  }
  return existing;
}

async function writeJsonFile(directoryHandle, name, data) {
  const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

async function readOptionalFile(directoryHandle, name) {
  try {
    return await (await directoryHandle.getFileHandle(name)).getFile();
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}

async function restoreOptionalFile(directoryHandle, name, blob) {
  if (!blob) {
    try { await directoryHandle.removeEntry(name); }
    catch (error) { if (error?.name !== 'NotFoundError') throw error; }
    return;
  }
  const writable = await (await directoryHandle.getFileHandle(name, { create: true })).createWritable();
  await writable.write(blob);
  await writable.close();
}

function strictStorageError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function getStoredDirectoryHandle() {
  try {
    return await idb.get(DIRECTORY_HANDLE_KEY);
  } catch (err) {
    console.warn('[storage] read directory handle failed', err);
    return null;
  }
}

async function persistDirectoryHandle(handle) {
  await idb.set(DIRECTORY_HANDLE_KEY, handle);
}

async function permissionState(handle, mode) {
  if (!handle?.queryPermission) return handle ? 'granted' : 'missing';
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return 'prompt';
  }
}

async function hasPermission(handle, mode) {
  return await permissionState(handle, mode) === 'granted';
}

async function requestPermission(handle, mode) {
  if (!handle?.requestPermission) return true;
  if (await permissionState(handle, mode) === 'granted') return true;
  return await handle.requestPermission({ mode }) === 'granted';
}

function markPendingSync(value, meta = {}) {
  localStorage.setItem(PENDING_SYNC_KEY, value ? 'true' : 'false');
  const previous = readSyncMeta();
  localStorage.setItem(SYNC_META_KEY, JSON.stringify(value
    ? { ...previous, lastErrorAt: new Date().toISOString(), error: meta.error || previous.error || '', stores: [...new Set([...(previous.stores || []), ...(meta.stores || [])])] }
    : { lastSuccessAt: new Date().toISOString(), lastErrorAt: '', error: '', stores: meta.stores || [] }));
}

function readSyncMeta() {
  try { return JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}') || {}; } catch { return {}; }
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
