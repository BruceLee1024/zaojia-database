import assert from 'node:assert/strict';
import { STORES, resourcePriceRepo, resourceRepo } from '../assets/data/repository.js';
import { resourceImportService } from '../assets/services/resourceImportService.js';
import { resourceService } from '../assets/services/resourceService.js';
import { searchAll, searchGroups } from '../assets/services/globalSearchService.js';
import { getResourceTemplateData } from '../assets/data/excel.js';

export async function testResourceWorkbench() {
  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  delete globalThis.window;
  try {
    await reset();
    await testPreviewUsesCodeFirstIdentityAndExactFallback();
    await reset();
    await testCommitDeduplicatesResourcesAndPrices();
    await reset();
    await testCommitRollsBackBothStores(storage);
    await reset();
    await testCopyStatusAndResourceSearchRouting();
    testResourceTemplates();
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
  }
}

function testResourceTemplates() {
  const material = getResourceTemplateData('material');
  const equipment = getResourceTemplateData('equipment');
  assert.equal(material.fileName, '材料库导入模板.xlsx');
  assert.equal(equipment.fileName, '设备库导入模板.xlsx');
  assert.equal(material.rows[0].includes('材料名称'), true);
  assert.equal(equipment.rows[0].includes('设备名称'), true);
  assert.equal(equipment.rows[0].includes('安装范围'), true);
}

async function testPreviewUsesCodeFirstIdentityAndExactFallback() {
  await resourceRepo.replaceAll([
    { id: 'coded', resourceType: 'material', code: 'M-01', name: '钢管', specModel: 'DN100', unit: 'm', brand: 'A', status: 'active' },
    { id: 'fallback', resourceType: 'material', code: '', name: 'PE 管', specModel: 'DN200', unit: 'm', brand: 'B', status: 'active' },
  ]);
  const preview = await resourceImportService.preview([
    { 编码: ' m-01 ', 名称: '更名后的钢管', 规格型号: 'DN150', 单位: 'm', 品牌: 'X' },
    { 名称: ' PE  管 ', 规格型号: 'dn200', 单位: 'M', 品牌: 'b' },
    { 名称: '钢管', 规格型号: 'DN100', 单位: 'm', 品牌: 'A' },
    { 编码: 'M-02', 名称: '钢管', 规格型号: 'DN100', 单位: 'm', 品牌: 'A' },
    { 名称: '缺单位' },
  ], 'material');
  assert.equal(preview.rows[0].action, 'update');
  assert.equal(preview.rows[0].existingId, 'coded');
  assert.equal(preview.rows[1].action, 'update');
  assert.equal(preview.rows[1].existingId, 'fallback');
  assert.equal(preview.rows[2].action, 'update');
  assert.equal(preview.rows[2].existingId, 'coded');
  assert.equal(preview.rows[3].action, 'create');
  assert.equal(preview.rows[4].action, 'invalid');
  assert.deepEqual(preview.counts, { total: 5, valid: 4, invalid: 1, create: 1, update: 3, duplicate: 0, withPrice: 0 });
  await resourceImportService.commit(preview, { updateExisting: true });
  assert.equal((await resourceRepo.findById('coded')).code, 'M-01');
}

async function testCommitDeduplicatesResourcesAndPrices() {
  const rows = [
    { 编码: 'E-01', 分类: '泵类', 名称: '潜水泵', 规格型号: 'Q=10', 单位: '台', 品牌: '甲', 单价: '12000', 价格日期: '2026-07-01', 省: '四川', 市: '成都', 价格来源: '供应商报价', 价格口径: '到场价', 供应商: '甲厂' },
    { 编码: ' e-01 ', 名称: '重复行', 单位: '台', 单价: '12000', 价格日期: '2026-07-01', 省: '四川', 市: '成都', 价格来源: '供应商报价', 价格口径: '到场价', 供应商: '甲厂' },
  ];
  const preview = await resourceImportService.preview(rows, 'equipment');
  assert.equal(preview.rows[1].action, 'duplicate');
  const report = await resourceImportService.commit(preview, { updateExisting: true });
  assert.deepEqual(report.counts, { resourcesCreated: 1, resourcesUpdated: 0, resourcesSkipped: 1, pricesCreated: 1, pricesSkipped: 1, errors: 0 });
  assert.equal((await resourceRepo.all()).length, 1);
  assert.equal((await resourcePriceRepo.all()).length, 1);

  const second = await resourceImportService.commit(await resourceImportService.preview(rows.slice(0, 1), 'equipment'), { updateExisting: true });
  assert.equal(second.counts.resourcesUpdated, 1);
  assert.equal(second.counts.pricesCreated, 0);
  assert.equal(second.counts.pricesSkipped, 1);
}

async function testCommitRollsBackBothStores(storage) {
  const seed = { id: 'seed', resourceType: 'material', code: 'S-1', name: '种子', unit: 'kg', status: 'active' };
  await resourceRepo.replaceAll([seed]);
  await resourcePriceRepo.replaceAll([]);
  const preview = await resourceImportService.preview([
    { 编码: 'M-9', 名称: '沙石', 单位: 't', 单价: 88, 价格日期: '2026-07-01', 省: '四川' },
  ], 'material');
  storage.failNextSet(STORES.resource_prices);
  await assert.rejects(() => resourceImportService.commit(preview, {}), err => err.code === 'RESOURCE_IMPORT_ROLLED_BACK');
  assert.deepEqual(await resourceRepo.all(), [seed]);
  assert.deepEqual(await resourcePriceRepo.all(), []);
}

async function testCopyStatusAndResourceSearchRouting() {
  const material = await resourceService.save({ resourceType: 'material', code: 'M-01', name: '不锈钢管', specModel: 'DN50', unit: 'm', category: '管材' });
  const copy = await resourceService.copy(material.id);
  assert.equal(copy.name, '不锈钢管 - 副本');
  assert.equal(copy.code, 'M-01-COPY');
  assert.equal(copy.preferredPriceId, '');
  assert.equal((await resourceService.setStatus(copy.id, 'inactive')).status, 'inactive');
  const results = await searchAll('不锈钢');
  const item = results.find(result => result.id === `material:${material.id}`);
  assert.equal(item.targetView, 'materials');
  assert.deepEqual(item.params, { keyword: '不锈钢', selectedId: material.id });
  assert.equal(searchGroups(results).some(group => group.type === 'material' && group.meta.label === '材料'), true);
}

async function reset() {
  for (const store of Object.values(STORES)) globalThis.localStorage.setItem(store, '[]');
  await resourceRepo.replaceAll([]);
  await resourcePriceRepo.replaceAll([]);
}

function memoryStorage() {
  const values = new Map();
  let failingKey = '';
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (key === failingKey) {
        failingKey = '';
        throw new Error(`simulated write failure: ${key}`);
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
    failNextSet(key) { failingKey = key; },
  };
}
