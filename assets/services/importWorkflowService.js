import { buildImportColumnMapping } from './importMappingService.js?v=6.15&build=20260814';
import { getImportSchema, normalizeImportValue } from './importSchemaService.js?v=6.15&build=20260814';
import { boqService } from './boqService.js?v=6.15';
import { boqLibraryService } from './boqLibraryService.js?v=6.15';
import { quotaService } from './quotaService.js?v=6.15';
import { resourceImportService } from './resourceImportService.js?v=6.15';
import { dataEngineService } from './dataEngineService.js?v=6.15';
import { importBoqQuotaBundle, normalizeBundleLayer } from './boqQuotaBundleImportService.js?v=6.15';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.15';
import { categoryGuess } from '../utils/stats.js?v=6.15';

export function analyzeImport(regions = [], {
  targetType = 'project_boq', mappings = {}, fixedValues = {}, amountRule = 'calculated', selectedRegionIds = null,
} = {}) {
  const schema = getImportSchema(targetType);
  const selected = new Set(selectedRegionIds || regions.map(region => region.id));
  const analyzedRegions = [];
  const outputRows = [];
  const issues = [];
  const skippedRows = [];
  const hierarchyRows = [];

  regions.filter(region => selected.has(region.id)).forEach(region => {
    const regionKind = detectProjectBoqRegionKind(region, targetType);
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
    const hierarchyContext = {
      unitName: detectSourceUnitName(region),
      sectionCode: '',
      sectionName: '',
      sectionRowNumber: null,
    };
    const orderedRows = [...region.rows, ...region.skippedRows].sort((a, b) => a.sourceRow - b.sourceRow);
    orderedRows.forEach(sourceRow => {
      schema.fields.filter(field => field.inheritContext).forEach(field => {
        const source = fieldState[field.key]?.source;
        const raw = source ? sourceRow.values[source] : '';
        if (raw !== '' && raw !== null && raw !== undefined) inheritedContext[field.key] = raw;
      });
      if (sourceRow.kind === 'section') {
        const section = readSourceSection(sourceRow, fieldState);
        if (section.name) {
          hierarchyContext.sectionCode = section.code;
          hierarchyContext.sectionName = section.name;
          hierarchyContext.sectionRowNumber = sourceRow.sourceRowNumber;
          hierarchyRows.push({
            kind: 'section', regionId: region.id, sheetName: region.sheetName,
            sourceRowNumber: sourceRow.sourceRowNumber, unitName: hierarchyContext.unitName, ...section,
          });
        }
        return;
      }
      if (sourceRow.kind === 'subtotal') {
        hierarchyRows.push({
          kind: 'subtotal', regionId: region.id, sheetName: region.sheetName,
          sourceRowNumber: sourceRow.sourceRowNumber, unitName: hierarchyContext.unitName,
          sectionCode: hierarchyContext.sectionCode, sectionName: hierarchyContext.sectionName,
          sourceAmount: readMappedValue(sourceRow, fieldState.amount),
        });
        return;
      }
      if (sourceRow.kind !== 'detail') return;
      const values = {};
      const provided = {};
      schema.fields.forEach(field => {
        const state = fieldState[field.key];
        let raw = state.sourceType === 'fixed' ? state.fixedValue : state.source ? sourceRow.values[state.source] : '';
        if (field.inheritContext && (raw === '' || raw === null || raw === undefined)) raw = inheritedContext[field.key] ?? '';
        provided[field.key] = raw !== '' && raw !== null && raw !== undefined;
        values[field.key] = normalizeImportValue(raw, field.kind);
      });
      const normalized = normalizeTargetRow(values, targetType, amountRule, { regionKind, provided });
      if (targetType === 'project_boq') {
        const sectionCode = hierarchyContext.sectionCode || normalized.sourceSectionCode || '';
        const sectionName = hierarchyContext.sectionName || normalized.sourceSectionName || '';
        Object.assign(normalized, {
          sourceSheetName: region.sheetName || '',
          sourceDocumentTitle: region.title || '',
          sourceUnitName: hierarchyContext.unitName,
          sourceSectionCode: sectionCode,
          sourceSectionName: sectionName,
          sourceSectionPath: [hierarchyContext.unitName, sectionName].filter(Boolean),
          sourceSectionRowNumber: hierarchyContext.sectionRowNumber,
          sourceRowNumber: sourceRow.sourceRowNumber,
        });
      }
      const rowIssues = validateTargetRow(normalized, schema, sourceRow, { targetType, region, regionKind });
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
    analyzedRegions.push({ ...region, mapping, fieldState, regionKind });
  });
  return {
    targetType,
    schema,
    amountRule,
    regions: analyzedRegions,
    rows: outputRows,
    hierarchyRows,
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
    if (domainResult.counts?.pricesPending) warnings.push(`${domainResult.counts.pricesPending} 条价格未作为有效价格写入，已标记为待确认`);
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
    duplicate: Number(result.counts?.resourcesSkipped || 0), pending: Number(result.counts?.pricesPending || 0), conflict: Number(result.counts?.errors || 0), attempted,
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
      issues: [...(row.issues || []), ...(result?.errors || []).map(message => ({ severity: result?.priceStatus === 'pending' ? 'warning' : 'error', message }))],
    };
  });
}

function normalizeTargetRow(values, targetType, amountRule, context = {}) {
  if (targetType === 'boq_quota_bundle') {
    return {
      ...values, layer: values.layer || '', rowKind: normalizeBundleLayer(values.layer), qty: Number(values.qty || 0),
      unitPrice: Number(values.unitPrice || 0), amount: Number(values.amount || 0),
      unitPriceProvided: values.unitPrice !== '' && values.unitPrice !== null && values.unitPrice !== undefined,
    };
  }
  if (targetType === 'project_boq') {
    const split = splitNameFeature(values.name, values.feature);
    if (context.regionKind === 'other_charge_summary') {
      const sourceAmount = Number(values.amount || 0);
      return {
        code: values.code || '', name: split.name, feature: split.feature, unit: '项', qty: 1, factor: 1,
        unitPrice: sourceAmount, amount: sourceAmount, priceMissing: !(sourceAmount > 0),
        lineType: 'other_charge', sourceTableKind: 'other_charge_summary',
        chargeType: classifyOtherCharge(split.name), sourceAmountProvided: Boolean(context.provided?.amount),
        process: values.process || '', structureGroup: 'other', sourceSectionName: '其他项目费',
      };
    }
    const qty = Number(values.qty || 0);
    const sourcePrice = Number(values.unitPrice || 0);
    const sourceAmount = Number(values.amount || 0);
    const unitPrice = amountRule === 'deriveUnitPrice' && !sourcePrice && qty > 0 && sourceAmount > 0 ? sourceAmount / qty : sourcePrice;
    return {
      code: values.code || '', name: split.name, feature: split.feature, unit: values.unit || '', qty, factor: 1, unitPrice,
      amount: amountRule === 'sourceAmount' && sourceAmount ? sourceAmount : calculateAmount(qty, unitPrice, 1),
      laborAmount: Number(values.laborAmount || 0), machineAmount: Number(values.machineAmount || 0),
      provisionalAmount: Number(values.provisionalAmount || 0),
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

function validateTargetRow(row, schema, sourceRow, context = {}) {
  const issues = [];
  schema.fields.filter(field => isImportFieldRequired(field, context.targetType, context.region)).forEach(field => {
    if (row[field.key] === '' || row[field.key] === null || row[field.key] === undefined || ((field.kind === 'number' || field.kind === 'money') && !Number.isFinite(Number(row[field.key])))) {
      issues.push({ code: `missing_${field.key}`, severity: 'error', message: `缺少必填字段「${field.label}」` });
    }
  });
  if (context.regionKind === 'other_charge_summary' && !row.sourceAmountProvided) issues.push({ code: 'missing_amount', severity: 'error', message: '汇总费用缺少金额' });
  if (schema.key === 'project_boq' && context.regionKind !== 'other_charge_summary' && !(row.qty > 0)) issues.push({ code: 'invalid_qty', severity: 'error', message: '工程量必须大于 0' });
  if (schema.key === 'project_boq' && context.regionKind !== 'other_charge_summary' && row.priceMissing) issues.push({ code: 'missing_price', severity: 'warning', message: '综合单价为空或 0' });
  if (schema.key === 'boq_quota_bundle' && row.rowKind === 'structure') issues.push({ code: 'unknown_layer', severity: 'error', message: '层级必须是“清单”或“定额”' });
  if (sourceRow.kind !== 'detail') issues.push({ code: 'not_detail', severity: 'error', message: '该行不是有效明细' });
  return issues;
}

export function detectProjectBoqRegionKind(region = {}, targetType = 'project_boq') {
  if (targetType !== 'project_boq') return 'detail_boq';
  const headerText = [
    region.sheetName, region.title,
    ...(region.columns || []).flatMap(column => [column.displayName, column.leaf, ...(column.path || [])]),
    ...(region.matrix || []).slice(0, Math.max(0, Number(region.dataStart || 0))).flat(),
  ].map(value => String(value || '').replace(/\s+/g, '')).filter(Boolean).join('|');
  if (/(?:其他项目(?:清单|费).*(?:计价)?汇总|暂列金额.*计日工.*总承包服务费)/.test(headerText)) return 'other_charge_summary';
  return 'detail_boq';
}

export function isImportFieldRequired(field = {}, targetType = '', region = {}) {
  if (targetType === 'project_boq' && detectProjectBoqRegionKind(region, targetType) === 'other_charge_summary') {
    return field.key === 'name' || field.key === 'amount';
  }
  return Boolean(field.required);
}

function classifyOtherCharge(name = '') {
  const text = String(name || '');
  if (/暂列金额/.test(text)) return 'provisional_sum';
  if (/专业工程暂估|暂估价/.test(text)) return 'professional_provisional';
  if (/计日工/.test(text)) return 'daywork';
  if (/总承包服务/.test(text)) return 'main_contractor_service';
  return 'other';
}

function splitNameFeature(name, feature) {
  const nameText = String(name || '').replace(/\r\n?/g, '\n').trim();
  const featureText = String(feature || '').replace(/\r\n?/g, '\n').trim();
  const lines = nameText.split('\n').map(value => value.trim()).filter(Boolean);
  return { name: lines[0] || '', feature: featureText || lines.slice(1).join('\n') };
}

function detectSourceUnitName(region = {}) {
  const values = (region.matrix || []).slice(0, Math.max(0, Number(region.dataStart || 0)))
    .flatMap(row => Array.isArray(row) ? row : [])
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
  for (const value of values) {
    const match = value.match(/(?:工程名称|单位工程名称)\s*[:：]\s*(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function readSourceSection(sourceRow, fieldState) {
  const mappedCode = readMappedValue(sourceRow, fieldState.code);
  const mappedName = readMappedValue(sourceRow, fieldState.name);
  const fallback = (sourceRow.raw || []).map(value => String(value ?? '').trim()).filter(Boolean);
  const code = String(mappedCode || (fallback.length > 1 && /^\w[\w.-]*$/.test(fallback[0]) ? fallback[0] : '')).trim();
  const name = String(mappedName || fallback.find(value => value !== code) || '').trim();
  return { code, name };
}

function readMappedValue(sourceRow, field = {}) {
  if (!field?.source) return '';
  return sourceRow.values?.[field.source] ?? '';
}

function resourceRowForDomain(row) {
  return {
    编码: row.code, 分类: row.category, 名称: row.name, 规格型号: row.specModel, 单位: row.unit, 品牌: row.brand, 生产厂家: row.manufacturer,
    单价: row.unitPrice || '', 价格来源: row.sourceType, 价格口径: row.priceBasis, 含税: row.taxIncluded ? '是' : '否', 税率: Number(row.taxRate || 0) * 100,
    省: row.province, 地区: row.province, 市: row.city, 区县: row.district, 价格日期: row.priceDate, 供应商: row.supplier, 备注: row.note,
  };
}
