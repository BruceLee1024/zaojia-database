// 独立清单库：标准清单条目维护与套用到项目
import { boqLibraryRepo, boqRepo, projectRepo, quotaRepo } from '../data/repository.js?v=6.3';
import { parseExcel, rowToBoqLibraryItem } from '../data/excel.js?v=6.3';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.3';
import { uid } from '../utils/dom.js?v=6.3';
import { groupForLine, recomputeProjectCost } from './boqService.js?v=6.3';

const now = () => new Date().toISOString();
const clean = value => String(value ?? '').trim();

export function normalizeLibraryItem(item = {}, { preserveCreatedAt = false } = {}) {
  const quotaItemIds = Array.isArray(item.quotaItemIds)
    ? item.quotaItemIds.filter(Boolean)
    : clean(item.quotaItemIds).split(/[，,;；\s]+/).filter(Boolean);
  return {
    ...item,
    code: clean(item.code), name: clean(item.name), feature: clean(item.feature), unit: clean(item.unit),
    major: clean(item.major), scope: clean(item.scope), structureGroup: clean(item.structureGroup),
    source: clean(item.source) || '自建', version: clean(item.version) || 'v1.0', note: clean(item.note),
    defaultQty: Number(item.defaultQty) || 0,
    quotaItemIds: [...new Set(quotaItemIds)],
    status: item.status === 'inactive' ? 'inactive' : 'active',
    referenceCount: Number(item.referenceCount) || 0,
    lastReferencedAt: item.lastReferencedAt || '', lastReferencedProjectName: item.lastReferencedProjectName || '',
    createdAt: preserveCreatedAt ? item.createdAt || now() : item.createdAt || now(),
    updatedAt: now(),
  };
}

export function findDuplicateLibraryItem(items = [], candidate = {}, excludeId = '') {
  const code = clean(candidate.code);
  if (code) return items.find(item => item.id !== excludeId && clean(item.code) === code) || null;
  const key = [candidate.name, candidate.feature, candidate.unit].map(clean).join('|');
  return items.find(item => item.id !== excludeId && [item.name, item.feature, item.unit].map(clean).join('|') === key) || null;
}

export const boqLibraryService = {
  async list(filters = {}) {
    const { keyword = '', major = '', code = '', unit = '', scope = '', status = '' } = filters;
    const kw = clean(keyword).toLowerCase();
    return (await boqLibraryRepo.all()).filter(item => {
      if (major && item.major !== major) return false;
      if (code && !clean(item.code).includes(code)) return false;
      if (unit && item.unit !== unit) return false;
      if (scope && item.scope !== scope) return false;
      if (status && item.status !== status) return false;
      return !kw || [item.code, item.name, item.feature, item.major, item.scope].join(' ').toLowerCase().includes(kw);
    }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },
  get: id => boqLibraryRepo.findById(id),
  async options(field) {
    return [...new Set((await boqLibraryRepo.all()).map(item => clean(item[field])).filter(Boolean))].sort();
  },
  async save(data) {
    const all = await boqLibraryRepo.all();
    const normalized = normalizeLibraryItem(data, { preserveCreatedAt: Boolean(data.id) });
    if (!normalized.name || !normalized.unit) throw new Error('请填写清单名称和单位');
    const duplicate = findDuplicateLibraryItem(all, normalized, normalized.id);
    if (duplicate) throw new Error(`已存在相同清单：${duplicate.code || duplicate.name}`);
    if (normalized.id) return boqLibraryRepo.update(normalized.id, normalized);
    normalized.id = uid();
    await boqLibraryRepo.upsert(normalized);
    return normalized;
  },
  async copy(id) {
    const source = await boqLibraryRepo.findById(id);
    if (!source) throw new Error('清单不存在');
    const clone = normalizeLibraryItem({ ...source, id: '', code: '', name: `${source.name}（副本）`, referenceCount: 0, lastReferencedAt: '', lastReferencedProjectName: '' });
    clone.id = uid();
    await boqLibraryRepo.upsert(clone);
    return clone;
  },
  remove: id => boqLibraryRepo.remove(id),
  async batchUpdate(ids, patch) {
    const all = await boqLibraryRepo.all();
    const target = new Set(ids);
    const updated = all.map(item => target.has(item.id) ? normalizeLibraryItem({ ...item, ...patch }, { preserveCreatedAt: true }) : item);
    await boqLibraryRepo.replaceAll(updated);
    return updated.filter(item => target.has(item.id));
  },
  async importFromExcel(file) {
    const rows = await parseExcel(file);
    return this.importRows(rows.map(rowToBoqLibraryItem));
  },
  async importRows(rows = []) {
    const [items, quotas] = await Promise.all([boqLibraryRepo.all(), quotaRepo.all()]);
    const result = { total: rows.length, success: 0, added: 0, updated: 0, skipped: 0, failed: 0, warnings: [] };
    rows.forEach((raw, index) => {
      const item = normalizeLibraryItem(raw);
      if (!item.name || !item.unit) { result.failed++; result.warnings.push(`第 ${index + 2} 行缺少清单名称或单位`); return; }
      const quotaRefs = raw.quotaRefs || raw.quotaItemIds || [];
      const refs = Array.isArray(quotaRefs) ? quotaRefs : clean(quotaRefs).split(/[，,;；\s]+/);
      item.quotaItemIds = refs.map(ref => quotas.find(q => q.id === ref || q.code === ref || q.name === ref)?.id).filter(Boolean);
      if (refs.length && !item.quotaItemIds.length) result.warnings.push(`第 ${index + 2} 行关联定额未匹配：${refs.join('、')}`);
      const existing = findDuplicateLibraryItem(items, item);
      if (existing) { Object.assign(existing, { ...item, id: existing.id, createdAt: existing.createdAt }); result.updated++; }
      else { item.id = uid(); items.push(item); result.added++; }
      result.success++;
    });
    await boqLibraryRepo.replaceAll(items);
    return result;
  },
  async applyToProject(libraryItemId, projectId) {
    const [item, project, quotas] = await Promise.all([boqLibraryRepo.findById(libraryItemId), projectRepo.findById(projectId), quotaRepo.all()]);
    if (!item) throw new Error('清单库条目不存在');
    if (!project) throw new Error('项目不存在');
    const quota = (item.quotaItemIds || []).length === 1 ? quotas.find(q => q.id === item.quotaItemIds[0]) : null;
    const unitPrice = quota ? (quota.useBreakdown ? Object.values(quota.breakdown || {}).reduce((sum, value) => sum + (Number(value) || 0), 0) : Number(quota.priceTotal || 0)) : 0;
    const line = {
      id: uid(), projectId, boqLibraryItemId: item.id, quotaItemId: quota?.id || '', code: item.code,
      name: item.name, feature: item.feature, unit: item.unit, qty: Number(item.defaultQty) || 0,
      factor: 1, unitPrice, amount: calculateAmount(item.defaultQty, unitPrice, 1),
      priceMissing: hasMissingPrice(unitPrice), structureGroup: item.structureGroup || groupForLine(item),
    };
    await boqRepo.upsert(line);
    const referencePatch = { referenceCount: (Number(item.referenceCount) || 0) + 1, lastReferencedAt: now(), lastReferencedProjectName: project.name || '', updatedAt: now() };
    await boqLibraryRepo.update(item.id, referencePatch);
    await recomputeProjectCost(projectId);
    return line;
  },
};
