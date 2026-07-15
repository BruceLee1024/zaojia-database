// 指标服务
import { projectRepo, boqRepo, indicatorRepo, dataFactRepo } from '../data/repository.js?v=6.2';
import { stats, categoryGuess } from '../utils/stats.js?v=6.2';

const UNSET = '未填写';
const PROJECT_METRICS = [
  { key: 'totalCost', label: '总造价(元)', value: p => Number(p.totalCost || 0) },
  { key: 'areaCost', label: '单方造价(元/㎡)', value: p => Number(p.area) ? Number(p.totalCost || 0) / Number(p.area) : null },
  { key: 'waterCost', label: '单水造价(元/(m³·d))', value: p => Number(p.dailyCapacity) ? Number(p.totalCost || 0) / (Number(p.dailyCapacity) * 10000) : null },
];

export function projectDims(p = {}) {
  return {
    type: p.type || UNSET,
    scale: p.scale || UNSET,
    process: p.process || p.processType || UNSET,
    structure: p.structure || UNSET,
    region: p.region || UNSET,
    year: String(p.priceYear || p.baseYear || (p.archivedAt ? new Date(p.archivedAt).getFullYear() : '') || UNSET),
    stage: p.stage || UNSET,
  };
}

function bucketKey(dims, mode = 'core') {
  const keys = mode === 'full'
    ? ['type', 'scale', 'process', 'structure', 'region', 'year']
    : ['type', 'scale', 'structure'];
  return keys.map(k => dims[k]).filter(Boolean).join(' / ') || UNSET;
}

function quartileSorted(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

function outlierBounds(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 4) return { low: -Infinity, high: Infinity, p25: quartileSorted(sorted, 0.25), p75: quartileSorted(sorted, 0.75), iqr: 0 };
  const p25 = quartileSorted(sorted, 0.25);
  const p75 = quartileSorted(sorted, 0.75);
  const iqr = p75 - p25;
  return { low: p25 - 1.5 * iqr, high: p75 + 1.5 * iqr, p25, p75, iqr };
}

function confidenceOf(n, dispersion, outlierCount) {
  let score = n >= 10 ? 4 : n >= 5 ? 3 : n >= 3 ? 2 : 1;
  if (dispersion > 0.8) score -= 1;
  if (dispersion > 1.4) score -= 1;
  if (outlierCount) score -= 1;
  if (score >= 4) return { level: '高可信', score };
  if (score >= 3) return { level: '中可信', score };
  if (score >= 2) return { level: '低可信', score };
  return { level: '仅参考', score };
}

function enrichIndicator(base) {
  const cleanValues = base.values.filter(v => Number.isFinite(v));
  const bounds = outlierBounds(cleanValues);
  const outlierCount = cleanValues.filter(v => v < bounds.low || v > bounds.high).length;
  const usable = base.excludeOutliers ? cleanValues.filter(v => v >= bounds.low && v <= bounds.high) : cleanValues;
  const s = stats(usable) || { n: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0 };
  const iqr = s.p75 - s.p25;
  const dispersion = s.median ? Math.abs(iqr / s.median) : 0;
  const confidence = confidenceOf(s.n, dispersion, outlierCount);
  return {
    ...base,
    ...s,
    rawN: cleanValues.length,
    iqr,
    dispersion,
    outlierCount,
    confidence: confidence.level,
    confidenceScore: confidence.score,
    updatedAt: new Date().toISOString(),
  };
}

function pushVal(indicators, project, dims, metric, level, value, extra = {}) {
  if (!Number.isFinite(value)) return;
  const key = bucketKey(dims, extra.bucketMode || 'core');
  let it = indicators.find(x => x.typeKey === key && x.metric === metric && x.level === level);
  if (!it) {
    it = {
      typeKey: key,
      metric,
      level,
      values: [],
      sampleProjectIds: [],
      sampleYears: [],
      filters: { ...dims },
      bucketMode: extra.bucketMode || 'core',
      category: extra.category || '',
    };
    indicators.push(it);
  }
  it.values.push(value);
  it.sampleProjectIds.push(project.id);
  if (dims.year && dims.year !== UNSET) it.sampleYears.push(dims.year);
}

function passesFilters(project, filters = {}) {
  const dims = projectDims(project);
  return ['type', 'scale', 'process', 'structure', 'region', 'year', 'stage'].every(k => {
    return !filters[k] || filters[k] === dims[k];
  });
}

function categoryTotals(lines) {
  const groups = {};
  lines.forEach(line => {
    const cat = line.majorCategory || line.category || categoryGuess(line.name);
    groups[cat] = (groups[cat] || 0) + Number(line.amount || 0);
  });
  return groups;
}

export async function recomputeIndicators(options = {}) {
  const [allProjects, facts] = await Promise.all([projectRepo.all(), dataFactRepo.all()]);
  const projectMap = new Map(allProjects.map(p => [p.id, p]));
  const includeCandidates = !!options.includeCandidates;
  const includeVersions = !!options.includeVersions;
  const statusAllowed = f => f.status === 'formal' || (includeCandidates && f.status === 'candidate');
  const sourceAllowed = f => f.sourceType === 'archived_project' || (includeVersions && f.sourceType === 'version');
  const projectFacts = facts.filter(f => statusAllowed(f) && sourceAllowed(f) && f.factType === 'project_cost' && Number(f.payload?.totalCost || 0) > 0);
  const categoryCostFacts = facts.filter(f => statusAllowed(f) && sourceAllowed(f) && f.factType === 'category_cost');
  const indicators = [];

  for (const fact of projectFacts) {
    const p = projectMap.get(fact.projectId);
    if (!p) continue;
    if (fact.sourceType === 'archived_project' && p.status !== 'archived') continue;
    const dims = projectDims(p);
    const totalCost = Number(fact.payload?.totalCost || p.totalCost || 0);

    for (const metric of PROJECT_METRICS) {
      const value = metric.value({ ...p, totalCost });
      pushVal(indicators, p, dims, metric.label, 'project', value);
    }

    const groups = {};
    categoryCostFacts
      .filter(f => f.projectId === p.id && f.sourceId === fact.sourceId)
      .forEach(f => { groups[f.payload?.category || UNSET] = Number(f.payload?.amount || 0); });
    Object.entries(groups).forEach(([cat, val]) => {
      pushVal(indicators, p, dims, `分项造价-${cat}(元)`, 'subitem', val, { category: cat });
      pushVal(indicators, p, dims, `分项造价占比-${cat}(%)`, 'subitem', totalCost ? val / totalCost * 100 : 0, { category: cat });
    });
  }

  const out = indicators.map(it => enrichIndicator({ ...it, excludeOutliers: !!options.excludeOutliers }));
  await indicatorRepo.replaceAll(out);
  return out;
}

function filterIndicators(indicators, filters = {}) {
  return indicators.filter(it => {
    const f = it.filters || {};
    return ['type', 'scale', 'process', 'structure', 'region', 'year', 'stage'].every(k => !filters[k] || filters[k] === f[k]);
  });
}

function benchmarkStatus(value, indicator) {
  if (!indicator || !Number.isFinite(value)) return { label: '无样本', tone: 'gray', percentile: 0 };
  const p25 = indicator.p25 || 0;
  const p75 = indicator.p75 || 0;
  const min = indicator.min || 0;
  const max = indicator.max || 0;
  const span = max - min || 1;
  const percentile = Math.max(0, Math.min(100, Math.round((value - min) / span * 100)));
  if (indicator.n < 3) return { label: '仅作参考', tone: 'yellow', percentile };
  if (value < p25) return { label: '偏低', tone: 'blue', percentile };
  if (value > p75) return { label: '偏高', tone: 'red', percentile };
  return { label: '合理区间', tone: 'green', percentile };
}

function sameBucketIndicators(indicators, project) {
  const key = bucketKey(projectDims(project), 'core');
  return indicators.filter(it => it.typeKey === key);
}

export async function benchmarkProject(projectId) {
  const [projects, boq, indicators] = await Promise.all([projectRepo.all(), boqRepo.all(), indicatorRepo.all()]);
  const project = projects.find(p => p.id === projectId);
  if (!project) return null;
  const pool = sameBucketIndicators(indicators, project);
  const lines = boq.filter(b => b.projectId === projectId);
  const groups = categoryTotals(lines);
  const total = Number(project.totalCost || 0) || Object.values(groups).reduce((a, b) => a + b, 0);
  const metrics = PROJECT_METRICS.map(metric => {
    const value = metric.value({ ...project, totalCost: total });
    const indicator = pool.find(it => it.metric === metric.label && it.level === 'project');
    return { key: metric.key, label: metric.label, value, indicator, status: benchmarkStatus(value, indicator) };
  });
  const deviations = Object.entries(groups).map(([cat, amount]) => {
    const indAmount = pool.find(it => it.metric === `分项造价-${cat}(元)`);
    const median = indAmount?.median || 0;
    return {
      category: cat,
      amount,
      median,
      delta: amount - median,
      ratio: total ? amount / total * 100 : 0,
    };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const main = metrics.find(m => m.key === 'totalCost') || metrics[0];
  return {
    project,
    dims: projectDims(project),
    sampleCount: main?.indicator?.n || 0,
    confidence: main?.indicator?.confidence || '无样本',
    metrics,
    deviations,
    conclusion: conclusionFor(project, metrics, deviations),
  };
}

function conclusionFor(project, metrics, deviations) {
  const total = metrics.find(m => m.key === 'totalCost');
  const top = deviations.slice(0, 3).filter(d => Math.abs(d.delta) > 0);
  if (!total?.indicator) return `${project.name || '当前项目'}暂无足够同类样本，建议先补充归档项目后再进行对标。`;
  const diff = total.indicator.median ? (total.value - total.indicator.median) / total.indicator.median * 100 : 0;
  const prefix = `${project.name || '当前项目'}总造价较同类中位数${diff >= 0 ? '高' : '低'} ${Math.abs(diff).toFixed(1)}%，判断为${total.status.label}。`;
  const parts = top.map(d => `${d.category}${d.delta >= 0 ? '+' : ''}${d.delta.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}元`).join('、');
  return parts ? `${prefix} 主要偏差来自：${parts}。` : prefix;
}

export async function estimate(filters = {}, input = {}) {
  const indicators = filterIndicators(await indicatorRepo.all(), filters);
  const areaInd = indicators.find(i => i.metric === '单方造价(元/㎡)' && i.level === 'project');
  const waterInd = indicators.find(i => i.metric === '单水造价(元/(m³·d))' && i.level === 'project');
  const area = Number(input.area || 0);
  const dailyCapacity = Number(input.dailyCapacity || 0);
  const byArea = areaInd && area ? { low: areaInd.p25 * area, mid: areaInd.median * area, high: areaInd.p75 * area, n: areaInd.n } : null;
  const byWater = waterInd && dailyCapacity ? { low: waterInd.p25 * dailyCapacity * 10000, mid: waterInd.median * dailyCapacity * 10000, high: waterInd.p75 * dailyCapacity * 10000, n: waterInd.n } : null;
  return { byArea, byWater, areaInd, waterInd };
}

export const indicatorService = {
  async list(filters = {}) { return filterIndicators(await indicatorRepo.all(), filters); },
  async recompute(options) { return await recomputeIndicators(options); },
  async benchmarkProject(projectId) { return await benchmarkProject(projectId); },
  async estimate(filters, input) { return await estimate(filters, input); },
  async byTypeKey(typeKey) {
    const all = await indicatorRepo.all();
    return all.filter(i => i.typeKey === typeKey);
  },
  projectDims,
};
