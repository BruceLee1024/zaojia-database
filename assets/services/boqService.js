// 工程量清单服务
import { boqRepo, projectRepo, quotaRepo } from '../data/repository.js?v=2.8';
import { uid } from '../utils/dom.js';
import { pickBestQuota, categoryGuess } from '../utils/stats.js';
import { calculateAmount } from '../utils/costing.js?v=2.8';
import { hasMissingPrice } from '../utils/costing.js?v=2.8';

export const boqService = {
  async listByProject(projectId) {
    return await boqRepo.byProject(projectId);
  },

  /** 通过定额 id 添加一条清单 */
  async addFromQuota(projectId, quotaItemId, qty = 0) {
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

  /** 修改一条 */
  async update(id, patch) {
    const all = await boqRepo.all();
    const b = all.find(x => x.id === id);
    if (!b) return null;
    const updated = { ...b, ...patch };
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
    await boqRepo.remove(id);
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
  async importLines(projectId, rows, { mode = 'append' } = {}) {
    const [all, quotaItems] = await Promise.all([boqRepo.all(), quotaRepo.all()]);
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
        amount: calculateAmount(row.qty, row.unitPrice, row.factor || 1),
        priceMissing: hasMissingPrice(row.unitPrice),
      });
    });

    const next = mode === 'replace'
      ? [...all.filter(line => line.projectId !== projectId), ...imported]
      : [...all, ...imported];
    await boqRepo.replaceAll(next);
    const total = await recomputeProjectCost(projectId);
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
};

/** 重算项目总造价 */
export async function recomputeProjectCost(projectId) {
  const lines = await boqRepo.byProject(projectId);
  const total = lines.reduce((s, b) => s + (b.amount || 0), 0);
  await projectRepo.update(projectId, { totalCost: total });
  return total;
}
