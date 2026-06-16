// 定额库服务
import { quotaRepo } from '../data/repository.js?v=2.8';
import { parseExcel, detectRowKind, rowToQuotaItem } from '../data/excel.js?v=2.8';
import { uid } from '../utils/dom.js';
import { hasMissingPrice } from '../utils/costing.js?v=2.8';

export const quotaService = {
  /** 列出所有定额，支持分类/关键字过滤 */
  async list({ keyword = '', category = '', unit = '', priceStatus = '' } = {}) {
    const items = await quotaRepo.all();
    const kw = keyword.toLowerCase();
    return items.filter(it => {
      if (category && (it.category || '未分类') !== category) return false;
      if (unit && (it.unit || '') !== unit) return false;
      if (priceStatus === 'missing' && !hasMissingPrice(it.priceTotal)) return false;
      if (priceStatus === 'priced' && hasMissingPrice(it.priceTotal)) return false;
      if (!kw) return true;
      const blob = `${it.name} ${it.feature} ${(it.tags || []).join(' ')}`.toLowerCase();
      return blob.includes(kw);
    });
  },

  /** 取得所有分类 */
  async categories() {
    const items = await quotaRepo.all();
    return [...new Set(items.map(i => i.category || '未分类'))].sort();
  },

  async units() {
    const items = await quotaRepo.all();
    return [...new Set(items.map(i => i.unit).filter(Boolean))].sort();
  },

  /** 拿到一条 */
  async get(id) { return await quotaRepo.findById(id); },

  /** 创建/更新 */
  async save(data) {
    if (data.id) {
      return await quotaRepo.update(data.id, { ...data, updatedAt: new Date().toISOString() });
    }
    const obj = { ...data, id: uid(), updatedAt: new Date().toISOString() };
    await quotaRepo.upsert(obj);
    return obj;
  },

  /** 删除 */
  async remove(id) { return await quotaRepo.remove(id); },

  /** 从 Excel 导入（定额库格式） */
  async importFromExcel(file) {
    const rows = await parseExcel(file);
    const items = await quotaRepo.all();
    const result = {
      total: rows.length,
      success: 0,
      failed: 0,
      missingPrice: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      warnings: [],
    };

    if (!rows.length) {
      result.warnings.push('文件为空或第一个工作表没有可读取的数据。');
      return result;
    }

    rows.forEach((r, idx) => {
      const kind = detectRowKind(r);
      if (kind === 'boq') {
        result.skipped++;
        result.warnings.push(`第 ${idx + 2} 行是工程量清单格式，已跳过。`);
        return;
      }
      if (kind === 'unknown') {
        result.failed++;
        result.warnings.push(`第 ${idx + 2} 行无法识别表头或缺少清单名称。`);
        return;
      }
      const item = rowToQuotaItem(r);
      if (!item.name) {
        result.failed++;
        result.warnings.push(`第 ${idx + 2} 行缺少清单名称，未导入。`);
        return;
      }
      if (hasMissingPrice(item.priceTotal)) result.missingPrice++;
      const k = item.name + '|' + (item.feature || '').slice(0, 30);
      const exist = items.find(x => (x.name + '|' + (x.feature || '').slice(0, 30)) === k);
      const obj = {
        ...item,
        id: exist?.id || uid(),
        category: exist?.category || item.category,
        breakdown: exist?.breakdown || { 人工: 0, 材料: 0, 机械: 0, 管理费: 0, 利润: 0, 风险: 0 },
        useBreakdown: exist?.useBreakdown || false,
        tags: exist?.tags || [],
        updatedAt: new Date().toISOString(),
      };
      if (exist) { Object.assign(exist, obj); result.updated++; }
      else { items.push(obj); result.added++; }
      result.success++;
    });
    await quotaRepo.replaceAll(items);
    if (result.missingPrice) {
      result.warnings.push(`${result.missingPrice} 条定额综合单价为空或为 0，生成报价时会按 0 计。`);
    }
    return result;
  },
};
