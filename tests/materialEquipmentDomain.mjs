import assert from 'node:assert/strict';
import { STORES, resourceRepo, resourcePriceRepo, quotaResourceUsageRepo, resourceAttachmentRepo } from '../assets/data/repository.js?v=6.4';
import { resourceService, resourceIdentity } from '../assets/services/resourceService.js?v=6.4';
import { resourcePriceService } from '../assets/services/resourcePriceService.js?v=6.4';
import { quotaResourceService } from '../assets/services/quotaResourceService.js?v=6.4';
import { boqService } from '../assets/services/boqService.js?v=6.4';

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
    await testDuplicateProtectionAndControlledMerge();
    await resetDomainStores();
    await testAppendOnlyPricesAndCurrentSelection();
    await resetDomainStores();
    await testQuotaCompositionAndLegacyBreakdown();
    await resetDomainStores();
    await testEquipmentPackageAndRollback(storage);
    await resetDomainStores();
    await testCrossProjectEquipmentPackageIsolation(storage);
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
  }
}

async function testDuplicateProtectionAndControlledMerge() {
  const source = await resourceService.save({ resourceType: 'material', code: 'M-SOURCE', name: '旧钢管', specModel: 'DN100', unit: 'm', brand: '甲' });
  const target = await resourceService.save({ resourceType: 'material', code: 'M-TARGET', name: '新钢管', specModel: 'DN100', unit: 'm', brand: '乙' });
  await assert.rejects(() => resourceService.save({ resourceType: 'equipment', code: 'm-source', name: '同编码设备', unit: '台' }), /相同编码/);
  await assert.rejects(() => resourceService.save({ resourceType: 'material', code: 'M-OTHER', name: '旧钢管', specModel: 'DN100', unit: 'm', brand: '甲' }), /相同编码/);
  const price = await resourcePriceService.save({ resourceId: source.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 88, region: { city: '成都' }, priceDate: '2026-07-15' });
  await quotaResourceUsageRepo.upsert({ id: 'usage-merge', quotaItemId: 'q-merge', resourceId: source.id, resourceType: 'material', selectedPriceId: price.id, priceSnapshot: { unitPrice: 88 } });
  await resourceAttachmentRepo.upsert({ id: 'attachment-merge', resourceId: source.id, priceId: price.id });
  await globalStoreSet(STORES.project_boq, [{ id: 'line-merge', projectId: 'p-merge', resourceItemId: source.id, resourceSnapshot: { id: source.id, name: source.name } }]);
  await resourceService.merge(source.id, target.id);
  assert.equal((await resourceService.get(source.id)).status, 'inactive');
  assert.equal((await resourceService.get(source.id)).mergedIntoResourceId, target.id);
  assert.equal((await resourcePriceRepo.findById(price.id)).resourceId, target.id);
  assert.equal((await quotaResourceUsageRepo.findById('usage-merge')).resourceId, target.id);
  assert.equal((await resourceAttachmentRepo.findById('attachment-merge')).resourceId, target.id);
  const line = (await globalStoreGet(STORES.project_boq))[0];
  assert.equal(line.resourceItemId, target.id);
  assert.equal(line.resourceSnapshot.id, source.id, '历史项目快照不得改写');
}

async function testCrossProjectEquipmentPackageIsolation(storage) {
  const equipment = await resourceService.save({ resourceType: 'equipment', name: '跨项目水泵', unit: '台' });
  const price = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 1000, region: { city: '成都' }, priceDate: '2026-07-15' });
  await globalStoreSet(STORES.projects, [{ id: 'project-a', totalCost: 0 }, { id: 'project-b', totalCost: 0 }]);
  await Promise.all([
    boqService.addEquipmentPackage('project-a', equipment.id, price.id, 1),
    boqService.addEquipmentPackage('project-b', equipment.id, price.id, 1),
  ]);
  let lines = await globalStoreGet(STORES.project_boq);
  assert.deepEqual(new Set(lines.map(line => line.projectId)), new Set(['project-a', 'project-b']));

  await globalStoreSet(STORES.project_boq, []);
  await globalStoreSet(STORES.projects, [{ id: 'project-a', totalCost: 0 }, { id: 'project-b', totalCost: 0 }]);
  storage.failNextSet(STORES.projects);
  const [failedA, successfulB] = await Promise.allSettled([
    boqService.addEquipmentPackage('project-a', equipment.id, price.id, 1),
    boqService.addEquipmentPackage('project-b', equipment.id, price.id, 1),
  ]);
  assert.equal(failedA.status, 'rejected');
  assert.equal(failedA.reason.code, 'EQUIPMENT_PACKAGE_ROLLED_BACK');
  assert.equal(successfulB.status, 'fulfilled');
  lines = await globalStoreGet(STORES.project_boq);
  assert.deepEqual(lines.map(line => line.projectId), ['project-b']);
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
  await assert.rejects(() => resourceService.save({ resourceType: 'equipment', name: '非法首选价设备', unit: '台', preferredPriceId: 'missing-price' }), /首选价格/);
  await assert.rejects(() => resourceService.save({ resourceType: 'material', code: 'm-01', name: '另一种材料', unit: 'kg' }), err => err.code === 'RESOURCE_DUPLICATE');
  assert.equal((await resourceService.list({ keyword: '钢管', resourceType: 'material' })).length, 1);

  await quotaResourceUsageRepo.upsert({ id: 'u-ref', quotaItemId: 'q-ref', resourceId: material.id });
  await resourcePriceRepo.upsert({ id: 'p-ref', resourceId: material.id, unitPrice: 1 });
  await resourceAttachmentRepo.upsert({ id: 'a-ref', resourceId: material.id, priceId: 'p-ref' });
  await globalStoreSet(STORES.project_boq, [
    { id: 'b-ref', projectId: 'project-ref', resourceItemId: material.id, resourceSnapshot: { name: material.name } },
    { id: 'b-manual-ref', projectId: 'project-ref', manualInstallationResourceId: material.id, linkedResourceSnapshot: { name: material.name } },
  ]);
  const usage = await resourceService.usage(material.id);
  assert.equal(usage.total, 5);
  assert.equal(usage.projectLineCount, 2);
  assert.equal(usage.priceCount, 1);
  assert.equal(usage.attachmentCount, 1);
  await assert.rejects(() => resourceService.remove(material.id), err => err.code === 'RESOURCE_IN_USE');
  await resourceService.remove(material.id, { force: true });
  assert.equal((await resourceService.get(material.id)).status, 'inactive');
  assert.equal((await quotaResourceUsageRepo.byResource(material.id)).length, 1);
  assert.equal((await resourcePriceRepo.byResource(material.id)).length, 1);
  assert.equal((await resourceAttachmentRepo.byResource(material.id)).length, 1);
  const preserved = (await globalStoreGet(STORES.project_boq))[0];
  assert.equal(preserved.resourceSnapshot.name, '钢管');
  assert.equal(preserved.resourceReferenceStatus, undefined);

  const unused = await resourceService.save({ resourceType: 'material', name: '未使用材料', unit: 'kg' });
  await resourceService.remove(unused.id);
  assert.equal(await resourceService.get(unused.id), null);
}

async function testAppendOnlyPricesAndCurrentSelection() {
  const equipment = await resourceService.save({ resourceType: 'equipment', name: '潜水泵', specModel: 'Q=10', unit: '台' });
  await assert.rejects(() => resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 0, region: { province: '四川' }, priceDate: '2026-01-01' }), /单价/);
  await assert.rejects(() => resourcePriceService.save({ resourceId: equipment.id, sourceType: 'supplier_quote', priceBasis: 'installed_composite', unitPrice: 12000, region: { city: '成都' }, priceDate: '2026-01-01' }), /安装范围/);
  const oldPrice = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'ex_factory', unitPrice: 9000, taxRate: 13, region: { province: '四川' }, priceDate: '2025-01-01', validTo: '2025-12-31' });
  const latest = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'supplier_quote', priceBasis: 'delivered', unitPrice: 10000, taxIncluded: true, taxRate: 13, region: { city: '成都' }, priceDate: '2026-06-01', supplier: '甲公司' });
  assert.equal((await resourcePriceService.getCurrentPrice(equipment.id)).id, latest.id);
  await resourceService.setPreferredPrice(equipment.id, oldPrice.id);
  assert.equal((await resourcePriceService.getCurrentPrice(equipment.id)).id, latest.id, '过期首选价必须回退到有效价格');
  await assert.rejects(() => resourcePriceService.save({ ...latest, unitPrice: 1 }), err => err.code === 'PRICE_IMMUTABLE');
  await resourceAttachmentRepo.upsert({ id: 'price-evidence', resourceId: equipment.id, priceId: oldPrice.id, status: 'available' });
  assert.equal(typeof resourcePriceService.withdraw, 'function');
  await resourcePriceService.withdraw(oldPrice.id);
  assert.equal((await resourceService.get(equipment.id)).preferredPriceId, '');
  const withdrawn = await resourcePriceRepo.findById(oldPrice.id);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.unitPrice, oldPrice.unitPrice);
  assert.equal((await resourceAttachmentRepo.findById('price-evidence')).priceId, oldPrice.id);
  assert.equal((await resourcePriceService.listByResource(equipment.id)).some(price => price.id === oldPrice.id), true);
  assert.equal((await resourcePriceService.getCurrentPrice(equipment.id)).id, latest.id);
  await assert.rejects(() => resourceService.setPreferredPrice(equipment.id, oldPrice.id), /已撤回/);
  const other = await resourceService.save({ resourceType: 'equipment', name: '另一台泵', unit: '台' });
  await assert.rejects(() => resourceService.save({ ...other, preferredPriceId: latest.id }), /不属于/);
  await assert.rejects(() => resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 100, region: { city: '成都' }, priceDate: '2026-02-30' }), /价格日期/);
  await assert.rejects(() => resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 100, region: { city: '成都' }, priceDate: '2026-02-28', validFrom: '2026-04-31' }), /生效日期/);
  await assert.rejects(() => resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 100, region: { city: '成都' }, priceDate: '2026-02-28', validTo: '2026-02-29' }), /失效日期/);
  const future = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 101, region: { city: '成都' }, priceDate: '2026-07-15', validFrom: '2099-01-01' });
  assert.notEqual((await resourcePriceService.getCurrentPrice(equipment.id)).id, future.id, '未生效价格不能成为当前价');
}

async function testQuotaCompositionAndLegacyBreakdown() {
  const material = await resourceService.save({ resourceType: 'material', name: '钢管', specModel: 'DN100', unit: 'm' });
  const equipment = await resourceService.save({ resourceType: 'equipment', name: '阀门', specModel: 'DN100', unit: '个' });
  const materialPrice = await resourcePriceService.save({ resourceId: material.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 100, region: { province: '四川' }, priceDate: '2026-07-01' });
  const withdrawnMaterialPrice = await resourcePriceService.save({ resourceId: material.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 90, region: { province: '四川' }, priceDate: '2025-07-01' });
  await resourcePriceService.remove(withdrawnMaterialPrice.id);
  const equipmentPrice = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'transaction', priceBasis: 'delivered', unitPrice: 500, region: { city: '成都' }, priceDate: '2026-07-02' });
  await globalStoreSet(STORES.quota_items, [{ id: 'q1', name: '管道安装', breakdown: { 人工: 30, 材料: 5, 机械: 10, 管理费: 2, 利润: 1, 风险: 1 } }]);
  await assert.rejects(() => quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: material.id, quantityPerUnit: 1, selectedPriceId: withdrawnMaterialPrice.id }), /已撤回/);
  const materialUsage = await quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: material.id, resourceType: 'equipment', quantityPerUnit: 2, lossRate: 5, selectedPriceId: materialPrice.id });
  assert.equal(materialUsage.calculatedCost, 210);
  assert.equal(materialUsage.resourceType, 'material');
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
  const factoryPrice = await resourcePriceService.save({ resourceId: material.id, sourceType: 'official', priceBasis: 'ex_factory', unitPrice: 80, region: { city: '成都' }, priceDate: '2026-07-15' });
  await assert.rejects(() => quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: material.id, selectedPriceId: factoryPrice.id, quantityPerUnit: 1 }), /到场价/);
  await resourceService.setStatus(material.id, 'inactive');
  await assert.rejects(() => quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: material.id, selectedPriceId: materialPrice.id, quantityPerUnit: 1 }), /停用/);
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
  const packageUsage = await resourceService.usage(equipment.id);
  assert.equal(packageUsage.projectLineCount, 2);
  assert.equal(packageUsage.total, 4);
  assert.equal(packageUsage.priceCount, 2);
  await assert.rejects(() => resourceService.remove(equipment.id), err => err.code === 'RESOURCE_IN_USE');
  await assert.rejects(() => boqService.addEquipmentPackage('project-1', equipment.id, composite.id, 1, { installQuotaId: 'install-q' }), /重复计取安装/);
  const obsolete = await resourcePriceService.save({ resourceId: equipment.id, sourceType: 'official', priceBasis: 'delivered', unitPrice: 18000, region: { city: '成都' }, priceDate: '2025-01-01' });
  await resourcePriceService.remove(obsolete.id);
  await assert.rejects(() => boqService.addEquipmentPackage('project-1', equipment.id, obsolete.id, 1), /已撤回/);

  await Promise.all([
    boqService.addEquipmentPackage('project-1', equipment.id, delivered.id, 1, { installQuotaId: 'install-q' }),
    boqService.addEquipmentPackage('project-1', equipment.id, delivered.id, 1, { installQuotaId: 'install-q' }),
  ]);
  assert.equal((await globalStoreGet(STORES.project_boq)).length, 6);

  const beforeLines = structuredClone(await globalStoreGet(STORES.project_boq));
  const beforeProject = structuredClone(await globalStoreGet(STORES.projects));
  storage.failNextSet(STORES.projects);
  await assert.rejects(() => boqService.addEquipmentPackage('project-1', equipment.id, delivered.id, 1), error => error.code === 'EQUIPMENT_PACKAGE_ROLLED_BACK' && Boolean(error.cause));
  assert.deepEqual(await globalStoreGet(STORES.project_boq), beforeLines);
  assert.deepEqual(await globalStoreGet(STORES.projects), beforeProject);

  storage.failAfterSets(STORES.projects, 1);
  storage.failAfterSets(STORES.project_boq, 2);
  await assert.rejects(
    () => boqService.addEquipmentPackage('project-1', equipment.id, delivered.id, 1),
    error => error.code === 'EQUIPMENT_PACKAGE_PARTIAL_RECOVERY' && Boolean(error.cause) && error.rollbackCauses.length === 1,
  );

  await resourceService.remove(equipment.id, { force: true });
  const removedLines = await globalStoreGet(STORES.project_boq);
  assert.equal((await resourceService.get(equipment.id)).status, 'inactive');
  assert.equal(removedLines.find(line => line.resourceItemId === equipment.id).resourceReferenceStatus, undefined);
  const linkedLine = removedLines.find(line => line.linkedResourceItemId === equipment.id);
  assert.equal(linkedLine.linkedResourceReferenceStatus, undefined);
  assert.equal(linkedLine.linkedResourceSnapshot.name, '鼓风机');
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
  const setCounts = new Map();
  const failAt = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      const call = (setCounts.get(key) || 0) + 1;
      setCounts.set(key, call);
      if (failAt.get(key) === call) {
        failAt.delete(key);
        throw new Error(`simulated scheduled write failure: ${key}`);
      }
      if (key === failingKey) {
        failingKey = '';
        throw new Error(`simulated write failure: ${key}`);
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
    failNextSet(key) { failingKey = key; },
    failAfterSets(key, offset) { failAt.set(key, (setCounts.get(key) || 0) + offset); },
  };
}
