import { resourcePriceRepo, resourceRepo } from '../data/repository.js?v=6.9';
import { resourceCodeIdentity, resourceCompositeIdentity, validateResourceCollection } from './resourceService.js?v=6.9';

const SOURCE_TYPE_MAP = new Map([
  ['official', 'official'], ['官方信息价', 'official'], ['信息价', 'official'],
  ['supplier_quote', 'supplier_quote'], ['供应商报价', 'supplier_quote'], ['询价', 'supplier_quote'],
  ['transaction', 'transaction'], ['成交价', 'transaction'], ['历史成交', 'transaction'],
]);
const PRICE_BASIS_MAP = new Map([
  ['ex_factory', 'ex_factory'], ['出厂价', 'ex_factory'],
  ['delivered', 'delivered'], ['到场价', 'delivered'], ['落地价', 'delivered'],
  ['installed_composite', 'installed_composite'], ['安装综合价', 'installed_composite'], ['安装价', 'installed_composite'],
]);
const SOURCE_TYPES = new Set(['official', 'supplier_quote', 'transaction']);
const PRICE_BASES = new Set(['ex_factory', 'delivered', 'installed_composite']);

export const resourceImportService = {
  async parse(file, resourceType) {
    validateResourceType(resourceType);
    if (!file?.arrayBuffer) throw new Error('请选择 Excel 文件');
    const xlsx = globalThis.XLSX;
    if (!xlsx?.read || !xlsx?.utils?.sheet_to_json) throw new Error('Excel 解析组件未加载');
    const workbook = xlsx.read(await file.arrayBuffer(), { type: 'array' });
    for (const name of workbook.SheetNames || []) {
      const matrix = xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
      const rows = resourceRowsFromMatrix(matrix);
      if (rows.length) return rows;
    }
    throw new Error('未识别到材料或设备表头');
  },

  async preview(rows, resourceType) {
    validateResourceType(resourceType);
    const existing = await resourceRepo.all();
    const typedExisting = existing.filter(item => item.resourceType === resourceType);
    const existingByCode = new Map(existing.filter(item => text(item.code)).map(item => [resourceCodeIdentity(item), item]));
    const existingByComposite = new Map(typedExisting.map(item => [resourceCompositeIdentity(item), item]));
    const batchByCode = new Map();
    const batchByComposite = new Map();
    const previewRows = (Array.isArray(rows) ? rows : []).map((raw, index) => {
      const resource = normalizeResourceRow(raw, resourceType);
      const price = normalizePriceRow(raw);
      const errors = validateRow(resource, price);
      const codeIdentity = resourceCodeIdentity(resource);
      const compositeIdentity = resourceCompositeIdentity(resource);
      const identity = codeIdentity || compositeIdentity;
      const usesCode = Boolean(text(resource.code));
      const codeMatch = codeIdentity ? existingByCode.get(codeIdentity) : null;
      const compositeMatch = existingByComposite.get(compositeIdentity);
      const existingItem = codeMatch || (!usesCode ? compositeMatch : null);
      const first = (codeIdentity ? batchByCode.get(codeIdentity) : null) || batchByComposite.get(compositeIdentity);
      const firstIndex = first?.index;
      const conflictingExisting = codeMatch && compositeMatch && codeMatch.id !== compositeMatch.id
        ? compositeMatch
        : (!codeMatch && usesCode && compositeMatch && text(compositeMatch.code) && resourceCodeIdentity(compositeMatch) !== codeIdentity ? compositeMatch : null);
      let action = errors.length ? 'invalid' : conflictingExisting ? 'conflict' : existingItem ? 'update' : 'create';
      if (!errors.length && firstIndex != null) action = 'duplicate';
      if (!errors.length && firstIndex == null && action !== 'conflict') {
        const entry = { index, identity };
        if (usesCode) batchByCode.set(codeIdentity, entry);
        batchByComposite.set(compositeIdentity, entry);
      }
      return {
        index,
        raw,
        identity,
        resource,
        price,
        action,
        existingId: existingItem?.id || '',
        conflictId: conflictingExisting?.id || '',
        duplicateOf: firstIndex ?? null,
        duplicateIdentity: first?.identity || '',
        errors,
      };
    });
    return {
      resourceType,
      rows: previewRows,
      counts: {
        total: previewRows.length,
        valid: previewRows.filter(row => !row.errors.length && row.action !== 'conflict').length,
        invalid: previewRows.filter(row => row.action === 'invalid').length,
        create: previewRows.filter(row => row.action === 'create').length,
        update: previewRows.filter(row => row.action === 'update').length,
        duplicate: previewRows.filter(row => row.action === 'duplicate').length,
        conflict: previewRows.filter(row => row.action === 'conflict').length,
        withPrice: previewRows.filter(row => row.price).length,
      },
    };
  },

  async commit(preview, { updateExisting = true } = {}) {
    if (!preview || !Array.isArray(preview.rows)) throw new Error('导入预览无效');
    validateResourceType(preview.resourceType);
    const [beforeResources, beforePrices] = await Promise.all([resourceRepo.all(), resourcePriceRepo.all()]);
    const resources = structuredClone(beforeResources);
    const prices = structuredClone(beforePrices);
    const report = {
      resourceType: preview.resourceType,
      counts: { resourcesCreated: 0, resourcesUpdated: 0, resourcesSkipped: 0, pricesCreated: 0, pricesSkipped: 0, errors: 0 },
      rows: [],
    };
    const resolved = new Map();
    const priceKeys = new Set(prices.map(priceIdentity));
    const now = new Date().toISOString();

    for (const row of preview.rows) {
      const invariantErrors = validateRow(row.resource || {}, row.price || null);
      if (row.action === 'invalid' || row.action === 'conflict' || invariantErrors.length) {
        report.counts.errors += 1;
        report.rows.push({ index: row.index, status: 'error', errors: [...new Set([...(row.errors || []), ...(row.action === 'conflict' ? ['编码或规格身份与已有资源冲突'] : []), ...invariantErrors])] });
        continue;
      }
      let resourceId = row.existingId || resolved.get(row.identity) || resolved.get(row.duplicateIdentity) || '';
      let resourceStatus = 'skipped';
      const existingIndex = resourceId ? resources.findIndex(item => item.id === resourceId) : -1;
      if (row.action === 'duplicate') {
        report.counts.resourcesSkipped += 1;
      } else if (existingIndex >= 0) {
        if (updateExisting) {
          resources[existingIndex] = {
            ...mergeImportedResource(resources[existingIndex], row.resource, row.raw),
            id: resourceId,
            preferredPriceId: resources[existingIndex].preferredPriceId || '',
            createdAt: resources[existingIndex].createdAt || now,
            updatedAt: now,
          };
          report.counts.resourcesUpdated += 1;
          resourceStatus = 'updated';
        } else {
          report.counts.resourcesSkipped += 1;
        }
      } else {
        resourceId = createId();
        resources.push({ ...row.resource, id: resourceId, preferredPriceId: '', createdAt: now, updatedAt: now });
        report.counts.resourcesCreated += 1;
        resourceStatus = 'created';
      }
      resolved.set(row.identity, resourceId);

      let priceStatus = 'none';
      if (row.price && resourceId) {
        const price = { ...row.price, resourceId };
        const key = priceIdentity(price);
        if (priceKeys.has(key)) {
          report.counts.pricesSkipped += 1;
          priceStatus = 'skipped';
        } else {
          prices.push({ ...price, id: createId(), createdAt: now });
          priceKeys.add(key);
          report.counts.pricesCreated += 1;
          priceStatus = 'created';
        }
      }
      report.rows.push({ index: row.index, status: resourceStatus, resourceId, priceStatus, errors: [] });
    }

    try {
      validateResourceCollection(resources);
      await resourceRepo.replaceAll(resources);
      await resourcePriceRepo.replaceAll(prices);
    } catch (cause) {
      let rollbackCause = null;
      try {
        await resourceRepo.replaceAll(beforeResources);
        await resourcePriceRepo.replaceAll(beforePrices);
      } catch (error) {
        rollbackCause = error;
      }
      const error = new Error(rollbackCause
        ? '材料设备导入失败，且未能完全回滚，请立即检查本地数据'
        : '材料设备导入失败，已回滚到导入前状态');
      error.code = rollbackCause ? 'RESOURCE_IMPORT_PARTIAL_RECOVERY' : 'RESOURCE_IMPORT_ROLLED_BACK';
      error.cause = cause;
      if (rollbackCause) error.rollbackCause = rollbackCause;
      error.report = buildFailureReport(report, error.code, error.message);
      throw error;
    }
    return report;
  },
};

export function buildFailureReport(report, failureCode, failureMessage = '') {
  const partial = failureCode === 'RESOURCE_IMPORT_PARTIAL_RECOVERY';
  const attemptedCounts = { ...(report.counts || {}) };
  const counts = {
    resourcesCreated: partial ? null : 0,
    resourcesUpdated: partial ? null : 0,
    resourcesSkipped: partial ? null : 0,
    pricesCreated: partial ? null : 0,
    pricesSkipped: partial ? null : 0,
    errors: attemptedCounts.errors || 0,
  };
  return {
    ...report,
    outcome: partial ? 'partial_recovery' : 'rolled_back',
    persistenceState: partial ? 'unknown' : 'not_persisted',
    failureCode,
    failureMessage,
    attemptedCounts,
    counts,
    rows: (report.rows || []).map(row => {
      if (row.status === 'error') return { ...row, attemptedStatus: 'error' };
      return {
        ...row,
        attemptedStatus: row.status,
        attemptedPriceStatus: row.priceStatus,
        status: partial ? 'uncertain' : 'rolled_back',
        priceStatus: partial ? 'uncertain' : 'not_written',
      };
    }),
  };
}

export function resourceRowsFromMatrix(matrix = []) {
  const rows = matrix.map(row => Array.isArray(row) ? row : []);
  const headerIndex = rows.slice(0, 12).findIndex(row => {
    const headers = row.map(normalizeHeader);
    return headers.some(header => ['名称', '材料名称', '设备名称'].includes(header))
      && headers.some(header => ['单位', '计量单位'].includes(header));
  });
  if (headerIndex < 0) return [];
  const headers = dedupeHeaders(rows[headerIndex]);
  return rows.slice(headerIndex + 1)
    .filter(row => row.some(cell => String(cell ?? '').trim()))
    .map(row => headers.reduce((record, header, index) => {
      if (header) record[header] = row[index] ?? '';
      return record;
    }, {}));
}

function normalizeResourceRow(raw, resourceType) {
  const value = (...keys) => firstValue(raw, keys);
  return {
    resourceType,
    code: text(value('编码', '材料编码', '设备编码', 'code')),
    category: text(value('分类', '材料分类', '设备分类', 'category')),
    name: text(value('名称', '材料名称', '设备名称', 'name')),
    specModel: text(value('规格型号', '规格', '型号', 'specModel')),
    unit: text(value('单位', '计量单位', 'unit')),
    brand: text(value('品牌', 'brand')),
    manufacturer: text(value('生产厂家', '制造商', 'manufacturer')),
    standard: text(value('执行标准', '标准', 'standard')),
    processStage: text(value('工艺段', 'processStage')),
    attributes: {},
    tags: splitList(value('标签', 'tags')),
    status: normalizeStatus(value('状态', 'status')),
    note: text(value('备注', '说明', 'note')),
  };
}

function normalizePriceRow(raw) {
  const value = (...keys) => firstValue(raw, keys);
  const rawPrice = value('单价', '不含税单价', '含税单价', '价格', 'unitPrice');
  if (rawPrice === '' || rawPrice == null) return null;
  return {
    sourceType: mapValue(SOURCE_TYPE_MAP, value('价格来源', '来源类型', 'sourceType'), 'official', true),
    priceBasis: mapValue(PRICE_BASIS_MAP, value('价格口径', '口径', 'priceBasis'), 'delivered', true),
    unitPrice: Number(rawPrice),
    currency: 'CNY',
    taxIncluded: booleanValue(value('含税', 'taxIncluded')),
    taxRate: numericValue(value('税率', 'taxRate')),
    region: { province: text(value('省', '省份', 'province')), city: text(value('市', '城市', 'city')), district: text(value('区县', '区', 'district')) },
    priceDate: normalizeDate(value('价格日期', '日期', 'priceDate')),
    validFrom: normalizeDate(value('生效日期', 'validFrom')),
    validTo: normalizeDate(value('失效日期', 'validTo')),
    supplier: text(value('供应商', 'supplier')),
    projectId: '',
    components: {
      base: numericValue(value('基础价', 'base')),
      freight: numericValue(value('运杂费', '运费', 'freight')),
      transportLoss: numericValue(value('运输损耗', 'transportLoss')),
      procurementStorage: numericValue(value('采购保管费', 'procurementStorage')),
      installation: numericValue(value('安装费', 'installation')),
      commissioning: numericValue(value('调试费', 'commissioning')),
      other: numericValue(value('其他费用', 'other')),
    },
    installationScope: text(value('安装范围', 'installationScope')),
    note: text(value('价格备注', 'priceNote')),
  };
}

function validateRow(resource, price) {
  const errors = [];
  if (!resource.name) errors.push('名称不能为空');
  if (!resource.unit) errors.push('单位不能为空');
  if (price) {
    if (!SOURCE_TYPES.has(price.sourceType)) errors.push('价格来源类型无效');
    if (!PRICE_BASES.has(price.priceBasis)) errors.push('价格口径无效');
    if (!(price.unitPrice > 0)) errors.push('单价必须大于 0');
    if (!Number.isFinite(price.taxRate) || price.taxRate < 0 || price.taxRate > 100) errors.push('税率必须在 0 到 100 之间');
    if (!isDate(price.priceDate)) errors.push('价格日期不能为空且必须有效');
    if (!price.region.province && !price.region.city && !price.region.district) errors.push('价格地区至少填写一项');
    if (price.validFrom && !isDate(price.validFrom)) errors.push('生效日期无效');
    if (price.validTo && !isDate(price.validTo)) errors.push('失效日期无效');
    if (price.validFrom && price.validTo && price.validFrom > price.validTo) errors.push('失效日期不能早于生效日期');
    if (price.priceBasis === 'installed_composite' && !price.installationScope) errors.push('安装综合价必须填写安装范围');
  }
  return errors;
}

function priceIdentity(price) {
  return [price.resourceId, price.sourceType, price.priceBasis, price.unitPrice, price.currency || 'CNY', price.taxIncluded ? 1 : 0, price.taxRate || 0,
    price.region?.province, price.region?.city, price.region?.district, price.priceDate, price.supplier, price.installationScope]
    .map(value => String(value ?? '').trim().toLowerCase()).join('|');
}

function mergeImportedResource(existing, incoming, raw) {
  const merged = { ...existing };
  if (!text(existing.code) && text(incoming.code)) merged.code = incoming.code;
  for (const key of ['category', 'name', 'specModel', 'unit', 'brand', 'manufacturer', 'standard', 'processStage', 'note']) {
    if (text(incoming[key])) merged[key] = incoming[key];
  }
  if (incoming.tags.length || hasAnyKey(raw, ['标签', 'tags'])) merged.tags = [...incoming.tags];
  if (hasAnyKey(raw, ['状态', 'status']) && text(firstValue(raw, ['状态', 'status']))) merged.status = incoming.status;
  return merged;
}

function hasAnyKey(row, keys) {
  return keys.some(key => Object.prototype.hasOwnProperty.call(row || {}, key));
}

function firstValue(row, keys) {
  for (const key of keys) if (row?.[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  return '';
}

function normalizeHeader(value) { return String(value ?? '').trim().replace(/[\s\n\r]+/g, ''); }
function dedupeHeaders(row) {
  const counts = new Map();
  return row.map((cell, index) => {
    const header = text(cell) || `未命名列${index + 1}`;
    const count = (counts.get(header) || 0) + 1;
    counts.set(header, count);
    return count === 1 ? header : `${header}_${count}`;
  });
}
function text(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function splitList(value) { return text(value).split(/[,，;；]/).map(item => item.trim()).filter(Boolean); }
function normalizeStatus(value) { return ['inactive', '停用', '禁用'].includes(text(value).toLowerCase()) ? 'inactive' : 'active'; }
function mapValue(map, value, fallback, preserveInvalid = false) {
  const normalized = text(value).toLowerCase();
  if (!normalized) return fallback;
  return map.get(normalized) || (preserveInvalid ? normalized : fallback);
}
function booleanValue(value) { return ['1', 'true', 'yes', '是', '含税'].includes(text(value).toLowerCase()); }
function numericValue(value) { return value === '' || value == null ? 0 : Number(value); }
function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000) {
    const date = new Date(Date.UTC(1899, 11, 30 + value));
    return date.toISOString().slice(0, 10);
  }
  return text(value).replace(/[./]/g, '-');
}
function isDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}
function validateResourceType(value) { if (!['material', 'equipment'].includes(value)) throw new Error('资源类型必须为 material 或 equipment'); }
function createId() { return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`; }
