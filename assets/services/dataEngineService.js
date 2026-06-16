// 本地数据引擎：把导入、版本、归档项目沉淀为可追溯样本
import {
  projectRepo,
  boqRepo,
  versionRepo,
  dataFactRepo,
  dataCandidateRepo,
  dataJobRepo,
  dataQualityReportRepo,
} from '../data/repository.js?v=2.8';
import { uid } from '../utils/dom.js';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=2.8';
import { categoryGuess } from '../utils/stats.js';
import { indicatorService } from './indicatorService.js?v=2.8';

const FORMAL_SOURCES = new Set(['archived_project', 'version']);
const PIPELINE_STAGES = ['采集', '标准化', '质量检查', '沉淀入库', '指标重建'];

export const dataEngineService = {
  async ingestBOQ(projectId, source = {}) {
    const lines = source.lines || await boqRepo.byProject(projectId);
    const job = await createJob('ingest_boq', { projectId, sourceType: source.sourceType || 'current_boq', sourceId: source.sourceId || projectId, stages: stageLog(['采集']) });
    const candidates = lines.map(line => makeLineFact(line, {
      sourceType: source.sourceType || 'current_boq',
      sourceId: source.sourceId || projectId,
      projectId,
      jobId: job.id,
      status: 'candidate',
    }));
    await touchJobStage(job.id, '标准化');
    await replaceCandidates(projectId, candidates, source.sourceType || 'current_boq', source.sourceId || projectId);
    await touchJobStage(job.id, '沉淀入库');
    const report = await this.analyzeQuality({ projectId, sourceType: source.sourceType || 'current_boq', sourceId: source.sourceId || projectId, jobId: job.id, lines });
    await touchJobStage(job.id, '质量检查');
    await finishJob(job.id, { status: 'success', candidateCount: candidates.length, reportId: report.id, qualityScore: report.qualityScore });
    return { job, candidates, report };
  },

  async ingestVersion(versionId) {
    const version = await versionRepo.findById(versionId);
    if (!version) throw new Error('报价版本不存在');
    const job = await createJob('ingest_version', { projectId: version.projectId, sourceType: 'version', sourceId: version.id, stages: stageLog(['采集']) });
    const facts = [
      makeProjectFact(version, { sourceType: 'version', sourceId: version.id, versionId, projectId: version.projectId, jobId: job.id }),
      ...(version.lines || []).map(line => makeLineFact(line, { sourceType: 'version', sourceId: version.id, versionId, projectId: version.projectId, jobId: job.id })),
      ...categoryFacts(version.lines || [], { sourceType: 'version', sourceId: version.id, versionId, projectId: version.projectId, jobId: job.id }),
    ];
    await touchJobStage(job.id, '标准化');
    await replaceFacts(facts, 'version', version.id);
    await touchJobStage(job.id, '沉淀入库');
    const report = await this.analyzeQuality({ projectId: version.projectId, sourceType: 'version', sourceId: version.id, versionId, jobId: job.id, lines: version.lines || [] });
    await touchJobStage(job.id, '质量检查');
    await finishJob(job.id, { status: 'success', factCount: facts.length, reportId: report.id, qualityScore: report.qualityScore });
    return { job, facts, report };
  },

  async ingestArchivedProject(projectId, options = {}) {
    const [project, lines] = await Promise.all([projectRepo.findById(projectId), boqRepo.byProject(projectId)]);
    if (!project) throw new Error('项目不存在');
    const job = await createJob('ingest_archived_project', { projectId, sourceType: 'archived_project', sourceId: projectId, stages: stageLog(['采集']) });
    const snapshot = { ...project, lines };
    const facts = [
      makeProjectFact(snapshot, { sourceType: 'archived_project', sourceId: projectId, projectId, jobId: job.id }),
      ...lines.map(line => makeLineFact(line, { sourceType: 'archived_project', sourceId: projectId, projectId, jobId: job.id })),
      ...categoryFacts(lines, { sourceType: 'archived_project', sourceId: projectId, projectId, jobId: job.id }),
    ];
    await touchJobStage(job.id, '标准化');
    await replaceFacts(facts, 'archived_project', projectId);
    await touchJobStage(job.id, '沉淀入库');
    const report = await this.analyzeQuality({ projectId, sourceType: 'archived_project', sourceId: projectId, jobId: job.id, lines, project });
    await touchJobStage(job.id, '质量检查');
    if (!options.skipRebuild) {
      await this.rebuildIndicators({ skipBackfill: true });
      await touchJobStage(job.id, '指标重建');
    }
    await finishJob(job.id, { status: 'success', factCount: facts.length, reportId: report.id, qualityScore: report.qualityScore });
    return { job, facts, report };
  },

  async analyzeQuality(scope = {}) {
    const lines = scope.lines || (scope.projectId ? await boqRepo.byProject(scope.projectId) : await boqRepo.all());
    const project = scope.project || (scope.projectId ? await projectRepo.findById(scope.projectId) : null);
    const duplicateKeys = new Map();
    lines.forEach(line => {
      const key = [line.code, line.name, line.feature, line.unit].map(v => String(v || '').trim()).join('|');
      duplicateKeys.set(key, (duplicateKeys.get(key) || 0) + 1);
    });
    const issues = [];
    const missingPrice = lines.filter(line => hasMissingPrice(line.unitPrice));
    const zeroQty = lines.filter(line => !(Number(line.qty) > 0));
    const unmatchedQuota = lines.filter(line => !line.quotaItemId);
    const duplicates = lines.filter(line => duplicateKeys.get([line.code, line.name, line.feature, line.unit].map(v => String(v || '').trim()).join('|')) > 1);
    if (project && !(Number(project.totalCost) > 0)) issues.push({ type: 'zero_total', severity: 'high', message: '项目总造价为 0，不能作为高可信样本' });
    if (missingPrice.length) issues.push({ type: 'missing_price', severity: 'high', count: missingPrice.length, message: `${missingPrice.length} 条清单缺少综合单价` });
    if (zeroQty.length) issues.push({ type: 'zero_qty', severity: 'medium', count: zeroQty.length, message: `${zeroQty.length} 条清单工程量为 0` });
    if (unmatchedQuota.length) issues.push({ type: 'unmatched_quota', severity: 'medium', count: unmatchedQuota.length, message: `${unmatchedQuota.length} 条清单未匹配定额` });
    if (duplicates.length) issues.push({ type: 'duplicate_line', severity: 'low', count: duplicates.length, message: `${duplicates.length} 条清单疑似重复` });
    const matched = lines.length - unmatchedQuota.length;
    const qualityScore = scoreQuality(lines.length, { missingPrice: missingPrice.length, zeroQty: zeroQty.length, unmatchedQuota: unmatchedQuota.length, duplicateLines: duplicates.length, zeroTotal: project && !(Number(project.totalCost) > 0) });
    const report = {
      id: uid(),
      projectId: scope.projectId || '',
      versionId: scope.versionId || '',
      sourceType: scope.sourceType || 'manual_scan',
      sourceId: scope.sourceId || scope.projectId || '',
      jobId: scope.jobId || '',
      totalLines: lines.length,
      missingPrice: missingPrice.length,
      zeroQty: zeroQty.length,
      unmatchedQuota: unmatchedQuota.length,
      duplicateLines: duplicates.length,
      matchRate: lines.length ? matched / lines.length : 0,
      qualityScore,
      qualityLevel: issues.some(i => i.severity === 'high') ? '低可信' : issues.some(i => i.severity === 'medium') ? '需复核' : '可用',
      issues,
      recommendations: recommendationsFor(issues),
      createdAt: new Date().toISOString(),
    };
    await dataQualityReportRepo.upsert(report);
    return report;
  },

  async promoteCandidates(ids = []) {
    const candidates = await dataCandidateRepo.all();
    const chosen = candidates.filter(c => ids.includes(c.id));
    if (!chosen.length) return { promoted: 0 };
    const now = new Date().toISOString();
    const facts = chosen.map(c => ({ ...c, id: uid(), status: 'formal', promotedAt: now, updatedAt: now, lineageId: c.lineageId || lineageFor(c) }));
    await dataFactRepo.replaceAll([...(await dataFactRepo.all()), ...facts]);
    await dataCandidateRepo.replaceAll(candidates.filter(c => !ids.includes(c.id)));
    await this.rebuildIndicators();
    return { promoted: facts.length };
  },

  async rebuildIndicators(options = {}) {
    if (!options.skipBackfill) {
      const [projects, facts] = await Promise.all([projectRepo.all(), dataFactRepo.all()]);
      const archived = projects.filter(p => p.status === 'archived');
      for (const project of archived) {
        const hasFact = facts.some(f => f.factType === 'project_cost' && f.sourceType === 'archived_project' && f.sourceId === project.id);
        if (!hasFact) await this.ingestArchivedProject(project.id, { skipRebuild: true });
      }
    }
    return await indicatorService.recompute();
  },

  async runPipeline() {
    const job = await createJob('run_pipeline', { sourceType: 'all', sourceId: 'all', stages: stageLog(['采集']) });
    await this.backfillArchivedProjects({ skipRebuild: true });
    await touchJobStage(job.id, '标准化');
    const report = await this.analyzeQuality({ sourceType: 'pipeline_scan', sourceId: job.id, jobId: job.id });
    await touchJobStage(job.id, '质量检查');
    await this.rebuildIndicators({ skipBackfill: true });
    await touchJobStage(job.id, '指标重建');
    await finishJob(job.id, { status: 'success', reportId: report.id, qualityScore: report.qualityScore });
    return { job, report };
  },

  async backfillArchivedProjects(options = {}) {
    const [projects, facts] = await Promise.all([projectRepo.all(), dataFactRepo.all()]);
    const archived = projects.filter(p => p.status === 'archived');
    let count = 0;
    for (const project of archived) {
      const hasFact = facts.some(f => f.factType === 'project_cost' && f.sourceType === 'archived_project' && f.sourceId === project.id);
      if (!hasFact) {
        await this.ingestArchivedProject(project.id, { skipRebuild: true });
        count++;
      }
    }
    if (count && !options.skipRebuild) await this.rebuildIndicators({ skipBackfill: true });
    return { count };
  },

  async clearCandidates() {
    await dataCandidateRepo.replaceAll([]);
  },

  async dashboard() {
    const [facts, candidates, jobs, reports, projects] = await Promise.all([
      dataFactRepo.all(),
      dataCandidateRepo.all(),
      dataJobRepo.all(),
      dataQualityReportRepo.all(),
      projectRepo.all(),
    ]);
    const archived = projects.filter(p => p.status === 'archived');
    const backfillNeeded = archived.filter(p => !facts.some(f => f.factType === 'project_cost' && f.sourceType === 'archived_project' && f.sourceId === p.id)).length;
    const lastReports = reports.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const sourceSummary = summarizeBy([...facts, ...candidates], 'sourceType');
    return {
      facts,
      candidates,
      reports,
      jobs: jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 8),
      lowQuality: reports.filter(r => r.qualityLevel === '低可信').length,
      qualityScore: lastReports.length ? Math.round(lastReports.reduce((s, r) => s + Number(r.qualityScore || 0), 0) / lastReports.length) : 0,
      lastReport: lastReports[0] || null,
      sourceSummary,
      backfillNeeded,
      stageSummary: pipelineSummary(jobs),
    };
  },
};

function makeProjectFact(source, meta) {
  const lines = source.lines || [];
  const totalCost = Number(source.totalCost || lines.reduce((s, line) => s + Number(line.amount || 0), 0));
  return {
    id: uid(),
    factType: 'project_cost',
    status: FORMAL_SOURCES.has(meta.sourceType) ? 'formal' : 'candidate',
    sourceType: meta.sourceType,
    sourceId: meta.sourceId,
    projectId: meta.projectId,
    versionId: meta.versionId || '',
    lineId: '',
    jobId: meta.jobId || '',
    schemaVersion: 1,
    lineageId: lineageFor({ factType: 'project_cost', sourceType: meta.sourceType, sourceId: meta.sourceId, projectId: meta.projectId, versionId: meta.versionId || '', lineId: '' }),
    datasetKey: datasetKey(meta.sourceType, meta.sourceId),
    payload: {
      name: source.name || '',
      totalCost,
      lineCount: lines.length || source.lineCount || 0,
      missingPriceCount: lines.filter(line => hasMissingPrice(line.unitPrice)).length || source.missingPriceCount || 0,
    },
    quality: qualityForProject(totalCost, lines),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    normalizedAt: new Date().toISOString(),
  };
}

function makeLineFact(line, meta) {
  const amount = calculateAmount(line.qty, line.unitPrice, line.factor || 1);
  return {
    id: uid(),
    factType: 'boq_line',
    status: meta.status || (FORMAL_SOURCES.has(meta.sourceType) ? 'formal' : 'candidate'),
    sourceType: meta.sourceType,
    sourceId: meta.sourceId,
    projectId: meta.projectId,
    versionId: meta.versionId || '',
    lineId: line.id || '',
    jobId: meta.jobId || '',
    schemaVersion: 1,
    lineageId: lineageFor({ factType: 'boq_line', sourceType: meta.sourceType, sourceId: meta.sourceId, projectId: meta.projectId, versionId: meta.versionId || '', lineId: line.id || '' }),
    datasetKey: datasetKey(meta.sourceType, meta.sourceId),
    payload: {
      quotaItemId: line.quotaItemId || '',
      code: line.code || '',
      name: line.name || '',
      feature: line.feature || '',
      unit: line.unit || '',
      qty: Number(line.qty || 0),
      factor: Number(line.factor || 1),
      unitPrice: Number(line.unitPrice || 0),
      amount,
      category: line.majorCategory || line.category || categoryGuess(line.name || ''),
    },
    quality: qualityForLine(line),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    normalizedAt: new Date().toISOString(),
  };
}

function categoryFacts(lines, meta) {
  const groups = {};
  lines.forEach(line => {
    const cat = line.majorCategory || line.category || categoryGuess(line.name || '');
    groups[cat] = (groups[cat] || 0) + Number(line.amount || calculateAmount(line.qty, line.unitPrice, line.factor || 1));
  });
  return Object.entries(groups).map(([category, amount]) => ({
    id: uid(),
    factType: 'category_cost',
    status: FORMAL_SOURCES.has(meta.sourceType) ? 'formal' : 'candidate',
    sourceType: meta.sourceType,
    sourceId: meta.sourceId,
    projectId: meta.projectId,
    versionId: meta.versionId || '',
    lineId: '',
    jobId: meta.jobId || '',
    schemaVersion: 1,
    lineageId: lineageFor({ factType: 'category_cost', sourceType: meta.sourceType, sourceId: meta.sourceId, projectId: meta.projectId, versionId: meta.versionId || '', lineId: category }),
    datasetKey: datasetKey(meta.sourceType, meta.sourceId),
    payload: { category, amount },
    quality: { level: amount > 0 ? '可用' : '低可信', issues: amount > 0 ? [] : ['zero_amount'] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    normalizedAt: new Date().toISOString(),
  }));
}

function qualityForLine(line) {
  const issues = [];
  if (hasMissingPrice(line.unitPrice)) issues.push('missing_price');
  if (!(Number(line.qty) > 0)) issues.push('zero_qty');
  if (!line.quotaItemId) issues.push('unmatched_quota');
  const score = scoreQuality(1, {
    missingPrice: hasMissingPrice(line.unitPrice) ? 1 : 0,
    zeroQty: !(Number(line.qty) > 0) ? 1 : 0,
    unmatchedQuota: line.quotaItemId ? 0 : 1,
    duplicateLines: 0,
  });
  return {
    level: issues.includes('missing_price') ? '低可信' : issues.length ? '需复核' : '可用',
    score,
    missingPrice: hasMissingPrice(line.unitPrice),
    matchConfidence: line.quotaItemId ? 1 : 0,
    issues,
  };
}

function qualityForProject(totalCost, lines) {
  const issues = [];
  if (!(Number(totalCost) > 0)) issues.push('zero_total');
  if (lines.some(line => hasMissingPrice(line.unitPrice))) issues.push('missing_price');
  return { level: issues.length ? '低可信' : '可用', score: scoreQuality(lines.length, { missingPrice: lines.filter(line => hasMissingPrice(line.unitPrice)).length, zeroTotal: !(Number(totalCost) > 0) }), issues };
}

async function replaceFacts(facts, sourceType, sourceId) {
  const all = await dataFactRepo.all();
  await dataFactRepo.replaceAll([
    ...all.filter(f => !(f.sourceType === sourceType && f.sourceId === sourceId)),
    ...facts,
  ]);
}

async function replaceCandidates(projectId, candidates, sourceType, sourceId) {
  const all = await dataCandidateRepo.all();
  await dataCandidateRepo.replaceAll([
    ...all.filter(f => !(f.projectId === projectId && f.sourceType === sourceType && f.sourceId === sourceId)),
    ...candidates,
  ]);
}

async function createJob(type, meta) {
  const job = { id: uid(), type, status: 'running', stages: stageLog(), ...meta, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await dataJobRepo.upsert(job);
  return job;
}

async function finishJob(id, patch) {
  const all = await dataJobRepo.all();
  await dataJobRepo.replaceAll(all.map(job => job.id === id ? { ...job, ...patch, updatedAt: new Date().toISOString() } : job));
}

async function touchJobStage(id, stage) {
  const all = await dataJobRepo.all();
  const now = new Date().toISOString();
  await dataJobRepo.replaceAll(all.map(job => {
    if (job.id !== id) return job;
    const stages = stageLog();
    (job.stages || []).forEach(s => {
      const found = stages.find(it => it.name === s.name);
      if (found) Object.assign(found, s);
    });
    const current = stages.find(s => s.name === stage);
    if (current) Object.assign(current, { status: 'done', at: now });
    return { ...job, stages, updatedAt: now };
  }));
}

function stageLog(done = []) {
  const now = new Date().toISOString();
  return PIPELINE_STAGES.map(name => ({ name, status: done.includes(name) ? 'done' : 'pending', at: done.includes(name) ? now : '' }));
}

function scoreQuality(totalLines, counts = {}) {
  let score = 100;
  const base = Math.max(1, totalLines || 1);
  score -= (counts.missingPrice || 0) / base * 35;
  score -= (counts.zeroQty || 0) / base * 20;
  score -= (counts.unmatchedQuota || 0) / base * 20;
  score -= (counts.duplicateLines || 0) / base * 8;
  if (counts.zeroTotal) score -= 25;
  return Math.max(0, Math.round(score));
}

function recommendationsFor(issues) {
  if (!issues.length) return ['当前数据可进入正式样本池。'];
  const map = {
    zero_total: '先刷新项目总造价，确认清单合价已正确汇总。',
    missing_price: '优先补齐综合单价为空或为 0 的清单项。',
    zero_qty: '复核工程量为 0 的清单，确认是否为暂估或漏填。',
    unmatched_quota: '补充定额匹配关系，提升后续推荐和指标归类准确性。',
    duplicate_line: '检查疑似重复清单，避免同一工作内容重复计价。',
  };
  return issues.map(i => map[i.type]).filter(Boolean);
}

function lineageFor(obj) {
  return [obj.factType, obj.sourceType, obj.sourceId, obj.projectId, obj.versionId || '', obj.lineId || ''].join('::');
}

function datasetKey(sourceType, sourceId) {
  return `${sourceType || 'unknown'}:${sourceId || ''}`;
}

function summarizeBy(items, key) {
  return items.reduce((acc, item) => {
    const val = item[key] || 'unknown';
    acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});
}

function pipelineSummary(jobs) {
  const summary = {};
  PIPELINE_STAGES.forEach(stage => { summary[stage] = 0; });
  jobs.forEach(job => (job.stages || []).forEach(stage => {
    if (stage.status === 'done') summary[stage.name] = (summary[stage.name] || 0) + 1;
  }));
  return summary;
}
