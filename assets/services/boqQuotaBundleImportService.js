import { boqLibraryQuotaRelationRepo, boqLibraryRepo, quotaRepo } from '../data/repository.js?v=6.7';
import { uid } from '../utils/dom.js?v=6.7';
import { categoryGuess } from '../utils/stats.js?v=6.7';
import { quotaPriceStatus } from '../utils/costing.js?v=6.7';
import { findDuplicateLibraryItem, normalizeLibraryItem } from './boqLibraryService.js?v=6.7';
import { normalizeQuotaRelation, parseQuotaUnit, quotaSnapshot } from './boqQuotaRelationService.js?v=6.7';

export function normalizeBundleLayer(value = '') {
  const text = String(value || '').replace(/[\s　]/g, '').toLowerCase();
  if (['清单', '工程量清单', '清单项'].includes(text)) return 'boq';
  if (['定额', '定额项', '定额子目'].includes(text)) return 'quota';
  return 'structure';
}

export function groupBundleRows(rows = []) {
  const groups = [];
  const orphans = [];
  let current = null;
  rows.forEach(row => {
    const kind = normalizeBundleLayer(row.layer);
    if (kind === 'boq') {
      current = { parent: row, children: [] };
      groups.push(current);
    } else if (kind === 'quota') {
      if (current) current.children.push(row);
      else orphans.push(row);
    } else {
      current = null;
    }
  });
  return { groups, orphans };
}

export async function importBoqQuotaBundle(rows = [], { sourceName = '组合表格导入', updateQuotaPrices = false } = {}) {
  const grouped = groupBundleRows(rows);
  if (grouped.orphans.length) throw new Error(`${grouped.orphans.length} 条定额上方没有可关联的清单`);
  if (!grouped.groups.length) throw new Error('没有识别到“层级=清单”的数据行');

  const [originalLibraries, originalQuotas, originalRelations] = await Promise.all([
    boqLibraryRepo.all(), quotaRepo.all(), boqLibraryQuotaRelationRepo.all(),
  ]);
  const libraries = structuredCloneSafe(originalLibraries);
  const quotas = structuredCloneSafe(originalQuotas);
  let relations = structuredCloneSafe(originalRelations);
  const result = { total: rows.length, success: 0, added: 0, updated: 0, skipped: 0, failed: 0, relationsAdded: 0, quotaAdded: 0, quotaUpdated: 0, warnings: [] };

  try {
    grouped.groups.forEach(group => {
      const raw = group.parent;
      const candidate = normalizeLibraryItem({
        code: raw.code, name: raw.name, feature: raw.feature, unit: raw.unit, defaultQty: raw.qty,
        source: sourceName, sourceUnitPrice: raw.unitPrice, sourceAmount: raw.amount,
      });
      let library = findDuplicateLibraryItem(libraries, candidate);
      if (library) {
        Object.assign(library, { ...candidate, id: library.id, createdAt: library.createdAt });
        result.updated++;
      } else {
        library = { ...candidate, id: uid() };
        libraries.push(library);
        result.added++;
      }

      const nextRelations = group.children.map((child, index) => {
        const parsedUnit = parseQuotaUnit(child.unit);
        let quota = quotas.find(item => child.code && String(item.code || '').trim() === String(child.code).trim());
        if (!quota) quota = quotas.find(item => !child.code && item.name === child.name && item.unit === child.unit);
        const breakdown = { 人工: Number(child.labor || 0), 材料: Number(child.material || 0), 设备: 0, 机械: Number(child.machine || 0), 管理费: Number(child.management || 0), 利润: Number(child.profit || 0), 风险: 0 };
        if (!quota) {
          quota = {
            id: uid(), code: child.code || '', category: categoryGuess(child.name), name: child.name, feature: child.feature || '',
            unit: child.unit || '', ...parsedUnit, priceTotal: Number(child.unitPrice || 0), priceStatus: quotaPriceStatus(child.unitPrice, child.unitPriceProvided !== false),
            breakdown, useBreakdown: false, tags: [], source: sourceName, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          quotas.push(quota);
          result.quotaAdded++;
        } else if (updateQuotaPrices) {
          Object.assign(quota, { code: child.code || quota.code || '', name: child.name || quota.name, feature: child.feature || quota.feature || '', unit: child.unit || quota.unit, ...parsedUnit, priceTotal: Number(child.unitPrice || 0), priceStatus: quotaPriceStatus(child.unitPrice, child.unitPriceProvided !== false), breakdown, updatedAt: new Date().toISOString() });
          result.quotaUpdated++;
        } else if (Number(quota.priceTotal || 0) !== Number(child.unitPrice || 0)) {
          result.warnings.push(`${child.code || child.name} 的来源价格与定额库不同，已保留在清单套用快照中。`);
        }
        const parentQty = Number(raw.qty || 0);
        const childQty = Number(child.qty || 0);
        const quantityValue = parentQty > 0 && childQty !== 0 ? childQty / parentQty : (parsedUnit.unitBase ? 1 / parsedUnit.unitBase : 1);
        return normalizeQuotaRelation({
          quotaItemId: quota.id, quantityBasis: 'per_unit', quantityValue, adjustmentFactor: 1,
          quotaSnapshot: quotaSnapshot(quota, { priceTotal: child.unitPrice, breakdown }),
          sourceQty: child.qty, sourceUnitPrice: child.unitPrice, sourceAmount: child.amount,
          source: { sourceName, sheetName: child.sheetName || '', rowNumber: child.sourceRowNumber || 0, parentRowNumber: raw.sourceRowNumber || 0, relationMethod: 'explicit_level', confidence: 'high' },
        }, { ownerId: library.id, order: index });
      });
      relations = [...relations.filter(item => item.boqLibraryItemId !== library.id), ...nextRelations];
      library.quotaItemIds = [...new Set(nextRelations.map(item => item.quotaItemId))];
      result.relationsAdded += nextRelations.length;
      result.success += 1 + group.children.length;
    });
    await quotaRepo.replaceAll(quotas);
    await boqLibraryRepo.replaceAll(libraries);
    await boqLibraryQuotaRelationRepo.replaceAll(relations);
    return result;
  } catch (error) {
    await Promise.allSettled([
      quotaRepo.replaceAll(originalQuotas), boqLibraryRepo.replaceAll(originalLibraries), boqLibraryQuotaRelationRepo.replaceAll(originalRelations),
    ]);
    throw error;
  }
}

function structuredCloneSafe(value) { return JSON.parse(JSON.stringify(value)); }
