import assert from 'node:assert/strict';
import { testResourceHealth } from './resourceHealth.mjs';
import { calculateAmount, hasMissingPrice } from '../assets/utils/costing.js';
import { detectCombinedNameFeatureMeta, detectRowKind, rowToBOQ, rowToQuotaItem, rowsFromSheetMatrix, summarizeSheetMatrices } from '../assets/data/excel.js';
import { applyMappingTemplate, buildImportMapping, matchMappingTemplate, resolveImportPricing } from '../assets/services/importMappingService.js';
import { createMappingTemplate, deleteMappingTemplate, listMappingTemplates, saveMappingTemplate } from '../assets/services/importMappingTemplateService.js';
import { findDuplicateLibraryItem, normalizeLibraryItem } from '../assets/services/boqLibraryService.js';
import { createRecognitionRequest, validateRecognitionPayload } from '../assets/services/aiImportRecognitionService.js';
import { getImportBlockingReasons, normalizeWizardStep, splitImportedNameFeature } from '../assets/views/aiImportWizard.js';
import { applyLibraryAISuggestions, buildLibraryEditPayload, buildLibraryMetricCards, getLibraryDetailSummary } from '../assets/views/boqLibrary.js';
import { ICONS, ICON_TONES, getIcon } from '../assets/utils/icons.js';
import { AI_SYSTEM_PROMPT_PRESETS, DEFAULT_AI_SYSTEM_PROMPT, getAIConfig, getAISystemPromptPreset, restoreBackupSafeAIConfig, toBackupSafeAIConfig } from '../assets/services/aiService.js';
import { buildSystemPromptGenerationMessages, parseSystemPromptDraft } from '../assets/services/aiPromptService.js';
import { testMaterialEquipmentDomain } from './materialEquipmentDomain.mjs';
import { testResourceWorkbench } from './resourceWorkbench.mjs';
import { testResourceAttachments } from './resourceAttachments.mjs';
import { testBackupService } from './backupService.mjs';
import { testQuotaBoqIntegration } from './quotaBoqIntegration.mjs';

function testCosting() {
  assert.equal(calculateAmount(10, 25, 1.08), 270);
  assert.equal(calculateAmount('', 25, 1), 0);
  assert.equal(calculateAmount(10, 0, 1), 0);
  assert.equal(hasMissingPrice(0), true);
  assert.equal(hasMissingPrice(''), true);
  assert.equal(hasMissingPrice(1), false);
}

function testBackupSafeAIConfig() {
  const safe = toBackupSafeAIConfig({
    provider: 'openai', base_url: 'https://example.com/v1', model: 'gpt-test', system: 'test', api_key: 'secret-key', ignored: 'x',
  });
  assert.deepEqual(safe, { provider: 'openai', base_url: 'https://example.com/v1', model: 'gpt-test', system: 'test' });
  const restored = restoreBackupSafeAIConfig(
    { ...safe, api_key: 'backup-key' },
    { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', system: 'old', api_key: 'device-key' },
  );
  assert.equal(restored.provider, 'openai');
  assert.equal(restored.api_key, 'device-key');
}

function testAISystemPromptPresets() {
  assert.equal(getAISystemPromptPreset(), DEFAULT_AI_SYSTEM_PROMPT);
  assert.equal(getAISystemPromptPreset('unknown'), DEFAULT_AI_SYSTEM_PROMPT);
  assert.equal(AI_SYSTEM_PROMPT_PRESETS.review.prompt.includes('报价审查'), true);
  assert.equal(AI_SYSTEM_PROMPT_PRESETS.knowledge.prompt.includes('资料'), true);
  assert.equal(DEFAULT_AI_SYSTEM_PROMPT.includes('不虚构价格'), true);
  assert.equal(DEFAULT_AI_SYSTEM_PROMPT.includes('建议动作：'), true);
}

function testLegacyDefaultSystemPromptMigration() {
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ system: '你是工程造价专家和报价审核助手。基于「企业定额库」「项目清单」「报价版本」「指标库」回答用户问题。先给结论，再给数据依据、风险提示和建议动作；样本不足或缺单价时必须说明。' }),
    setItem: () => {},
  };
  assert.equal(getAIConfig().system, DEFAULT_AI_SYSTEM_PROMPT);
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ system: '我自己的提示词' }),
    setItem: () => {},
  };
  assert.equal(getAIConfig().system, '我自己的提示词');
  globalThis.localStorage = originalLocalStorage;
}

function testSystemPromptGenerationContract() {
  const messages = buildSystemPromptGenerationMessages({
    scenario: '污水厂投标报价复核', focus: '漏项与异常工程量', responseStyle: 'concise',
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content.includes('污水厂投标报价复核'), true);
  assert.equal(messages[1].content.includes('当前提示词'), false);
  const withBase = buildSystemPromptGenerationMessages({ scenario: '资料整理', basePrompt: '已有提示词' });
  assert.equal(withBase[1].content.includes('已有提示词'), true);
  assert.throws(() => buildSystemPromptGenerationMessages({ scenario: '' }), /工作场景/);
  assert.equal(parseSystemPromptDraft('```json\n{"prompt":"新的提示词"}\n```'), '新的提示词');
  assert.throws(() => parseSystemPromptDraft('{"summary":"缺少草案"}'), /未返回/);
}

function testExcelRows() {
  const quotaRow = {
    清单名称: 'C30 满堂基础',
    项目特征: '混凝土强度等级：C30',
    单位: 'm³',
    综合单价: '520.5',
  };
  assert.equal(detectRowKind(quotaRow), 'quota');
  const quota = rowToQuotaItem(quotaRow);
  assert.equal(quota.name, 'C30 满堂基础');
  assert.equal(quota.priceTotal, 520.5);
  assert.equal(quota.priceMissing, false);

  const missingPriceQuota = rowToQuotaItem({ 清单名称: '缺价项', 单位: 'm²', 综合单价: '' });
  assert.equal(missingPriceQuota.priceMissing, true);

  const boqRow = {
    项目编码: '0101',
    项目名称: '防水卷材',
    计量单位: 'm²',
    工程数量: '12',
    综合单价: '30',
  };
  assert.equal(detectRowKind(boqRow), 'boq');
  const boq = rowToBOQ(boqRow, 'p1');
  assert.equal(boq.projectId, 'p1');
  assert.equal(boq.amount, 360);
  assert.equal(boq.priceMissing, false);

  const combinedBoq = rowToBOQ({
    项目编码: '0102',
    '项目名称\n项目特征': '钢管内填芯\n1、混凝土灌芯长度:1.5m\n2、砼强度:C40',
    计量单位: 'm3',
    工程数量: '3.4',
    综合单价: '',
  }, 'p1');
  assert.equal(detectRowKind({ 项目编码: '0102', '项目名称\n项目特征': '钢管内填芯' }), 'boq');
  assert.equal(combinedBoq.name, '钢管内填芯');
  assert.equal(combinedBoq.feature.includes('混凝土灌芯长度'), true);
  assert.equal(combinedBoq.qty, 3.4);
  assert.equal(combinedBoq.priceMissing, true);

  const nameColumnBoq = rowToBOQ({
    名称: '截桩',
    '项目名称\n项目特征': '截桩\n1、桩类型:预应力混凝土空心方桩',
    计量单位: '根',
    工程数量: '50',
  }, 'p1');
  assert.equal(detectRowKind({ 名称: '截桩', '项目名称\n项目特征': '截桩' }), 'boq');
  assert.equal(nameColumnBoq.name, '截桩');
  assert.equal(nameColumnBoq.feature.includes('桩类型'), true);
  assert.equal(nameColumnBoq.unit, '根');
}

function testImportMapping() {
  const mapped = buildImportMapping([
    '序号', '项目名称', '项目特征', '计量单位', '工程量（m3）', '综合单价（含税）', '合价（元）',
  ], [{
    序号: '1',
    项目名称: '池壁混凝土',
    项目特征: 'C30，抗渗等级 P8',
    计量单位: 'm3',
    '工程量（m3）': '12.5',
    '综合单价（含税）': '680',
    '合价（元）': '8500',
  }]);
  assert.equal(mapped.mapping.name, '项目名称');
  assert.equal(mapped.mapping.qty, '工程量（m3）');
  assert.equal(mapped.mapping.unitPrice, '综合单价（含税）');
  assert.equal(mapped.mapping.amount, '合价（元）');
  assert.equal(mapped.mapping.qty === '序号', false);
  assert.equal(mapped.fields.qty.confidence, 'high');

  const noPrice = buildImportMapping(['序号', '项目名称', '数量(暂估)', '单位'], [{
    序号: '1',
    项目名称: '临时排水',
    '数量(暂估)': '3',
    单位: '项',
  }]);
  assert.equal(noPrice.mapping.qty, '数量(暂估)');
  assert.equal(noPrice.mapping.unitPrice, '');
  assert.equal(noPrice.fields.unitPrice.status, 'missing');

  const combined = buildImportMapping(['项目名称\n项目特征', '单位', '工程数量'], [{
    '项目名称\n项目特征': '钢筋混凝土池壁\n厚度 300mm',
    单位: 'm3',
    工程数量: '5',
  }]);
  assert.equal(combined.mapping.name, '项目名称\n项目特征');
  assert.equal(combined.mapping.feature, '项目名称\n项目特征');
  assert.equal(combined.mapping.qty, '工程数量');
}

function testMappingTemplates() {
  const storage = memoryStorage();
  const base = createMappingTemplate({
    name: '污水工程清单',
    scope: 'global',
    mapping: { name: '项目名称', unit: '单位', qty: '工程量', unitPrice: '综合单价' },
    fixedValues: { process: '土建工程' },
    amountRule: 'calculated',
  });
  saveMappingTemplate(base, { storage });
  assert.equal(listMappingTemplates({ projectId: 'p-1' }, { storage }).length, 1);
  assert.throws(() => saveMappingTemplate({ ...base, id: undefined }, { storage }), /同名模板/);

  const projectTemplate = createMappingTemplate({
    name: '污水工程清单', scope: 'project', projectId: 'p-1', mapping: { name: '名称' },
  });
  saveMappingTemplate(projectTemplate, { storage });
  assert.equal(listMappingTemplates({ projectId: 'p-1' }, { storage }).length, 2);
  assert.equal(listMappingTemplates({ projectId: 'p-2' }, { storage }).length, 1);

  const match = matchMappingTemplate(base, ['序号', '项目名称', '单位', '工程量（m3）', '综合单价（含税）']);
  assert.equal(match.status, 'recommended');
  assert.equal(match.matchedFields.includes('qty'), true);
  const partial = matchMappingTemplate(base, ['项目名称', '单位']);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.missingSources.includes('工程量'), true);
  const applied = applyMappingTemplate(base, ['项目名称', '单位', '工程量（m3）', '综合单价（含税）'], [{
    项目名称: '池壁', 单位: 'm3', '工程量（m3）': '12', '综合单价（含税）': '680',
  }]);
  assert.equal(applied.mapping.qty, '工程量（m3）');
  assert.equal(applied.fields.qty.status, 'template');
  assert.equal(applied.fixedValues.process, '土建工程');
  assert.equal(applied.amountRule, 'calculated');
  deleteMappingTemplate(projectTemplate.id, { storage });
  assert.equal(listMappingTemplates({ projectId: 'p-1' }, { storage }).length, 1);
}

function testImportPricingRules() {
  assert.deepEqual(resolveImportPricing({ qty: 10, unitPrice: 25 }), {
    qty: 10, unitPrice: 25, sourceAmount: 0, calculatedAmount: 250, amount: 250, derivedUnitPrice: false,
  });
  assert.equal(resolveImportPricing({ qty: 10, unitPrice: 25, amount: 260, amountRule: 'sourceAmount' }).amount, 260);
  const derived = resolveImportPricing({ qty: 8, amount: 400, amountRule: 'deriveUnitPrice' });
  assert.equal(derived.unitPrice, 50);
  assert.equal(derived.amount, 400);
  assert.equal(resolveImportPricing({ qty: 0, amount: 400, amountRule: 'deriveUnitPrice' }).unitPrice, 0);
}

function testBoqLibraryItemIdentity() {
  const existing = [
    { id: 'a', code: '030101001001', name: '土方开挖', feature: '三类土', unit: 'm³' },
    { id: 'b', code: '', name: '钢筋混凝土池壁', feature: 'C30 P6', unit: 'm³' },
  ];
  assert.equal(findDuplicateLibraryItem(existing, { code: '030101001001', name: '别名', feature: '', unit: '项' }).id, 'a');
  assert.equal(findDuplicateLibraryItem(existing, { code: '', name: '钢筋混凝土池壁', feature: 'C30 P6', unit: 'm³' }).id, 'b');
  assert.equal(findDuplicateLibraryItem(existing, { code: '', name: '钢筋混凝土池壁', feature: 'C35', unit: 'm³' }), null);

  const item = normalizeLibraryItem({ name: '池壁', unit: 'm3', defaultQty: '12.5', quotaItemIds: 'q-1' });
  assert.equal(item.status, 'active');
  assert.equal(item.defaultQty, 12.5);
  assert.deepEqual(item.quotaItemIds, ['q-1']);
}

function testBoqLibraryEditPayload() {
  const existing = {
    id: 'library-1', createdAt: '2026-01-01T00:00:00.000Z', referenceCount: 3,
    lastReferencedAt: '2026-07-01T00:00:00.000Z', lastReferencedProjectName: '一期工程',
  };
  const payload = buildLibraryEditPayload(existing, {
    code: ' 030101001001 ', name: ' 土方开挖 ', feature: ' 三类土 ', unit: ' m³ ', defaultQty: '120',
    major: '水处理工程', scope: '市政污水处理工程', structureGroup: '土建', source: '系统示例',
    version: 'v1.1', status: 'inactive', note: '已复核', quotaItemIds: ['q-1', 'q-1', 'q-2'],
  });
  assert.equal(payload.id, existing.id);
  assert.equal(payload.createdAt, existing.createdAt);
  assert.equal(payload.referenceCount, existing.referenceCount);
  assert.equal(payload.lastReferencedAt, existing.lastReferencedAt);
  assert.equal(payload.lastReferencedProjectName, existing.lastReferencedProjectName);
  assert.equal(payload.name, '土方开挖');
  assert.equal(payload.defaultQty, 120);
  assert.deepEqual(payload.quotaItemIds, ['q-1', 'q-2']);
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.get(key) || null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

function testSheetHeaderDetection() {
  const rows = rowsFromSheetMatrix([
    ['产品水池扩建工程量清单'],
    ['项目名称', '', '工程量', '综合单价'],
    ['', '项目特征', 'm3', '含税'],
    ['池壁混凝土', 'C30，抗渗 P8', 12.5, 680],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].项目名称, '池壁混凝土');
  assert.equal(rows[0].项目特征, 'C30，抗渗 P8');
  assert.equal(rows[0]['工程量 m3'], 12.5);
  assert.equal(rows[0]['综合单价 含税'], 680);
  assert.throws(() => rowsFromSheetMatrix([['产品水池扩建工程'], ['说明：请填写完整']]), /未能识别/);
}

function testCombinedNameFeatureColumnMetadata() {
  const source = '项目名称 项目特征';
  const meta = detectCombinedNameFeatureMeta([source, '计量单位'], [
    { [source]: '钢管内填芯\r\n1、混凝土灌芯长度：1.5m\r\n\r\n2、砼强度：C40', 计量单位: 'm3' },
    { [source]: '截桩\n1、桩类型：预应力混凝土空心方桩', 计量单位: '根' },
  ]);
  assert.deepEqual(meta, {
    source,
    strategy: 'first_line_name_rest_feature',
    status: 'ready',
    sampleCount: 2,
    validSampleCount: 2,
    preview: [
      { name: '钢管内填芯', feature: '1、混凝土灌芯长度：1.5m\n2、砼强度：C40' },
      { name: '截桩', feature: '1、桩类型：预应力混凝土空心方桩' },
    ],
  });
  assert.equal(detectCombinedNameFeatureMeta(['项目名称', '项目特征'], [{ 项目名称: '池壁', 项目特征: 'C30' }]), null);
  assert.equal(detectCombinedNameFeatureMeta([source], [{ [source]: '只有名称' }]).status, 'invalid');
}

function testAiImportRecognitionContract() {
  const request = createRecognitionRequest({
    targetType: 'project_boq',
    sheetName: '工程量清单',
    headers: ['编号', '项目内容', '单位', '数量'],
    sampleRows: Array.from({ length: 55 }, (_, index) => ({ 编号: index + 1, 项目内容: `条目${index + 1}`, 单位: 'm', 数量: index + 1 })),
  });
  assert.equal(request.sampleRows.length, 50);
  assert.deepEqual(Object.keys(request).sort(), ['availableFields', 'headers', 'sampleRows', 'sheetName', 'targetType']);
  assert.equal(request.availableFields.some(field => field.key === 'qty' && field.required), true);

  const valid = validateRecognitionPayload({
    summary: '识别到工程量清单',
    amountRule: 'calculated',
    fields: {
      name: { sourceType: 'column', source: '项目内容', confidence: 'high', reason: '名称列' },
      unit: { sourceType: 'column', source: '单位', confidence: 'high', reason: '单位列' },
      qty: { sourceType: 'column', source: '数量', confidence: 'high', reason: '数值列' },
    },
  }, { targetType: 'project_boq', sheetName: '工程量清单', sampleRows: [{ 项目内容: '池壁混凝土' }], headers: ['编号', '项目内容', '单位', '数量'] });
  assert.equal(valid.fields.name.source, '项目内容');
  assert.equal(valid.fields.name.confirmed, true);
  assert.equal(valid.fields.name.autoMatched, true);
  assert.equal(valid.fields.feature.sourceType, 'none');
  assert.equal(valid.fields.feature.confirmed, true);
  assert.equal(valid.analysis.sheetName, '工程量清单');
  assert.equal(valid.analysis.sampleRowCount, 1);
  assert.equal(valid.fields.feature.reason.includes('未匹配'), true);

  assert.throws(() => validateRecognitionPayload({
    fields: {
      name: { sourceType: 'column', source: '项目内容', confidence: 'high', reason: '' },
      unit: { sourceType: 'column', source: '单位', confidence: 'high', reason: '' },
      qty: { sourceType: 'column', source: '单位', confidence: 'high', reason: '' },
    },
  }, { targetType: 'project_boq', headers: ['项目内容', '单位'] }), /重复映射/);

  assert.throws(() => validateRecognitionPayload({
    fields: { name: { sourceType: 'column', source: '不存在列', confidence: 'high', reason: '' } },
  }, { targetType: 'boq_library', headers: ['清单名称', '单位'] }), /不存在/);

  const localFallback = validateRecognitionPayload({ fields: {} }, {
    targetType: 'boq_library',
    headers: ['专业', '清单编码', '清单名称', '项目特征', '单位', '工程数量'],
    sampleRows: [{ 专业: '水处理工程', 清单编码: '010101', 清单名称: '池壁混凝土', 项目特征: 'C40', 单位: 'm3', 工程数量: 18.5 }],
  });
  assert.equal(localFallback.fields.major.source, '专业');
  assert.equal(localFallback.fields.code.source, '清单编码');
  assert.equal(localFallback.fields.name.source, '清单名称');
  assert.equal(localFallback.fields.unit.source, '单位');
  assert.equal(localFallback.fields.defaultQty.source, '工程数量');
  assert.equal(localFallback.fields.name.confirmed, true);
  assert.equal(localFallback.fields.source.sourceType, 'none');
  assert.equal(localFallback.fields.source.confirmed, true);
}

function testAiImportWizardSafety() {
  assert.equal(normalizeWizardStep('confirm', { recognition: null, hasSheet: false }), 'upload');
  assert.equal(normalizeWizardStep('confirm', { recognition: null, hasSheet: true }), 'sheet');
  assert.equal(normalizeWizardStep('confirm', { recognition: { fields: {} }, hasSheet: true }), 'confirm');
  assert.deepEqual(
    splitImportedNameFeature('钢管内填芯\n1、混凝土灌芯长度：1.5m\n2、砼强度：C40', '钢管内填芯\n1、混凝土灌芯长度：1.5m\n2、砼强度：C40'),
    { name: '钢管内填芯', feature: '1、混凝土灌芯长度：1.5m\n2、砼强度：C40' },
  );
}

function testAiImportReadinessExplainsMissingRequiredMapping() {
  const fields = [
    { key: 'name', label: '清单名称', required: true },
    { key: 'unit', label: '单位', required: true },
  ];
  const reasons = getImportBlockingReasons(fields, {
    name: { sourceType: 'none', confirmed: true },
    unit: { sourceType: 'column', source: '计量单位', confirmed: true },
  }, { targetType: 'boq_library' });
  assert.deepEqual(reasons, ['“清单名称”是必填字段：请选择 Excel 来源列或填写固定值']);
  assert.deepEqual(getImportBlockingReasons(fields, {
    name: { sourceType: 'fixed', fixedValue: '', confirmed: true },
    unit: { sourceType: 'column', source: '计量单位', confirmed: true },
  }, { targetType: 'boq_library' }), ['“清单名称”填写了固定值，但内容为空']);

  assert.deepEqual(getImportBlockingReasons(fields, {
    name: { sourceType: 'column', source: '名称', confirmed: true },
    unit: { sourceType: 'none', confirmed: false },
  }, { targetType: 'boq_library' }), ['“单位”是必填字段：请选择 Excel 来源列或填写固定值']);
}

function testLibraryDetailSummary() {
  assert.deepEqual(getLibraryDetailSummary({
    code: '010501004001', name: '油池防水底板', unit: 'm3', defaultQty: 25,
    quotaItemIds: ['q-1', 'q-2'], source: '企业自建', version: 'V1.2', status: 'active',
    referenceCount: 3, lastReferencedProjectName: '油池改造工程', lastReferencedAt: '2026-07-13',
  }), {
    code: '010501004001', sourceLabel: '企业自建 · V1.2', statusLabel: '启用',
    qty: '25', quotaCount: 2, referenceLabel: '3 次', lastReference: '油池改造工程 · 2026-07-13',
  });
}

function testLibraryMetricCards() {
  assert.deepEqual(buildLibraryMetricCards({ total: 1268, water: 892, added: 48, references: 326 }), [
    { label: '清单总数', value: '1,268', unit: '个', note: '全部标准清单', icon: 'format_list_bulleted', tone: 'blue' },
    { label: '水处理工程清单', value: '892', unit: '个', note: '占比 70.3%', icon: 'water_drop', tone: 'teal' },
    { label: '本月新增清单', value: '48', unit: '个', note: '本月新增', icon: 'add', tone: 'blue' },
    { label: '被引用次数', value: '326', unit: '次', note: '累计引用', icon: 'trending_up', tone: 'amber' },
  ]);
}

function testIconSystem() {
  assert.equal(ICONS.navigation.boqLibrary, 'format_list_bulleted');
  assert.equal(ICONS.action.import, 'upload');
  assert.equal(ICONS.status.error, 'error');
  assert.equal(ICON_TONES.primary, 'teal');
  assert.equal(getIcon('action', 'remove'), 'delete');
  assert.equal(getIcon('missing', 'missing', 'info'), 'info');
}

function testWorkbookSummariesForAiImport() {
  const sheets = summarizeSheetMatrices([
    { name: '封面', matrix: [['污水厂项目'], ['编制单位：某设计院']] },
    { name: '不规范清单', matrix: [['序号', '工作内容描述', '计量', '工程量'], [1, '池壁混凝土', 'm3', 12]] },
  ]);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].headers.length, 0);
  assert.equal(sheets[1].headers.includes('工作内容描述'), true);
  assert.equal(sheets[1].rows[0].工作内容描述, '池壁混凝土');
  assert.equal(sheets[1].previewRows.length, 1);
}

class MemoryDirectoryHandle {
  constructor(name) {
    this.name = name;
    this.kind = 'directory';
    this.directories = new Map();
    this.files = new Map();
  }

  async getDirectoryHandle(name, options = {}) {
    if (!this.directories.has(name)) {
      if (!options.create) throw notFound();
      this.directories.set(name, new MemoryDirectoryHandle(name));
    }
    return this.directories.get(name);
  }

  async getFileHandle(name, options = {}) {
    if (!this.files.has(name)) {
      if (!options.create) throw notFound();
      this.files.set(name, new MemoryFileHandle(name));
    }
    return this.files.get(name);
  }

  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
}

class MemoryFileHandle {
  constructor(name) {
    this.name = name;
    this.kind = 'file';
    this.content = '';
  }

  async getFile() {
    return { text: async () => this.content };
  }

  async createWritable() {
    return {
      write: async value => { this.content = String(value); },
      close: async () => {},
    };
  }
}

function notFound() {
  const err = new Error('Not found');
  err.name = 'NotFoundError';
  return err;
}

testCosting();
testBackupSafeAIConfig();
testAISystemPromptPresets();
testLegacyDefaultSystemPromptMigration();
testSystemPromptGenerationContract();
testExcelRows();
testImportMapping();
testMappingTemplates();
testImportPricingRules();
testBoqLibraryItemIdentity();
testBoqLibraryEditPayload();
testSheetHeaderDetection();
testCombinedNameFeatureColumnMetadata();
testAiImportRecognitionContract();
testAiImportWizardSafety();
testAiImportReadinessExplainsMissingRequiredMapping();
testLibraryDetailSummary();
testLibraryMetricCards();
testIconSystem();
testWorkbookSummariesForAiImport();
await testLocalFolderJsonStorage();
await testVersions();
await testArchiveEligibility();
await testDataEngine();
await testGlobalSearch();
await testAIAssistService();
await testExperienceService();
await testBoqLibraryService();
await testBuiltinDemoData();
await testMaterialEquipmentDomain();
await testResourceWorkbench();
await testResourceAttachments();
await testBackupService();
await testQuotaBoqIntegration();
await testResourceHealth();
console.log('All tests passed');

async function testLocalFolderJsonStorage() {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
  };
  globalThis.window = {
    idbKeyval: {
      get: async () => null,
      set: async () => {},
    },
  };
  const storage = await import('../assets/data/storage.js?v=test-folder-json');
  const root = new MemoryDirectoryHandle('污水造价数据库');
  await storage.writeStoresToDirectory(root, {
    projects: [{ id: 'p-local', name: '本地项目' }],
    project_boq: [{ id: 'b-local', projectId: 'p-local', name: '土方' }],
  }, { backupLabel: 'test' });

  const projects = await storage.readStoreFromDirectory(root, 'projects');
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, '本地项目');
  const storesDir = await root.getDirectoryHandle('stores');
  const projectsFile = await storesDir.getFileHandle('projects.json');
  const projectsPayload = JSON.parse(await (await projectsFile.getFile()).text());
  assert.equal(projectsPayload.store, 'projects');
  assert.equal(Array.isArray(projectsPayload.records), true);
  const manifestFile = await root.getFileHandle('manifest.json');
  const manifest = JSON.parse(await (await manifestFile.getFile()).text());
  assert.equal(manifest.storage, 'local-folder-json');
  assert.equal(manifest.stores.projects.file, 'stores/projects.json');
  const backupsDir = await root.getDirectoryHandle('backups');
  assert.equal([...backupsDir.files.keys()].some(name => name.startsWith('test-') && name.endsWith('.json')), true);
}

async function testVersions() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.has(`ls:${key}`) ? memory.get(`ls:${key}`) : null,
    setItem: (key, value) => memory.set(`ls:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-version');
  const { versionService } = await import('../assets/services/versionService.js?v=test-version');

  await repo.projectRepo.replaceAll([{ id: 'p1', name: '测试项目', totalCost: 100 }]);
  await repo.quotaRepo.replaceAll([
    { id: 'q1', name: '土方', feature: '综合', unit: 'm³', priceTotal: 10 },
    { id: 'q2', name: '钢筋', feature: 'HRB400', unit: 't', priceTotal: 3000 },
  ]);
  await repo.boqRepo.replaceAll([
    { id: 'l1', projectId: 'p1', quotaItemId: 'q1', name: '土方', unit: 'm³', qty: 10, factor: 1, unitPrice: 10, amount: 100, structureGroup: 'civil' },
  ]);

  const versionA = await versionService.createFromCurrent('p1', { name: 'A', note: '初版' });
  await repo.boqRepo.replaceAll([
    { id: 'l1', projectId: 'p1', quotaItemId: 'q1', name: '土方', unit: 'm³', qty: 12, factor: 1, unitPrice: 10, amount: 120 },
    { id: 'l2', projectId: 'p1', quotaItemId: 'q2', name: '钢筋', unit: 't', qty: 2, factor: 1, unitPrice: 3000, amount: 6000 },
  ]);
  const versionB = await versionService.createFromCurrent('p1', { name: 'B' });

  const savedA = await repo.versionRepo.findById(versionA.id);
  assert.equal(savedA.lines.length, 1);
  assert.equal(savedA.lines[0].qty, 10);

  const diff = await versionService.compare(versionA.id, versionB.id);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.modified.length, 1);
  assert.equal(diff.totalDelta, 6020);
  assert.equal(diff.categorySummary.some(row => row.id === 'civil'), true);

  const restored = await versionService.restore(versionA.id);
  const current = await repo.boqRepo.byProject('p1');
  const project = await repo.projectRepo.findById('p1');
  assert.equal(restored.restoredCount, 1);
  assert.equal(Boolean(restored.backup), true);
  assert.equal(current.length, 1);
  assert.equal(current[0].qty, 10);
  assert.notEqual(current[0].id, 'l1');
  assert.equal(project.totalCost, 100);

  const { boqService } = await import('../assets/services/boqService.js?v=test-version');
  const recommendations = await boqService.recommendQuota({ name: '钢筋', feature: 'HRB400', unit: 't' });
  assert.equal(recommendations[0].id, 'q2');
  await boqService.replaceQuota(current[0].id, 'q2');
  const replaced = (await repo.boqRepo.byProject('p1'))[0];
  assert.equal(replaced.quotaItemId, 'q2');
  assert.equal(replaced.unitPrice, 3000);
  await boqService.updateStructureGroup(replaced.id, 'custom:安装清单');
  const grouped = (await repo.boqRepo.byProject('p1'))[0];
  assert.equal(grouped.structureGroup, 'custom:安装清单');
  await repo.boqRepo.replaceAll([
    { id: 'risk1', projectId: 'p1', quotaItemId: '', name: '缺价项', unit: 'm²', qty: 0, factor: 1.3, unitPrice: 0, amount: 0 },
  ]);
  const audit = await boqService.audit('p1');
  assert.equal(audit.issues.missingPrice.length, 1);
  assert.equal(audit.issues.zeroQty.length, 1);
  assert.equal(audit.issues.factorRisk.length, 1);
  assert.equal(audit.issues.unmatchedQuota.length, 1);

  await repo.projectRepo.replaceAll([{ id: 'p-ref', name: '引用测试项目', totalCost: 100 }]);
  await repo.quotaRepo.replaceAll([{ id: 'q-ref', name: '被引用定额', unit: 'm³', priceTotal: 10 }]);
  await repo.boqRepo.replaceAll([{ id: 'line-ref', projectId: 'p-ref', quotaItemId: 'q-ref', name: '被引用清单', unit: 'm³', qty: 10, unitPrice: 10, factor: 1, amount: 100 }]);
  await repo.boqLibraryRepo.replaceAll([{ id: 'lib-ref', name: '引用清单库', unit: 'm³', quotaItemIds: ['q-ref'] }]);
  const { quotaService } = await import('../assets/services/quotaService.js?v=test-version');
  await assert.rejects(() => quotaService.remove('q-ref'), err => err.code === 'QUOTA_IN_USE' && err.usage.total === 2);
  const removal = await quotaService.remove('q-ref', { force: true });
  assert.equal(removal.projectLineCount, 1);
  assert.equal((await repo.boqRepo.byProject('p-ref')).find(line => line.id === 'line-ref').quotaReferenceStatus, 'missing');
  assert.deepEqual((await repo.boqLibraryRepo.findById('lib-ref')).quotaItemIds, []);
  const invalidAudit = await boqService.audit('p-ref');
  assert.equal(invalidAudit.issues.invalidQuotaReference.length, 1);
}

async function testDataEngine() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.has(`de:${key}`) ? memory.get(`de:${key}`) : null,
    setItem: (key, value) => memory.set(`de:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-data-engine');
  const { dataEngineService } = await import('../assets/services/dataEngineService.js?v=test-data-engine');
  const { projectService } = await import('../assets/services/projectService.js?v=test-data-engine');

  await repo.dataFactRepo.replaceAll([]);
  await repo.dataCandidateRepo.replaceAll([]);
  await repo.dataJobRepo.replaceAll([]);
  await repo.dataQualityReportRepo.replaceAll([]);
  await repo.indicatorRepo.replaceAll([]);
  await repo.projectRepo.replaceAll([{ id: 'p2', name: '沉淀项目', type: '水厂', scale: '中型', structure: '钢筋砼', status: 'doing', totalCost: 100 }]);
  await repo.boqRepo.replaceAll([
    { id: 'l21', projectId: 'p2', quotaItemId: 'q1', code: '001', name: '土方', feature: '综合', unit: 'm³', qty: 10, factor: 1, unitPrice: 10, amount: 100 },
    { id: 'l22', projectId: 'p2', quotaItemId: '', code: '002', name: '缺价项', feature: '', unit: 'm²', qty: 0, factor: 1, unitPrice: 0, amount: 0 },
  ]);

  const ingest = await dataEngineService.ingestBOQ('p2', { sourceType: 'excel', sourceId: '清单.xlsx' });
  assert.equal(ingest.candidates.length, 2);
  assert.equal(ingest.report.missingPrice, 1);
  assert.equal(ingest.report.zeroQty, 1);
  assert.equal(ingest.report.unmatchedQuota, 1);
  assert.equal(ingest.report.qualityScore < 100, true);
  assert.equal(ingest.report.recommendations.some(t => t.includes('综合单价')), true);
  assert.equal(ingest.candidates.every(c => c.lineageId && c.datasetKey && c.schemaVersion === 1), true);
  assert.equal((await repo.dataCandidateRepo.all()).length, 2);
  assert.equal((await repo.dataFactRepo.all()).length, 0);
  const firstJob = (await repo.dataJobRepo.all()).find(j => j.type === 'ingest_boq');
  assert.equal(firstJob.stages.some(s => s.name === '质量检查' && s.status === 'done'), true);

  const promoted = await dataEngineService.promoteCandidates([ingest.candidates[0].id]);
  assert.equal(promoted.promoted, 1);
  assert.equal((await repo.dataFactRepo.all()).length, 1);
  assert.equal((await repo.dataCandidateRepo.all()).length, 1);

  const { versionService } = await import('../assets/services/versionService.js?v=test-data-engine');
  await repo.boqRepo.replaceAll([
    { id: 'l21', projectId: 'p2', quotaItemId: 'q1', code: '001', name: '土方', feature: '综合', unit: 'm³', qty: 10, factor: 1, unitPrice: 10, amount: 100 },
  ]);
  await versionService.createFromCurrent('p2', { name: '归档前版本' });
  await projectService.archive('p2');
  const facts = await repo.dataFactRepo.all();
  assert.equal(facts.some(f => f.factType === 'project_cost' && f.sourceType === 'archived_project'), true);
  assert.equal(facts.some(f => f.factType === 'category_cost' && f.sourceType === 'archived_project'), true);
  const indicators = await repo.indicatorRepo.all();
  assert.equal(indicators.some(i => i.metric === '总造价(元)'), true);
  const dashboard = await dataEngineService.dashboard();
  assert.equal(dashboard.qualityScore > 0, true);
  assert.equal(dashboard.sourceSummary.archived_project > 0, true);
  assert.equal(dashboard.stageSummary['采集'] > 0, true);
  await projectService.archive('p2');
  assert.equal((await repo.dataFactRepo.all()).some(f => f.projectId === 'p2' && f.sourceType === 'archived_project'), false);
  assert.equal((await repo.indicatorRepo.all()).some(i => (i.sampleProjectIds || []).includes('p2')), false);

  await repo.projectRepo.replaceAll([
    ...(await repo.projectRepo.all()),
    { id: 'p3', name: '待回填项目', type: '水厂', scale: '小型', structure: '钢筋砼', status: 'archived', totalCost: 50 },
  ]);
  await repo.boqRepo.replaceAll([
    ...(await repo.boqRepo.all()),
    { id: 'l31', projectId: 'p3', quotaItemId: 'q3', code: '003', name: '模板', feature: '', unit: 'm²', qty: 5, factor: 1, unitPrice: 10, amount: 50 },
  ]);
  const beforePipeline = await dataEngineService.dashboard();
  assert.equal(beforePipeline.backfillNeeded, 1);
  const pipeline = await dataEngineService.runPipeline();
  assert.equal(pipeline.report.qualityScore > 0, true);
  const afterPipeline = await dataEngineService.dashboard();
  assert.equal(afterPipeline.backfillNeeded, 0);

  const backupShape = {
    data_facts: await repo.dataFactRepo.all(),
    data_candidates: await repo.dataCandidateRepo.all(),
    data_jobs: await repo.dataJobRepo.all(),
    data_quality_reports: await repo.dataQualityReportRepo.all(),
  };
  assert.equal(Array.isArray(backupShape.data_facts), true);
  assert.equal(Array.isArray(backupShape.data_quality_reports), true);
}

async function testArchiveEligibility() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.has(`wf:${key}`) ? memory.get(`wf:${key}`) : null,
    setItem: (key, value) => memory.set(`wf:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-workflow');
  const { archiveEligibility } = await import('../assets/services/projectWorkflow.js?v=test-workflow');
  const { projectService, normalizeProjectMetadata } = await import('../assets/services/projectService.js?v=test-workflow');
  const { versionService } = await import('../assets/services/versionService.js?v=test-workflow');

  const project = { id: 'pa', name: '归档校验项目', status: 'doing', totalCost: 0 };
  assert.deepEqual(normalizeProjectMetadata({ code: ' P-01 ', client: ' 业主 ', region: ' 南京 ', stage: '投标报价', priceYear: 2026 }), {
    code: 'P-01', client: '业主', region: '南京', stage: '投标报价', priceYear: '2026',
  });
  assert.equal(normalizeProjectMetadata({ priceYear: '20x6' }).priceYear, '');
  await repo.projectRepo.replaceAll([project]);
  await repo.boqRepo.replaceAll([
    { id: 'la1', projectId: 'pa', name: '缺价项', unit: 'm²', qty: 0, factor: 1, unitPrice: 0, amount: 0 },
  ]);
  await repo.versionRepo.replaceAll([]);
  let eligibility = archiveEligibility(project, await repo.boqRepo.byProject('pa'), []);
  assert.equal(eligibility.allowed, false);
  assert.equal(eligibility.blockers.some(b => b.id === 'missing_price'), true);
  assert.equal(eligibility.blockers.some(b => b.id === 'zero_qty'), true);
  assert.equal(eligibility.blockers.some(b => b.id === 'no_version'), true);
  await assert.rejects(() => projectService.archive('pa'), err => err.code === 'ARCHIVE_BLOCKED');

  await repo.boqRepo.replaceAll([
    { id: 'la1', projectId: 'pa', quotaItemId: 'q1', name: '合格项', unit: 'm²', qty: 10, factor: 1, unitPrice: 20, amount: 200 },
  ]);
  eligibility = archiveEligibility(project, await repo.boqRepo.byProject('pa'), []);
  assert.equal(eligibility.allowed, false);
  assert.equal(eligibility.blockers.some(b => b.id === 'no_version'), true);
  await versionService.createFromCurrent('pa', { name: '合格版本' });
  eligibility = archiveEligibility(project, await repo.boqRepo.byProject('pa'), await repo.versionRepo.byProject('pa'));
  assert.equal(eligibility.allowed, true);
}

async function testGlobalSearch() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.has(`gs:${key}`) ? memory.get(`gs:${key}`) : null,
    setItem: (key, value) => memory.set(`gs:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-search');
  const { searchAll } = await import('../assets/services/globalSearchService.js?v=test-search');
  await repo.quotaRepo.replaceAll([{ id: 'q-search', name: '水池防水定额', feature: '池壁', category: '防水防腐', unit: 'm²', priceTotal: 118 }]);
  await repo.boqLibraryRepo.replaceAll([{ id: 'bl-search', code: 'BL-001', name: '水池防水清单', feature: '池壁防腐', unit: 'm²', status: 'active', quotaItemIds: ['q-search'] }]);
  await repo.projectRepo.replaceAll([{ id: 'p-search', name: '水池项目', type: '水厂', scale: '中型', process: 'AAO', structure: '钢筋砼', status: 'doing' }]);
  await repo.boqRepo.replaceAll([{ id: 'b-search', projectId: 'p-search', name: '水池防水', unit: 'm²', qty: 1, unitPrice: 0, amount: 0 }]);
  await repo.versionRepo.replaceAll([{ id: 'v-search', projectId: 'p-search', name: '水池版本', totalCost: 0, lines: [] }]);
  await repo.indicatorRepo.replaceAll([{ metric: '水池单水造价(元/(m³·d))', typeKey: '水厂 / 中型 / 钢筋砼', n: 2, confidence: '仅参考' }]);
  await repo.experienceCardRepo.replaceAll([{ id: 'e-search', title: '水池防水报价经验', lesson: '防水报价需核对基层条件', reviewStatus: 'confirmed', projectNameSnapshot: '水池项目' }]);
  const results = await searchAll('水池');
  const types = new Set(results.map(r => r.type));
  assert.equal(types.has('quota'), true);
  assert.equal(types.has('boq_library'), true);
  assert.equal(types.has('project'), true);
  assert.equal(types.has('indicator'), true);
  assert.equal(types.has('experience'), true);
  assert.equal(results.every(r => r.targetView && r.params), true);
}

async function testAIAssistService() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.has(`ai:${key}`) ? memory.get(`ai:${key}`) : null,
    setItem: (key, value) => memory.set(`ai:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-ai-assist');
  const ai = await import('../assets/services/aiAssistService.js?v=test-ai-assist');
  await repo.quotaRepo.replaceAll([
    { id: 'q-ai-1', name: 'C30 钢筋混凝土池壁', feature: '混凝土强度等级：C30', category: '混凝土与钢筋', unit: 'm³', priceTotal: 780, tags: ['混凝土', '池壁'] },
    { id: 'q-ai-2', name: '池壁防水涂料', feature: '污水池内壁', category: '防水防腐', unit: 'm²', priceTotal: 118, tags: ['防水'] },
  ]);
  await repo.projectRepo.replaceAll([{ id: 'p-ai', name: '5 万吨/日 AAO 污水厂', type: '水厂', process: 'AAO' }]);
  await repo.boqRepo.replaceAll([
    { id: 'b-ai-1', projectId: 'p-ai', name: 'C30 钢筋混凝土池壁', feature: '', unit: '', qty: 10, factor: 1, unitPrice: 0, amount: 0 },
  ]);
  await repo.versionRepo.replaceAll([{ id: 'v-ai-1', projectId: 'p-ai', name: '上一版', totalCost: 100, lines: [] }]);
  await repo.indicatorRepo.replaceAll([{ metric: '总造价(元)', typeKey: '水厂', n: 1 }]);
  await repo.experienceCardRepo.replaceAll([{ id: 'e-ai', title: '防水经验', lesson: '防水需复核基层', reviewStatus: 'confirmed' }]);

  const line = (await repo.boqRepo.byProject('p-ai'))[0];
  const lineSuggestion = await ai.suggestBoqLine(line);
  assert.equal(lineSuggestion.suggestions.some(s => s.field === 'unit'), true);
  assert.equal(lineSuggestion.suggestions.some(s => s.field === 'unitPrice' && Number(s.suggestedValue) > 0), true);

  const missing = await ai.suggestMissingPrices([line]);
  assert.equal(missing.suggestions.length, 1);
  assert.equal(missing.suggestions[0].confidence, 'high');

  const mapping = await ai.suggestImportMapping(['项目名称', '工程量', '综合单价'], [{ 项目名称: '土方', 工程量: '10', 综合单价: '20' }]);
  assert.equal(mapping.suggestions.some(s => s.targetField === 'name' && s.sourceHeader === '项目名称'), true);
  assert.equal(mapping.suggestions.some(s => s.targetField === 'qty' && s.sourceHeader === '工程量'), true);

  const project = ai.suggestProjectInfo('某县污水厂二期 5 万吨/日 AAO 改扩建');
  assert.equal(project.suggestions.some(s => s.field === 'dailyCapacity' && s.suggestedValue === 5), true);
  assert.equal(project.suggestions.some(s => s.field === 'process' && s.suggestedValue === 'AAO'), true);

  const version = await ai.suggestVersionSummary('p-ai');
  assert.equal(version.suggestions.some(s => s.field === 'name'), true);
  assert.equal(version.suggestions.some(s => s.field === 'note'), true);

  const smart = await ai.smartSearch('找缺价最多的项目');
  assert.equal(smart.suggestions.some(s => s.targetView === 'boq' && s.params.priceStatus === 'missing'), true);

  const connection = await ai.testAIConnection();
  assert.equal(connection.confidence, 'low');

  const libraryItem = { name: 'C30 钢筋混凝土池壁', feature: '', unit: '', major: '', scope: '', structureGroup: '' };
  const localLibrary = await ai.suggestLibraryItem(libraryItem, await repo.quotaRepo.all());
  assert.equal(localLibrary.source, 'local');
  assert.equal(localLibrary.quotaSuggestions.length <= 5, true);
  assert.equal(localLibrary.quotaSuggestions[0].quotaId, 'q-ai-1');
  assert.equal(localLibrary.suggestions.some(s => s.field === 'feature' && s.apply === true), true);

  const protectedLibrary = await ai.suggestLibraryItem({ ...libraryItem, unit: '项', major: '人工确认专业' }, await repo.quotaRepo.all());
  assert.equal(protectedLibrary.suggestions.find(s => s.field === 'unit')?.apply, false);
  assert.equal(protectedLibrary.suggestions.find(s => s.field === 'major')?.apply, false);

  memory.set('ai:ai_config', JSON.stringify({ api_key: 'test-key', base_url: 'https://example.invalid/v1', model: 'test-model' }));
  globalThis.fetch = async () => { throw new Error('network unavailable'); };
  const fallbackLibrary = await ai.suggestLibraryItem(libraryItem, await repo.quotaRepo.all());
  assert.equal(fallbackLibrary.source, 'local');
  assert.equal(fallbackLibrary.warnings.some(w => w.includes('远端 AI')), true);

  // 远端建议可补充本地规则未覆盖的允许字段，且不得自动覆盖已有值。
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      fields: [{ field: 'scope', suggestedValue: '远端补充适用范围', confidence: 'high', reason: '远端语义判断' }],
      quotaIds: [],
    }) } }] }),
  });
  const remoteExtraField = await ai.suggestLibraryItem({ name: '未知工序', feature: '', unit: '', major: '', scope: '', structureGroup: '' }, await repo.quotaRepo.all());
  const scopeSuggestion = remoteExtraField.suggestions.find(s => s.field === 'scope');
  assert.equal(remoteExtraField.source, 'remote');
  assert.equal(scopeSuggestion?.suggestedValue, '远端补充适用范围');
  assert.equal(scopeSuggestion?.apply, true);

  // 无法解析或结构不合规的远端内容必须回退本地建议，并给出警告。
  for (const content of [
    '{not valid json',
    JSON.stringify({ fields: [{ field: 'feature', suggestedValue: '缺少 quotaIds' }] }),
    JSON.stringify({ fields: {}, quotaIds: [] }),
    JSON.stringify({ fields: [], quotaIds: 'q-ai-1' }),
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    });
    const invalidRemoteFallback = await ai.suggestLibraryItem(libraryItem, await repo.quotaRepo.all());
    assert.equal(invalidRemoteFallback.source, 'local');
    assert.equal(invalidRemoteFallback.warnings.some(w => w.includes('远端 AI')), true);
  }
  globalThis.fetch = undefined;

  const applied = applyLibraryAISuggestions(libraryItem, ['q-ai-2'], {
    suggestions: [
      { field: 'feature', suggestedValue: 'AI 补全特征', apply: true },
      { field: 'unit', suggestedValue: 'm³', apply: false },
      { field: 'code', suggestedValue: '不可修改', apply: true },
    ],
    quotaSuggestions: [{ quotaId: 'q-ai-1', apply: true }, { quotaId: 'q-ai-2', apply: false }],
  });
  assert.equal(applied.fields.feature, 'AI 补全特征');
  assert.equal(applied.fields.unit, undefined);
  assert.equal(applied.fields.code, undefined);
  assert.deepEqual(applied.quotaItemIds, ['q-ai-2', 'q-ai-1']);
}

async function testExperienceService() {
  const memory = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.localStorage = {
    getItem: key => memory.has(`ex:${key}`) ? memory.get(`ex:${key}`) : null,
    setItem: (key, value) => memory.set(`ex:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-experience');
  const { experienceService } = await import('../assets/services/experienceService.js?v=test-experience');
  await Promise.all([
    repo.projectRepo.replaceAll([{ id: 'p4', name: '经验项目', type: '水厂', scale: '中型', structure: '钢筋砼', process: 'AAO', status: 'doing', totalCost: 1500 }]),
    repo.boqRepo.replaceAll([
      { id: 'l41', projectId: 'p4', quotaItemId: 'q1', name: '防水卷材', feature: '池壁', unit: 'm²', qty: 10, factor: 1, unitPrice: 50, amount: 500 },
      { id: 'l42', projectId: 'p4', quotaItemId: '', name: '暂估设备', feature: '', unit: '台', qty: 1, factor: 1.3, unitPrice: 0, amount: 0 },
    ]),
    repo.versionRepo.replaceAll([{ id: 'v4', projectId: 'p4', name: '报审版', note: '提交前复盘', totalCost: 500, lineCount: 2, missingPriceCount: 1, lines: [] }]),
    repo.dataQualityReportRepo.replaceAll([{ id: 'r4', projectId: 'p4', qualityLevel: '需复核', qualityScore: 72, recommendations: ['补齐综合单价'], createdAt: '2026-01-01T00:00:00.000Z' }]),
    repo.experienceSessionRepo.replaceAll([]),
    repo.experienceCardRepo.replaceAll([]),
  ]);

  const session = await experienceService.startReview({ projectId: 'p4', versionId: 'v4', sourceType: 'version_saved' });
  assert.equal(session.projectId, 'p4');
  assert.equal(session.versionId, 'v4');
  assert.equal(session.questions.length >= 3, true);
  assert.equal(session.status, 'drafting');
  assert.equal(session.questionSource, 'local');
  assert.equal(typeof session.extraction.score, 'number');
  assert.equal(session.extraction.gaps.some(g => g.key === 'evidence'), true);

  globalThis.localStorage.setItem('ai_config', JSON.stringify({
    provider: 'test',
    base_url: 'https://example.test/v1',
    api_key: 'sk-test',
    model: 'test-model',
    system: 'test',
  }));
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            questions: [
              { id: 'ai_price_basis', label: '价格依据', prompt: 'AI：这次防水单价依据哪份询价或历史项目？' },
              { id: 'ai_risk_boundary', label: '风险边界', prompt: 'AI：暂估设备的价格边界如何向业主说明？' },
              { id: 'ai_reuse_condition', label: '复用条件', prompt: 'AI：哪些条件满足时这条经验才能复用？' },
            ],
          }),
        },
      }],
    }),
  });
  const aiSession = await experienceService.startReview({ projectId: 'p4', versionId: 'v4', sourceType: 'version_saved' });
  assert.equal(aiSession.questionSource, 'ai');
  assert.equal(aiSession.questions[0].id, 'ai_price_basis');
  assert.equal(aiSession.questions[0].prompt.includes('AI：'), true);
  globalThis.fetch = originalFetch;
  globalThis.localStorage.setItem('ai_config', JSON.stringify({}));
  const aiFallbackDraft = await experienceService.draftCard(aiSession.id, {
    ai_price_basis: '参考上一期 AAO 水厂池壁防水结算价，并补充本地询价。',
    ai_risk_boundary: '暂估设备必须注明品牌范围和二次询价机制。',
    ai_reuse_condition: '仅适用于池体结构和防水做法相近的中型水厂。',
  });
  assert.equal(aiFallbackDraft.lesson.includes('AAO 水厂池壁防水'), true);
  assert.equal(aiFallbackDraft.applicability.includes('中型水厂'), true);
  assert.equal(aiFallbackDraft.risks.includes('暂估设备'), true);
  assert.equal(typeof aiFallbackDraft.extractionScore, 'number');
  assert.equal(aiFallbackDraft.extraction.checks.some(item => item.key === 'boundary'), true);

  const refinedLocal = await experienceService.refineQuestions(session.id, {
    judgement: '防水按池壁做法计取。',
  });
  assert.equal(refinedLocal.followUpSource, 'local');
  assert.equal(refinedLocal.questions.some(q => q.level === 'L2'), true);
  assert.equal(refinedLocal.questions.some(q => q.id === 'followup_boundary'), true);
  assert.equal(refinedLocal.extraction.gaps.some(g => g.key === 'boundary'), true);

  globalThis.localStorage.setItem('ai_config', JSON.stringify({
    provider: 'test',
    base_url: 'https://example.test/v1',
    api_key: 'sk-test',
    model: 'test-model',
    system: 'test',
  }));
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            questions: [
              { id: 'ai_followup_evidence', label: '证据补充', prompt: 'AI：这条口径需要保留哪份询价或版本证据？' },
            ],
          }),
        },
      }],
    }),
  });
  const refinedAi = await experienceService.refineQuestions(aiSession.id, {
    ai_price_basis: '参考上一期 AAO 水厂池壁防水结算价。',
  });
  assert.equal(refinedAi.followUpSource, 'ai');
  assert.equal(refinedAi.questions.some(q => q.id === 'ai_followup_evidence' && q.level === 'L2'), true);
  globalThis.fetch = originalFetch;
  globalThis.localStorage.setItem('ai_config', JSON.stringify({}));

  const draft = await experienceService.draftCard(session.id, {
    judgement: '防水按池壁做法计取，暂估设备需二次询价。',
    reuse: 'AAO 水厂池体防水先按面积口径复核，再核对构造做法。',
    boundary: '若图纸构造层数变化，不直接复用。',
  });
  assert.equal(draft.title.includes('经验项目'), true);
  assert.equal(draft.category, '投标报价复盘');
  assert.equal(draft.status, undefined);
  assert.equal(draft.extractionScore >= 70, true);
  assert.equal(Array.isArray(draft.extractionGaps), true);

  const card = await experienceService.confirmCard(session.id, { title: 'AAO 水厂防水报价复盘' });
  assert.equal(card.status, 'confirmed');
  assert.equal(card.reviewStatus, 'confirmed');
  assert.equal(card.knowledgeType, '经验卡');
  assert.equal(card.projectType, '水厂');
  assert.equal(card.processType, 'AAO');
  assert.equal(card.keywords.includes('防水'), true);
  assert.equal(Array.isArray(card.evidenceRefs), true);
  assert.equal(card.extractionScore >= 70, true);
  assert.equal(card.extraction.checks.some(item => item.key === 'evidence'), true);
  assert.equal(Array.isArray(card.extractionGaps), true);
  assert.equal(card.reuseCount, 0);
  assert.equal(card.projectId, 'p4');
  assert.equal(card.projectNameSnapshot, '经验项目');
  assert.equal((await repo.experienceCardRepo.all()).length, 1);
  const updatedSession = await repo.experienceSessionRepo.findById(session.id);
  assert.equal(updatedSession.status, 'confirmed');

  const hits = await experienceService.searchCards('防水 经验', { type: '水厂', process: 'AAO' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, card.id);
  const afterSearch = await repo.experienceCardRepo.findById(card.id);
  assert.equal(afterSearch.reuseCount, 1);
  assert.equal(Boolean(afterSearch.lastUsedAt), true);

  await repo.experienceCardRepo.upsert({
    id: 'legacy-card',
    title: '旧卡片',
    projectId: 'p4',
    projectNameSnapshot: '经验项目',
    tags: ['水厂', '防水'],
    lesson: '旧经验也应该进入知识库',
    applicability: '同类项目参考',
    risks: '需复核',
    expiresAt: '2020-01-01',
    status: 'confirmed',
  });
  const kbAll = await experienceService.listKnowledgeBase({ keyword: '防水' });
  assert.equal(kbAll.items.some(item => item.id === 'legacy-card' && item.reviewStatus === 'confirmed'), true);
  assert.equal(kbAll.items.some(item => item.id === card.id), true);
  assert.equal(kbAll.items.find(item => item.id === 'legacy-card').extractionScore > 0, true);
  const kbFiltered = await experienceService.listKnowledgeBase({ projectType: '水厂', processType: 'AAO', status: 'confirmed' });
  assert.equal(kbFiltered.items.some(item => item.id === card.id), true);
  const expired = await experienceService.listKnowledgeBase({ expired: 'expired' });
  assert.equal(expired.items.some(item => item.id === 'legacy-card'), true);

  const reused = await experienceService.recordReuse(card.id);
  assert.equal(reused.reuseCount, 2);
  const needsReview = await experienceService.markNeedsReview(card.id, '市场价变化后复核');
  assert.equal(needsReview.reviewStatus, 'needs_review');
  assert.equal(needsReview.reviewNote, '市场价变化后复核');
  const archivedCard = await experienceService.archiveCard(card.id);
  assert.equal(archivedCard.reviewStatus, 'archived');
  const afterArchiveHits = await experienceService.searchCards('防水 经验', { type: '水厂', process: 'AAO' });
  assert.equal(afterArchiveHits.some(item => item.id === card.id), false);

  await repo.projectRepo.remove('p4');
  const afterProjectDelete = await repo.experienceCardRepo.all();
  assert.equal(afterProjectDelete.length, 2);
  assert.equal(afterProjectDelete.every(c => c.projectNameSnapshot === '经验项目'), true);
  globalThis.fetch = originalFetch;
}

async function testBoqLibraryService() {
  const memory = new Map();
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window = { idbKeyval: { get: async key => memory.get(key), set: async (key, value) => memory.set(key, value) } };
  const repo = await import('../assets/data/repository.js?v=1.0');
  const { boqLibraryService } = await import('../assets/services/boqLibraryService.js');
  await repo.projectRepo.replaceAll([{ id: 'library-project', name: '清单库测试项目', totalCost: 0 }]);
  await repo.quotaRepo.replaceAll([{ id: 'library-quota', name: '池壁定额', unit: 'm³', priceTotal: 680, useBreakdown: false }]);
  await repo.boqRepo.replaceAll([]);
  await repo.boqLibraryRepo.replaceAll([]);
  const item = await boqLibraryService.save({ code: 'LIB-001', name: '钢筋混凝土池壁', feature: 'C30 P6', unit: 'm³', defaultQty: 12, quotaItemIds: ['library-quota'] });
  const line = await boqLibraryService.applyToProject(item.id, 'library-project');
  assert.equal(line.boqLibraryItemId, item.id);
  assert.equal(line.unitPrice, 680);
  assert.equal(line.amount, 8160);
  const saved = await repo.boqLibraryRepo.findById(item.id);
  assert.equal(saved.referenceCount, 1);
  assert.equal(saved.lastReferencedProjectName, '清单库测试项目');
  const projectLineSnapshot = {
    name: line.name,
    feature: line.feature,
    unit: line.unit,
    qty: line.qty,
    unitPrice: line.unitPrice,
  };
  const edited = await boqLibraryService.save({
    ...saved,
    name: '复核后的池壁',
    feature: 'C35 P8',
    unit: 'm²',
    defaultQty: 99,
    quotaItemIds: [],
  });
  assert.equal(edited.id, item.id);
  assert.equal(edited.createdAt, item.createdAt);
  assert.equal(edited.referenceCount, 1);
  assert.equal(edited.lastReferencedProjectName, '清单库测试项目');
  assert.deepEqual(edited.quotaItemIds, []);
  const projectLineAfterLibraryEdit = (await repo.boqRepo.byProject('library-project')).find(row => row.id === line.id);
  assert.deepEqual({
    name: projectLineAfterLibraryEdit.name,
    feature: projectLineAfterLibraryEdit.feature,
    unit: projectLineAfterLibraryEdit.unit,
    qty: projectLineAfterLibraryEdit.qty,
    unitPrice: projectLineAfterLibraryEdit.unitPrice,
  }, projectLineSnapshot);
  await assert.rejects(() => boqLibraryService.save({ code: 'LIB-001', name: '重复编码', unit: '项' }), /已存在相同清单/);
  await assert.rejects(() => boqLibraryService.save({ name: '复核后的池壁', feature: 'C35 P8', unit: 'm²' }), /已存在相同清单/);
  await repo.boqRepo.update(line.id, { qty: 20 });
  assert.equal((await repo.boqLibraryRepo.findById(item.id)).defaultQty, 99);

  const noPrice = await boqLibraryService.save({ code: 'LIB-002', name: '未匹配项', unit: '项', quotaItemIds: [] });
  const noPriceLine = await boqLibraryService.applyToProject(noPrice.id, 'library-project');
  assert.equal(noPriceLine.priceMissing, true);
  assert.equal(noPriceLine.quotaItemId, '');
}

async function testBuiltinDemoData() {
  const memory = new Map();
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}` },
      configurable: true,
    });
  }
  globalThis.localStorage = {
    getItem: key => memory.has(`demo:${key}`) ? memory.get(`demo:${key}`) : null,
    setItem: (key, value) => memory.set(`demo:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=test-demo');
  const { ensureDemoData } = await import('../assets/data/demo.js?v=test-demo');

  await Promise.all([
    repo.quotaRepo.replaceAll([]),
    repo.boqLibraryRepo.replaceAll([]),
    repo.projectRepo.replaceAll([]),
    repo.boqRepo.replaceAll([]),
    repo.versionRepo.replaceAll([]),
    repo.indicatorRepo.replaceAll([]),
    repo.dataFactRepo.replaceAll([]),
    repo.dataCandidateRepo.replaceAll([]),
    repo.dataJobRepo.replaceAll([]),
    repo.dataQualityReportRepo.replaceAll([]),
    repo.experienceSessionRepo.replaceAll([]),
    repo.experienceCardRepo.replaceAll([]),
  ]);

  const first = await ensureDemoData();
  assert.equal(first.loaded, true);
  assert.equal((await repo.projectRepo.all()).length, 3);
  assert.equal((await repo.quotaRepo.all()).length >= 10, true);
  assert.equal((await repo.boqLibraryRepo.all()).length >= 5, true);
  assert.equal((await repo.boqRepo.all()).length >= 20, true);
  assert.equal((await repo.versionRepo.all()).length >= 3, true);
  assert.equal((await repo.dataFactRepo.all()).some(f => f.sourceType === 'archived_project'), true);

  const second = await ensureDemoData();
  assert.equal(second.loaded, false);
  assert.equal((await repo.projectRepo.all()).length, 3);
}
