import assert from 'node:assert/strict';
import { aggregateReferenceProjects, projectRegionLabel } from '../assets/services/indicatorService.js?v=test-indicator-aggregation';

export function testIndicatorAggregation() {
  const projects = [
    { id: 'p1', status: 'archived', type: '污水处理厂', area: 1000, dailyCapacity: 2, pricingRegion: { province: '安徽', city: '合肥', district: '蜀山' } },
    { id: 'p2', status: 'archived', type: '污水处理厂', area: 2000, dailyCapacity: 4, pricingRegion: { province: '安徽', city: '芜湖' } },
    { id: 'p3', status: 'doing', type: '泵站', region: '江苏' },
  ];
  const facts = [
    formalFact('f1', 'p1', 1000000),
    formalFact('f2', 'p2', 3000000),
    formalFact('f3', 'p3', 9000000),
    { ...formalFact('candidate', 'p1', 8000000), status: 'candidate' },
  ];
  assert.equal(projectRegionLabel(projects[0]), '安徽 · 合肥 · 蜀山');
  assert.equal(projectRegionLabel(projects[0], 'province'), '安徽');

  const byProvince = aggregateReferenceProjects(projects, facts, 'province');
  assert.equal(byProvince.length, 1);
  assert.equal(byProvince[0].key, '安徽');
  assert.equal(byProvince[0].count, 2);
  assert.equal(byProvince[0].total.median, 1000000);
  assert.equal(byProvince[0].area.median, 1000);
  assert.equal(byProvince[0].water.median, 50);
  assert.equal(byProvince[0].areaCoverage, 1);

  const byType = aggregateReferenceProjects(projects, facts, 'type');
  assert.equal(byType[0].key, '污水处理厂');
  assert.deepEqual(byType[0].projectIds.sort(), ['p1', 'p2']);
}

function formalFact(id, projectId, totalCost) {
  return { id, projectId, status: 'formal', sourceType: 'archived_project', factType: 'project_cost', payload: { totalCost }, updatedAt: id };
}
