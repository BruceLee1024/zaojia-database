import assert from 'node:assert/strict';

export async function testResourceHealth() {
  const { selectCurrentResourcePrice } = await import('../assets/services/resourcePriceService.js?v=test-health');
  const { getUsageComparisonReasons } = await import('../assets/services/quotaResourceService.js?v=test-health');
  const { buildResourceHealth } = await import('../assets/services/resourceHealthService.js?v=test-health');
  const { resourceHealthSection } = await import('../assets/views/dashboard.js?v=test-health');
  const { nextResourceViewState } = await import('../assets/views/resources.js?v=test-health');
  const { quotaRouteNotice } = await import('../assets/views/quota.js?v=test-health');

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

  assert.equal(selectCurrentResourcePrice(resources[1], prices, localToday).id, 'p-expired', '首选价即使过期也仍是当前价');
  assert.deepEqual(getUsageComparisonReasons(usages[1], resources[2], prices[1]), []);
  assert.deepEqual(getUsageComparisonReasons({ ...usages[1], resourceType: 'material' }, resources[2], prices[1]), ['resourceType']);

  const health = buildResourceHealth({ resources, prices, attachments, usages, today: localToday });
  assert.deepEqual(health.missingCurrentPrice, {
    total: 1, material: 1, equipment: 0,
    resourceIds: ['m-no-price'], materialResourceIds: ['m-no-price'], equipmentResourceIds: [], priceIds: [], usageIds: [], quotaItemIds: [],
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
  assert.deepEqual(health.summary, { total: 4, material: 2, equipment: 2 });

  const html = resourceHealthSection(health);
  assert.equal(html.includes('资源健康'), true);
  assert.equal(html.includes('缺少当前价'), true);
  assert.equal(html.includes('data-health-issue="missingCurrentPrice"'), true);
  assert.equal(html.includes('data-health-type="material"'), true);
  assert.equal(html.includes('data-health-issue="pendingQuotaUpdates"'), true);
  assert.equal(html.includes('查看待更新定额'), true);

  const filtered = nextResourceViewState(
    { resourceType: 'material', keyword: '旧关键词', resourceIds: [] },
    'materials',
    { resourceIds: ['m-no-price', 'm-expired'], healthLabel: '需要处理' },
  );
  assert.deepEqual(filtered.resourceIds, ['m-no-price', 'm-expired']);
  assert.equal(filtered.healthLabel, '需要处理');
  assert.equal(quotaRouteNotice({ healthReason: 'pending-resource-updates', affectedCount: 2 }), '来自“资源健康”：2 条定额的材料/设备价格或元数据已变更，请打开人材机组成对比并确认刷新快照。');
}
