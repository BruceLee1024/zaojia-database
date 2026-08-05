import assert from 'node:assert/strict';
import { STORES, quotaRepo, quotaResourceUsageRepo, resourcePriceRepo, resourceRepo } from '../assets/data/repository.js?v=6.8';
import { quotaResourceService } from '../assets/services/quotaResourceService.js?v=6.8';
import { boqService } from '../assets/services/boqService.js?v=6.8';
import { versionService } from '../assets/services/versionService.js?v=6.8';
import { BREAKDOWN_KEYS, buildCompositionPreview, buildUsageComparisonViewModel, compositionPanelShell, normalizeBreakdown, parseQuotaBreakdownInputValues } from '../assets/views/quotaResourceComposition.js?v=6.8';
import { applyCompositionFromPanel, isCurrentQuotaResourcePanel } from '../assets/views/quotaResourceCompositionPanel.js?v=6.8';
import { annotateBoqResourceAuditIssues, buildBoqResourceViewModel, renderBoqResourceReference, withBoqResourcePriceMetadata } from '../assets/views/boqResourceReference.js?v=6.8';
import { buildQuoteAuditViewModel, loadQuoteAuditViewModel, renderQuoteAuditViewModel } from '../assets/views/boqAuditViewModel.js?v=6.8';
import { createBusyActionRunner, createLatestRequestGuard } from '../assets/utils/asyncInteraction.js?v=6.8';
import { localDateKey } from '../assets/utils/localDate.js?v=6.8';

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
    await testApplyCompositionUsesValidatedUnsavedBase();
    await reset();
    await testResourceAuditAndVersionSnapshots();
    await reset();
    await testDuplicateInstallationMatchesExactEquipmentLine();
    await testPanelApplyCapturesUnsavedBreakdown();
    await testQuotaBreakdownInputValidation();
    await testAsyncInteractionGuards();
    testLocalCalendarDateAndPanelContext();
    testPureResourceViewModels();
    await testVisibleQuoteAuditViewModel();
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
    { id: 'p1', resourceId: 'r1', unitPrice: 100, priceBasis: 'delivered', sourceType: 'official', priceDate: '2026-01-01', validTo: '2026-12-31', supplier: '甲厂', taxIncluded: true, taxRate: 13, region: { province: '四川' } },
    { id: 'p2', resourceId: 'r1', unitPrice: 125, priceBasis: 'delivered', sourceType: 'supplier_quote', priceDate: '2026-07-01', validTo: '2026-12-31', supplier: '乙厂', taxIncluded: false, taxRate: 9, region: { province: '重庆' } },
  ]);
  const usage = await quotaResourceService.saveUsage({ quotaItemId: 'q1', resourceId: 'r1', selectedPriceId: 'p1', quantityPerUnit: 2, lossRate: 10 });
  const before = await quotaResourceService.compareUsage(usage.id);
  assert.equal(before.stale, true);
  assert.equal(before.priceDelta, 25);
  assert.equal(before.currentPrice.id, 'p2');
  ['supplier', 'taxIncluded', 'taxRate', 'region'].forEach(reason => assert.equal(before.staleReasons.includes(reason), true));
  assert.equal((await quotaResourceUsageRepo.findById(usage.id)).selectedPriceId, 'p1', '比较不得自动刷新');

  const refreshed = await quotaResourceService.refreshUsageSnapshot(usage.id);
  assert.equal(refreshed.selectedPriceId, 'p2');
  assert.equal(refreshed.priceSnapshot.priceBasis, 'delivered');
  assert.equal(refreshed.calculatedCost, 275);
  assert.equal((await quotaResourceService.compareUsage(usage.id)).stale, false);
  assert.deepEqual(await quotaResourceService.removeUsage(usage.id), refreshed);
  assert.equal(await quotaResourceUsageRepo.findById(usage.id), null);
}

async function testApplyCompositionUsesValidatedUnsavedBase() {
  await quotaRepo.replaceAll([{ id: 'q-draft', name: '草稿定额', breakdown: { 人工: 10, 材料: 1, 设备: 2, 机械: 3, 管理费: 4, 利润: 5, 风险: 6 } }]);
  await quotaResourceUsageRepo.replaceAll([
    { id: 'u-material', quotaItemId: 'q-draft', resourceType: 'material', calculatedCost: 120 },
    { id: 'u-equipment', quotaItemId: 'q-draft', resourceType: 'equipment', calculatedCost: 500 },
  ]);
  const unsaved = { 人工: 88, 材料: 999, 设备: 999, 机械: 33, 管理费: 44, 利润: 55, 风险: 66 };
  const applied = await quotaResourceService.applyComposition('q-draft', { baseBreakdown: unsaved });
  assert.deepEqual(applied.breakdown, { 人工: 88, 材料: 120, 设备: 500, 机械: 33, 管理费: 44, 利润: 55, 风险: 66 });
  assert.equal(applied.priceTotal, 906);
  assert.equal(applied.useBreakdown, true);
  await assert.rejects(
    () => quotaResourceService.applyComposition('q-draft', { baseBreakdown: { ...unsaved, 人工: -1 } }),
    /分项费用/,
  );
  await assert.rejects(
    () => quotaResourceService.applyComposition('q-draft', { baseBreakdown: { 人工: 1 } }),
    /缺少分项费用/,
  );
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
    installationResourceItemId: 'equipment-1', manualInstallationResourceId: 'equipment-1',
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
  const installSnap = version.lines.find(line => line.id === 'line-install');
  assert.equal(installSnap.installationResourceItemId, 'equipment-1');
  assert.equal(installSnap.manualInstallationResourceId, 'equipment-1');
  const restore = await versionService.restore(version.id);
  const restored = (await setStoreGet(STORES.project_boq)).find(line => line.resourceItemId === 'equipment-1');
  assert.deepEqual(restored.resourcePriceSnapshot, expired);
  assert.equal(restore.restoredCount, 3);
  const restoredInstall = (await setStoreGet(STORES.project_boq)).find(line => line.quotaItemId === 'quota-install');
  assert.equal(restoredInstall.installationResourceItemId, 'equipment-1');
  assert.equal(restoredInstall.manualInstallationResourceId, 'equipment-1');
}

async function testDuplicateInstallationMatchesExactEquipmentLine() {
  const composite = { id: 'price-composite', resourceId: 'equipment-1', unitPrice: 26000, priceBasis: 'installed_composite' };
  const delivered = { id: 'price-delivered', resourceId: 'equipment-1', unitPrice: 20000, priceBasis: 'delivered' };
  const compositeLine = { id: 'equipment-composite', projectId: 'project-dup', resourceItemId: 'equipment-1', resourcePriceId: composite.id, resourcePriceSnapshot: composite, name: '综合价风机', qty: 1, factor: 1, unitPrice: 26000 };
  const deliveredLine = { id: 'equipment-delivered', projectId: 'project-dup', resourceItemId: 'equipment-1', resourcePriceId: delivered.id, resourcePriceSnapshot: delivered, name: '到场价风机', qty: 1, factor: 1, unitPrice: 20000 };
  const validDeliveredInstall = { id: 'install-delivered', projectId: 'project-dup', quotaItemId: 'q-install', linkedResourceItemId: 'equipment-1', linkedEquipmentLineId: deliveredLine.id, name: '到场价风机安装', qty: 1, factor: 1, unitPrice: 2000 };
  const duplicateCompositeInstall = { id: 'install-composite', projectId: 'project-dup', quotaItemId: 'q-install', linkedResourceItemId: 'equipment-1', linkedEquipmentLineId: compositeLine.id, name: '综合价风机安装', qty: 1, factor: 1, unitPrice: 2000 };
  await setStore(STORES.projects, [{ id: 'project-dup' }]);
  await setStore(STORES.project_boq, [compositeLine, deliveredLine, validDeliveredInstall, duplicateCompositeInstall]);
  await quotaRepo.replaceAll([{ id: 'q-install', name: '风机安装' }]);
  await resourceRepo.replaceAll([{ id: 'equipment-1', resourceType: 'equipment', name: '风机' }]);
  await resourcePriceRepo.replaceAll([composite, delivered]);
  const exactAudit = await boqService.audit('project-dup');
  assert.deepEqual(
    exactAudit.issues.duplicateEquipmentInstallation.map(line => line.id).sort(),
    ['equipment-composite', 'install-composite'],
  );

  await setStore(STORES.project_boq, [compositeLine, deliveredLine, { ...validDeliveredInstall, id: 'install-unscoped', linkedEquipmentLineId: '' }]);
  const ambiguousAudit = await boqService.audit('project-dup');
  assert.deepEqual(ambiguousAudit.issues.duplicateEquipmentInstallation, []);

  await setStore(STORES.project_boq, [compositeLine, { ...duplicateCompositeInstall, id: 'install-broken-link', linkedEquipmentLineId: 'missing-equipment-line' }]);
  const brokenLinkAudit = await boqService.audit('project-dup');
  assert.deepEqual(brokenLinkAudit.issues.duplicateEquipmentInstallation, []);
}

async function testPanelApplyCapturesUnsavedBreakdown() {
  const calls = [];
  const unsaved = { 人工: 81, 材料: 2, 设备: 3, 机械: 31, 管理费: 4, 利润: 5, 风险: 6 };
  const quota = { id: 'quota-caller', breakdown: { 人工: 1 } };
  const result = await applyCompositionFromPanel({
    quota,
    getBaseBreakdown: () => unsaved,
    service: { applyComposition: async (...args) => { calls.push(args); return { id: quota.id, breakdown: { ...unsaved, 材料: 120, 设备: 500 }, priceTotal: 747 }; } },
  });
  assert.deepEqual(calls, [['quota-caller', { baseBreakdown: unsaved }]]);
  assert.equal(result.breakdown.人工, 81);
  assert.equal(quota.breakdown.机械, 31);
}

async function testQuotaBreakdownInputValidation() {
  const valid = Object.fromEntries(BREAKDOWN_KEYS.map((key, index) => [key, String(index + 1)]));
  assert.deepEqual(parseQuotaBreakdownInputValues(valid), { 人工: 1, 材料: 2, 设备: 3, 机械: 4, 管理费: 5, 利润: 6, 风险: 7 });
  assert.throws(() => parseQuotaBreakdownInputValues({ ...valid, 人工: 'Infinity' }), /人工.*有效数字/);
  assert.throws(() => parseQuotaBreakdownInputValues({ ...valid, 机械: 'not-a-number' }), /机械.*有效数字/);

  let applyCalls = 0;
  await assert.rejects(
    () => applyCompositionFromPanel({
      quota: { id: 'quota-invalid-input' },
      getBaseBreakdown: () => parseQuotaBreakdownInputValues({ ...valid, 风险: 'NaN' }),
      service: { applyComposition: async () => { applyCalls += 1; } },
    }),
    /风险.*有效数字/,
  );
  assert.equal(applyCalls, 0, '非法输入不得调用组成应用服务');
}

function testLocalCalendarDateAndPanelContext() {
  const localMidnight = new Date(2026, 6, 15, 0, 30, 0);
  assert.equal(localDateKey(localMidnight), '2026-07-15');
  assert.equal(localMidnight.toISOString().slice(0, 10), '2026-07-14', 'Asia/Shanghai 本地日期应与 UTC 日期不同');
  assert.equal(localDateKey(new Date(Number.NaN)), '');

  const connected = { isConnected: true };
  const base = {
    container: connected,
    currentContainer: connected,
    expectedGeneration: 4,
    currentGeneration: 4,
    expectedResourceId: 'resource-a',
    currentResourceId: 'resource-a',
  };
  assert.equal(isCurrentQuotaResourcePanel(base), true);
  assert.equal(isCurrentQuotaResourcePanel({ ...base, container: { isConnected: false }, currentContainer: connected }), false);
  assert.equal(isCurrentQuotaResourcePanel({ ...base, currentContainer: {} }), false);
  assert.equal(isCurrentQuotaResourcePanel({ ...base, currentGeneration: 5 }), false);
  assert.equal(isCurrentQuotaResourcePanel({ ...base, currentResourceId: 'resource-b' }), false);
}

async function testAsyncInteractionGuards() {
  const latest = createLatestRequestGuard();
  const applied = [];
  let resolveFirst;
  let resolveSecond;
  const first = latest.run(() => new Promise(resolve => { resolveFirst = resolve; }), value => applied.push(value));
  const second = latest.run(() => new Promise(resolve => { resolveSecond = resolve; }), value => applied.push(value));
  resolveSecond('second');
  await second;
  resolveFirst('first');
  const stale = await first;
  assert.deepEqual(applied, ['second']);
  assert.equal(stale.stale, true);

  const busyStates = [];
  const errors = [];
  let release;
  const runner = createBusyActionRunner({ onBusy: value => busyStates.push(value), onError: error => errors.push(error.message) });
  const running = runner.run(() => new Promise(resolve => { release = resolve; }));
  assert.equal((await runner.run(async () => 'overlap')).skipped, true);
  release('done');
  assert.deepEqual(await running, { ok: true, value: 'done' });
  const failure = await runner.run(async () => { throw new Error('用户可见错误'); });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.message, '用户可见错误');
  assert.deepEqual(busyStates, [true, false, true, false]);
  assert.deepEqual(errors, ['用户可见错误']);
}

function testPureResourceViewModels() {
  assert.equal(compositionPanelShell({ id: 'q1' }).includes('搜索并关联材料或设备'), true);
  assert.equal(compositionPanelShell({ id: '' }).includes('保存定额后'), true);
  const usageVm = buildUsageComparisonViewModel({
    usage: { priceSnapshot: { unitPrice: 100, priceBasis: 'delivered', sourceType: 'official', sourceName: '甲厂', supplier: '甲厂', taxIncluded: true, taxRate: 13, region: { province: '四川' }, validTo: '2026-08-01', installationScope: '' }, calculatedCost: 210 },
    resource: { name: '钢管', specModel: 'DN100' }, currentPrice: { unitPrice: 120, priceBasis: 'installed_composite', sourceType: 'supplier_quote', supplier: '乙厂', taxIncluded: false, taxRate: 9, region: { province: '重庆' }, validTo: '2026-12-31', installationScope: '含调试' },
    currentCost: 252, priceDelta: 20, costDelta: 42, stale: true, staleReasons: ['unitPrice', 'priceBasis', 'supplier', 'taxRate', 'region', 'validTo', 'installationScope'],
  });
  assert.equal(usageVm.statusLabel, '已过时');
  assert.equal(usageVm.deltaLabel.includes('+20'), true);
  assert.equal(usageVm.changeDetails.some(item => item.includes('口径：到场价 → 安装综合价')), true);
  assert.equal(usageVm.changeDetails.some(item => item.includes('供应商：甲厂 → 乙厂')), true);
  assert.equal(usageVm.changeDetails.some(item => item.includes('地区：四川 → 重庆')), true);
  assert.equal(usageVm.changeDetails.some(item => item.includes('安装范围：未记录 → 含调试')), true);
  const inactiveVm = buildUsageComparisonViewModel({
    usage: { id: 'inactive', resourceType: 'equipment', priceSnapshot: { unitPrice: 1 } },
    resource: { id: 'r-inactive', resourceType: 'equipment', status: 'inactive', name: '停用设备' },
    currentPrice: { id: 'p-inactive', unitPrice: 1 }, stale: true, staleReasons: ['resourceInactive'],
  });
  assert.equal(inactiveVm.changeDetails.includes('资源已停用，请替换或确认处理'), true);
  const boqVm = buildBoqResourceViewModel({
    resourceReferenceStatus: 'missing', resourceSnapshot: { name: '泵', specModel: 'Q=10' },
    resourcePriceId: 'price-live', unitPrice: 10000,
  }, new Date('2026-07-15T00:00:00Z'), { id: 'price-live', unitPrice: 10000, sourceType: 'supplier_quote', priceBasis: 'installed_composite', validTo: '2000-01-01' });
  assert.equal(boqVm.name, '泵');
  assert.equal(boqVm.badges.includes('引用失效'), true);
  assert.equal(boqVm.badges.includes('价格过期'), true);
  assert.equal(boqVm.badges.includes('缺价格口径'), false);
  assert.equal(boqVm.basisLabel, '安装综合价');
  const normalizedLine = withBoqResourcePriceMetadata({ id: 'line-live', resourcePriceId: 'price-live' }, new Map([['price-live', { id: 'price-live', priceBasis: 'installed_composite' }]]));
  assert.equal(normalizedLine.resourcePriceSnapshot.priceBasis, 'installed_composite');
  assert.equal('resourcePriceSnapshot' in withBoqResourcePriceMetadata({ id: 'plain' }, new Map()), false);
  const annotated = annotateBoqResourceAuditIssues([{ id: 'equipment-composite' }, { id: 'plain' }], { issues: { duplicateEquipmentInstallation: [{ id: 'equipment-composite' }] } });
  assert.deepEqual(annotated[0].resourceAuditIssueKeys, ['duplicateEquipmentInstallation']);
  assert.deepEqual(annotated[1].resourceAuditIssueKeys, []);
  const html = renderBoqResourceReference(boqVm);
  assert.equal(html.includes('价格来源'), true);
  assert.equal(html.includes('快照口径'), true);
  assert.equal(html.includes('价格过期'), true);
}

async function testVisibleQuoteAuditViewModel() {
  const lines = id => [{ id, name: id }];
  const serviceAudit = {
    score: 61,
    level: '高风险',
    lines: [...lines('a'), ...lines('b')],
    versions: [{ id: 'v1' }],
    issues: {
      invalidResourceReference: lines('invalid'),
      expiredResourcePrice: lines('expired'),
      missingResourcePriceBasis: lines('basis'),
      duplicateEquipmentInstallation: lines('duplicate-install'),
    },
  };
  const vm = buildQuoteAuditViewModel(serviceAudit, { summary: 'AI 辅助审查', suggestions: [], warnings: [] });
  assert.equal(vm.score, 61);
  assert.equal(vm.level, '高风险');
  assert.deepEqual(vm.issueBlocks.map(item => item.key), ['invalidResourceReference', 'expiredResourcePrice', 'missingResourcePriceBasis', 'duplicateEquipmentInstallation']);
  assert.equal(vm.issueBlocks.every(item => item.count === 1), true);
  const html = renderQuoteAuditViewModel(vm);
  assert.equal(html.includes('健康分'), true);
  assert.equal(html.includes('资源引用失效'), true);
  assert.equal(html.includes('设备安装重复计取'), true);
  const calls = [];
  const loaded = await loadQuoteAuditViewModel('project-visible', {
    audit: async projectId => { calls.push(['audit', projectId]); return serviceAudit; },
    review: async projectId => { calls.push(['review', projectId]); return { summary: 'AI 辅助审查', suggestions: [], warnings: [] }; },
  });
  assert.deepEqual(calls.sort(), [['audit', 'project-visible'], ['review', 'project-visible']]);
  assert.equal(loaded.score, 61);
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
