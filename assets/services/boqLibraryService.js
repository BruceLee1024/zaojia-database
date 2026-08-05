// 独立清单库：标准清单条目维护与套用到项目
import { boqLibraryQuotaRelationRepo, boqLibraryRepo, boqRepo, projectBoqQuotaRelationRepo, projectRepo, quotaRepo } from '../data/repository.js?v=6.5';
import { parseExcel, rowToBoqLibraryItem } from '../data/excel.js?v=6.5';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.5';
import { uid } from '../utils/dom.js?v=6.5';
import { groupForLine, recomputeProjectCost } from './boqService.js?v=6.5';
import { boqQuotaRelationService, calculateQuotaRelations, normalizeQuotaRelation, quotaSnapshot } from './boqQuotaRelationService.js?v=6.5';
import { normalizeCurrency } from '../utils/currency.js?v=6.5';

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
    const [libraryItems, allRelations] = await Promise.all([boqLibraryRepo.all(), boqLibraryQuotaRelationRepo.all()]);
    const relationMap = new Map();
    allRelations.forEach(relation => {
      const rows = relationMap.get(relation.boqLibraryItemId) || [];
      rows.push(relation);
      relationMap.set(relation.boqLibraryItemId, rows);
    });
    return libraryItems.map(item => {
      const quotaRelations = relationMap.get(item.id) || [];
      const relationIds = quotaRelations.map(relation => relation.quotaItemId).filter(Boolean);
      const quotaItemIds = relationIds.length ? [...new Set(relationIds)] : (item.quotaItemIds || []);
      const composition = calculateQuotaRelations(quotaRelations, item.defaultQty);
      return { ...item, quotaItemIds, quotaRelations, quotaCount: quotaRelations.length || quotaItemIds.length, referenceUnitPrice: composition.unitPrice };
    }).filter(item => {
      if (major && item.major !== major) return false;
      if (code && !clean(item.code).includes(code)) return false;
      if (unit && item.unit !== unit) return false;
      if (scope && item.scope !== scope) return false;
      if (status && item.status !== status) return false;
      return !kw || [item.code, item.name, item.feature, item.major, item.scope].join(' ').toLowerCase().includes(kw);
    }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },
  async get(id) {
    const item = await boqLibraryRepo.findById(id);
    if (!item) return null;
    const quotaRelations = await boqQuotaRelationService.libraryRelations(id);
    return { ...item, quotaRelations, quotaItemIds: [...new Set(quotaRelations.map(row => row.quotaItemId).filter(Boolean))], quotaCount: quotaRelations.length, referenceUnitPrice: calculateQuotaRelations(quotaRelations, item.defaultQty).unitPrice };
  },
  async options(field) {
    return [...new Set((await boqLibraryRepo.all()).map(item => clean(item[field])).filter(Boolean))].sort();
  },
  async save(data) {
    const all = await boqLibraryRepo.all();
    const normalized = normalizeLibraryItem(data, { preserveCreatedAt: Boolean(data.id) });
    if (!normalized.name || !normalized.unit) throw new Error('请填写清单名称和单位');
    const duplicate = findDuplicateLibraryItem(all, normalized, normalized.id);
    if (duplicate) throw new Error(`已存在相同清单：${duplicate.code || duplicate.name}`);
    if (normalized.id) {
      const saved = await boqLibraryRepo.update(normalized.id, normalized);
      if (Array.isArray(data.quotaRelations)) await boqQuotaRelationService.replaceLibraryRelations(normalized.id, data.quotaRelations);
      else if (Array.isArray(data.quotaItemIds)) {
        const quotas = await quotaRepo.all();
        const existingRelations = await boqQuotaRelationService.libraryRelations(normalized.id);
        const next = data.quotaItemIds.map((quotaItemId, index) => existingRelations.find(row => row.quotaItemId === quotaItemId) || normalizeQuotaRelation({ quotaItemId, quotaSnapshot: quotaSnapshot(quotas.find(row => row.id === quotaItemId) || { id: quotaItemId }) }, { ownerId: normalized.id, order: index }));
        await boqQuotaRelationService.replaceLibraryRelations(normalized.id, next);
      }
      return saved;
    }
    normalized.id = uid();
    await boqLibraryRepo.upsert(normalized);
    if (Array.isArray(data.quotaRelations)) await boqQuotaRelationService.replaceLibraryRelations(normalized.id, data.quotaRelations);
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
  async remove(id) {
    const relations = await boqLibraryQuotaRelationRepo.all();
    await Promise.all([
      boqLibraryRepo.remove(id),
      boqLibraryQuotaRelationRepo.replaceAll(relations.filter(row => row.boqLibraryItemId !== id)),
    ]);
  },
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
    const [items, quotas, originalRelations] = await Promise.all([boqLibraryRepo.all(), quotaRepo.all(), boqLibraryQuotaRelationRepo.all()]);
    const relations = [...originalRelations];
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
      const owner = existing || item;
      const nextRelations = item.quotaItemIds.map((quotaItemId, relationIndex) => normalizeQuotaRelation({
        quotaItemId, quotaSnapshot: quotaSnapshot(quotas.find(row => row.id === quotaItemId) || { id: quotaItemId }),
      }, { ownerId: owner.id, order: relationIndex }));
      relations.splice(0, relations.length, ...relations.filter(row => row.boqLibraryItemId !== owner.id), ...nextRelations);
      result.success++;
    });
    await boqLibraryRepo.replaceAll(items);
    await boqLibraryQuotaRelationRepo.replaceAll(relations);
    return result;
  },
  async applyToProject(libraryItemId, projectId) {
    const [item, project, originalLines, originalRelations] = await Promise.all([boqLibraryRepo.findById(libraryItemId), projectRepo.findById(projectId), boqRepo.all(), projectBoqQuotaRelationRepo.all()]);
    if (!item) throw new Error('清单库条目不存在');
    if (!project) throw new Error('项目不存在');
    const libraryRelations = await boqQuotaRelationService.libraryRelations(libraryItemId);
    const projectCurrency = normalizeCurrency(project.currency);
    const mismatched = libraryRelations.find(relation => normalizeCurrency(relation.quotaSnapshot?.currency) !== projectCurrency);
    if (mismatched) throw new Error(`清单库中的定额币种与项目本位币 ${projectCurrency} 不一致，不能直接套用。`);
    const composition = calculateQuotaRelations(libraryRelations, Number(item.defaultQty) || 0);
    const unitPrice = composition.unitPrice;
    const line = {
      id: uid(), projectId, boqLibraryItemId: item.id, quotaItemId: libraryRelations.length === 1 ? libraryRelations[0].quotaItemId || '' : '', code: item.code,
      name: item.name, feature: item.feature, unit: item.unit, qty: Number(item.defaultQty) || 0,
      factor: 1, pricingMode: libraryRelations.length ? 'composition' : 'manual', compositionUnitPrice: unitPrice,
      unitPrice, amount: calculateAmount(item.defaultQty, unitPrice, 1),
      priceMissing: hasMissingPrice(unitPrice), structureGroup: item.structureGroup || groupForLine(item),
    };
    try {
      await boqRepo.replaceAll([...originalLines, line]);
      await boqQuotaRelationService.copyLibraryToProject(item.id, projectId, line.id);
      const referencePatch = { referenceCount: (Number(item.referenceCount) || 0) + 1, lastReferencedAt: now(), lastReferencedProjectName: project.name || '', updatedAt: now() };
      await boqLibraryRepo.update(item.id, referencePatch);
      await recomputeProjectCost(projectId);
      return line;
    } catch (error) {
      await Promise.allSettled([boqRepo.replaceAll(originalLines), projectBoqQuotaRelationRepo.replaceAll(originalRelations)]);
      throw error;
    }
  },
};
