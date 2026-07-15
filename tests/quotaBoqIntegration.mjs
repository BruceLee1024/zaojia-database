import assert from 'node:assert/strict';
import { STORES, quotaRepo, quotaResourceUsageRepo, resourcePriceRepo, resourceRepo } from '../assets/data/repository.js';
import { quotaResourceService } from '../assets/services/quotaResourceService.js';
import { boqService } from '../assets/services/boqService.js';
import { versionService } from '../assets/services/versionService.js';
import { buildCompositionPreview, buildUsageComparisonViewModel, compositionPanelShell, normalizeBreakdown } from '../assets/views/quotaResourceComposition.js';
import { buildBoqResourceViewModel, renderBoqResourceReference } from '../assets/views/boqResourceReference.js';

export async function testQuotaBoqIntegration() {
  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  globalThis.localStorage = memoryStorage();
  delete globalThis.window;
  try {
    await testCanonicalBreakdownAndCompositionPreview();
    await reset();
    await testUsageComparisonRemovalAndExplicitRefresh();
    await reset();
    await testResourceAuditAndVersionSnapshots();
    testPureResourceViewModels();
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
  }
}

async function testCanonicalBreakdownAndCompositionPreview() {
  const legacy = { id: 'q-legacy', breakdown: { 人工: 30, 材料: 8, 机械: 12, 管理费: 3, 利润: 2, 风险: 1 } };
  const normalized = normalizeBreakdown(legacy.breakdown);
  assert.deepEqual(Object.keys(normalized), ['人工', '材料', '设备', '机械', '管理费', '利润', '风险']);
  assert.equal(normalized.设备, 0);
  assert.equal('设备' in legacy.breakdown, false, '读取旧定额不应原地迁移');
  const preview = buildCompositionPreview(legacy, [
    { resourceType: 'material', calculatedCost: 120 },
    { resourceType: 'equipment', calculatedCost: 500, priceSnapshot: { priceBasis: 'installed_composite' } },
  ]);
  assert.equal(preview.oldBreakdown.人工, 30);
  assert.equal(preview.newBreakdown.材料, 120);
  assert.equal(preview.newBreakdown.设备, 500);
  assert.equal(preview.newBreakdown.机械, 12);
  assert.equal(preview.delta.total, 612);
  assert.equal(preview.warnings.some(message => message.includes('安装综合价')), true);
}

async function testUsageComparisonRemovalAndExplicitRefresh() {
  await quotaRepo.replaceAll([{ id: 'q1', name: '泵安装', breakdown: { 人工: 10, 材料: 0, 机械: 5 } }]);
  await resourceRepo.replaceAll([{ id: 'r1', resourceType: 'equipment', name: '泵', unit: '台', status: 'active', preferredPriceId: 'p2' }]);
  await resourcePriceRepo.replaceAll([
    { id: 'p1', resourceId: 'r1', unitPrice: 100, priceBasis: 'delivered', sourceType: 'official', priceDate: '2025-01-01', validTo: '2025-12-31' },
    { id: 'p2', resourceId: 'r1', unitPrice: 125, priceBasis: 'installed_composite', sourceType: 'supplier_quote', priceDate: '2026-07-01', validTo: '2026-12-31', supplier: '甲厂' },
  ]);
  const usage = await quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: 'r1', selectedPriceId: 'p1', quantityPerUnit: 2, lossRate: 10 });
  const before = await quotaResourceService.compareUsage(usage.id);
  assert.equal(before.stale, true);
  assert.equal(before.priceDelta, 25);
  assert.equal(before.currentPrice.id, 'p2');
  assert.equal((await quotaResourceUsageRepo.findById(usage.id)).selectedPriceId, 'p1', '比较不得自动刷新');

  const refreshed = await quotaResourceService.refreshUsageSnapshot(usage.id);
  assert.equal(refreshed.selectedPriceId, 'p2');
  assert.equal(refreshed.priceSnapshot.priceBasis, 'installed_composite');
  assert.equal(refreshed.calculatedCost, 275);
  assert.equal((await quotaResourceService.compareUsage(usage.id)).stale, false);
  assert.deepEqual(await quotaResourceService.removeUsage(usage.id), refreshed);
  assert.equal(await quotaResourceUsageRepo.findById(usage.id), null);
}

async function testResourceAuditAndVersionSnapshots() {
  const expired = { id: 'price-expired', resourceId: 'equipment-1', unitPrice: 20000, sourceType: 'supplier_quote', priceBasis: 'installed_composite', validTo: '2000-01-01' };
  const equipmentLine = {
    id: 'line-equipment', projectId: 'project-1', resourceItemId: 'equipment-1', resourcePriceId: expired.id,
    resourceSnapshot: { id: 'equipment-1', resourceType: 'equipment', name: '鼓风机' }, resourcePriceSnapshot: expired,
    name: '鼓风机', unit: '台', qty: 1, factor: 1, unitPrice: 20000, amount: 20000,
  };
  const installLine = {
    id: 'line-install', projectId: 'project-1', quotaItemId: 'quota-install', linkedResourceItemId: 'equipment-1',
    linkedResourceSnapshot: { id: 'equipment-1', name: '鼓风机' }, name: '鼓风机安装', unit: '台', qty: 1, factor: 1, unitPrice: 1000, amount: 1000,
  };
  const missingBasisLine = {
    id: 'line-missing-basis', projectId: 'project-1', resourceItemId: 'missing-resource', resourcePriceId: 'missing-price',
    resourceSnapshot: { id: 'missing-resource', name: '旧设备' }, resourcePriceSnapshot: { unitPrice: 500 },
    name: '旧设备', unit: '台', qty: 1, factor: 1, unitPrice: 500, amount: 500,
  };
  await setStore(STORES.projects, [{ id: 'project-1', name: '测试项目' }]);
  await setStore(STORES.project_boq, [equipmentLine, installLine, missingBasisLine]);
  await quotaRepo.replaceAll([{ id: 'quota-install', name: '鼓风机安装' }]);
  await resourceRepo.replaceAll([{ id: 'equipment-1', resourceType: 'equipment', name: '鼓风机' }]);
  await resourcePriceRepo.replaceAll([expired]);
  const audit = await boqService.audit('project-1');
  assert.deepEqual(audit.issues.invalidResourceReference.map(line => line.id), ['line-missing-basis']);
  assert.deepEqual(audit.issues.expiredResourcePrice.map(line => line.id), ['line-equipment']);
  assert.deepEqual(audit.issues.missingResourcePriceBasis.map(line => line.id), ['line-missing-basis']);
  assert.equal(audit.issues.duplicateEquipmentInstallation.some(line => line.id === 'line-equipment'), true);

  const version = await versionService.createFromCurrent('project-1', { name: '资源快照' });
  const snap = version.lines.find(line => line.id === 'line-equipment');
  assert.equal(snap.resourceItemId, 'equipment-1');
  assert.deepEqual(snap.resourceSnapshot, equipmentLine.resourceSnapshot);
  assert.deepEqual(snap.resourcePriceSnapshot, expired);
  const restore = await versionService.restore(version.id);
  const restored = (await setStoreGet(STORES.project_boq)).find(line => line.resourceItemId === 'equipment-1');
  assert.deepEqual(restored.resourcePriceSnapshot, expired);
  assert.equal(restore.restoredCount, 3);
}

function testPureResourceViewModels() {
  assert.equal(compositionPanelShell({ id: 'q1' }).includes('搜索并关联材料或设备'), true);
  assert.equal(compositionPanelShell({ id: '' }).includes('保存定额后'), true);
  const usageVm = buildUsageComparisonViewModel({
    usage: { priceSnapshot: { unitPrice: 100, priceBasis: 'delivered', sourceName: '甲厂' }, calculatedCost: 210 },
    resource: { name: '钢管', specModel: 'DN100' }, currentPrice: { unitPrice: 120, priceBasis: 'delivered', supplier: '乙厂' },
    currentCost: 252, priceDelta: 20, costDelta: 42, stale: true, staleReasons: ['unitPrice'],
  });
  assert.equal(usageVm.statusLabel, '已过时');
  assert.equal(usageVm.deltaLabel.includes('+20'), true);
  const boqVm = buildBoqResourceViewModel({
    resourceReferenceStatus: 'missing', resourceSnapshot: { name: '泵', specModel: 'Q=10' },
    resourcePriceSnapshot: { unitPrice: 10000, sourceType: 'supplier_quote', priceBasis: '', validTo: '2000-01-01' },
  }, new Date('2026-07-15T00:00:00Z'));
  assert.equal(boqVm.name, '泵');
  assert.equal(boqVm.badges.includes('引用失效'), true);
  assert.equal(boqVm.badges.includes('价格过期'), true);
  assert.equal(boqVm.badges.includes('缺价格口径'), true);
  const html = renderBoqResourceReference(boqVm);
  assert.equal(html.includes('价格来源'), true);
  assert.equal(html.includes('快照口径'), true);
  assert.equal(html.includes('价格过期'), true);
}

async function reset() {
  await Promise.all(Object.values(STORES).map(store => setStore(store, [])));
}

function setStore(store, value) {
  globalThis.localStorage.setItem(store, JSON.stringify(value));
}

function setStoreGet(store) {
  return JSON.parse(globalThis.localStorage.getItem(store) || '[]');
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}
