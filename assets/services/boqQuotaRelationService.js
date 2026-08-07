import {
  boqLibraryQuotaRelationRepo,
  boqLibraryRepo,
  projectBoqQuotaRelationRepo,
  quotaRepo,
} from '../data/repository.js?v=6.12';
import { uid } from '../utils/dom.js?v=6.12';
import { quotaPriceStatus, roundMoney } from '../utils/costing.js?v=6.12';

const now = () => new Date().toISOString();

export function parseQuotaUnit(unit = '') {
  const text = String(unit || '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*(.+)$/.exec(text);
  if (!match) return { unitBase: 1, normalizedUnit: text };
  const unitBase = Number(match[1]);
  return { unitBase: unitBase > 0 ? unitBase : 1, normalizedUnit: match[2].trim() };
}

export function quotaSnapshot(quota = {}, overrides = {}) {
  const parsed = parseQuotaUnit(overrides.unit ?? quota.unit);
  const price = Number(overrides.priceTotal ?? quota.priceTotal ?? 0);
  return {
    id: quota.id || '', code: String(overrides.code ?? quota.code ?? '').trim(),
    name: String(overrides.name ?? quota.name ?? '').trim(), feature: String(overrides.feature ?? quota.feature ?? '').trim(),
    unit: String(overrides.unit ?? quota.unit ?? '').trim(), unitBase: Number(overrides.unitBase || quota.unitBase || parsed.unitBase) || 1,
    normalizedUnit: String(overrides.normalizedUnit ?? quota.normalizedUnit ?? parsed.normalizedUnit).trim(),
    priceTotal: price, breakdown: structuredCloneSafe(overrides.breakdown ?? quota.breakdown ?? {}),
    priceStatus: quotaPriceStatus(price, overrides.priceProvided ?? true), updatedAt: quota.updatedAt || '',
  };
}

export function normalizeQuotaRelation(relation = {}, { scope = 'library', ownerId = '', projectId = '', order = 0 } = {}) {
  const snapshot = quotaSnapshot(relation.quotaSnapshot || {}, {
    code: relation.quotaSnapshot?.code ?? relation.code,
    name: relation.quotaSnapshot?.name ?? relation.name,
    unit: relation.quotaSnapshot?.unit ?? relation.unit,
    priceTotal: relation.quotaSnapshot?.priceTotal ?? relation.sourceUnitPrice ?? relation.priceTotal,
    priceProvided: relation.quotaSnapshot?.priceStatus !== 'missing',
  });
  return {
    ...relation,
    id: relation.id || uid(),
    ...(scope === 'project'
      ? { projectId: relation.projectId || projectId, projectBoqLineId: relation.projectBoqLineId || ownerId }
      : { boqLibraryItemId: relation.boqLibraryItemId || ownerId }),
    quotaItemId: relation.quotaItemId || snapshot.id || '',
    sortOrder: Number.isFinite(Number(relation.sortOrder)) ? Number(relation.sortOrder) : order,
    quantityBasis: relation.quantityBasis === 'total' ? 'total' : 'per_unit',
    quantityValue: Number.isFinite(Number(relation.quantityValue)) ? Number(relation.quantityValue) : 1,
    adjustmentFactor: Number.isFinite(Number(relation.adjustmentFactor)) ? Number(relation.adjustmentFactor) : 1,
    quotaSnapshot: snapshot,
    sourceQty: finiteOrNull(relation.sourceQty), sourceUnitPrice: finiteOrNull(relation.sourceUnitPrice), sourceAmount: finiteOrNull(relation.sourceAmount),
    referenceStatus: relation.referenceStatus || (relation.quotaItemId || snapshot.id ? 'active' : 'unlinked'),
    quantityStatus: relation.quantityStatus || 'confirmed', source: structuredCloneSafe(relation.source || {}),
    createdAt: relation.createdAt || now(), updatedAt: now(),
  };
}

export function calculateQuotaRelations(relations = [], boqQty = 0) {
  const parentQty = Number(boqQty) || 0;
  const rows = [...relations].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0)).map(relation => {
    const price = Number(relation.quotaSnapshot?.priceTotal ?? relation.sourceUnitPrice ?? 0) || 0;
    const factor = Number(relation.adjustmentFactor ?? 1) || 1;
    const value = Number(relation.quantityValue) || 0;
    const totalQty = relation.quantityBasis === 'total' ? value : parentQty * value;
    const amount = roundMoney(totalQty * price * factor);
    const contributionUnitPrice = parentQty ? amount / parentQty : 0;
    return { ...relation, totalQty, effectivePrice: price, amount, contributionUnitPrice };
  });
  const rawUnitPrice = rows.reduce((sum, row) => sum + row.contributionUnitPrice, 0);
  return { rows, unitPrice: parentQty ? roundMoney(rawUnitPrice) : 0, amount: rows.reduce((sum, row) => sum + row.amount, 0), calculable: parentQty > 0 };
}

export const boqQuotaRelationService = {
  async libraryRelations(boqLibraryItemId, { migrateLegacy = true } = {}) {
    let relations = await boqLibraryQuotaRelationRepo.byBoqLibraryItem(boqLibraryItemId);
    if (!relations.length && migrateLegacy) {
      const item = await boqLibraryRepo.findById(boqLibraryItemId);
      const ids = item?.quotaItemIds || [];
      if (ids.length) {
        const quotas = await quotaRepo.all();
        relations = ids.map((quotaItemId, index) => {
          const quota = quotas.find(row => row.id === quotaItemId) || { id: quotaItemId };
          return normalizeQuotaRelation({ quotaItemId, quotaSnapshot: quotaSnapshot(quota), quantityStatus: ids.length > 1 ? 'needs_review' : 'confirmed' }, { ownerId: boqLibraryItemId, order: index });
        });
        await boqLibraryQuotaRelationRepo.replaceAll([...(await boqLibraryQuotaRelationRepo.all()), ...relations]);
      }
    }
    return relations.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  },

  async replaceLibraryRelations(boqLibraryItemId, inputs = []) {
    const current = await boqLibraryQuotaRelationRepo.all();
    const normalized = inputs.map((item, index) => normalizeQuotaRelation(item, { ownerId: boqLibraryItemId, order: index }));
    await boqLibraryQuotaRelationRepo.replaceAll([...current.filter(item => item.boqLibraryItemId !== boqLibraryItemId), ...normalized]);
    await boqLibraryRepo.update(boqLibraryItemId, { quotaItemIds: [...new Set(normalized.map(item => item.quotaItemId).filter(Boolean))], updatedAt: now() });
    return normalized;
  },

  async projectRelations(projectBoqLineId) {
    return (await projectBoqQuotaRelationRepo.byBoqLine(projectBoqLineId)).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  },

  async copyLibraryToProject(boqLibraryItemId, projectId, projectBoqLineId) {
    const templates = await this.libraryRelations(boqLibraryItemId);
    const all = await projectBoqQuotaRelationRepo.all();
    const copies = templates.map((item, index) => normalizeQuotaRelation({
      ...item, id: '', sourceLibraryRelationId: item.id, boqLibraryItemId: undefined,
    }, { scope: 'project', ownerId: projectBoqLineId, projectId, order: index }));
    await projectBoqQuotaRelationRepo.replaceAll([...all.filter(item => item.projectBoqLineId !== projectBoqLineId), ...copies]);
    return copies;
  },
};

function finiteOrNull(value) { return value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value); }
function structuredCloneSafe(value) { return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value; }
