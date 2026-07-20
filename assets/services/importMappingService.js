// Excel 导入字段映射：表头语义与样本值双重校验，默认只确认高置信字段。
import { getImportSchema } from './importSchemaService.js?v=6.3';

export const IMPORT_FIELD_DEFS = [
  { key: 'name', label: '清单名称', required: true, aliases: ['项目名称', '清单名称', '工程名称', '名称', '项目名称项目特征'], kind: 'text' },
  { key: 'feature', label: '项目特征', aliases: ['项目特征', '特征描述', '清单描述', '描述', '项目名称项目特征'], kind: 'text' },
  { key: 'unit', label: '单位', required: true, aliases: ['计量单位', '单位'], kind: 'unit' },
  { key: 'qty', label: '工程量', required: true, aliases: ['工程数量', '工程量', '数量', '计量数量'], kind: 'number' },
  { key: 'unitPrice', label: '综合单价', aliases: ['综合单价', '单价', '含税单价', '不含税单价', '清单单价'], kind: 'money' },
  { key: 'amount', label: '合价', aliases: ['综合合价', '合价', '金额', '总价', '合计'], kind: 'money' },
  { key: 'process', label: '工艺段', aliases: ['工艺段', '工艺', '区域', '单体', '分部', '分部分项', '专业'], kind: 'text' },
  { key: 'costCategory', label: '成本分类', aliases: ['成本分类', '费用分类', '工程分类', '分类', '类别'], kind: 'text' },
];

const SERIAL_HEADER_RE = /^(序号|编号|编码|项目编码|清单编码|id)$/;

export function normalizeImportHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\r\n\s　]/g, '')
    .replace(/[()（）\[\]［］【】]/g, '')
    .replace(/[\\/_-]/g, '')
    .replace(/(含税|不含税|税前|税后|人民币|元)/g, '');
}

export function buildImportMapping(headers = [], sampleRows = []) {
  const sources = headers
    .map(header => String(header || '').trim())
    .filter(Boolean)
    .map(header => ({ header, normalized: normalizeImportHeader(header), profile: profileColumn(header, sampleRows) }));
  const usedHeaders = new Set();
  const fields = {};
  const mapping = {};

  IMPORT_FIELD_DEFS.forEach(def => {
    const candidates = sources
      .map(source => scoreCandidate(def, source))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const candidate = candidates.find(item => canReuseHeader(def, item.header, usedHeaders)) || null;
    const confidence = candidate ? confidenceFor(candidate.score) : 'none';
    const confirmed = confidence === 'high';
    const source = confirmed ? candidate.header : '';
    if (source && !isSharedNameFeature(def.key, source)) usedHeaders.add(source);
    mapping[def.key] = source;
    fields[def.key] = {
      key: def.key,
      label: def.label,
      required: Boolean(def.required),
      source,
      candidateSource: candidate?.header || '',
      confidence,
      status: source ? 'confirmed' : candidate ? 'needs-review' : 'missing',
      reason: mappingReason(def, candidate, confidence),
    };
  });

  return { mapping, fields };
}

/** 针对层级表头列的统一映射，返回稳定列 ID 而不是可重复的叶子名称。 */
export function buildImportColumnMapping(columns = [], sampleRows = [], targetType = 'project_boq') {
  const schema = getImportSchema(targetType);
  const used = new Set();
  const mapping = {};
  const fields = {};
  schema.fields.forEach(def => {
    const candidates = columns
      .map(column => scoreImportColumn(def, column, sampleRows))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const candidate = candidates.find(item => !used.has(item.column.id)) || null;
    const confidence = candidate ? confidenceFor(candidate.score) : 'none';
    const confirmed = confidence === 'high';
    const source = confirmed ? candidate.column.id : '';
    if (source) used.add(source);
    mapping[def.key] = source;
    fields[def.key] = {
      key: def.key,
      label: def.label,
      required: Boolean(def.required),
      kind: def.kind,
      source,
      candidateSource: candidate?.column.id || '',
      candidateLabel: candidate?.column.displayName || '',
      alternatives: candidates.slice(0, 3).map(item => item.column.id),
      confidence,
      status: source ? 'confirmed' : candidate ? 'needs-review' : 'missing',
      reason: candidate
        ? `${confidence === 'high' ? '已根据' : '请确认'}完整表头路径「${candidate.column.displayName}」`
        : '未找到可识别的来源列',
      confirmed,
      sourceType: source ? 'column' : 'none',
    };
  });
  return { targetType, mapping, fields };
}

export function createHeaderFingerprint(headers = []) {
  const normalizedHeaders = headers.map(normalizeImportHeader).filter(Boolean).sort();
  return { version: 1, headers: normalizedHeaders, columnCount: normalizedHeaders.length };
}

export function matchMappingTemplate(template, headers = []) {
  const mapping = template?.mapping || {};
  const fields = Object.entries(mapping).filter(([, source]) => source);
  const matchedFields = [];
  const missingSources = [];
  const conflictingFields = [];
  fields.forEach(([key, source]) => {
    const actual = findCompatibleHeader(source, headers);
    if (actual) matchedFields.push(key);
    else missingSources.push(source);
  });
  const score = fields.length ? Math.round((matchedFields.length / fields.length) * 100) : 0;
  return {
    templateId: template?.id || '',
    matchedFields,
    missingSources: [...new Set(missingSources)],
    conflictingFields,
    score,
    status: score >= 80 ? 'recommended' : score >= 50 ? 'partial' : 'incompatible',
  };
}

export function applyMappingTemplate(template, headers = [], sampleRows = []) {
  const automatic = buildImportMapping(headers, sampleRows);
  const mapping = { ...automatic.mapping };
  const fields = { ...automatic.fields };
  const sources = template?.mapping || {};
  Object.entries(sources).forEach(([key, savedSource]) => {
    const actual = findCompatibleHeader(savedSource, headers);
    if (!actual) {
      mapping[key] = '';
      fields[key] = {
        ...(fields[key] || {}), key, source: '', candidateSource: '', confidence: 'none',
        status: 'template-missing', reason: `模板来源列“${savedSource}”不存在`,
      };
      return;
    }
    const def = IMPORT_FIELD_DEFS.find(item => item.key === key);
    const compatible = !def || isColumnCompatible(def, actual, sampleRows);
    mapping[key] = compatible ? actual : '';
    fields[key] = {
      ...(fields[key] || {}), key, source: compatible ? actual : '', candidateSource: actual,
      confidence: compatible ? 'template' : 'low',
      status: compatible ? 'template' : 'needs-review',
      reason: compatible ? `已由模板“${template.name}”应用` : `模板列“${actual}”的样本值不符合${def?.label || '字段'}要求，请确认`,
    };
  });
  return { mapping, fields, fixedValues: { ...(template?.fixedValues || {}) }, amountRule: template?.amountRule || 'calculated' };
}

export function resolveImportPricing({ qty = 0, unitPrice = 0, amount = 0, amountRule = 'calculated' } = {}) {
  const numericQty = Number(qty) || 0;
  const sourceUnitPrice = Number(unitPrice) || 0;
  const sourceAmount = Number(amount) || 0;
  const derivedUnitPrice = amountRule === 'deriveUnitPrice' && !sourceUnitPrice && numericQty > 0 && sourceAmount > 0
    ? sourceAmount / numericQty
    : sourceUnitPrice;
  const calculatedAmount = numericQty * derivedUnitPrice;
  return {
    qty: numericQty,
    unitPrice: derivedUnitPrice,
    sourceAmount,
    calculatedAmount,
    amount: amountRule === 'sourceAmount' && sourceAmount > 0 ? sourceAmount : calculatedAmount,
    derivedUnitPrice: Boolean(amountRule === 'deriveUnitPrice' && !sourceUnitPrice && numericQty > 0 && sourceAmount > 0),
  };
}

function findCompatibleHeader(source, headers) {
  const normalizedSource = normalizeImportHeader(source);
  return headers.find(header => {
    const normalizedHeader = normalizeImportHeader(header);
    return normalizedHeader === normalizedSource
      || normalizedHeader.includes(normalizedSource)
      || normalizedSource.includes(normalizedHeader);
  }) || '';
}

function isColumnCompatible(def, header, rows) {
  const profile = profileColumn(header, rows);
  if (def.kind === 'number' || def.kind === 'money') return profile.numericRate >= 0.6 && !SERIAL_HEADER_RE.test(normalizeImportHeader(header));
  if (def.kind === 'unit') return profile.nonEmptyRate >= 0.5 && profile.unitRate >= 0.4;
  return profile.nonEmptyRate >= 0.4;
}

function scoreCandidate(def, source) {
  if ((def.kind === 'number' || def.kind === 'money') && SERIAL_HEADER_RE.test(source.normalized)) return null;
  const headerScore = semanticHeaderScore(def.aliases, source.normalized);
  if (!headerScore) return null;
  const { nonEmptyRate, numericRate, unitRate } = source.profile;
  let score = headerScore;
  if (def.kind === 'number' || def.kind === 'money') {
    if (numericRate < 0.6) return null;
    score += numericRate >= 0.85 ? 12 : 4;
  } else if (def.kind === 'unit') {
    if (nonEmptyRate < 0.5) return null;
    score += unitRate >= 0.6 ? 10 : 2;
  } else if (nonEmptyRate >= 0.6) {
    score += 8;
  }
  return { header: source.header, score, profile: source.profile };
}

function scoreImportColumn(def, column, rows) {
  const leaf = normalizeImportHeader(column.leaf);
  const path = normalizeImportHeader((column.path || []).join(' '));
  let semantic = 0;
  for (const alias of def.aliases || []) {
    const normalized = normalizeImportHeader(alias);
    if (!normalized) continue;
    if (leaf === normalized) semantic = Math.max(semantic, 94);
    else if (path === normalized) semantic = Math.max(semantic, 92);
    else if (leaf.includes(normalized) || normalized.includes(leaf)) semantic = Math.max(semantic, 82);
    else if (path.includes(normalized)) semantic = Math.max(semantic, 76);
  }
  if (!semantic) return null;
  const fullPath = String((column.path || []).join(' '));
  if ((def.positiveContext || []).some(value => normalizeImportHeader(fullPath).includes(normalizeImportHeader(value)))) semantic += 8;
  if ((def.negativeContext || []).some(value => normalizeImportHeader(fullPath).includes(normalizeImportHeader(value)))) semantic -= 25;
  const values = rows.slice(0, 50).map(row => row?.values?.[column.id]).filter(value => value !== '' && value != null);
  if (def.kind === 'number' || def.kind === 'money' || def.kind === 'percent') {
    const numericRate = values.length ? values.filter(isNumericValue).length / values.length : 0;
    if (values.length && numericRate < 0.5) return null;
    semantic += numericRate >= 0.8 ? 8 : 0;
  }
  if (def.kind === 'unit' && values.length) {
    const unitRate = values.filter(value => /^(?:m|m2|m3|㎡|m²|m³|t|kg|套|台|项|根|座|块|个|组|工日)$/i.test(String(value).trim())).length / values.length;
    if (unitRate >= 0.5) semantic += 8;
  }
  return { column, score: semantic };
}

function semanticHeaderScore(aliases, normalizedHeader) {
  let best = 0;
  aliases.forEach(alias => {
    const normalizedAlias = normalizeImportHeader(alias);
    if (!normalizedAlias) return;
    if (normalizedHeader === normalizedAlias) best = Math.max(best, 92);
    else if (normalizedHeader.includes(normalizedAlias) || normalizedAlias.includes(normalizedHeader)) best = Math.max(best, 80);
  });
  return best;
}

function profileColumn(header, rows) {
  const values = rows.slice(0, 30).map(row => row?.[header]).filter(value => value !== undefined && value !== null && String(value).trim() !== '');
  if (!values.length) return { nonEmptyRate: 0, numericRate: 0, unitRate: 0 };
  const numericCount = values.filter(isNumericValue).length;
  const unitCount = values.filter(value => /^(m|m2|m3|㎡|m²|m³|t|kg|套|台|项|根|座|块|个|组|kW|kw|h|小时|工日)$/i.test(String(value).trim())).length;
  const sampleSize = Math.min(rows.length, 30) || values.length;
  return {
    nonEmptyRate: values.length / sampleSize,
    numericRate: numericCount / values.length,
    unitRate: unitCount / values.length,
  };
}

function isNumericValue(value) {
  const normalized = String(value).replace(/[,，¥￥\s]/g, '');
  return normalized !== '' && Number.isFinite(Number(normalized));
}

function confidenceFor(score) {
  if (score >= 90) return 'high';
  if (score >= 75) return 'medium';
  return 'low';
}

function canReuseHeader(def, header, usedHeaders) {
  return !usedHeaders.has(header) || isSharedNameFeature(def.key, header);
}

function isSharedNameFeature(key, header) {
  return (key === 'name' || key === 'feature') && normalizeImportHeader(header) === '项目名称项目特征';
}

function mappingReason(def, candidate, confidence) {
  if (!candidate) return '未找到可识别的来源列';
  if (confidence === 'high') return `已按表头和样本数据确认“${candidate.header}”`;
  return `检测到候选列“${candidate.header}”，请确认后使用`;
}
