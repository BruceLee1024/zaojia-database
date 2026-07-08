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
await testExperienceService();
await testBuiltinDemoData();
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

async function testExperienceService() {
  const memory = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.localStorage = {
    getItem: key => memory.has(`ex:${key}`) ? memory.get(`ex:${key}`) : null,
    setItem: (key, value) => memory.set(`ex:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-experience');
  const { experienceService } = await import('../assets/services/experienceService.js?v=test-experience');
  await Promise.all([
    repo.projectRepo.replaceAll([{ id: 'p4', name: '经验项目', type: '水厂', scale: '中型', structure: '钢筋砼', process: 'AAO', status: 'doing', totalCost: 1500 }]),
    repo.boqRepo.replaceAll([
      { id: 'l41', projectId: 'p4', quotaItemId: 'q1', name: '防水卷材', feature: '池壁', unit: 'm²', qty: 10, factor: 1, unitPrice: 50, amount: 500 },
      { id: 'l42', projectId: 'p4', quotaItemId: '', name: '暂估设备', feature: '', unit: '台', qty: 1, factor: 1.3, unitPrice: 0, amount: 0 },
    ]),
    repo.versionRepo.replaceAll([{ id: 'v4', projectId: 'p4', name: '报审版', note: '提交前复盘', totalCost: 500, lineCount: 2, missingPriceCount: 1, lines: [] }]),
    repo.dataQualityReportRepo.replaceAll([{ id: 'r4', projectId: 'p4', qualityLevel: '需复核', qualityScore: 72, recommendations: ['补齐综合单价'], createdAt: '2026-01-01T00:00:00.000Z' }]),
    repo.experienceSessionRepo.replaceAll([]),
    repo.experienceCardRepo.replaceAll([]),
  ]);

  const session = await experienceService.startReview({ projectId: 'p4', versionId: 'v4', sourceType: 'version_saved' });
  assert.equal(session.projectId, 'p4');
  assert.equal(session.versionId, 'v4');
  assert.equal(session.questions.length >= 3, true);
  assert.equal(session.status, 'drafting');
  assert.equal(session.questionSource, 'local');
  assert.equal(typeof session.extraction.score, 'number');
  assert.equal(session.extraction.gaps.some(g => g.key === 'evidence'), true);

  globalThis.localStorage.setItem('ai_config', JSON.stringify({
    provider: 'test',
    base_url: 'https://example.test/v1',
    api_key: 'sk-test',
    model: 'test-model',
    system: 'test',
  }));
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            questions: [
              { id: 'ai_price_basis', label: '价格依据', prompt: 'AI：这次防水单价依据哪份询价或历史项目？' },
              { id: 'ai_risk_boundary', label: '风险边界', prompt: 'AI：暂估设备的价格边界如何向业主说明？' },
              { id: 'ai_reuse_condition', label: '复用条件', prompt: 'AI：哪些条件满足时这条经验才能复用？' },
            ],
          }),
        },
      }],
    }),
  });
  const aiSession = await experienceService.startReview({ projectId: 'p4', versionId: 'v4', sourceType: 'version_saved' });
  assert.equal(aiSession.questionSource, 'ai');
  assert.equal(aiSession.questions[0].id, 'ai_price_basis');
  assert.equal(aiSession.questions[0].prompt.includes('AI：'), true);
  globalThis.fetch = originalFetch;
  globalThis.localStorage.setItem('ai_config', JSON.stringify({}));
  const aiFallbackDraft = await experienceService.draftCard(aiSession.id, {
    ai_price_basis: '参考上一期 AAO 水厂池壁防水结算价，并补充本地询价。',
    ai_risk_boundary: '暂估设备必须注明品牌范围和二次询价机制。',
    ai_reuse_condition: '仅适用于池体结构和防水做法相近的中型水厂。',
  });
  assert.equal(aiFallbackDraft.lesson.includes('AAO 水厂池壁防水'), true);
  assert.equal(aiFallbackDraft.applicability.includes('中型水厂'), true);
  assert.equal(aiFallbackDraft.risks.includes('暂估设备'), true);
  assert.equal(typeof aiFallbackDraft.extractionScore, 'number');
  assert.equal(aiFallbackDraft.extraction.checks.some(item => item.key === 'boundary'), true);

  const refinedLocal = await experienceService.refineQuestions(session.id, {
    judgement: '防水按池壁做法计取。',
  });
  assert.equal(refinedLocal.followUpSource, 'local');
  assert.equal(refinedLocal.questions.some(q => q.level === 'L2'), true);
  assert.equal(refinedLocal.questions.some(q => q.id === 'followup_boundary'), true);
  assert.equal(refinedLocal.extraction.gaps.some(g => g.key === 'boundary'), true);

  globalThis.localStorage.setItem('ai_config', JSON.stringify({
    provider: 'test',
    base_url: 'https://example.test/v1',
    api_key: 'sk-test',
    model: 'test-model',
    system: 'test',
  }));
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            questions: [
              { id: 'ai_followup_evidence', label: '证据补充', prompt: 'AI：这条口径需要保留哪份询价或版本证据？' },
            ],
          }),
        },
      }],
    }),
  });
  const refinedAi = await experienceService.refineQuestions(aiSession.id, {
    ai_price_basis: '参考上一期 AAO 水厂池壁防水结算价。',
  });
  assert.equal(refinedAi.followUpSource, 'ai');
  assert.equal(refinedAi.questions.some(q => q.id === 'ai_followup_evidence' && q.level === 'L2'), true);
  globalThis.fetch = originalFetch;
  globalThis.localStorage.setItem('ai_config', JSON.stringify({}));

  const draft = await experienceService.draftCard(session.id, {
    judgement: '防水按池壁做法计取，暂估设备需二次询价。',
    reuse: 'AAO 水厂池体防水先按面积口径复核，再核对构造做法。',
    boundary: '若图纸构造层数变化，不直接复用。',
  });
  assert.equal(draft.title.includes('经验项目'), true);
  assert.equal(draft.category, '投标报价复盘');
  assert.equal(draft.status, undefined);
  assert.equal(draft.extractionScore >= 70, true);
  assert.equal(Array.isArray(draft.extractionGaps), true);

  const card = await experienceService.confirmCard(session.id, { title: 'AAO 水厂防水报价复盘' });
  assert.equal(card.status, 'confirmed');
  assert.equal(card.reviewStatus, 'confirmed');
  assert.equal(card.knowledgeType, '经验卡');
  assert.equal(card.projectType, '水厂');
  assert.equal(card.processType, 'AAO');
  assert.equal(card.keywords.includes('防水'), true);
  assert.equal(Array.isArray(card.evidenceRefs), true);
  assert.equal(card.extractionScore >= 70, true);
  assert.equal(card.extraction.checks.some(item => item.key === 'evidence'), true);
  assert.equal(Array.isArray(card.extractionGaps), true);
  assert.equal(card.reuseCount, 0);
  assert.equal(card.projectId, 'p4');
  assert.equal(card.projectNameSnapshot, '经验项目');
  assert.equal((await repo.experienceCardRepo.all()).length, 1);
  const updatedSession = await repo.experienceSessionRepo.findById(session.id);
  assert.equal(updatedSession.status, 'confirmed');

  const hits = await experienceService.searchCards('防水 经验', { type: '水厂', process: 'AAO' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, card.id);
  const afterSearch = await repo.experienceCardRepo.findById(card.id);
  assert.equal(afterSearch.reuseCount, 1);
  assert.equal(Boolean(afterSearch.lastUsedAt), true);

  await repo.experienceCardRepo.upsert({
    id: 'legacy-card',
    title: '旧卡片',
    projectId: 'p4',
    projectNameSnapshot: '经验项目',
    tags: ['水厂', '防水'],
    lesson: '旧经验也应该进入知识库',
    applicability: '同类项目参考',
    risks: '需复核',
    expiresAt: '2020-01-01',
    status: 'confirmed',
  });
  const kbAll = await experienceService.listKnowledgeBase({ keyword: '防水' });
  assert.equal(kbAll.items.some(item => item.id === 'legacy-card' && item.reviewStatus === 'confirmed'), true);
  assert.equal(kbAll.items.some(item => item.id === card.id), true);
  assert.equal(kbAll.items.find(item => item.id === 'legacy-card').extractionScore > 0, true);
  const kbFiltered = await experienceService.listKnowledgeBase({ projectType: '水厂', processType: 'AAO', status: 'confirmed' });
  assert.equal(kbFiltered.items.some(item => item.id === card.id), true);
  const expired = await experienceService.listKnowledgeBase({ expired: 'expired' });
  assert.equal(expired.items.some(item => item.id === 'legacy-card'), true);

  const reused = await experienceService.recordReuse(card.id);
  assert.equal(reused.reuseCount, 2);
  const needsReview = await experienceService.markNeedsReview(card.id, '市场价变化后复核');
  assert.equal(needsReview.reviewStatus, 'needs_review');
  assert.equal(needsReview.reviewNote, '市场价变化后复核');
  const archivedCard = await experienceService.archiveCard(card.id);
  assert.equal(archivedCard.reviewStatus, 'archived');
  const afterArchiveHits = await experienceService.searchCards('防水 经验', { type: '水厂', process: 'AAO' });
  assert.equal(afterArchiveHits.some(item => item.id === card.id), false);

  await repo.projectRepo.remove('p4');
  const afterProjectDelete = await repo.experienceCardRepo.all();
  assert.equal(afterProjectDelete.length, 2);
  assert.equal(afterProjectDelete.every(c => c.projectNameSnapshot === '经验项目'), true);
  globalThis.fetch = originalFetch;
}

async function testBuiltinDemoData() {
  const memory = new Map();
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}` },
      configurable: true,
    });
  }
  globalThis.localStorage = {
    getItem: key => memory.has(`demo:${key}`) ? memory.get(`demo:${key}`) : null,
    setItem: (key, value) => memory.set(`demo:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-demo');
  const { ensureDemoData } = await import('../assets/data/demo.js?v=test-demo');

  await Promise.all([
    repo.quotaRepo.replaceAll([]),
    repo.projectRepo.replaceAll([]),
    repo.boqRepo.replaceAll([]),
    repo.versionRepo.replaceAll([]),
    repo.indicatorRepo.replaceAll([]),
    repo.dataFactRepo.replaceAll([]),
    repo.dataCandidateRepo.replaceAll([]),
    repo.dataJobRepo.replaceAll([]),
    repo.dataQualityReportRepo.replaceAll([]),
    repo.experienceSessionRepo.replaceAll([]),
    repo.experienceCardRepo.replaceAll([]),
  ]);

  const first = await ensureDemoData();
  assert.equal(first.loaded, true);
  assert.equal((await repo.projectRepo.all()).length, 3);
  assert.equal((await repo.quotaRepo.all()).length >= 10, true);
  assert.equal((await repo.boqRepo.all()).length >= 20, true);
  assert.equal((await repo.versionRepo.all()).length >= 3, true);
  assert.equal((await repo.dataFactRepo.all()).some(f => f.sourceType === 'archived_project'), true);

  const second = await ensureDemoData();
  assert.equal(second.loaded, false);
  assert.equal((await repo.projectRepo.all()).length, 3);
}
