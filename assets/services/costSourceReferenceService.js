import { boqRepo, indicatorRepo, projectRepo, quotaRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=6.15';
import { categoryGuess } from '../utils/stats.js?v=6.15';
import { normalizeQuotaBreakdown } from '../utils/quotaBreakdown.js?v=6.15';

export const costSourceReferenceService = {
  async list(line = {}, source = '') {
    if (source === 'history') {
      const [projects, lines] = await Promise.all([projectRepo.all(), boqRepo.all()]);
      return rankHistoryReferences(line, projects, lines);
    }
    if (source === 'enterprise_quota') {
      return rankQuotaReferences(line, await quotaRepo.all());
    }
    if (source === 'resource') {
      const [resources, prices] = await Promise.all([resourceRepo.all(), resourcePriceRepo.all()]);
      return rankResourceReferences(line, resources, prices);
    }
    if (source === 'experience') {
      return rankIndicatorReferences(line, await indicatorRepo.all());
    }
    return [];
  },
};

export function rankQuotaReferences(line = {}, quotas = []) {
  return quotas
    .map(quota => {
      const unitPrice = optionalNumber(quota.priceTotal);
      const breakdown = normalizeQuotaBreakdown(quota.breakdown);
      const priced = unitPrice != null && unitPrice > 0 && quota.priceMissing !== true && quota.priceStatus !== 'missing';
      const score = matchScore(line, quota)
        + (line.quotaItemId && line.quotaItemId === quota.id ? 80 : 0)
        + (priced ? 8 : 0);
      const composition = Object.entries(breakdown)
        .filter(([, value]) => Number(value) !== 0)
        .map(([key, value]) => `${key} ${number(value)}`)
        .join('、');
      return {
        id: `enterprise-quota:${quota.id}`,
        source: 'enterprise_quota',
        sourceId: quota.id,
        quotaItemId: quota.id,
        label: `${quota.code ? `${quota.code} · ` : ''}${quota.name || '未命名企业定额'}`,
        detail: [quota.category || '未分类', quota.unit || '无单位', quota.version ? `版本 ${quota.version}` : '', composition || '暂无价格组成'].filter(Boolean).join(' · '),
        unitPrice,
        canApplyPrice: priced && sameUnit(line.unit, quota.unit),
        date: quota.updatedAt || quota.createdAt || '',
        version: quota.version || '',
        breakdown,
        score,
      };
    })
    .sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)))
    .slice(0, 100);
}

export function rankHistoryReferences(line = {}, projects = [], lines = []) {
  const projectMap = new Map(projects.map(project => [project.id, project]));
  return lines
    .filter(candidate => candidate.id !== line.id && candidate.projectId !== line.projectId)
    .map(candidate => {
      const project = projectMap.get(candidate.projectId) || {};
      const costPrice = optionalNumber(candidate.costUnitPrice);
      const bidPrice = optionalNumber(candidate.unitPrice);
      const unitPrice = costPrice ?? bidPrice;
      const score = matchScore(line, candidate) + (project.status === 'archived' ? 12 : 0) + (costPrice != null ? 8 : 0);
      return {
        id: `history:${candidate.id}`,
        source: 'history',
        sourceId: candidate.id,
        projectId: candidate.projectId,
        label: `${project.name || '历史项目'} · ${candidate.name || '未命名清单'}`,
        detail: `${candidate.code || '未编码'} · ${candidate.unit || '无单位'} · ${costPrice != null ? '历史内部成本价' : '历史投标综合价'}`,
        unitPrice,
        canApplyPrice: unitPrice != null && sameUnit(line.unit, candidate.unit),
        date: project.archivedAt || project.updatedAt || candidate.costUpdatedAt || '',
        score,
      };
    })
    .filter(candidate => candidate.unitPrice != null && candidate.score > 0)
    .sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)))
    .slice(0, 20);
}

export function rankResourceReferences(line = {}, resources = [], prices = []) {
  const resourceMap = new Map(resources.map(resource => [resource.id, resource]));
  return prices
    .filter(price => price.status !== 'withdrawn' && optionalNumber(price.unitPrice) != null)
    .map(price => {
      const resource = resourceMap.get(price.resourceId) || {};
      const score = textScore(`${line.name || ''} ${line.feature || ''} ${line.code || ''}`, `${resource.name || ''} ${resource.specification || ''} ${resource.code || ''}`)
        + (resource.preferredPriceId === price.id ? 10 : 0);
      const sourceLabel = ({ official: '官方信息价', supplier_quote: '供应商报价', transaction: '历史成交价' })[price.sourceType] || price.sourceType || '价格记录';
      return {
        id: `resource:${price.id}`,
        source: 'resource',
        sourceId: price.id,
        resourceId: price.resourceId,
        label: `${resource.name || '材料设备'}${resource.specification ? ` · ${resource.specification}` : ''}`,
        detail: `${sourceLabel}${price.supplier ? ` · ${price.supplier}` : ''} · ${price.priceDate || '未记录日期'} · ${resource.unit || '无单位'}`,
        unitPrice: Number(price.unitPrice),
        canApplyPrice: sameUnit(line.unit, resource.unit),
        date: price.priceDate || price.createdAt || '',
        score,
      };
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)))
    .slice(0, 20);
}

export function rankIndicatorReferences(line = {}, indicators = []) {
  const category = categoryGuess(line.name || '');
  return indicators
    .map(indicator => {
      const categoryMatch = normalize(indicator.category) && normalize(line.name).includes(normalize(indicator.category)) ? 60 : 0;
      const score = categoryMatch + textScore(`${category} ${line.name || ''}`, `${indicator.metric || ''} ${indicator.category || ''}`);
      return {
        id: `experience:${indicator.typeKey || ''}:${indicator.metric || ''}`,
        source: 'experience',
        sourceId: `${indicator.typeKey || ''}:${indicator.metric || ''}`,
        label: indicator.metric || '经验指标',
        detail: `${indicator.typeKey || '未分类'} · 中位数 ${number(indicator.median)} · ${indicator.n || 0} 个样本 · ${indicator.confidence || '仅参考'}`,
        unitPrice: null,
        canApplyPrice: false,
        date: indicator.updatedAt || '',
        score,
      };
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function matchScore(target, candidate) {
  const codeScore = target.code && candidate.code && normalize(target.code) === normalize(candidate.code) ? 100 : 0;
  const nameScore = normalize(target.name) === normalize(candidate.name) && target.name ? 80 : textScore(target.name, candidate.name);
  return codeScore + nameScore + (sameUnit(target.unit, candidate.unit) ? 10 : 0);
}

function textScore(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 80;
  if (a.includes(b) || b.includes(a)) return 45;
  const aTokens = tokens(a);
  const bTokens = new Set(tokens(b));
  return aTokens.reduce((score, token) => score + (bTokens.has(token) ? Math.max(5, Math.min(20, token.length * 3)) : 0), 0);
}

function tokens(value) {
  return String(value || '').match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{2,}/g) || [];
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s\-_/()（）]/g, '');
}

function sameUnit(left, right) {
  return Boolean(normalize(left) && normalize(left) === normalize(right));
}

function optionalNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function number(value) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
