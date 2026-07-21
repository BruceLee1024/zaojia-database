// 工程量清单服务
import { boqRepo, projectBoqQuotaRelationRepo, projectRepo, quotaRepo, resourcePriceRepo, resourceRepo, versionRepo } from '../data/repository.js?v=6.3';
import { uid } from '../utils/dom.js?v=6.3';
import { pickBestQuota, categoryGuess } from '../utils/stats.js?v=6.3';
import { calculateAmount } from '../utils/costing.js?v=6.3';
import { hasMissingPrice } from '../utils/costing.js?v=6.3';
import { localDateKey } from '../utils/localDate.js?v=6.3';
import { createSerializedKeyCoordinator } from '../utils/requestCoordinator.js?v=6.3';
import { assertResourceAvailableForNewUse } from './resourceService.js?v=6.3';
import { assertPriceUsableForCosting } from './resourcePriceService.js?v=6.3';
import { assertProjectEditable, assertProjectEditableById } from './projectLockService.js?v=6.3';
import { calculateQuotaRelations } from './boqQuotaRelationService.js?v=6.3';

const equipmentPackageCoordinator = createSerializedKeyCoordinator();

export const boqService = {
  async listByProject(projectId) {
    return await boqRepo.byProject(projectId);
  },

  /** 通过定额 id 添加一条清单 */
  async addFromQuota(projectId, quotaItemId, qty = 0) {
    await assertProjectEditableById(projectId);
    const it = await quotaRepo.findById(quotaItemId);
    if (!it) throw new Error('定额不存在');
    const unitPrice = it.useBreakdown
      ? Object.values(it.breakdown || {}).reduce((a, b) => a + (+b || 0), 0)
      : (it.priceTotal || 0);
    const line = {
      id: uid(),
      projectId,
      quotaItemId,
      code: '',
      name: it.name,
      feature: it.feature || '',
      unit: it.unit,
      qty,
      factor: 1,
      unitPrice,
      amount: calculateAmount(qty, unitPrice, 1),
      priceMissing: !(unitPrice > 0),
      structureGroup: groupForQuota(it),
    };
    await boqRepo.upsert(line);
    await recomputeProjectCost(projectId);
    return line;
  },

  /** 自然语言添加清单（用 AI 路由前的本地匹配） */
  async addByText(projectId, quotaHint, qty) {
    const items = await quotaRepo.all();
    const hit = pickBestQuota(items, quotaHint);
    if (!hit) throw new Error(`没找到「${quotaHint}」相关定额`);
    return await this.addFromQuota(projectId, hit.id, qty);
  },

  async addEquipmentPackage(projectId, resourceId, priceId, qty, { installQuotaId } = {}) {
    return equipmentPackageCoordinator.run('project_boq', async () => {
      const [project, resource, price, installQuota] = await Promise.all([
      projectRepo.findById(projectId),
      resourceRepo.findById(resourceId),
      resourcePriceRepo.findById(priceId),
      installQuotaId ? quotaRepo.findById(installQuotaId) : null,
      ]);
      if (!project) throw new Error('项目不存在');
    assertProjectEditable(project);
    if (!resource || resource.resourceType !== 'equipment') throw new Error('只能将设备加入项目');
    assertResourceAvailableForNewUse(resource);
    if (!price || price.resourceId !== resourceId) throw new Error('设备价格不存在或不属于当前设备');
    assertPriceUsableForCosting(price, resource, {
      context: 'equipment', pricingContext: { projectId: project.id, region: project.pricingRegion, asOf: project.pricingDate },
    });
    const quantity = Number(qty);
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error('设备数量不能为负数');
    if (installQuotaId && !installQuota) throw new Error('安装定额不存在');
    if (price.priceBasis === 'installed_composite' && installQuotaId) throw new Error('安装综合价不能重复计取安装定额');

    const [originalLines, originalProjects] = await Promise.all([boqRepo.all(), projectRepo.all()]);
    const equipmentLine = {
      id: uid(),
      projectId,
      quotaItemId: '',
      resourceItemId: resource.id,
      resourcePriceId: price.id,
      resourceSnapshot: cloneSnapshot(resource),
      resourcePriceSnapshot: cloneSnapshot(price),
      code: resource.code || '',
      name: resource.name,
      feature: [resource.specModel, resource.brand || resource.manufacturer].filter(Boolean).join('；'),
      unit: resource.unit,
      qty: quantity,
      factor: 1,
      unitPrice: Number(price.unitPrice),
      amount: calculateAmount(quantity, price.unitPrice, 1),
      priceMissing: false,
      structureGroup: 'equipment',
    };
    const created = [equipmentLine];
    if (installQuota) {
      const installPrice = installQuota.useBreakdown
        ? Object.values(installQuota.breakdown || {}).reduce((sum, value) => sum + Number(value || 0), 0)
        : Number(installQuota.priceTotal || 0);
      created.push({
        id: uid(),
        projectId,
        quotaItemId: installQuota.id,
        linkedResourceItemId: resource.id,
        linkedResourceSnapshot: cloneSnapshot(resource),
        linkedEquipmentLineId: equipmentLine.id,
        code: '',
        name: installQuota.name,
        feature: installQuota.feature || '',
        unit: installQuota.unit || resource.unit,
        qty: quantity,
        factor: 1,
        unitPrice: installPrice,
        amount: calculateAmount(quantity, installPrice, 1),
        priceMissing: !(installPrice > 0),
        structureGroup: 'equipment',
      });
    }
    try {
      await boqRepo.replaceAll([...originalLines, ...created]);
      await recomputeProjectCost(projectId);
      return created;
    } catch (error) {
      const rollback = await Promise.allSettled([
        boqRepo.replaceAll(originalLines),
        projectRepo.replaceAll(originalProjects),
      ]);
      const rollbackCauses = rollback.filter(result => result.status === 'rejected').map(result => result.reason);
      if (rollbackCauses.length) {
        throw Object.assign(new Error('设备包写入失败，且原数据未能完全恢复。'), {
          code: 'EQUIPMENT_PACKAGE_PARTIAL_RECOVERY', cause: error, rollbackCauses,
        });
      }
      throw Object.assign(new Error('设备包写入失败，原数据已恢复。'), {
        code: 'EQUIPMENT_PACKAGE_ROLLED_BACK', cause: error,
      });
    }
    });
  },

  /** 修改一条 */
  async update(id, patch) {
    const all = await boqRepo.all();
    const b = all.find(x => x.id === id);
    if (!b) return null;
    await assertProjectEditableById(b.projectId);
    const updated = { ...b, ...patch };
    if (updated.pricingMode === 'composition' && ('qty' in patch || 'pricingMode' in patch)) {
      const relations = await projectBoqQuotaRelationRepo.byBoqLine(id);
      if (relations.length) {
        const composition = calculateQuotaRelations(relations, updated.qty);
        updated.compositionUnitPrice = composition.unitPrice;
        updated.unitPrice = composition.unitPrice;
      }
    }
    if ('qty' in patch || 'unitPrice' in patch || 'factor' in patch) {
      updated.amount = calculateAmount(updated.qty, updated.unitPrice, updated.factor);
      updated.priceMissing = !(updated.unitPrice > 0);
    }
    await boqRepo.update(id, updated);
    await recomputeProjectCost(updated.projectId);
    return updated;
  },

  /** 删除一条 */
  async remove(id) {
    const all = await boqRepo.all();
    const b = all.find(x => x.id === id);
    if (!b) return;
    await assertProjectEditableById(b.projectId);
    const relations = await projectBoqQuotaRelationRepo.all();
    await Promise.all([boqRepo.remove(id), projectBoqQuotaRelationRepo.replaceAll(relations.filter(row => row.projectBoqLineId !== id))]);
    await recomputeProjectCost(b.projectId);
  },

  /** 批量调价 */
  async batchAdjust(projectId, target, factor) {
    const all = await boqRepo.all();
    let count = 0;
    for (const b of all) {
      if (b.projectId !== projectId) continue;
      const blob = `${b.name} ${b.feature || ''}`;
      if (target === '全部' || target === '所有' || blob.includes(target)) {
        b.factor = (b.factor || 1) * factor;
        b.amount = calculateAmount(b.qty, b.unitPrice, b.factor);
        count++;
      }
    }
    await boqRepo.replaceAll(all);
    await recomputeProjectCost(projectId);
    return count;
  },

  /** 导入 Excel 转换后的清单行 */
  async importLines(projectId, rows, { mode = 'append', amountRule = 'calculated' } = {}) {
    const [all, quotaItems, originalProjects] = await Promise.all([boqRepo.all(), quotaRepo.all(), projectRepo.all()]);
    const imported = [];
    const warnings = [];

    rows.forEach((row, index) => {
      if (!row.name) {
        warnings.push(`第 ${index + 1} 行缺少项目名称`);
        return;
      }
      const hit = pickBestQuota(quotaItems, `${row.name} ${row.feature || ''}`);
      imported.push({
        ...row,
        id: uid(),
        projectId,
        quotaItemId: hit?.id || row.quotaItemId || '',
        factor: Number(row.factor || 1) || 1,
        qty: Number(row.qty || 0) || 0,
        unitPrice: Number(row.unitPrice || 0) || 0,
        amount: amountRule === 'sourceAmount' && Number.isFinite(Number(row.amount))
          ? Number(row.amount)
          : calculateAmount(row.qty, row.unitPrice, row.factor || 1),
        priceMissing: hasMissingPrice(row.unitPrice),
        structureGroup: row.structureGroup || groupForLine(row),
      });
    });

    const next = mode === 'replace'
      ? [...all.filter(line => line.projectId !== projectId), ...imported]
      : [...all, ...imported];
    let total;
    try {
      await boqRepo.replaceAll(next);
      total = await recomputeProjectCost(projectId);
    } catch (cause) {
      const rollback = await Promise.allSettled([boqRepo.replaceAll(all), projectRepo.replaceAll(originalProjects)]);
      const rollbackCauses = rollback.filter(result => result.status === 'rejected').map(result => result.reason);
      const error = new Error(rollbackCauses.length ? '清单导入失败，且原数据未能完全恢复' : '清单导入失败，已恢复导入前数据');
      error.code = rollbackCauses.length ? 'BOQ_IMPORT_PARTIAL_RECOVERY' : 'BOQ_IMPORT_ROLLED_BACK';
      error.cause = cause;
      error.rollbackCauses = rollbackCauses;
      throw error;
    }
    return {
      total: rows.length,
      success: imported.length,
      failed: rows.length - imported.length,
      missingPrice: imported.filter(line => hasMissingPrice(line.unitPrice)).length,
      matchedQuota: imported.filter(line => line.quotaItemId).length,
      warnings,
      totalCost: total,
    };
  },

  /** 项目分项造价占比 */
  async breakdown(projectId) {
    const lines = await this.listByProject(projectId);
    const groups = {};
    lines.forEach(b => {
      const cat = categoryGuess(b.name);
      groups[cat] = (groups[cat] || 0) + (b.amount || 0);
    });
    const total = Object.values(groups).reduce((a, b) => a + b, 0) || 1;
    return {
      total: lines.reduce((s, b) => s + (b.amount || 0), 0),
      count: lines.length,
      groups: Object.entries(groups)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, amount]) => ({ cat, amount, ratio: amount / total })),
    };
  },

  async updateStructureGroup(id, structureGroup) {
    return await this.update(id, { structureGroup });
  },

  async recommendQuota(line, limit = 5) {
    const items = await quotaRepo.all();
    const source = `${line?.name || ''} ${line?.feature || ''}`.trim();
    const words = source.toLowerCase().split(/[\s,，;；、/]+/).filter(w => w.length > 1);
    return items
      .map(item => {
        const blob = `${item.name || ''} ${item.feature || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
        const exact = source && blob.includes(source.toLowerCase()) ? 4 : 0;
        const wordScore = words.reduce((sum, word) => sum + (blob.includes(word) ? 1 : 0), 0);
        const unitScore = item.unit && line?.unit && item.unit === line.unit ? 1.5 : 0;
        const categoryScore = groupForQuota(item) === groupForLine(line || {}) ? 1 : 0;
        return { item, score: exact + wordScore + unitScore + categoryScore };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => ({ ...x.item, score: x.score }));
  },

  async replaceQuota(lineId, quotaItemId) {
    const [all, quota] = await Promise.all([boqRepo.all(), quotaRepo.findById(quotaItemId)]);
    const line = all.find(b => b.id === lineId);
    if (!line || !quota) throw new Error('清单或定额不存在');
    const unitPrice = quota.useBreakdown
      ? Object.values(quota.breakdown || {}).reduce((a, b) => a + (+b || 0), 0)
      : Number(quota.priceTotal || 0);
    return await this.update(lineId, {
      quotaItemId: quota.id,
      code: line.code || '',
      name: quota.name,
      feature: quota.feature || line.feature || '',
      unit: quota.unit || line.unit || '',
      unitPrice,
      structureGroup: groupForQuota(quota),
    });
  },

  async audit(projectId) {
    const [project, lines, versions, quotas, resources, resourcePrices, quotaRelations] = await Promise.all([
      projectRepo.findById(projectId),
      boqRepo.byProject(projectId),
      versionRepo.byProject(projectId),
      quotaRepo.all(),
      resourceRepo.all(),
      resourcePriceRepo.all(),
      projectBoqQuotaRelationRepo.byProject(projectId),
    ]);
    const quotaIds = new Set(quotas.map(item => item.id));
    const resourceIds = new Set(resources.map(item => item.id));
    const resourcePriceMap = new Map(resourcePrices.map(item => [item.id, item]));
    const today = localDateKey();
    const relationsByLine = new Map();
    quotaRelations.forEach(relation => { const rows = relationsByLine.get(relation.projectBoqLineId) || []; rows.push(relation); relationsByLine.set(relation.projectBoqLineId, rows); });
    const duplicateMap = new Map();
    lines.forEach(line => {
      const key = [line.name, line.feature, line.unit].map(v => String(v || '').trim()).join('|');
      duplicateMap.set(key, (duplicateMap.get(key) || 0) + 1);
    });
    const issues = {
      missingPrice: lines.filter(line => hasMissingPrice(line.unitPrice)),
      zeroQty: lines.filter(line => !(Number(line.qty) > 0)),
      factorRisk: lines.filter(line => Number(line.factor || 1) > 1.2 || Number(line.factor || 1) < 0.8),
      unmatchedQuota: lines.filter(line => !line.quotaItemId && !(relationsByLine.get(line.id) || []).some(row => row.quotaItemId)),
      invalidQuotaReference: lines.filter(line => line.quotaReferenceStatus === 'missing' || (line.quotaItemId && !quotaIds.has(line.quotaItemId)) || (relationsByLine.get(line.id) || []).some(row => row.referenceStatus === 'missing' || (row.quotaItemId && !quotaIds.has(row.quotaItemId)))),
      duplicate: lines.filter(line => duplicateMap.get([line.name, line.feature, line.unit].map(v => String(v || '').trim()).join('|')) > 1),
      invalidResourceReference: lines.filter(line => hasInvalidResourceReference(line, resourceIds)),
      expiredResourcePrice: lines.filter(line => isExpiredResourcePrice(line, resourcePriceMap, today)),
      missingResourcePriceBasis: lines.filter(line => hasResourcePrice(line) && !resourcePriceForLine(line, resourcePriceMap)?.priceBasis),
      duplicateEquipmentInstallation: duplicateEquipmentInstallationLines(lines, resourcePriceMap),
      noVersion: versions.length ? [] : [project].filter(Boolean),
    };
    const score = Math.max(0, 100
      - issues.missingPrice.length * 12
      - issues.zeroQty.length * 8
      - issues.factorRisk.length * 5
      - issues.unmatchedQuota.length * 4
      - issues.invalidQuotaReference.length * 8
      - issues.duplicate.length * 3
      - issues.invalidResourceReference.length * 8
      - issues.expiredResourcePrice.length * 5
      - issues.missingResourcePriceBasis.length * 5
      - issues.duplicateEquipmentInstallation.length * 8
      - (versions.length ? 0 : 10));
    return {
      project,
      lines,
      versions,
      score,
      level: score >= 85 ? '可提交' : score >= 65 ? '需复核' : '高风险',
      issues,
      totalIssueCount: Object.values(issues).reduce((sum, arr) => sum + arr.length, 0),
    };
  },
};

/** 重算项目总造价 */
export async function recomputeProjectCost(projectId) {
  const lines = await boqRepo.byProject(projectId);
  const total = lines.reduce((s, b) => s + (b.amount || 0), 0);
  await projectRepo.update(projectId, { totalCost: total });
  return total;
}

export function groupForLine(line = {}) {
  if (line.structureGroup) return line.structureGroup;
  const text = `${line.category || ''} ${line.majorCategory || ''} ${line.name || ''} ${line.feature || ''}`.toLowerCase();
  if (/设备|泵|鼓风|风机|闸|阀|格栅|刮泥|搅拌|曝气|加药|脱水|除臭|机械/.test(text)) return 'equipment';
  if (/电气|电缆|配电|自控|仪表|照明|接地|桥架|弱电|plc|控制/.test(text)) return 'electric';
  if (/管|管道|阀门井|检查井|井室|管网|雨水|污水管/.test(text)) return 'pipe';
  if (/土|桩|混凝土|钢筋|模板|砌|防水|抹灰|门窗|屋面|基础|垫层|墙|梁|板|装修|道路|土建/.test(text)) return 'civil';
  return 'other';
}

function groupForQuota(item = {}) {
  return groupForLine({ ...item, structureGroup: item.structureGroup || item.group });
}

function cloneSnapshot(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function hasInvalidResourceReference(line, resourceIds) {
  if (line.resourceReferenceStatus === 'missing' || line.linkedResourceReferenceStatus === 'missing') return true;
  const ids = [line.resourceItemId, line.linkedResourceItemId].filter(Boolean);
  return ids.some(id => !resourceIds.has(id));
}

function hasResourcePrice(line) {
  return Boolean(line.resourceItemId || line.resourcePriceId || line.resourcePriceSnapshot);
}

function resourcePriceForLine(line, resourcePriceMap) {
  return line.resourcePriceSnapshot || resourcePriceMap.get(line.resourcePriceId) || null;
}

function isExpiredResourcePrice(line, resourcePriceMap, today) {
  if (!hasResourcePrice(line)) return false;
  const price = resourcePriceForLine(line, resourcePriceMap);
  return Boolean(price?.validTo && price.validTo < today);
}

function duplicateEquipmentInstallationLines(lines, resourcePriceMap) {
  const equipmentLines = lines.filter(line => line.resourceItemId);
  const equipmentById = new Map(equipmentLines.map(line => [line.id, line]));
  const equipmentByResource = new Map();
  equipmentLines.forEach(line => {
    const group = equipmentByResource.get(line.resourceItemId) || [];
    group.push(line);
    equipmentByResource.set(line.resourceItemId, group);
  });
  const duplicateLineIds = new Set();
  lines.forEach(installationLine => {
    const resourceId = installationLine.linkedResourceItemId || installationLine.installationResourceItemId || installationLine.manualInstallationResourceId;
    if (!resourceId) return;
    const candidate = installationLine.linkedEquipmentLineId
      ? equipmentById.get(installationLine.linkedEquipmentLineId)
      : ((equipmentByResource.get(resourceId) || []).length === 1 ? equipmentByResource.get(resourceId)[0] : null);
    if (!candidate || candidate.resourceItemId !== resourceId) return;
    if (resourcePriceForLine(candidate, resourcePriceMap)?.priceBasis !== 'installed_composite') return;
    duplicateLineIds.add(candidate.id);
    duplicateLineIds.add(installationLine.id);
  });
  return lines.filter(line => duplicateLineIds.has(line.id));
}
