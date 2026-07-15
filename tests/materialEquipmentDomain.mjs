import assert from 'node:assert/strict';
import { STORES, resourceRepo, resourcePriceRepo, quotaResourceUsageRepo, resourceAttachmentRepo } from '../assets/data/repository.js';
import { resourceService, resourceIdentity } from '../assets/services/resourceService.js';
import { resourcePriceService } from '../assets/services/resourcePriceService.js';
import { quotaResourceService } from '../assets/services/quotaResourceService.js';
import { boqService } from '../assets/services/boqService.js';

export async function testMaterialEquipmentDomain() {
  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  delete globalThis.window;
  try {
    await testRepositories();
    await resetDomainStores();
    await testResourceIdentityAndReferenceProtection();
    await resetDomainStores();
    await testAppendOnlyPricesAndCurrentSelection();
    await resetDomainStores();
    await testQuotaCompositionAndLegacyBreakdown();
    await resetDomainStores();
    await testEquipmentPackageAndRollback(storage);
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
  }
}

async function testRepositories() {
  assert.equal(STORES.resource_items, 'resource_items');
  assert.equal(STORES.resource_prices, 'resource_prices');
  assert.equal(STORES.quota_resource_usages, 'quota_resource_usages');
  assert.equal(STORES.resource_attachments, 'resource_attachments');
  await resourceRepo.replaceAll([{ id: 'r1', name: '钢管' }]);
  await resourcePriceRepo.replaceAll([{ id: 'p1', resourceId: 'r1' }]);
  await quotaResourceUsageRepo.replaceAll([{ id: 'u1', quotaItemId: 'q1', resourceId: 'r1' }]);
  await resourceAttachmentRepo.replaceAll([{ id: 'a1', resourceId: 'r1' }]);
  assert.equal((await resourceRepo.findById('r1')).name, '钢管');
  assert.equal((await resourcePriceRepo.byResource('r1')).length, 1);
  assert.equal((await quotaResourceUsageRepo.byQuota('q1')).length, 1);
  assert.equal((await quotaResourceUsageRepo.byResource('r1')).length, 1);
  assert.equal((await resourceAttachmentRepo.byResource('r1')).length, 1);
}

async function testResourceIdentityAndReferenceProtection() {
  assert.equal(resourceIdentity({ resourceType: 'material', code: ' M-01 ' }), 'code:m-01');
  assert.equal(resourceIdentity({ resourceType: 'equipment', name: ' 潜水泵 ', specModel: 'Q=10', unit: '台', brand: 'A' }), 'equipment|潜水泵|q=10|台|a');
  await assert.rejects(() => resourceService.save({ resourceType: 'other', name: 'x', unit: '台' }), /类型/);
  const material = await resourceService.save({ resourceType: 'material', code: 'M-01', name: '钢管', unit: 'm', tags: ['管材'] });
  assert.equal(material.status, 'active');
  await assert.rejects(() => resourceService.save({ resourceType: 'material', code: 'm-01', name: '另一种材料', unit: 'kg' }), err => err.code === 'RESOURCE_DUPLICATE');
  assert.equal((await resourceService.list({ keyword: '钢管', resourceType: 'material' })).length, 1);

  await quotaResourceUsageRepo.upsert({ id: 'u-ref', quotaItemId: 'q-ref', resourceId: material.id });
  await globalStoreSet(STORES.project_boq, [{ id: 'b-ref', projectId: 'project-ref', resourceItemId: material.id, resourceSnapshot: { name: material.name } }]);
  const usage = await resourceService.usage(material.id);
  assert.equal(usage.total, 2);
  await assert.rejects(() => resourceService.remove(material.id), err => err.code === 'RESOURCE_IN_USE');
  await resourceService.remove(material.id, { force: true });
  assert.equal(await resourceService.get(material.id), null);
  assert.equal((await quotaResourceUsageRepo.byResource(material.id)).length, 0);
  const preserved = (await globalStoreGet(STORES.project_boq))[0];
  assert.equal(preserved.resourceSnapshot.name, '钢管');
  assert.equal(preserved.resourceReferenceStatus, 'missing');
}

async function testAppendOnlyPricesAndCurrentSelection() {
  const equipment = await resourceService.save({ resourceType: 'equipment', name: '潜水泵', specModel: 'Q=10', unit: '台' });
  await assert.rejects(() => resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 0, region: { province: '四川' }, priceDate: '2026-01-01' }), /单价/);
  await assert.rejects(() => resourcePriceService.save({ resourceId: equipment.id, sourceType: 'supplier_quote', priceBasis: 'installed_composite', unitPrice: 12000, region: { city: '成都' }, priceDate: '2026-01-01' }), /安装范围/);
  const oldPrice = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'ex_factory', unitPrice: 9000, taxRate: 13, region: { province: '四川' }, priceDate: '2025-01-01', validTo: '2025-12-31' });
  const latest = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'supplier_quote', priceBasis: 'delivered', unitPrice: 10000, taxIncluded: true, taxRate: 13, region: { city: '成都' }, priceDate: '2026-06-01', supplier: '甲公司' });
  assert.equal((await resourcePriceService.getCurrentPrice(equipment.id)).id, latest.id);
  await resourceService.setPreferredPrice(equipment.id, oldPrice.id);
  assert.equal((await resourcePriceService.getCurrentPrice(equipment.id)).id, oldPrice.id);
  await assert.rejects(() => resourcePriceService.save({ ...latest, unitPrice: 1 }), err => err.code === 'PRICE_IMMUTABLE');
  await resourcePriceService.remove(oldPrice.id);
  assert.equal((await resourceService.get(equipment.id)).preferredPriceId, '');
}

async function testQuotaCompositionAndLegacyBreakdown() {
  const material = await resourceService.save({ resourceType: 'material', name: '钢管', specModel: 'DN100', unit: 'm' });
  const equipment = await resourceService.save({ resourceType: 'equipment', name: '阀门', specModel: 'DN100', unit: '个' });
  const materialPrice = await resourcePriceService.save({ resourceId: material.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 100, region: { province: '四川' }, priceDate: '2026-07-01' });
  const equipmentPrice = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'transaction', priceBasis: 'ex_factory', unitPrice: 500, region: { city: '成都' }, priceDate: '2026-07-02' });
  await globalStoreSet(STORES.quota_items, [{ id: 'q1', name: '管道安装', breakdown: { 人工: 30, 材料: 5, 机械: 10, 管理费: 2, 利润: 1, 风险: 1 } }]);
  const materialUsage = await quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: material.id, quantityPerUnit: 2, lossRate: 5, selectedPriceId: materialPrice.id });
  assert.equal(materialUsage.calculatedCost, 210);
  assert.equal(materialUsage.priceSnapshot.unitPrice, 100);
  await quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: equipment.id, quantityPerUnit: 0.5, lossRate: 0, selectedPriceId: equipmentPrice.id });
  const composition = await quotaResourceService.calculateComposition('q1');
  assert.deepEqual(composition, { material: 210, equipment: 250, total: 460 });
  const applied = await quotaResourceService.applyComposition('q1');
  assert.equal(applied.breakdown.材料, 210);
  assert.equal(applied.breakdown.设备, 250);
  assert.equal(applied.breakdown.人工, 30);
  assert.equal(applied.useBreakdown, true);
  assert.equal(applied.priceTotal, 504);
  await assert.rejects(() => quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: material.id, quantityPerUnit: -1 }), /用量/);
}

async function testEquipmentPackageAndRollback(storage) {
  const equipment = await resourceService.save({ resourceType: 'equipment', name: '鼓风机', specModel: '20m³/min', unit: '台' });
  const delivered = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'supplier_quote', priceBasis: 'delivered', unitPrice: 20000, taxIncluded: true, taxRate: 13, region: { city: '成都' }, priceDate: '2026-07-10', supplier: '风机厂' });
  const composite = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'supplier_quote', priceBasis: 'installed_composite', unitPrice: 26000, region: { city: '成都' }, priceDate: '2026-07-11', installationScope: '安装调试' });
  await globalStoreSet(STORES.projects, [{ id: 'project-1', totalCost: 0 }]);
  await globalStoreSet(STORES.quota_items, [{ id: 'install-q', name: '鼓风机安装', unit: '台', priceTotal: 3000, breakdown: { 人工: 1000, 设备: 0 }, useBreakdown: false }]);
  const lines = await boqService.addEquipmentPackage('project-1', equipment.id, delivered.id, 2, { installQuotaId: 'install-q' });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].resourceItemId, equipment.id);
  assert.equal(lines[0].resourcePriceSnapshot.unitPrice, 20000);
  assert.equal(lines[0].amount, 40000);
  assert.equal((await globalStoreGet(STORES.projects))[0].totalCost, 46000);
  await assert.rejects(() => boqService.addEquipmentPackage('project-1', equipment.id, composite.id, 1, { installQuotaId: 'install-q' }), /重复计取安装/);

  const beforeLines = structuredClone(await globalStoreGet(STORES.project_boq));
  const beforeProject = structuredClone(await globalStoreGet(STORES.projects));
  storage.failNextSet(STORES.projects);
  await assert.rejects(() => boqService.addEquipmentPackage('project-1', equipment.id, delivered.id, 1));
  assert.deepEqual(await globalStoreGet(STORES.project_boq), beforeLines);
  assert.deepEqual(await globalStoreGet(STORES.projects), beforeProject);
}

async function resetDomainStores() {
  await Promise.all(Object.values(STORES).map(store => globalStoreSet(store, [])));
}

async function globalStoreGet(store) {
  return JSON.parse(globalThis.localStorage.getItem(store) || 'null') || [];
}

async function globalStoreSet(store, value) {
  globalThis.localStorage.setItem(store, JSON.stringify(value));
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
