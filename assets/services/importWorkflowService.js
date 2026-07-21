import { buildImportColumnMapping } from './importMappingService.js?v=6.3';
import { getImportSchema, normalizeImportValue } from './importSchemaService.js?v=6.3';
import { boqService } from './boqService.js?v=6.3';
import { boqLibraryService } from './boqLibraryService.js?v=6.3';
import { quotaService } from './quotaService.js?v=6.3';
import { resourceImportService } from './resourceImportService.js?v=6.3';
import { dataEngineService } from './dataEngineService.js?v=6.3';
import { importBoqQuotaBundle, normalizeBundleLayer } from './boqQuotaBundleImportService.js?v=6.3';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.3';
import { categoryGuess } from '../utils/stats.js?v=6.3';

export function analyzeImport(regions = [], {
  targetType = 'project_boq', mappings = {}, fixedValues = {}, amountRule = 'calculated', selectedRegionIds = null,
} = {}) {
  const schema = getImportSchema(targetType);
  const selected = new Set(selectedRegionIds || regions.map(region => region.id));
  const analyzedRegions = [];
  const outputRows = [];
  const issues = [];
  const skippedRows = [];

  regions.filter(region => selected.has(region.id)).forEach(region => {
    const automatic = buildImportColumnMapping(region.columns, region.rows, targetType);
    const configured = mappings[region.signature] || mappings[region.id] || {};
    const mapping = { ...automatic.mapping, ...configured };
    const regionFixed = fixedValues[region.signature] || fixedValues[region.id] || {};
    const fieldState = Object.fromEntries(schema.fields.map(field => [field.key, {
      ...automatic.fields[field.key],
      source: mapping[field.key] || '',
      sourceType: regionFixed[field.key] !== undefined ? 'fixed' : mapping[field.key] ? 'column' : 'none',
      fixedValue: regionFixed[field.key] ?? '',
    }]));
    const inheritedContext = {};
    const orderedRows = [...region.rows, ...region.skippedRows].sort((a, b) => a.sourceRow - b.sourceRow);
    orderedRows.forEach(sourceRow => {
      schema.fields.filter(field => field.inheritContext).forEach(field => {
        const source = fieldState[field.key]?.source;
        const raw = source ? sourceRow.values[source] : '';
        if (raw !== '' && raw !== null && raw !== undefined) inheritedContext[field.key] = raw;
      });
      if (sourceRow.kind !== 'detail') return;
      const values = {};
      schema.fields.forEach(field => {
        const state = fieldState[field.key];
        let raw = state.sourceType === 'fixed' ? state.fixedValue : state.source ? sourceRow.values[state.source] : '';
        if (field.inheritContext && (raw === '' || raw === null || raw === undefined)) raw = inheritedContext[field.key] ?? '';
        values[field.key] = normalizeImportValue(raw, field.kind);
      });
      const normalized = normalizeTargetRow(values, targetType, amountRule);
      const rowIssues = validateTargetRow(normalized, schema, sourceRow);
      const record = {
        id: `${region.id}:R${sourceRow.sourceRowNumber}`,
        targetType,
        regionId: region.id,
        sheetName: region.sheetName,
        sourceRow: sourceRow.sourceRow,
        sourceRowNumber: sourceRow.sourceRowNumber,
        source: sourceRow,
        data: normalized,
        issues: rowIssues,
        importable: !rowIssues.some(issue => issue.severity === 'error'),
      };
      outputRows.push(record);
      issues.push(...rowIssues.map(issue => ({ ...issue, rowId: record.id, sheetName: region.sheetName, sourceRowNumber: sourceRow.sourceRowNumber })));
    });
    skippedRows.push(...region.skippedRows.map(row => ({ ...row, regionId: region.id, sheetName: region.sheetName })));
    analyzedRegions.push({ ...region, mapping, fieldState });
  });
  return {
    targetType,
    schema,
    amountRule,
    regions: analyzedRegions,
    rows: outputRows,
    skippedRows,
    issues,
    counts: {
      regions: analyzedRegions.length,
      total: outputRows.length,
      valid: outputRows.filter(row => row.importable).length,
      invalid: outputRows.filter(row => !row.importable).length,
      skipped: skippedRows.length,
      warnings: issues.filter(issue => issue.severity === 'warning').length,
      errors: issues.filter(issue => issue.severity === 'error').length,
    },
  };
}

export async function commitImport(preview, options = {}) {
  if (!preview?.targetType || !Array.isArray(preview.rows)) throw new Error('导入预览无效');
  const validRows = preview.rows.filter(row => row.importable).map(row => ({ ...row.data, sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber }));
  if (!validRows.length) throw new Error('没有可导入的有效数据');
  const sourceName = String(options.sourceName || '表格导入');
  let domainResult;
  const warnings = [];
  if (preview.targetType === 'boq_quota_bundle') {
    domainResult = await importBoqQuotaBundle(validRows, { sourceName, updateQuotaPrices: options.updateExisting === true });
  } else if (preview.targetType === 'project_boq') {
    if (!options.projectId) throw new Error('请选择导入项目');
    domainResult = await boqService.importLines(options.projectId, validRows.map(row => ({ ...row, projectId: options.projectId })), { mode: options.mode === 'replace' ? 'replace' : 'append', amountRule: preview.amountRule });
    try {
      await dataEngineService.ingestBOQ(options.projectId, { sourceType: 'unified_table_import', sourceId: sourceName });
    } catch (error) {
      warnings.push(`清单已写入，但数据沉淀索引更新失败：${error.message || '未知错误'}`);
    }
  } else if (preview.targetType === 'boq_library') {
    domainResult = await boqLibraryService.importRows(validRows);
  } else if (preview.targetType === 'quota') {
    domainResult = await quotaService.importRows(validRows);
  } else if (preview.targetType === 'material' || preview.targetType === 'equipment') {
    const resourcePreview = await resourceImportService.preview(validRows.map(resourceRowForDomain), preview.targetType);
    domainResult = await resourceImportService.commit(resourcePreview, { updateExisting: options.updateExisting !== false });
  } else {
    throw new Error('不支持的导入目标');
  }
  return {
    targetType: preview.targetType,
    sourceName,
    outcome: warnings.length ? 'success_with_warnings' : 'success',
    warnings,
    counts: { ...preview.counts, ...domainCounts(domainResult, preview.targetType, validRows.length) },
    domainResult,
    rows: mergeCommitRows(preview.rows, domainResult, preview.targetType),
  };
}

function domainCounts(result = {}, targetType, attempted) {
  if (targetType === 'material' || targetType === 'equipment') {
    const committed = (result.rows || []).filter(row => ['created', 'updated'].includes(row.status) || row.priceStatus === 'created').length;
    return {
    committed,
    added: Number(result.counts?.resourcesCreated || 0), updated: Number(result.counts?.resourcesUpdated || 0),
    duplicate: Number(result.counts?.resourcesSkipped || 0), conflict: Number(result.counts?.errors || 0), attempted,
    notWritten: Math.max(0, attempted - committed),
    };
  }
  const committed = Number(result.success ?? attempted);
  return {
    committed, added: Number(result.added || 0), updated: Number(result.updated || 0),
    duplicate: Number(result.skipped || 0), conflict: Number(result.failed || 0), attempted,
    notWritten: Math.max(0, attempted - committed),
  };
}

export function mergeCommitRows(previewRows = [], domainResult = {}, targetType = '') {
  let domainIndex = 0;
  const resourceRows = new Map((domainResult.rows || []).map(row => [Number(row.index), row]));
  return previewRows.map(row => {
    if (!row.importable) return { id: row.id, sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, status: 'invalid', issues: row.issues };
    if (targetType !== 'material' && targetType !== 'equipment') {
      return { id: row.id, sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, status: 'committed', issues: row.issues };
    }
    const result = resourceRows.get(domainIndex++);
    return {
      id: row.id,
      sheetName: row.sheetName,
      sourceRowNumber: row.sourceRowNumber,
      status: result?.status || 'uncertain',
      priceStatus: result?.priceStatus || 'none',
      issues: [...(row.issues || []), ...(result?.errors || []).map(message => ({ severity: 'error', message }))],
    };
  });
}

function normalizeTargetRow(values, targetType, amountRule) {
  if (targetType === 'boq_quota_bundle') {
    return {
      ...values, layer: values.layer || '', rowKind: normalizeBundleLayer(values.layer), qty: Number(values.qty || 0),
      unitPrice: Number(values.unitPrice || 0), amount: Number(values.amount || 0),
      unitPriceProvided: values.unitPrice !== '' && values.unitPrice !== null && values.unitPrice !== undefined,
    };
  }
  if (targetType === 'project_boq') {
    const split = splitNameFeature(values.name, values.feature);
    const qty = Number(values.qty || 0);
    const sourcePrice = Number(values.unitPrice || 0);
    const sourceAmount = Number(values.amount || 0);
    const unitPrice = amountRule === 'deriveUnitPrice' && !sourcePrice && qty > 0 && sourceAmount > 0 ? sourceAmount / qty : sourcePrice;
    return {
      code: values.code || '', name: split.name, feature: split.feature, unit: values.unit || '', qty, factor: 1, unitPrice,
      amount: amountRule === 'sourceAmount' && sourceAmount ? sourceAmount : calculateAmount(qty, unitPrice, 1),
      priceMissing: hasMissingPrice(unitPrice), process: values.process || '', structureGroup: values.costCategory || categoryGuess(split.name),
    };
  }
  if (targetType === 'boq_library') {
    const split = splitNameFeature(values.name, values.feature);
    return { ...values, name: split.name, feature: split.feature, defaultQty: Number(values.defaultQty || 0) };
  }
  if (targetType === 'quota') {
    return { ...values, category: categoryGuess(values.name), priceTotal: Number(values.priceTotal || 0), priceMissing: hasMissingPrice(values.priceTotal) };
  }
  return { ...values, resourceType: targetType };
}

function validateTargetRow(row, schema, sourceRow) {
  const issues = [];
  schema.fields.filter(field => field.required).forEach(field => {
    if (row[field.key] === '' || row[field.key] === null || row[field.key] === undefined || ((field.kind === 'number' || field.kind === 'money') && !Number.isFinite(Number(row[field.key])))) {
      issues.push({ code: `missing_${field.key}`, severity: 'error', message: `缺少必填字段「${field.label}」` });
    }
  });
  if (schema.key === 'project_boq' && !(row.qty > 0)) issues.push({ code: 'invalid_qty', severity: 'error', message: '工程量必须大于 0' });
  if (schema.key === 'project_boq' && row.priceMissing) issues.push({ code: 'missing_price', severity: 'warning', message: '综合单价为空或 0' });
  if (schema.key === 'boq_quota_bundle' && row.rowKind === 'structure') issues.push({ code: 'unknown_layer', severity: 'error', message: '层级必须是“清单”或“定额”' });
  if (sourceRow.kind !== 'detail') issues.push({ code: 'not_detail', severity: 'error', message: '该行不是有效明细' });
  return issues;
}

function splitNameFeature(name, feature) {
  const nameText = String(name || '').replace(/\r\n?/g, '\n').trim();
  const featureText = String(feature || '').replace(/\r\n?/g, '\n').trim();
  const lines = nameText.split('\n').map(value => value.trim()).filter(Boolean);
  return { name: lines[0] || '', feature: featureText || lines.slice(1).join('\n') };
}

function resourceRowForDomain(row) {
  return {
    编码: row.code, 分类: row.category, 名称: row.name, 规格型号: row.specModel, 单位: row.unit, 品牌: row.brand, 生产厂家: row.manufacturer,
    单价: row.unitPrice || '', 价格来源: row.sourceType, 价格口径: row.priceBasis, 含税: row.taxIncluded ? '是' : '否', 税率: Number(row.taxRate || 0) * 100,
    省: row.province, 市: row.city, 区县: row.district, 价格日期: row.priceDate, 供应商: row.supplier, 备注: row.note,
  };
}
