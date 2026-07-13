// AI 自由格式清单识别：只传递当前工作表的有限样本，且只返回待用户确认的映射建议。
import { getAIConfig } from './aiService.js?v=3.9';
import { normalizeImportHeader } from './importMappingService.js?v=1.2';

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
  if (targetType === 'project_boq') return PROJECT_FIELDS.map(field => ({ ...field }));
  if (targetType === 'boq_library') return LIBRARY_FIELDS.map(field => ({ ...field }));
  throw new Error('不支持的导入目标');
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
  return {
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
  };
}

function recognitionSystemPrompt() {
  return `你是工程量清单 Excel 字段识别器。只返回 JSON 对象，不能返回 Markdown 或解释文字。\n字段必须来自 availableFields，source 必须精确等于 headers 中的列名。每个字段返回 sourceType(column/fixed/none)、source、fixedValue、confidence(high/medium/low)、reason、alternatives。不要猜测不存在的列，不要填入业务数据。amountRule 只能是 calculated、sourceAmount 或 deriveUnitPrice。`;
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
