import assert from 'node:assert/strict';
import { STORES, resourcePriceRepo, resourceRepo } from '../assets/data/repository.js?v=6.3';
import { resourceImportService } from '../assets/services/resourceImportService.js?v=6.3';
import { resourceService } from '../assets/services/resourceService.js?v=6.3';
import { searchAll, searchGroups } from '../assets/services/globalSearchService.js?v=6.3';
import { getResourceTemplateData } from '../assets/data/excel.js?v=6.3';
import { createLatestResourceSelection, nextResourceViewState } from '../assets/views/resources.js?v=6.3';
import { buildImportReportRows, buildImportReportViewModel, renderImportReportMetric } from '../assets/views/resourceImport.js?v=6.3';

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
    await testPreviewFlagsCodeAndCompositeConflict();
    await reset();
    await testCommitDeduplicatesResourcesAndPrices();
    await reset();
    await testCommitRollsBackBothStores(storage);
    await reset();
    await testImportPriceInvariants();
    await reset();
    await testCopyStatusAndResourceSearchRouting();
    await reset();
    await testResourceSearchCapsTypesIndependently();
    await testLatestResourceSelectionWins();
    testResourceRouteStateIsolation();
    testImportReportRows();
    testFailureReportMetricTone();
    testResourceTemplates();
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
  }
}

async function testPreviewFlagsCodeAndCompositeConflict() {
  await resourceRepo.replaceAll([{ id: 'existing', resourceType: 'material', code: 'M-01', name: '钢管', specModel: 'DN100', unit: 'm', brand: 'A', status: 'active' }]);
  const preview = await resourceImportService.preview([{ 编码: 'M-02', 名称: '钢管', 规格型号: 'DN100', 单位: 'm', 品牌: 'A' }], 'material');
  assert.equal(preview.rows[0].action, 'conflict');
  assert.equal(preview.counts.valid, 0);
  const report = await resourceImportService.commit(preview);
  assert.equal(report.counts.errors, 1);
  assert.equal((await resourceRepo.all()).length, 1);
}

function testFailureReportMetricTone() {
  assert.equal(renderImportReportMetric('尝试新增', 2, 'warning').includes('border-amber-200'), true);
  assert.equal(renderImportReportMetric('尝试新增', 2, 'danger').includes('text-red-700'), true);
  assert.equal(renderImportReportMetric('新增', 2, 'success').includes('text-teal-700'), true);
}

async function testLatestResourceSelectionWins() {
  const usageA = deferred();
  const usageB = deferred();
  const state = { selectedId: '', usage: null };
  const paintedPanels = [];
  const select = createLatestResourceSelection({
    setSelectedId: id => { state.selectedId = id; },
    getSelectedId: () => state.selectedId,
    loadUsage: id => id === 'A' ? usageA.promise : usageB.promise,
    commit: async ({ id, usage }) => {
      state.usage = usage;
      paintedPanels.push(id);
    },
  });

  const selectA = select('A');
  const selectB = select('B');
  usageB.resolve({ total: 2, resourceId: 'B' });
  assert.equal(await selectB, true);
  usageA.resolve({ total: 1, resourceId: 'A' });
  assert.equal(await selectA, false);
  assert.deepEqual(state.usage, { total: 2, resourceId: 'B' });
  assert.deepEqual(paintedPanels, ['B']);
  assert.equal(state.selectedId, 'B');
}

async function testImportPriceInvariants() {
  const preview = await resourceImportService.preview([
    { 名称: '负税率', 单位: 't', 单价: 10, 价格日期: '2026-07-01', 省: '四川', 税率: -5 },
    { 名称: '超大税率', 单位: 't', 单价: 10, 价格日期: '2026-07-01', 省: '四川', 税率: 999 },
    { 名称: '无效价格条件', 单位: 't', 单价: 10, 价格日期: '2026-07-01', 省: '四川', 价格来源: '不明来源', 价格口径: '不明口径', 生效日期: '2026-08-01', 失效日期: '2026-07-01' },
  ], 'material');
  assert.equal(preview.rows[0].action, 'invalid');
  assert.equal(preview.rows[0].errors.includes('税率必须在 0 到 100 之间'), true);
  assert.equal(preview.rows[1].errors.includes('税率必须在 0 到 100 之间'), true);
  assert.equal(preview.rows[2].errors.includes('价格来源类型无效'), true);
  assert.equal(preview.rows[2].errors.includes('价格口径无效'), true);
  assert.equal(preview.rows[2].errors.includes('失效日期不能早于生效日期'), true);
  const report = await resourceImportService.commit(preview, {});
  assert.equal(report.counts.errors, 3);
  assert.equal((await resourcePriceRepo.all()).length, 0);

  const tampered = await resourceImportService.preview([
    { 名称: '被篡改预览', 单位: 't', 单价: 10, 价格日期: '2026-07-01', 省: '四川', 税率: 13 },
  ], 'material');
  tampered.rows[0].price.taxRate = 999;
  const guarded = await resourceImportService.commit(tampered, {});
  assert.equal(guarded.counts.errors, 1);
  assert.equal((await resourcePriceRepo.all()).length, 0);
}

function testResourceRouteStateIsolation() {
  const material = nextResourceViewState({ resourceType: 'material', keyword: '钢管', category: '管材', status: 'inactive', selectedId: 'm1' }, 'materials', {});
  assert.deepEqual(material, { resourceType: 'material', keyword: '钢管', category: '管材', status: 'inactive', selectedId: 'm1' });
  const equipment = nextResourceViewState(material, 'equipment', { keyword: '泵', selectedId: 'e1' });
  assert.deepEqual(equipment, { resourceType: 'equipment', keyword: '泵', category: '', status: '', selectedId: 'e1' });
  const back = nextResourceViewState(equipment, 'materials', { category: '阀门', status: 'active' });
  assert.deepEqual(back, { resourceType: 'material', keyword: '', category: '阀门', status: 'active', selectedId: '' });
}

function testImportReportRows() {
  const rows = buildImportReportRows({ rows: [
    { index: 0, status: 'created', priceStatus: 'created', errors: [] },
    { index: 1, status: 'skipped', priceStatus: 'skipped', errors: [] },
    { index: 2, status: 'error', errors: ['税率必须在 0 到 100 之间'] },
  ] });
  assert.deepEqual(rows.map(row => row.statusLabel), ['已新增', '已跳过', '失败']);
  assert.equal(rows[0].message.includes('价格快照已新增'), true);
  assert.equal(rows[1].message.includes('价格已存在'), true);
  assert.equal(rows[2].message, '税率必须在 0 到 100 之间');

  const rolledBackReport = {
    outcome: 'rolled_back',
    failureCode: 'RESOURCE_IMPORT_ROLLED_BACK',
    counts: { resourcesCreated: 0, resourcesUpdated: 0, resourcesSkipped: 0, pricesCreated: 0, pricesSkipped: 0, errors: 0 },
    attemptedCounts: { resourcesCreated: 1, resourcesUpdated: 0, resourcesSkipped: 0, pricesCreated: 1, pricesSkipped: 0, errors: 0 },
    rows: [{ index: 0, status: 'rolled_back', attemptedStatus: 'created', priceStatus: 'not_written', attemptedPriceStatus: 'created', errors: [] }],
  };
  const rolledBack = buildImportReportRows(rolledBackReport);
  assert.equal(rolledBack[0].statusLabel, '已回滚');
  assert.equal(rolledBack[0].message.includes('主数据尝试新增'), true);
  assert.equal(rolledBack[0].message.includes('未写入'), true);
  const rolledBackVm = buildImportReportViewModel(rolledBackReport);
  assert.equal(rolledBackVm.tone, 'warning');
  assert.equal(rolledBackVm.title, '导入已回滚');
  assert.equal(rolledBackVm.metrics[0].label.startsWith('尝试'), true);

  const partialReport = {
    ...rolledBackReport,
    outcome: 'partial_recovery',
    failureCode: 'RESOURCE_IMPORT_PARTIAL_RECOVERY',
    rows: [{ index: 0, status: 'uncertain', attemptedStatus: 'created', priceStatus: 'uncertain', attemptedPriceStatus: 'created', errors: [] }],
  };
  const partial = buildImportReportRows(partialReport);
  assert.equal(partial[0].statusLabel, '需人工核对');
  assert.equal(partial[0].message.includes('写入状态不确定'), true);
  const partialVm = buildImportReportViewModel(partialReport);
  assert.equal(partialVm.tone, 'danger');
  assert.equal(partialVm.title, '导入状态不确定');
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
  assert.equal(preview.rows[3].action, 'duplicate');
  assert.equal(preview.rows[4].action, 'invalid');
  assert.deepEqual(preview.counts, { total: 5, valid: 4, invalid: 1, create: 0, update: 3, duplicate: 1, conflict: 0, withPrice: 0 });
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
  const rolledBackError = await captureRejection(() => resourceImportService.commit(preview, {}));
  assert.equal(rolledBackError.code, 'RESOURCE_IMPORT_ROLLED_BACK');
  assert.equal(rolledBackError.report.outcome, 'rolled_back');
  assert.equal(rolledBackError.report.persistenceState, 'not_persisted');
  assert.equal(rolledBackError.report.counts.resourcesCreated, 0);
  assert.equal(rolledBackError.report.counts.pricesCreated, 0);
  assert.equal(rolledBackError.report.attemptedCounts.resourcesCreated, 1);
  assert.equal(rolledBackError.report.attemptedCounts.pricesCreated, 1);
  assert.equal(rolledBackError.report.rows[0].status, 'rolled_back');
  assert.equal(rolledBackError.report.rows[0].priceStatus, 'not_written');
  assert.deepEqual(await resourceRepo.all(), [seed]);
  assert.deepEqual(await resourcePriceRepo.all(), []);

  storage.failSequence(STORES.resource_prices, STORES.resource_items);
  const partialError = await captureRejection(() => resourceImportService.commit(preview, {}));
  assert.equal(partialError.code, 'RESOURCE_IMPORT_PARTIAL_RECOVERY');
  assert.equal(partialError.report.outcome, 'partial_recovery');
  assert.equal(partialError.report.persistenceState, 'unknown');
  assert.equal(partialError.report.counts.resourcesCreated, null);
  assert.equal(partialError.report.attemptedCounts.resourcesCreated, 1);
  assert.equal(partialError.report.rows[0].status, 'uncertain');
  assert.equal(partialError.report.rows[0].priceStatus, 'uncertain');
  assert.equal(/未能完全回滚/.test(partialError.message), true);
  assert.equal(Boolean(partialError.rollbackCause), true);
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

async function testResourceSearchCapsTypesIndependently() {
  const materials = Array.from({ length: 14 }, (_, index) => ({ id: `m${index}`, resourceType: 'material', code: `M-${index}`, name: `污水通用材料 ${index}`, unit: 'm', status: 'active' }));
  const equipment = Array.from({ length: 3 }, (_, index) => ({ id: `e${index}`, resourceType: 'equipment', code: `E-${index}`, name: `污水通用设备 ${index}`, unit: '台', status: 'active' }));
  await resourceRepo.replaceAll([...materials, ...equipment]);
  const results = await searchAll('污水通用');
  assert.equal(results.filter(item => item.type === 'material').length, 8);
  assert.equal(results.filter(item => item.type === 'equipment').length, 3);
}

async function reset() {
  for (const store of Object.values(STORES)) globalThis.localStorage.setItem(store, '[]');
  await resourceRepo.replaceAll([]);
  await resourcePriceRepo.replaceAll([]);
}

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to reject');
}

function memoryStorage() {
  const values = new Map();
  let failingKeys = [];
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (key === failingKeys[0]) {
        failingKeys.shift();
        throw new Error(`simulated write failure: ${key}`);
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
    failNextSet(key) { failingKeys = [key]; },
    failSequence(...keys) { failingKeys = [...keys]; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
