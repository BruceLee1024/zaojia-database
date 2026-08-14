import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export async function testResourceHealth() {
  const { selectCurrentResourcePrice, selectUsableResourcePrice } = await import('../assets/services/resourcePriceService.js?v=test-health');
  const { getUsageComparisonReasons } = await import('../assets/services/quotaResourceService.js?v=test-health');
  const { buildResourceHealth, selectResourcePriceForHealth } = await import('../assets/services/resourceHealthService.js?v=test-health');
  const { dashboardTabNav, healthResourceRouteParams, resourceHealthSection } = await import('../assets/views/dashboard.js?v=test-health');
  const { nextResourceViewState } = await import('../assets/views/resources.js?v=test-health');
  const { quotaRouteNotice } = await import('../assets/views/quota.js?v=test-health');
  const { navigationItemHtml } = await import('../assets/views/navigation.js?v=test-health');

  const localToday = '2026-07-15';
  const resources = [
    { id: 'm-no-price', resourceType: 'material', status: 'active', name: '无价材料' },
    { id: 'm-expired', resourceType: 'material', status: 'active', preferredPriceId: 'p-expired', name: '过期材料' },
    { id: 'e-current', resourceType: 'equipment', status: 'active', name: '在用设备' },
    { id: 'e-inactive', resourceType: 'equipment', status: 'inactive', name: '停用设备' },
  ];
  const prices = [
    { id: 'p-expired', resourceId: 'm-expired', sourceType: 'official', unitPrice: 8, priceDate: '2026-01-01', validTo: '2026-07-14' },
    { id: 'p-current', resourceId: 'e-current', sourceType: 'supplier_quote', unitPrice: 100, priceBasis: 'delivered', supplier: '乙厂', priceDate: '2026-07-10', validTo: '2026-12-31', region: { province: '四川' } },
    { id: 'p-evidence-ok', resourceId: 'e-current', sourceType: 'supplier_quote', unitPrice: 90, priceBasis: 'delivered', supplier: '甲厂', priceDate: '2026-06-01', region: { province: '四川' } },
    { id: 'p-inactive', resourceId: 'e-inactive', sourceType: 'supplier_quote', unitPrice: 10, priceDate: '2026-07-01' },
  ];
  const attachments = [
    { id: 'a-ok', resourceId: 'e-current', priceId: 'p-evidence-ok', status: 'available' },
    { id: 'a-missing', resourceId: 'e-current', priceId: 'p-current', status: 'missing' },
  ];
  const usages = [
    {
      id: 'u-stale', quotaItemId: 'q-stale', resourceId: 'e-current', resourceType: 'equipment', selectedPriceId: 'p-evidence-ok',
      priceSnapshot: { unitPrice: 90, priceBasis: 'delivered', sourceType: 'supplier_quote', supplier: '甲厂', priceDate: '2026-06-01', region: { province: '四川' } },
    },
    {
      id: 'u-current', quotaItemId: 'q-current', resourceId: 'e-current', resourceType: 'equipment', selectedPriceId: 'p-current',
      priceSnapshot: { unitPrice: 100, priceBasis: 'delivered', sourceType: 'supplier_quote', supplier: '乙厂', priceDate: '2026-07-10', validTo: '2026-12-31', region: { province: '四川' } },
    },
  ];

  assert.equal(selectCurrentResourcePrice(resources[1], prices, localToday), null, '过期首选价不能成为当前价');
  assert.deepEqual(getUsageComparisonReasons(usages[1], resources[2], prices[1]), []);
  assert.deepEqual(getUsageComparisonReasons({ ...usages[1], resourceType: 'material' }, resources[2], prices[1]), ['resourceType']);
  assert.equal(getUsageComparisonReasons({ ...usages[1], resourceId: 'e-inactive' }, resources[3], prices[3])[0], 'resourceInactive');

  const ordinaryExpired = { id: 'm-ordinary-expired', resourceType: 'material', status: 'active', preferredPriceId: 'missing' };
  const ordinaryExpiredPrices = [
    { id: 'older', resourceId: ordinaryExpired.id, priceDate: '2026-01-01', validTo: '2026-12-31' },
    { id: 'latest', resourceId: ordinaryExpired.id, priceDate: '2026-07-01', validTo: '2026-07-14' },
  ];
  assert.equal(selectCurrentResourcePrice(ordinaryExpired, ordinaryExpiredPrices, localToday).id, 'older', 'operational policy still selects a valid price');
  const regional = { id: 'regional', resourceType: 'equipment', preferredPriceId: 'sc' };
  const regionalPrices = [
    { id: 'sc', resourceId: 'regional', priceDate: '2026-07-10', validFrom: '2026-07-01', region: { province: '四川', city: '成都' } },
    { id: 'cq', resourceId: 'regional', priceDate: '2026-07-12', validFrom: '2026-07-01', region: { province: '重庆', city: '重庆' } },
    { id: 'project', resourceId: 'regional', projectId: 'p1', priceDate: '2026-07-11', validFrom: '2026-07-01', region: { province: '四川', city: '成都' } },
  ];
  assert.equal(selectUsableResourcePrice(regional, regionalPrices, { asOf: localToday, region: { province: '四川', city: '成都' } }).id, 'sc');
  assert.equal(selectUsableResourcePrice(regional, regionalPrices, { asOf: localToday, projectId: 'p1', region: { province: '四川', city: '成都' } }).id, 'project');
  assert.equal(selectUsableResourcePrice(regional, regionalPrices, { asOf: localToday, region: { province: '江苏', city: '南京' } }), null);
  assert.equal(selectResourcePriceForHealth(ordinaryExpired, ordinaryExpiredPrices, localToday).id, 'older', 'health classification first uses the operational current price');
  const expiredHealth = buildResourceHealth({ resources: [ordinaryExpired], prices: ordinaryExpiredPrices, today: localToday });
  assert.equal(expiredHealth.missingCurrentPrice.total, 0);
  assert.deepEqual(expiredHealth.expiredCurrentPrice.resourceIds, []);
  const onlyExpired = { id: 'only-expired', resourceType: 'equipment', status: 'active' };
  const onlyExpiredHealth = buildResourceHealth({
    resources: [onlyExpired],
    prices: [{ id: 'only-expired-price', resourceId: onlyExpired.id, priceDate: '2026-07-01', validTo: '2026-07-14' }],
    today: localToday,
  });
  assert.equal(onlyExpiredHealth.missingCurrentPrice.total, 1);
  assert.deepEqual(onlyExpiredHealth.expiredCurrentPrice.resourceIds, [onlyExpired.id]);

  const health = buildResourceHealth({ resources, prices, attachments, usages, today: localToday });
  assert.deepEqual(health.missingCurrentPrice, {
    total: 2, material: 2, equipment: 0,
    resourceIds: ['m-no-price', 'm-expired'], materialResourceIds: ['m-no-price', 'm-expired'], equipmentResourceIds: [], priceIds: [], usageIds: [], quotaItemIds: [],
  });
  assert.deepEqual(health.expiredCurrentPrice, {
    total: 1, material: 1, equipment: 0,
    resourceIds: ['m-expired'], materialResourceIds: ['m-expired'], equipmentResourceIds: [], priceIds: ['p-expired'], usageIds: [], quotaItemIds: [],
  });
  assert.deepEqual(health.missingQuoteEvidence, {
    total: 1, material: 0, equipment: 1,
    resourceIds: ['e-current'], materialResourceIds: [], equipmentResourceIds: ['e-current'], priceIds: ['p-current'], usageIds: [], quotaItemIds: [],
  });
  assert.deepEqual(health.pendingQuotaUpdates, {
    total: 1, material: 0, equipment: 1,
    resourceIds: ['e-current'], materialResourceIds: [], equipmentResourceIds: ['e-current'], priceIds: ['p-current'], usageIds: ['u-stale'], quotaItemIds: ['q-stale'],
  });
  assert.deepEqual(health.summary, { total: 5, material: 3, equipment: 2 });

  const mixedPending = buildResourceHealth({
    resources: [
      { id: 'm1', resourceType: 'material', status: 'active' },
      { id: 'e1', resourceType: 'equipment', status: 'active' },
      { id: 'e2', resourceType: 'equipment', status: 'active' },
    ],
    prices: [
      { id: 'pm', resourceId: 'm1', unitPrice: 10, priceDate: '2026-07-10' },
      { id: 'pe1', resourceId: 'e1', unitPrice: 20, priceDate: '2026-07-10' },
      { id: 'pe2', resourceId: 'e2', unitPrice: 30, priceDate: '2026-07-10' },
    ],
    usages: [
      { id: 'um', quotaItemId: 'q-mixed', resourceId: 'm1', resourceType: 'material', selectedPriceId: 'old-m', priceSnapshot: { unitPrice: 9 } },
      { id: 'ue1', quotaItemId: 'q-mixed', resourceId: 'e1', resourceType: 'equipment', selectedPriceId: 'old-e1', priceSnapshot: { unitPrice: 19 } },
      { id: 'ue2', quotaItemId: 'q-equipment', resourceId: 'e2', resourceType: 'equipment', selectedPriceId: 'old-e2', priceSnapshot: { unitPrice: 29 } },
    ],
    today: localToday,
  }).pendingQuotaUpdates;
  assert.equal(mixedPending.total, 2);
  assert.equal(mixedPending.material, 1);
  assert.equal(mixedPending.equipment, 2);
  assert.deepEqual(mixedPending.usageIds, ['um', 'ue1', 'ue2']);
  assert.deepEqual(mixedPending.quotaItemIds, ['q-mixed', 'q-equipment']);

  const html = resourceHealthSection(health);
  assert.equal(html.includes('资源健康'), true);
  assert.equal(html.includes('缺少当前价'), true);
  assert.equal(html.includes('data-health-issue="missingCurrentPrice"'), true);
  assert.equal(html.includes('data-health-type="material"'), true);
  assert.equal(html.includes('data-health-issue="pendingQuotaUpdates"'), true);
  assert.equal(html.includes('查看待更新定额'), true);

  const dashboardTabs = dashboardTabNav({
    nextActions: [{ id: 'pending' }],
    projects: [{ id: 'project-1' }, { id: 'project-2' }],
    recentVersions: [{ id: 'version-1' }],
    resourceHealth: health,
  }, 'resources');
  assert.equal((dashboardTabs.match(/role="tab"/g) || []).length, 4, '概览应按职责拆分为 4 个 Tab');
  assert.equal(dashboardTabs.includes('工作概览'), true);
  assert.equal(dashboardTabs.includes('项目分析'), true);
  assert.equal(dashboardTabs.includes('资源健康'), true);
  assert.equal(dashboardTabs.includes('版本与复盘'), true);
  assert.match(dashboardTabs, /data-dashboard-tab="resources"[^>]+aria-selected="true"/);
  assert.equal(dashboardTabs.includes('border-b-'), false, 'Tab 不使用底部下划线表示选中');

  const filtered = nextResourceViewState(
    { resourceType: 'material', keyword: '旧关键词', resourceIds: [] },
    'materials',
    { resourceIds: ['m-no-price', 'm-expired'], healthLabel: '需要处理' },
  );
  assert.deepEqual(filtered.resourceIds, ['m-no-price', 'm-expired']);
  assert.equal(filtered.healthLabel, '需要处理');
  const normalNavigation = nextResourceViewState({ ...filtered, keyword: '保留关键词', category: '管材', status: 'active', selectedId: 'm-no-price' }, 'materials', {});
  assert.equal(normalNavigation.keyword, '保留关键词');
  assert.equal(normalNavigation.category, '管材');
  assert.equal(normalNavigation.status, 'active');
  assert.equal(normalNavigation.selectedId, 'm-no-price');
  assert.deepEqual(normalNavigation.resourceIds, []);
  assert.equal(normalNavigation.healthLabel, '');
  assert.deepEqual(healthResourceRouteParams('missingCurrentPrice', health.missingCurrentPrice, 'material'), { resourceIds: ['m-no-price', 'm-expired'], healthLabel: '缺参考价' });
  assert.deepEqual(healthResourceRouteParams('expiredCurrentPrice', health.expiredCurrentPrice, 'material'), { resourceIds: ['m-expired'], healthLabel: '价格已过期' });
  assert.deepEqual(healthResourceRouteParams('missingQuoteEvidence', health.missingQuoteEvidence, 'equipment'), { resourceIds: ['e-current'], healthLabel: '询价缺附件' });
  assert.equal(quotaRouteNotice({ healthReason: 'pending-resource-updates', affectedCount: 2 }), '来自“资源健康”：2 条定额的材料/设备价格或元数据已变更，请打开人材机组成对比并确认刷新快照。');

  const activeNav = navigationItemHtml({ id: 'materials', label: '我的材料库', desc: '材料主数据与价格', icon: 'category' }, true);
  assert.equal(activeNav.startsWith('<button'), true);
  assert.equal(activeNav.includes('aria-label="我的材料库：材料主数据与价格"'), true);
  assert.equal(activeNav.includes('title="我的材料库"'), true);
  assert.equal(activeNav.includes('aria-current="page"'), true);
  assert.equal(navigationItemHtml({ id: 'equipment', label: '我的设备库', desc: '设备选型与价格', icon: 'build' }, false).includes('aria-current'), false);
  const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(appSource, /id: 'cost-estimation',[^\n]+icon: 'payments'/, '成本测算导航必须保留与其他菜单一致的图标占位');

  assertCacheGraph();
}

function assertCacheGraph() {
  const expectations = [
    ['../app.js', "./assets/views/dashboard.js?v=6.15&build=20260814e", "./assets/views/quota.js?v=6.15", "./assets/views/resources.js?v=6.15", "./assets/views/navigation.js?v=6.15"],
    ['../assets/views/dashboard.js', "../services/resourceHealthService.js?v=6.15"],
    ['../assets/views/resources.js', "../services/resourcePriceService.js?v=6.15", "./resourceAttachments.js?v=6.15"],
    ['../assets/views/quota.js', "./quotaResourceComposition.js?v=6.15", "./quotaResourceCompositionPanel.js?v=6.15"],
    ['../assets/views/quotaResourceCompositionPanel.js', "../services/quotaResourceService.js?v=6.15", "../services/resourcePriceService.js?v=6.15", "./quotaResourceComposition.js?v=6.15"],
    ['../assets/views/resourceAttachments.js', "../services/resourcePriceService.js?v=6.15"],
    ['../assets/services/resourceHealthService.js', "./quotaResourceService.js?v=6.15", "./resourcePriceService.js?v=6.15"],
    ['../assets/services/quotaResourceService.js', "./resourcePriceService.js?v=6.15"],
  ];
  expectations.forEach(([file, ...imports]) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    imports.forEach(specifier => assert.equal(source.includes(specifier), true, `${file} must import ${specifier}`));
  });
}
