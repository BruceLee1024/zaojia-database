// 定额库服务
import { quotaRepo, boqRepo, boqLibraryRepo } from '../data/repository.js?v=6.2';
import { parseExcel, detectRowKind, rowToQuotaItem } from '../data/excel.js?v=6.2';
import { uid } from '../utils/dom.js?v=6.2';
import { hasMissingPrice } from '../utils/costing.js?v=6.2';
import { normalizeQuotaBreakdown } from '../utils/quotaBreakdown.js?v=6.2';

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
    const normalized = {
      ...data,
      ...('breakdown' in data ? { breakdown: normalizeQuotaBreakdown(data.breakdown) } : {}),
    };
    if (data.id) {
      return await quotaRepo.update(data.id, { ...normalized, updatedAt: new Date().toISOString() });
    }
    const obj = { ...normalized, breakdown: normalizeQuotaBreakdown(normalized.breakdown), id: uid(), updatedAt: new Date().toISOString() };
    await quotaRepo.upsert(obj);
    return obj;
  },

  /** 删除前先检查引用。强制删除会保留项目工作价，但把引用标记为已失效。 */
  async usage(id) {
    const [projectLines, libraryItems] = await Promise.all([boqRepo.all(), boqLibraryRepo.all()]);
    const lines = projectLines.filter(line => line.quotaItemId === id);
    const libraries = libraryItems.filter(item => (item.quotaItemIds || []).includes(id));
    return {
      projectLineCount: lines.length,
      projectIds: [...new Set(lines.map(line => line.projectId).filter(Boolean))],
      libraryItemCount: libraries.length,
      libraryItemIds: libraries.map(item => item.id),
      total: lines.length + libraries.length,
    };
  },

  async remove(id, { force = false } = {}) {
    const usage = await this.usage(id);
    if (usage.total && !force) {
      const err = new Error('该定额仍被项目清单或清单库引用，请先替换关联定额，或确认强制删除。');
      err.code = 'QUOTA_IN_USE';
      err.usage = usage;
      throw err;
    }
    if (force && usage.total) {
      const [lines, libraryItems] = await Promise.all([boqRepo.all(), boqLibraryRepo.all()]);
      await Promise.all([
        boqRepo.replaceAll(lines.map(line => line.quotaItemId === id ? {
          ...line,
          quotaReferenceStatus: 'missing',
          quotaReferenceNote: '关联定额已删除，请重新匹配或确认保留当前项目单价。',
        } : line)),
        boqLibraryRepo.replaceAll(libraryItems.map(item => (item.quotaItemIds || []).includes(id) ? {
          ...item,
          quotaItemIds: item.quotaItemIds.filter(quotaId => quotaId !== id),
          updatedAt: new Date().toISOString(),
        } : item)),
      ]);
    }
    await quotaRepo.remove(id);
    return usage;
  },

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
        breakdown: normalizeQuotaBreakdown(exist?.breakdown),
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
