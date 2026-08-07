import assert from 'node:assert/strict';
import {
  boqLibraryQuotaRelationRepo, boqLibraryRepo, boqRepo, projectBoqQuotaRelationRepo, projectRepo, quotaRepo,
} from '../assets/data/repository.js?v=6.12';
import { calculateQuotaRelations, parseQuotaUnit } from '../assets/services/boqQuotaRelationService.js?v=6.12';
import { groupBundleRows, importBoqQuotaBundle } from '../assets/services/boqQuotaBundleImportService.js?v=6.12';
import { boqLibraryService } from '../assets/services/boqLibraryService.js?v=6.12';

export async function testBoqQuotaRelations() {
  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  globalThis.localStorage = memoryStorage();
  delete globalThis.window;
  try {
    assert.deepEqual(parseQuotaUnit('10m²'), { unitBase: 10, normalizedUnit: 'm²' });
    assert.deepEqual(parseQuotaUnit('m³'), { unitBase: 1, normalizedUnit: 'm³' });

    const rows = screenshotRows();
    const grouped = groupBundleRows(rows);
    assert.equal(grouped.groups.length, 2);
    assert.equal(grouped.groups[0].children.length, 2);
    assert.equal(grouped.groups[1].children.length, 1);
    assert.equal(grouped.orphans.length, 0);

    await reset();
    const report = await importBoqQuotaBundle(rows, { sourceName: '截图结构测试' });
    assert.equal(report.added, 2);
    assert.equal(report.quotaAdded, 2, '相同定额编码在另一清单出现时应复用定额主数据');
    assert.equal(report.relationsAdded, 3);

    const libraries = await boqLibraryRepo.all();
    const quotas = await quotaRepo.all();
    const relations = await boqLibraryQuotaRelationRepo.all();
    assert.equal(libraries.length, 2);
    assert.equal(quotas.length, 2);
    assert.equal(relations.length, 3);

    const firstLibrary = libraries.find(item => item.code === '010904002017');
    const firstRelations = relations.filter(item => item.boqLibraryItemId === firstLibrary.id);
    assert.equal(firstRelations.length, 2);
    assert.equal(firstRelations.some(item => item.quotaSnapshot.priceTotal === -74.7), true, '负价调整定额必须保留为有效组成');
    assert.equal(calculateQuotaRelations(firstRelations, 435.05).unitPrice, 20.76);

    const sharedQuota = quotas.find(item => item.code === '9-2-47');
    assert.equal(relations.filter(item => item.quotaItemId === sharedQuota.id).length, 2, '同一定额主数据应能被多条清单引用');

    await projectRepo.replaceAll([{ id: 'project-rel', name: '关系测试项目', totalCost: 0 }]);
    const projectLine = await boqLibraryService.applyToProject(firstLibrary.id, 'project-rel');
    assert.equal(projectLine.unitPrice, 20.76);
    assert.equal(projectLine.pricingMode, 'composition');
    assert.equal((await projectBoqQuotaRelationRepo.byBoqLine(projectLine.id)).length, 2);
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
  }
}

function screenshotRows() {
  return [
    { layer: '清单', code: '010904002017', name: '楼（地）面涂膜防水', feature: '聚氨酯防水涂料', unit: 'm²', qty: 435.05, unitPrice: 20.76, amount: 9031.64, sourceRowNumber: 521 },
    { layer: '定额', code: '9-2-47', name: '聚氨酯防水涂膜 厚2mm 平面', feature: '定额标识：16jz', unit: '10m²', qty: 43.505, unitPrice: 282.29, amount: 12281.03, labor: 36.68, material: 225.89, machine: 0, management: 12.44, profit: 7.28, sourceRowNumber: 522 },
    { layer: '定额', code: '9-2-49', name: '聚氨酯防水涂膜 每增减0.5mm厚 平面（-1.00倍）', unit: '10m²', qty: 43.505, unitPrice: -74.7, amount: -3249.82, labor: -9.17, material: -60.6, management: -3.11, profit: -1.82, sourceRowNumber: 523 },
    { layer: '清单', code: '010904002099', name: '池壁涂膜防水', unit: 'm²', qty: 100, unitPrice: 28.23, amount: 2823, sourceRowNumber: 530 },
    { layer: '定额', code: '9-2-47', name: '聚氨酯防水涂膜 厚2mm 平面', unit: '10m²', qty: 10, unitPrice: 282.29, amount: 2822.9, sourceRowNumber: 531 },
  ];
}

async function reset() {
  await Promise.all([
    boqLibraryRepo.replaceAll([]), quotaRepo.replaceAll([]), boqLibraryQuotaRelationRepo.replaceAll([]),
    projectRepo.replaceAll([]), boqRepo.replaceAll([]), projectBoqQuotaRelationRepo.replaceAll([]),
  ]);
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    clear: () => data.clear(),
  };
}
