import assert from 'node:assert/strict';
import { calculateAmount, hasMissingPrice } from '../assets/utils/costing.js';
import { detectRowKind, rowToBOQ, rowToQuotaItem } from '../assets/data/excel.js';

function testCosting() {
  assert.equal(calculateAmount(10, 25, 1.08), 270);
  assert.equal(calculateAmount('', 25, 1), 0);
  assert.equal(calculateAmount(10, 0, 1), 0);
  assert.equal(hasMissingPrice(0), true);
  assert.equal(hasMissingPrice(''), true);
  assert.equal(hasMissingPrice(1), false);
}

function testExcelRows() {
  const quotaRow = {
    清单名称: 'C30 满堂基础',
    项目特征: '混凝土强度等级：C30',
    单位: 'm³',
    综合单价: '520.5',
  };
  assert.equal(detectRowKind(quotaRow), 'quota');
  const quota = rowToQuotaItem(quotaRow);
  assert.equal(quota.name, 'C30 满堂基础');
  assert.equal(quota.priceTotal, 520.5);
  assert.equal(quota.priceMissing, false);

  const missingPriceQuota = rowToQuotaItem({ 清单名称: '缺价项', 单位: 'm²', 综合单价: '' });
  assert.equal(missingPriceQuota.priceMissing, true);

  const boqRow = {
    项目编码: '0101',
    项目名称: '防水卷材',
    计量单位: 'm²',
    工程数量: '12',
    综合单价: '30',
  };
  assert.equal(detectRowKind(boqRow), 'boq');
  const boq = rowToBOQ(boqRow, 'p1');
  assert.equal(boq.projectId, 'p1');
  assert.equal(boq.amount, 360);
  assert.equal(boq.priceMissing, false);

  const combinedBoq = rowToBOQ({
    项目编码: '0102',
    '项目名称\n项目特征': '钢管内填芯\n1、混凝土灌芯长度:1.5m\n2、砼强度:C40',
    计量单位: 'm3',
    工程数量: '3.4',
    综合单价: '',
  }, 'p1');
  assert.equal(detectRowKind({ 项目编码: '0102', '项目名称\n项目特征': '钢管内填芯' }), 'boq');
  assert.equal(combinedBoq.name, '钢管内填芯');
  assert.equal(combinedBoq.feature.includes('混凝土灌芯长度'), true);
  assert.equal(combinedBoq.qty, 3.4);
  assert.equal(combinedBoq.priceMissing, true);

  const nameColumnBoq = rowToBOQ({
    名称: '截桩',
    '项目名称\n项目特征': '截桩\n1、桩类型:预应力混凝土空心方桩',
    计量单位: '根',
    工程数量: '50',
  }, 'p1');
  assert.equal(detectRowKind({ 名称: '截桩', '项目名称\n项目特征': '截桩' }), 'boq');
  assert.equal(nameColumnBoq.name, '截桩');
  assert.equal(nameColumnBoq.feature.includes('桩类型'), true);
  assert.equal(nameColumnBoq.unit, '根');
}

testCosting();
testExcelRows();
await testVersions();
await testDataEngine();
console.log('All tests passed');

async function testVersions() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.has(`ls:${key}`) ? memory.get(`ls:${key}`) : null,
    setItem: (key, value) => memory.set(`ls:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-version');
  const { versionService } = await import('../assets/services/versionService.js?v=test-version');

  await repo.projectRepo.replaceAll([{ id: 'p1', name: '测试项目', totalCost: 100 }]);
  await repo.quotaRepo.replaceAll([
    { id: 'q1', name: '土方', feature: '综合', unit: 'm³', priceTotal: 10 },
    { id: 'q2', name: '钢筋', feature: 'HRB400', unit: 't', priceTotal: 3000 },
  ]);
  await repo.boqRepo.replaceAll([
    { id: 'l1', projectId: 'p1', quotaItemId: 'q1', name: '土方', unit: 'm³', qty: 10, factor: 1, unitPrice: 10, amount: 100, structureGroup: 'civil' },
  ]);

  const versionA = await versionService.createFromCurrent('p1', { name: 'A', note: '初版' });
  await repo.boqRepo.replaceAll([
    { id: 'l1', projectId: 'p1', quotaItemId: 'q1', name: '土方', unit: 'm³', qty: 12, factor: 1, unitPrice: 10, amount: 120 },
    { id: 'l2', projectId: 'p1', quotaItemId: 'q2', name: '钢筋', unit: 't', qty: 2, factor: 1, unitPrice: 3000, amount: 6000 },
  ]);
  const versionB = await versionService.createFromCurrent('p1', { name: 'B' });

  const savedA = await repo.versionRepo.findById(versionA.id);
  assert.equal(savedA.lines.length, 1);
  assert.equal(savedA.lines[0].qty, 10);

  const diff = await versionService.compare(versionA.id, versionB.id);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.modified.length, 1);
  assert.equal(diff.totalDelta, 6020);
  assert.equal(diff.categorySummary.some(row => row.id === 'civil'), true);

  const restored = await versionService.restore(versionA.id);
  const current = await repo.boqRepo.byProject('p1');
  const project = await repo.projectRepo.findById('p1');
  assert.equal(restored.restoredCount, 1);
  assert.equal(Boolean(restored.backup), true);
  assert.equal(current.length, 1);
  assert.equal(current[0].qty, 10);
  assert.notEqual(current[0].id, 'l1');
  assert.equal(project.totalCost, 100);

  const { boqService } = await import('../assets/services/boqService.js?v=test-version');
  const recommendations = await boqService.recommendQuota({ name: '钢筋', feature: 'HRB400', unit: 't' });
  assert.equal(recommendations[0].id, 'q2');
  await boqService.replaceQuota(current[0].id, 'q2');
  const replaced = (await repo.boqRepo.byProject('p1'))[0];
  assert.equal(replaced.quotaItemId, 'q2');
  assert.equal(replaced.unitPrice, 3000);
  await boqService.updateStructureGroup(replaced.id, 'custom:安装清单');
  const grouped = (await repo.boqRepo.byProject('p1'))[0];
  assert.equal(grouped.structureGroup, 'custom:安装清单');
  await repo.boqRepo.replaceAll([
    { id: 'risk1', projectId: 'p1', quotaItemId: '', name: '缺价项', unit: 'm²', qty: 0, factor: 1.3, unitPrice: 0, amount: 0 },
  ]);
  const audit = await boqService.audit('p1');
  assert.equal(audit.issues.missingPrice.length, 1);
  assert.equal(audit.issues.zeroQty.length, 1);
  assert.equal(audit.issues.factorRisk.length, 1);
  assert.equal(audit.issues.unmatchedQuota.length, 1);
}

async function testDataEngine() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.has(`de:${key}`) ? memory.get(`de:${key}`) : null,
    setItem: (key, value) => memory.set(`de:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-data-engine');
  const { dataEngineService } = await import('../assets/services/dataEngineService.js?v=test-data-engine');
  const { projectService } = await import('../assets/services/projectService.js?v=test-data-engine');

  await repo.dataFactRepo.replaceAll([]);
  await repo.dataCandidateRepo.replaceAll([]);
  await repo.dataJobRepo.replaceAll([]);
  await repo.dataQualityReportRepo.replaceAll([]);
  await repo.indicatorRepo.replaceAll([]);
  await repo.projectRepo.replaceAll([{ id: 'p2', name: '沉淀项目', type: '水厂', scale: '中型', structure: '钢筋砼', status: 'doing', totalCost: 100 }]);
  await repo.boqRepo.replaceAll([
    { id: 'l21', projectId: 'p2', quotaItemId: 'q1', code: '001', name: '土方', feature: '综合', unit: 'm³', qty: 10, factor: 1, unitPrice: 10, amount: 100 },
    { id: 'l22', projectId: 'p2', quotaItemId: '', code: '002', name: '缺价项', feature: '', unit: 'm²', qty: 0, factor: 1, unitPrice: 0, amount: 0 },
  ]);

  const ingest = await dataEngineService.ingestBOQ('p2', { sourceType: 'excel', sourceId: '清单.xlsx' });
  assert.equal(ingest.candidates.length, 2);
  assert.equal(ingest.report.missingPrice, 1);
  assert.equal(ingest.report.zeroQty, 1);
  assert.equal(ingest.report.unmatchedQuota, 1);
  assert.equal(ingest.report.qualityScore < 100, true);
  assert.equal(ingest.report.recommendations.some(t => t.includes('综合单价')), true);
  assert.equal(ingest.candidates.every(c => c.lineageId && c.datasetKey && c.schemaVersion === 1), true);
  assert.equal((await repo.dataCandidateRepo.all()).length, 2);
  assert.equal((await repo.dataFactRepo.all()).length, 0);
  const firstJob = (await repo.dataJobRepo.all()).find(j => j.type === 'ingest_boq');
  assert.equal(firstJob.stages.some(s => s.name === '质量检查' && s.status === 'done'), true);

  const promoted = await dataEngineService.promoteCandidates([ingest.candidates[0].id]);
  assert.equal(promoted.promoted, 1);
  assert.equal((await repo.dataFactRepo.all()).length, 1);
  assert.equal((await repo.dataCandidateRepo.all()).length, 1);

  await projectService.archive('p2');
  const facts = await repo.dataFactRepo.all();
  assert.equal(facts.some(f => f.factType === 'project_cost' && f.sourceType === 'archived_project'), true);
  assert.equal(facts.some(f => f.factType === 'category_cost' && f.sourceType === 'archived_project'), true);
  const indicators = await repo.indicatorRepo.all();
  assert.equal(indicators.some(i => i.metric === '总造价(元)'), true);
  const dashboard = await dataEngineService.dashboard();
  assert.equal(dashboard.qualityScore > 0, true);
  assert.equal(dashboard.sourceSummary.archived_project > 0, true);
  assert.equal(dashboard.stageSummary['采集'] > 0, true);

  await repo.projectRepo.replaceAll([
    ...(await repo.projectRepo.all()),
    { id: 'p3', name: '待回填项目', type: '水厂', scale: '小型', structure: '钢筋砼', status: 'archived', totalCost: 50 },
  ]);
  await repo.boqRepo.replaceAll([
    ...(await repo.boqRepo.all()),
    { id: 'l31', projectId: 'p3', quotaItemId: 'q3', code: '003', name: '模板', feature: '', unit: 'm²', qty: 5, factor: 1, unitPrice: 10, amount: 50 },
  ]);
  const beforePipeline = await dataEngineService.dashboard();
  assert.equal(beforePipeline.backfillNeeded, 1);
  const pipeline = await dataEngineService.runPipeline();
  assert.equal(pipeline.report.qualityScore > 0, true);
  const afterPipeline = await dataEngineService.dashboard();
  assert.equal(afterPipeline.backfillNeeded, 0);

  const backupShape = {
    data_facts: await repo.dataFactRepo.all(),
    data_candidates: await repo.dataCandidateRepo.all(),
    data_jobs: await repo.dataJobRepo.all(),
    data_quality_reports: await repo.dataQualityReportRepo.all(),
  };
  assert.equal(Array.isArray(backupShape.data_facts), true);
  assert.equal(Array.isArray(backupShape.data_quality_reports), true);
}
