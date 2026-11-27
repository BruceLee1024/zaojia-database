import { buildImportColumnMapping } from './importMappingService.js?v=6.15&build=20261127r1';
import { getImportSchema, normalizeImportNumber, normalizeImportValue } from './importSchemaService.js?v=6.15&build=20261127r1';
import { boqService } from './boqService.js?v=6.15';
import { assertProjectEditableById } from './projectLockService.js?v=6.15';
import { boqLibraryService } from './boqLibraryService.js?v=6.15&build=20261127r1';
import { quotaService } from './quotaService.js?v=6.15&build=20261117c';
import { resourceImportService } from './resourceImportService.js?v=6.15&build=20261127r1';
import { dataEngineService } from './dataEngineService.js?v=6.15';
import { groupBundleRows, importBoqQuotaBundle, normalizeBundleLayer } from './boqQuotaBundleImportService.js?v=6.15&build=20261127r1';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.15';
import { categoryGuess } from '../utils/stats.js?v=6.15';

export function analyzeImport(regions = [], {
  targetType = 'project_boq', mappings = {}, fixedValues = {}, amountRule = 'calculated', selectedRegionIds = null,
} = {}) {
  const schema = getImportSchema(targetType);
  const resourceImport = targetType === 'material' || targetType === 'equipment';
  const bundleImport = targetType === 'boq_quota_bundle';
  const selected = new Set(selectedRegionIds || regions.map(region => region.id));
  const analyzedRegions = [];
  const outputRows = [];
  const skippedRows = [];
  const hierarchyRows = [];

  regions.filter(region => selected.has(region.id)).forEach(region => {
    const regionKind = detectProjectBoqRegionKind(region, targetType);
    const requiredFields = schema.fields.filter(field => isImportFieldRequired(field, targetType, region));
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
      const bundleDetail = bundleImport && fieldState.layer.sourceType === 'column'
        && ['section', 'repeated_header', 'invalid'].includes(sourceRow.kind)
        && normalizeBundleLayer(readMappedValue(sourceRow, fieldState.layer)) !== 'structure';
      if (sourceRow.kind !== 'detail' && !bundleDetail) skippedRows.push({ ...sourceRow, regionId: region.id, sheetName: region.sheetName });
      if (sourceRow.kind === 'section' && !bundleDetail) {
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
      if (sourceRow.kind !== 'detail' && !bundleDetail) return;
      const values = {};
      const provided = {};
      schema.fields.forEach(field => {
        const state = fieldState[field.key];
        if (resourceImport && state.sourceType === 'none') return;
        let raw = state.sourceType === 'fixed' ? state.fixedValue : state.source ? sourceRow.values[state.source] : '';
        if (field.inheritContext && (raw === '' || raw === null || raw === undefined)) raw = inheritedContext[field.key] ?? '';
        provided[field.key] = resourceImport && field.key === 'unitPrice'
          ? hasResourceImportPrice(raw)
          : raw !== '' && raw !== null && raw !== undefined;
        const input = resourceImport && field.key === 'taxRate' ? String(raw ?? '') : raw;
        values[field.key] = targetType === 'project_boq' && field.key === 'amount'
          ? normalizeImportNumber(input, { fallback: null })
          : normalizeImportValue(input, field.kind);
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
      const rowIssues = validateTargetRow(normalized, requiredFields, { targetType, regionKind });
      const record = {
        id: `${region.id}:R${sourceRow.sourceRowNumber}`,
        targetType,
        regionId: region.id,
        sheetName: region.sheetName,
        sourceRow: sourceRow.sourceRow,
        sourceRowNumber: sourceRow.sourceRowNumber,
        sourceRowNumbers: [sourceRow.sourceRowNumber, ...(sourceRow.continuationRows || [])],
        source: sourceRow,
        data: normalized,
        issues: rowIssues,
        importable: !rowIssues.some(issue => issue.severity === 'error'),
      };
      outputRows.push(record);
    });
    analyzedRegions.push({ ...region, mapping, fieldState, regionKind });
  });
  if (bundleImport) {
    const { orphans } = groupBundleRows(bundleDomainRows(outputRows));
    const orphanIds = new Set(orphans.map(row => row.id));
    for (const row of outputRows) {
      if (!orphanIds.has(row.id)) continue;
      row.issues.push({ code: 'missing_bundle_parent', severity: 'error', message: '本数据区上方没有可关联的有效清单' });
      row.importable = false;
    }
  }
  const duplicateCount = blockDuplicateImportRows(outputRows, targetType);
  const issues = collectRowIssues(outputRows);
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
      skipped: skippedRows.length,
      ...summarizeRows(outputRows, issues),
      duplicates: duplicateCount,
    },
  };
}

export async function reviewResourceImport(preview) {
  const eligibleRows = preview.rows.filter(row => row.importable);
  if (!eligibleRows.length) return preview;
  const check = await resourceImportService.preview(eligibleRows.map(row => resourceRowForDomain(row.data)), preview.targetType);
  let index = 0;
  const rows = preview.rows.map(row => {
    if (!row.importable) return row;
    const resourceRow = check.rows[index++];
    const errors = resourceRow.errors.map(message => ({ code: 'resource_identity', severity: 'error', message }));
    const priceIssues = errors.length ? [] : resourceRow.priceReview.map(message => ({ code: 'resource_price_pending', severity: 'warning', message }));
    return {
      ...row,
      importable: !errors.length,
      resourceAction: resourceRow.action,
      issues: [...row.issues, ...errors, ...priceIssues],
    };
  });
  const issues = collectRowIssues(rows);
  return {
    ...preview,
    rows,
    issues,
    counts: {
      ...preview.counts,
      ...summarizeRows(rows, issues),
      pending: rows.filter(row => row.issues.some(issue => issue.code === 'resource_price_pending')).length,
    },
  };
}

function collectRowIssues(rows) {
  return rows.flatMap(row => row.issues.map(issue => ({
    ...issue, rowId: row.id, sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, sourceRowNumbers: row.sourceRowNumbers,
  })));
}

function summarizeRows(rows, issues) {
  const valid = rows.filter(row => row.importable).length;
  const warnings = issues.filter(issue => issue.severity === 'warning').length;
  return { total: rows.length, valid, invalid: rows.length - valid, warnings, errors: issues.length - warnings };
}

export async function commitImport(preview, options = {}) {
  if (!preview?.targetType || !Array.isArray(preview.rows)) throw new Error('导入预览无效');
  const validRows = preview.rows.filter(row => row.importable).map(row => ({
    ...row.data, sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, sourceRowNumbers: row.sourceRowNumbers,
  }));
  if (!validRows.length) throw new Error('没有可导入的有效数据');
  const sourceName = String(options.sourceName || '表格导入');
  let domainResult;
  const warnings = [];
  if (preview.targetType === 'boq_quota_bundle') {
    domainResult = await importBoqQuotaBundle(bundleDomainRows(preview.rows), { sourceName, updateQuotaPrices: options.updateExisting === true });
  } else if (preview.targetType === 'project_boq') {
    if (!options.projectId) throw new Error('请选择导入项目');
    await assertProjectEditableById(options.projectId);
    domainResult = await boqService.importLines(options.projectId, validRows.map(row => ({ ...row, projectId: options.projectId })), { mode: options.mode === 'replace' ? 'replace' : 'append', amountRule: preview.amountRule });
    try {
      await dataEngineService.ingestBOQ(options.projectId, { sourceType: 'unified_table_import', sourceId: sourceName });
    } catch (error) {
      warnings.push(`清单已写入，但数据沉淀索引更新失败：${error.message || '未知错误'}`);
    }
  } else if (preview.targetType === 'boq_library') {
    domainResult = await boqLibraryService.importRows(validRows, { updateExisting: options.updateExisting !== false });
  } else if (preview.targetType === 'quota') {
    domainResult = await quotaService.importRows(validRows, { updateExisting: options.updateExisting !== false });
  } else if (preview.targetType === 'material' || preview.targetType === 'equipment') {
    const resourcePreview = await resourceImportService.preview(validRows.map(resourceRowForDomain), preview.targetType);
    domainResult = await resourceImportService.commit(resourcePreview, { updateExisting: options.updateExisting !== false });
    if (domainResult.counts?.pricesPending) warnings.push(`${domainResult.counts.pricesPending} 条价格未作为有效价格写入，已标记为待确认`);
  } else {
    throw new Error('不支持的导入目标');
  }
  for (const warning of domainResult.warnings || []) warnings.push(warning);
  const writeCounts = domainCounts(domainResult, preview.targetType, validRows.length);
  const counts = {
    ...preview.counts,
    ...writeCounts,
    total: preview.rows.length,
    invalid: preview.rows.length - validRows.length,
    attempted: validRows.length,
    notWritten: preview.rows.length - writeCounts.committed,
    conflict: writeCounts.conflict + preview.rows.filter(row => row.resourceAction === 'conflict').length,
  };
  const needsReview = warnings.length > 0 || counts.notWritten > 0 || counts.pending > 0;
  return {
    targetType: preview.targetType,
    sourceName,
    outcome: needsReview ? 'success_with_warnings' : 'success',
    warnings,
    counts,
    domainResult,
    rows: mergeCommitRows(preview.rows, domainResult, preview.targetType),
  };
}

function blockDuplicateImportRows(rows, targetType) {
  const firstByIdentity = new Map();
  let duplicates = 0;
  rows.forEach(row => {
    if (!row.importable) return;
    const identity = importIdentity(row.data, targetType);
    if (!identity) return;
    const first = firstByIdentity.get(identity);
    if (!first) {
      firstByIdentity.set(identity, row);
      return;
    }
    const issue = {
      code: 'duplicate_in_file', severity: 'error',
      message: `与 ${first.sheetName} 第 ${first.sourceRowNumber} 行身份重复，请保留其中一行后再导入`,
      rowId: row.id, sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, sourceRowNumbers: row.sourceRowNumbers,
    };
    row.issues.push(issue);
    row.importable = false;
    duplicates += 1;
  });
  return duplicates;
}

function importIdentity(data = {}, targetType = '') {
  const part = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (targetType === 'quota') return ['quota', part(data.specialty), part(data.name), part(data.feature)].join('|');
  if (targetType === 'boq_library') {
    const code = part(data.code);
    return code ? `boq-library|code|${code}` : ['boq-library', part(data.name), part(data.feature), part(data.unit)].join('|');
  }
  return '';
}

function bundleDomainRows(rows) {
  return rows.map(row => ({
    ...row.data, id: row.id, regionId: row.regionId, sheetName: row.sheetName,
    sourceRowNumber: row.sourceRowNumber, importable: row.importable,
  }));
}

function domainCounts(result = {}, targetType, attempted) {
  if (targetType === 'material' || targetType === 'equipment') {
    const committed = (result.rows || []).filter(row => ['created', 'updated'].includes(row.status) || row.priceStatus === 'created').length;
    return {
      committed,
      added: Number(result.counts?.resourcesCreated || 0),
      updated: Number(result.counts?.resourcesUpdated || 0),
      duplicate: Number(result.counts?.resourcesSkipped || 0),
      pending: Number(result.counts?.pricesPending || 0),
      conflict: Number(result.counts?.errors || 0),
    };
  }
  const committed = Number(result.success ?? attempted);
  return {
    committed,
    added: targetType === 'project_boq' ? committed : Number(result.added || 0),
    updated: Number(result.updated || 0),
    duplicate: Number(result.skipped || 0),
    pending: Number(result.missingPrice || 0),
    conflict: Number(result.failed || 0),
  };
}

export function mergeCommitRows(previewRows = [], domainResult = {}, targetType = '') {
  let domainIndex = 0;
  const domainRows = new Map((domainResult.rows || []).map(row => [Number(row.index), row]));
  return previewRows.map(row => {
    const source = { id: row.id, sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, sourceRowNumbers: row.sourceRowNumbers, name: row.data?.name || '' };
    if (!row.importable) return { ...source, status: 'invalid', issues: row.issues };
    const result = domainRows.get(domainIndex++);
    if (targetType !== 'material' && targetType !== 'equipment') {
      return { ...source, status: result?.status || 'committed', issues: [...row.issues, ...(result?.issues || [])] };
    }
    const issues = (row.issues || []).filter(issue => issue.code !== 'resource_price_pending');
    const severity = result?.priceStatus === 'pending' ? 'warning' : 'error';
    return {
      ...source,
      status: result?.status || 'uncertain',
      priceStatus: result?.priceStatus || 'none',
      issues: [...issues, ...(result?.errors || []).map(message => ({ severity, message }))],
    };
  });
}

function normalizeTargetRow(values, targetType, amountRule, context = {}) {
  if (targetType === 'boq_quota_bundle') {
    return {
      ...values, layer: values.layer || '', rowKind: normalizeBundleLayer(values.layer), qty: Number(values.qty || 0),
      unitPrice: Number(values.unitPrice || 0), amount: Number(values.amount || 0),
      unitPriceProvided: Boolean(context.provided?.unitPrice),
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
        chargeType: classifyOtherCharge(split.name), sourceAmountProvided: values.amount !== null,
        process: values.process || '', structureGroup: 'other', sourceSectionName: '其他项目费',
      };
    }
    const qty = Number(values.qty || 0);
    const sourcePrice = Number(values.unitPrice || 0);
    const sourceAmount = values.amount;
    const unitPrice = amountRule === 'deriveUnitPrice' && !sourcePrice && qty > 0 && sourceAmount > 0 ? sourceAmount / qty : sourcePrice;
    return {
      code: values.code || '', name: split.name, feature: split.feature, unit: values.unit || '', qty, factor: 1, unitPrice,
      amount: amountRule === 'sourceAmount' && sourceAmount !== null ? sourceAmount : calculateAmount(qty, unitPrice, 1),
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
  return { ...values, resourceType: targetType, unitPriceProvided: Boolean(context.provided?.unitPrice) };
}

function validateTargetRow(row, requiredFields, { targetType, regionKind }) {
  const issues = [];
  requiredFields.forEach(field => {
    if (row[field.key] === '' || row[field.key] === null || row[field.key] === undefined || ((field.kind === 'number' || field.kind === 'money') && !Number.isFinite(Number(row[field.key])))) {
      issues.push({ code: `missing_${field.key}`, severity: 'error', message: `缺少必填字段「${field.label}」` });
    }
  });
  if (regionKind === 'other_charge_summary' && !row.sourceAmountProvided) issues.push({ code: 'missing_amount', severity: 'error', message: '汇总费用缺少金额' });
  if (targetType === 'project_boq' && regionKind !== 'other_charge_summary' && !(row.qty > 0)) issues.push({ code: 'invalid_qty', severity: 'error', message: '工程量必须大于 0' });
  if (targetType === 'project_boq' && regionKind !== 'other_charge_summary' && row.priceMissing) issues.push({ code: 'missing_price', severity: 'warning', message: '综合单价为空或 0' });
  if (targetType === 'boq_quota_bundle' && row.rowKind === 'structure') issues.push({ code: 'unknown_layer', severity: 'error', message: '层级必须是“清单”或“定额”' });
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
  const { unitPriceProvided, ...fields } = row;
  const hasPrice = unitPriceProvided ?? hasResourceImportPrice(fields.unitPrice);
  return {
    ...fields,
    unitPrice: hasPrice ? fields.unitPrice : '',
    taxRate: Number(fields.taxRate || 0) * 100,
  };
}

function hasResourceImportPrice(value) {
  return value != null && !/^(?:-{1,2}|—|无|n\/?a)?$/i.test(String(value).trim());
}
