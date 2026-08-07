// AI 自由格式清单识别：只传递当前工作表的有限样本。
// 标准表头由本地规则优先自动匹配，AI 只负责补充模糊列的建议。
import { getAIConfig } from './aiService.js?v=6.10';
import { normalizeImportHeader } from './importMappingService.js?v=6.10';
import { getImportSchema } from './importSchemaService.js?v=6.10';

const PROJECT_FIELDS = [
  { key: 'code', label: '清单编码', aliases: ['项目编码', '清单编码', '编码'], kind: 'text' },
  { key: 'name', label: '清单名称', required: true, aliases: ['项目名称', '清单名称', '名称'], kind: 'text' },
  { key: 'feature', label: '项目特征', aliases: ['项目特征', '特征', '描述'], kind: 'text' },
  { key: 'unit', label: '单位', required: true, aliases: ['单位', '计量单位'], kind: 'unit' },
  { key: 'qty', label: '工程量', required: true, aliases: ['工程量', '工程数量', '数量'], kind: 'number' },
  { key: 'unitPrice', label: '综合单价', aliases: ['综合单价', '单价'], kind: 'money' },
  { key: 'amount', label: '合价', aliases: ['合价', '金额', '总价'], kind: 'money' },
  { key: 'process', label: '工艺段', aliases: ['工艺段', '区域', '单体'], kind: 'text' },
  { key: 'costCategory', label: '成本分类', aliases: ['成本分类', '费用分类', '分类'], kind: 'text' },
];

const LIBRARY_FIELDS = [
  { key: 'major', label: '专业', aliases: ['专业', '适用专业'], kind: 'text' },
  { key: 'code', label: '清单编码', aliases: ['清单编码', '项目编码', '编码'], kind: 'text' },
  { key: 'name', label: '清单名称', required: true, aliases: ['清单名称', '项目名称', '名称'], kind: 'text' },
  { key: 'feature', label: '项目特征', aliases: ['项目特征', '特征', '描述'], kind: 'text' },
  { key: 'unit', label: '单位', required: true, aliases: ['单位', '计量单位'], kind: 'unit' },
  { key: 'defaultQty', label: '默认工程量', aliases: ['默认工程量', '工程量', '工程数量', '数量'], kind: 'number' },
  { key: 'scope', label: '适用范围', aliases: ['适用范围'], kind: 'text' },
  { key: 'structureGroup', label: '结构分组', aliases: ['结构分组', '费用分类'], kind: 'text' },
  { key: 'quotaRefs', label: '关联定额', aliases: ['关联定额编码', '关联定额', '定额编码'], kind: 'text' },
  { key: 'source', label: '来源', aliases: ['来源'], kind: 'text' },
  { key: 'version', label: '版本', aliases: ['版本'], kind: 'text' },
  { key: 'note', label: '备注', aliases: ['备注', '说明'], kind: 'text' },
];

const AMOUNT_RULES = new Set(['calculated', 'sourceAmount', 'deriveUnitPrice']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

export function getRecognitionFields(targetType) {
  return getImportSchema(targetType).fields.map(field => ({ ...field }));
}

export function createHierarchicalRecognitionRequest({ targetType, signature = '', columns = [], rows = [] } = {}) {
  const availableFields = getRecognitionFields(targetType).map(field => ({
    key: field.key, label: field.label, required: Boolean(field.required), aliases: field.aliases, kind: field.kind,
  }));
  return {
    targetType,
    signature: String(signature || ''),
    columns: columns.map(column => ({
      id: column.id,
      path: [...(column.path || [])],
      leaf: column.leaf || '',
      unitHint: column.unitHint || '',
      samples: rows.slice(0, 50).map(row => row?.values?.[column.id]).filter(value => value !== '' && value != null).slice(0, 8),
    })),
    availableFields,
  };
}

export async function recognizeImportColumns(input, { fetchImpl = fetch, localResult = null, timeoutMs = 15000 } = {}) {
  const request = createHierarchicalRecognitionRequest(input);
  const cfg = getAIConfig();
  if (!cfg.api_key) return { ...(localResult || {}), degraded: true, degradationReason: '未配置 AI 模型，已使用本地映射' };
  try {
    const controller = new AbortController();
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('请求超时')); }, Math.max(1000, timeoutMs));
    });
    let response;
    try {
      response = await Promise.race([fetchImpl(`${cfg.base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model, temperature: 0, response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: hierarchicalRecognitionPrompt() },
            { role: 'user', content: JSON.stringify(request) },
          ],
        }),
      }), timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = JSON.parse(stripCodeFence((await response.json())?.choices?.[0]?.message?.content || ''));
    return validateColumnRecognitionPayload(payload, request, localResult);
  } catch (error) {
    return { ...(localResult || {}), degraded: true, degradationReason: `AI 识别失败（${error.message || '未知错误'}），已使用本地映射` };
  }
}

export function validateColumnRecognitionPayload(payload, request, localResult = null) {
  const fieldKeys = new Set(request.availableFields.map(field => field.key));
  const columnIds = new Set(request.columns.map(column => column.id));
  const mapping = { ...(localResult?.mapping || {}) };
  const assigned = new Map(Object.entries(mapping).filter(([, columnId]) => columnId).map(([fieldKey, columnId]) => [columnId, fieldKey]));
  const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
  suggestions.forEach(item => {
    const fieldKey = String(item?.fieldKey || '');
    const columnId = String(item?.columnId || '');
    if (!fieldKeys.has(fieldKey)) throw new Error(`AI 返回了不支持的字段：${fieldKey}`);
    if (!columnIds.has(columnId)) throw new Error(`AI 返回的列 ${columnId} 不存在`);
    const occupiedBy = assigned.get(columnId);
    if (occupiedBy && occupiedBy !== fieldKey) throw new Error(`AI 返回了重复列映射：${columnId}`);
    if (item.confidence === 'high' || !mapping[fieldKey]) {
      if (mapping[fieldKey]) assigned.delete(mapping[fieldKey]);
      mapping[fieldKey] = columnId;
      assigned.set(columnId, fieldKey);
    }
  });
  return {
    ...(localResult || {}),
    mapping,
    suggestions: suggestions.map(item => ({
      fieldKey: String(item.fieldKey), columnId: String(item.columnId),
      confidence: CONFIDENCE.has(item.confidence) ? item.confidence : 'low', reason: String(item.reason || 'AI 识别建议'),
    })),
    summary: String(payload?.summary || 'AI 已补充层级表头映射'),
    degraded: false,
    degradationReason: '',
  };
}

export function createRecognitionRequest({ targetType, sheetName = '', headers = [], sampleRows = [], availableFields } = {}) {
  const safeHeaders = headers.map(value => String(value || '').trim()).filter(Boolean);
  return {
    targetType,
    sheetName: String(sheetName || ''),
    headers: safeHeaders,
    sampleRows: sampleRows.slice(0, 50).map(row => pickRow(row, safeHeaders)),
    availableFields: (availableFields || getRecognitionFields(targetType)).map(field => ({
      key: field.key, label: field.label, required: Boolean(field.required), aliases: field.aliases, kind: field.kind,
    })),
  };
}

export async function recognizeBoqImport(input, { fetchImpl = fetch } = {}) {
  const request = createRecognitionRequest(input);
  if (!request.headers.length || !request.sampleRows.length) throw new Error('请选择含有表头和数据的工作表');
  const cfg = getAIConfig();
  if (!cfg.api_key) throw new Error('AI 清单识别需要先配置模型');
  const response = await fetchImpl(`${cfg.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: recognitionSystemPrompt() },
        { role: 'user', content: JSON.stringify(request) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI 识别请求失败：HTTP ${response.status}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 未返回可用的字段识别结果');
  let payload;
  try { payload = JSON.parse(stripCodeFence(content)); } catch { throw new Error('AI 返回的字段识别结果不是有效 JSON，请重试'); }
  return validateRecognitionPayload(payload, request);
}

export function validateRecognitionPayload(payload, { targetType, sheetName = '', sampleRows = [], headers = [] } = {}) {
  const defs = getRecognitionFields(targetType);
  const byKey = new Map(defs.map(field => [field.key, field]));
  const fields = {};
  const used = new Map();
  const sourceFields = payload?.fields && typeof payload.fields === 'object' ? payload.fields : {};

  Object.keys(sourceFields).forEach(key => {
    if (!byKey.has(key)) throw new Error(`AI 返回了不支持的字段：${key}`);
  });

  defs.forEach(def => {
    const raw = sourceFields[def.key] || { sourceType: 'none', confidence: 'low', reason: `未匹配到可用于“${def.label}”的来源列，请手动选择或设为不导入` };
    const sourceType = ['column', 'fixed', 'none'].includes(raw.sourceType) ? raw.sourceType : 'none';
    const source = String(raw.source || '').trim();
    const fixedValue = raw.fixedValue == null ? '' : String(raw.fixedValue);
    const confidence = CONFIDENCE.has(raw.confidence) ? raw.confidence : 'low';
    if (sourceType === 'column') {
      if (!headers.includes(source)) throw new Error(`AI 识别的来源列“${source}”不存在`);
      const previous = used.get(source);
      if (previous && !canShareColumn(previous, def.key, source)) throw new Error(`来源列“${source}”存在重复映射`);
      used.set(source, def.key);
    }
    if (sourceType === 'fixed' && !fixedValue.trim()) throw new Error(`字段“${def.label}”缺少固定值`);
    fields[def.key] = {
      key: def.key,
      label: def.label,
      required: Boolean(def.required),
      sourceType,
      source: sourceType === 'column' ? source : '',
      fixedValue: sourceType === 'fixed' ? fixedValue : '',
      confidence,
      reason: String(raw.reason || 'AI 识别建议'),
      alternatives: Array.isArray(raw.alternatives) ? raw.alternatives.filter(value => headers.includes(value)).slice(0, 3) : [],
      confirmed: false,
    };
  });
  const amountRule = AMOUNT_RULES.has(payload?.amountRule) ? payload.amountRule : 'calculated';
  return applyAutomaticHeaderMappings({
    summary: String(payload?.summary || 'AI 已生成字段映射建议'),
    targetType,
    fields,
    amountRule,
    warnings: Array.isArray(payload?.warnings) ? payload.warnings.map(String).slice(0, 20) : [],
    sheetUnderstanding: String(payload?.sheetUnderstanding || ''),
    analysis: {
      sheetName: String(sheetName || ''),
      headerCount: headers.length,
      sampleRowCount: Array.isArray(sampleRows) ? Math.min(sampleRows.length, 50) : 0,
      headers: headers.slice(0, 20),
    },
  }, { targetType, headers, sampleRows });
}

// 对明确的标准表头做确定性匹配。这样即使模型漏识别，常规 Excel 也不必逐项手动选择。
export function applyAutomaticHeaderMappings(recognition, { targetType, headers = [], sampleRows = [] } = {}) {
  const defs = getRecognitionFields(targetType || recognition?.targetType);
  const fields = { ...(recognition?.fields || {}) };
  const usedSources = new Set(Object.values(fields)
    .filter(field => field?.sourceType === 'column')
    .map(field => field.source));

  defs.forEach(def => {
    const current = fields[def.key] || emptyRecognitionField(def);
    const exactHeader = findExactAliasHeader(def, headers, sampleRows, usedSources);

    if (current.sourceType === 'column') {
      const isExactAlias = def.aliases.some(alias => normalizeImportHeader(alias) === normalizeImportHeader(current.source));
      fields[def.key] = {
        ...current,
        // 高置信度的 AI 建议及标准表头匹配均可直接采用；用户改动后仍需自行确认。
        confirmed: current.confidence === 'high' || isExactAlias,
        autoMatched: current.confidence === 'high' || isExactAlias,
        reason: isExactAlias
          ? `已按标准表头「${current.source}」自动匹配`
          : current.reason,
      };
      return;
    }

    if (exactHeader) {
      usedSources.add(exactHeader);
      fields[def.key] = {
        ...current,
        sourceType: 'column',
        source: exactHeader,
        fixedValue: '',
        confidence: 'high',
        reason: `已按标准表头「${exactHeader}」自动匹配`,
        alternatives: unique([exactHeader, ...(current.alternatives || [])]).slice(0, 3),
        confirmed: true,
        autoMatched: true,
      };
      return;
    }

    // 可选字段没有来源列本身就是完整选择，无需用户再勾选一次“不导入”。
    if (current.sourceType === 'none' && !def.required) {
      fields[def.key] = {
        ...current,
        confirmed: true,
        autoMatched: true,
        reason: current.reason || `未检测到可用于“${def.label}”的来源列，已设为不导入`,
      };
    }
  });

  return { ...recognition, targetType: targetType || recognition?.targetType, fields };
}

function emptyRecognitionField(def) {
  return {
    key: def.key, label: def.label, required: Boolean(def.required), sourceType: 'none', source: '', fixedValue: '',
    confidence: 'low', reason: `未匹配到可用于“${def.label}”的来源列`, alternatives: [], confirmed: false,
  };
}

function findExactAliasHeader(def, headers, sampleRows, usedSources) {
  for (const alias of def.aliases || []) {
    const header = headers.find(value => normalizeImportHeader(value) === normalizeImportHeader(alias));
    if (header && !usedSources.has(header) && hasUsableValues(def, header, sampleRows)) return header;
  }
  return '';
}

function hasUsableValues(def, header, sampleRows) {
  const values = sampleRows.map(row => String(row?.[header] ?? '').trim()).filter(Boolean);
  if (!values.length) return false;
  if (def.kind === 'number' || def.kind === 'money') return values.filter(isNumericValue).length / values.length >= 0.6;
  if (def.kind === 'unit') return values.some(value => /^(?:m[23]?|m²|m³|㎡|㎥|t|kg|台|套|项|个|根|米|吨|千克|平方(?:米)?|立方(?:米)?)$/i.test(value.replace(/\s/g, '')));
  return true;
}

function isNumericValue(value) {
  const normalized = String(value).replace(/[,，\s]/g, '');
  return normalized !== '' && Number.isFinite(Number(normalized));
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function recognitionSystemPrompt() {
  return `你是工程量清单 Excel 字段识别器。只返回 JSON 对象，不能返回 Markdown 或解释文字。\n字段必须来自 availableFields，source 必须精确等于 headers 中的列名。每个字段返回 sourceType(column/fixed/none)、source、fixedValue、confidence(high/medium/low)、reason、alternatives。不要猜测不存在的列，不要填入业务数据。amountRule 只能是 calculated、sourceAmount 或 deriveUnitPrice。`;
}

function hierarchicalRecognitionPrompt() {
  return `你是工程造价表格的层级表头映射器。只返回 JSON 对象，格式为 {"summary":"","suggestions":[{"fieldKey":"","columnId":"","confidence":"high|medium|low","reason":""}]}。fieldKey 必须来自 availableFields，columnId 必须精确来自 columns.id。必须结合完整 path、leaf、unitHint 和 samples，不得因为多个叶子都叫“单价”而忽略父级语义。不要返回不存在的列或字段。`;
}

function pickRow(row, headers) {
  return headers.reduce((result, header) => { result[header] = row?.[header] ?? ''; return result; }, {});
}

function stripCodeFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function canShareColumn(first, second, source) {
  return (first === 'name' || first === 'feature') && (second === 'name' || second === 'feature')
    && normalizeImportHeader(source) === '项目名称项目特征';
}
