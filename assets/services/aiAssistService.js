// AI 辅助建议服务：本地规则优先，远端模型作为增强
import { getAIConfig } from './aiService.js?v=6.6';
import { testConnection as remoteTestConnection } from '../ai/remoteLLM.js?v=6.6';
import { quotaRepo, projectRepo, boqRepo, versionRepo, indicatorRepo, experienceCardRepo } from '../data/repository.js?v=6.6';
import { boqService } from './boqService.js?v=6.6';
import { versionService } from './versionService.js?v=6.6';
import { searchAll } from './globalSearchService.js?v=6.6';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.6';
import { categoryGuess } from '../utils/stats.js?v=6.6';
import { buildImportMapping } from './importMappingService.js?v=6.6';

export async function suggestBoqLine(line = {}, context = {}) {
  const quotas = context.quotas || await quotaRepo.all();
  const candidates = rankQuotas(quotas, line).slice(0, 5);
  const best = candidates[0] || null;
  const unit = line.unit || best?.unit || inferUnit(line.name, line.feature);
  const feature = line.feature || inferFeature(line.name, context.project);
  const unitPrice = hasMissingPrice(line.unitPrice) ? Number(best?.priceTotal || categoryAverage(await boqRepo.all(), line) || rulePrice(line)) : Number(line.unitPrice || best?.priceTotal || 0);
  const confidence = best?.score >= 6 ? 'high' : best?.score >= 3 ? 'medium' : 'low';
  const suggestions = [
    suggestion('feature', line.feature || '', feature, confidence, best ? `参考相似定额「${best.name}」补充项目特征` : '根据清单名称生成常用项目特征'),
    suggestion('unit', line.unit || '', unit, confidence, best ? `参考相似定额单位「${best.unit || unit}」` : '根据清单名称关键词判断单位'),
    suggestion('unitPrice', line.unitPrice || 0, round2(unitPrice), confidence, best ? `参考企业定额「${best.name}」综合单价` : '基于同类清单均价或本地规则估算'),
    suggestion('quotaId', line.quotaItemId || '', best?.id || '', confidence, best ? `匹配到相似定额，得分 ${best.score.toFixed(1)}` : '未找到高匹配定额'),
    suggestion('priceNote', '', best ? `价格参考：${best.name}，${best.unit || '-'}，${round2(best.priceTotal || 0)} 元` : '价格参考：本地规则估算，建议人工复核', confidence, '用于保存前复核价格来源'),
  ].filter(item => item.suggestedValue !== '' && item.suggestedValue != null);
  return wrap({
    source: 'local',
    confidence,
    summary: best ? `已找到相似定额「${best.name}」，可补全当前清单。` : '未找到高匹配定额，已按关键词生成保守建议。',
    suggestions,
    warnings: confidence === 'low' ? ['建议仅作为草稿，保存前请人工复核价格。'] : [],
  });
}

// 清单库维护专用：只生成可选择的字段与定额建议，不写入任何数据。
export async function suggestLibraryItem(item = {}, quotas) {
  const availableQuotas = Array.isArray(quotas) ? quotas : await quotaRepo.all();
  const local = buildLocalLibrarySuggestion(item, availableQuotas);
  const cfg = getAIConfig();
  if (!cfg.api_key) return local;
  try {
    const remote = await enhanceLibrarySuggestion(item, local, cfg);
    return mergeRemoteLibrarySuggestion(item, local, remote);
  } catch (err) {
    return wrap({
      ...local,
      warnings: [...(local.warnings || []), `远端 AI 增强不可用，已保留本地建议：${String(err?.message || err).slice(0, 120)}`],
    });
  }
}

export async function suggestMissingPrices(lines = [], context = {}) {
  const quotas = context.quotas || await quotaRepo.all();
  const allBoq = await boqRepo.all();
  const suggestions = [];
  for (const line of lines.filter(line => hasMissingPrice(line.unitPrice))) {
    const best = rankQuotas(quotas, line)[0];
    const avg = categoryAverage(allBoq, line);
    const price = Number(best?.priceTotal || avg || rulePrice(line));
    const confidence = best?.score >= 6 ? 'high' : best?.score >= 3 || avg ? 'medium' : 'low';
    suggestions.push({
      lineId: line.id,
      lineName: line.name || '未命名清单',
      unit: line.unit || best?.unit || inferUnit(line.name, line.feature),
      currentPrice: Number(line.unitPrice || 0),
      suggestedPrice: round2(price),
      sourceType: best ? 'quota' : avg ? 'category_avg' : 'rule',
      sourceLabel: best ? best.name : avg ? `${categoryGuess(line.name)} 同类均价` : '本地估算规则',
      confidence,
      reason: best ? `匹配企业定额，得分 ${best.score.toFixed(1)}` : avg ? '取当前项目/历史清单同类有效单价均值' : '根据单位和清单类型给出保守建议',
      apply: confidence === 'high',
    });
  }
  return wrap({
    source: 'local',
    confidence: suggestions.some(s => s.confidence === 'high') ? 'high' : suggestions.length ? 'medium' : 'low',
    summary: suggestions.length ? `已为 ${suggestions.length} 条缺单价清单生成补价建议。` : '当前没有缺单价清单。',
    suggestions,
    warnings: suggestions.some(s => s.confidence !== 'high') ? ['中低置信度建议默认不勾选，请人工确认后再应用。'] : [],
  });
}

export async function suggestImportMapping(headers = [], sampleRows = []) {
  const result = buildImportMapping(headers, sampleRows);
  const suggestions = Object.values(result.fields)
    .filter(field => field.candidateSource)
    .map(field => ({ ...field, targetField: field.key, sourceHeader: field.candidateSource }));
  const confirmed = suggestions.filter(field => field.status === 'confirmed').length;
  const pending = suggestions.filter(field => field.status === 'needs-review').length;
  return wrap({
    source: 'local',
    confidence: pending ? 'medium' : 'high',
    summary: `已确认 ${confirmed} 个字段映射${pending ? `，${pending} 个字段需要确认` : ''}。`,
    suggestions,
    warnings: pending ? ['低置信候选不会自动应用，请在字段映射区确认。'] : [],
    mapping: result.mapping,
    fields: result.fields,
  });
}

export function suggestImportRepairs(rows = [], quality = {}) {
  const suggestions = [];
  (quality.missingUnit || []).slice(0, 20).forEach(row => suggestions.push({ rowIndex: row.index, type: 'missing_unit', suggestion: `建议单位填为 ${inferUnit(row.name, row.feature)}`, confidence: 'medium', reason: '根据清单名称和项目特征判断' }));
  (quality.missingPrice || []).slice(0, 20).forEach(row => suggestions.push({ rowIndex: row.index, type: 'missing_price', suggestion: '建议导入后使用 AI 补缺价，从定额库或同类清单补价。', confidence: 'medium', reason: '导入阶段不直接写入价格' }));
  (quality.zeroQty || []).slice(0, 20).forEach(row => suggestions.push({ rowIndex: row.index, type: 'zero_qty', suggestion: '建议确认是否暂估项；正式归档前应补齐工程量。', confidence: 'high', reason: '工程量为 0 会影响合价和指标' }));
  (quality.unknownCategory || []).slice(0, 20).forEach(row => suggestions.push({ rowIndex: row.index, type: 'unknown_category', suggestion: `建议分类为 ${categoryGuess(row.name || row.feature || '')}`, confidence: 'medium', reason: '按关键词归类' }));
  (quality.duplicates || []).slice(0, 20).forEach(row => suggestions.push({ rowIndex: row.index, type: 'duplicate', suggestion: '疑似重复清单，建议合并或保留一条。', confidence: 'medium', reason: '名称、特征或单位重复' }));
  return wrap({ source: 'local', confidence: suggestions.length ? 'medium' : 'high', summary: suggestions.length ? `生成 ${suggestions.length} 条导入修复建议。` : '未发现需要 AI 修复的导入问题。', suggestions, warnings: [] });
}

export async function suggestQuotaBatchCleanup(items = []) {
  const suggestions = items.slice(0, 80).map(item => {
    const intent = quotaIntent(item);
    const unit = item.unit || inferUnit(item.name, item.feature);
    return {
      id: item.id,
      name: item.name,
      category: item.category || categoryByIntent(intent),
      unit,
      tags: [...new Set([...(item.tags || []), ...tagsByIntent(intent)])],
      feature: item.feature || inferFeature(item.name),
      work: item.work || workByIntent(intent),
      rule: item.rule || ruleByUnit(unit),
      confidence: item.name ? 'medium' : 'low',
      reason: '按名称、特征和单位补齐定额基础字段',
      apply: Boolean(item.id),
    };
  });
  return wrap({ source: 'local', confidence: 'medium', summary: `已生成 ${suggestions.length} 条定额清洗建议。`, suggestions, warnings: suggestions.length >= 80 ? ['仅预览前 80 条建议。'] : [] });
}

export function suggestProjectInfo(projectName = '') {
  const text = String(projectName || '');
  const daily = extractDailyCapacity(text);
  const process = (text.match(/AAO|A2O|MBR|SBR|氧化沟|CAST|CASS/i)?.[0] || '').toUpperCase();
  const type = /住宅|住宅楼|商品房/.test(text) ? '住宅建筑' : /房建|房屋建筑|建筑工程/.test(text) ? '房屋建筑' : /公共建筑|学校|医院|办公楼|商业综合体/.test(text) ? '公共建筑' : /工业厂房|厂房|工业园/.test(text) ? '工业厂房' : /工业废水|工业污水/.test(text) ? '工业废水' : /园区/.test(text) ? '园区建设' : /道路|公路|路基|路面/.test(text) ? '市政道路' : /桥梁|隧道/.test(text) ? '桥梁隧道' : /管廊/.test(text) ? '综合管廊' : /水利|河道|闸站|灌溉/.test(text) ? '水利工程' : /电力|输电|配电/.test(text) ? '电力工程' : /再生水|中水/.test(text) ? '再生水厂' : /污泥/.test(text) ? '污泥处理' : /调蓄/.test(text) ? '调蓄池' : /泵站/.test(text) ? '泵站' : /管网|管道/.test(text) ? '管网' : /水厂|污水|处理厂/.test(text) ? '污水处理厂' : '水厂';
  const structure = /钢结构/.test(text) ? '钢结构' : /砖混/.test(text) ? '砖混' : /改扩建|二期|水池|污水/.test(text) ? '钢筋砼' : '';
  return wrap({
    source: 'local',
    confidence: text ? 'medium' : 'low',
    summary: daily || process ? '已从项目名称识别关键参数。' : '项目信息较少，已给出默认项目口径。',
    suggestions: [
      { field: 'type', suggestedValue: type, confidence: 'medium', reason: '按项目名称关键词识别' },
      { field: 'dailyCapacity', suggestedValue: daily || '', confidence: daily ? 'high' : 'low', reason: '识别“万吨/日、万m³/d”等容量表达' },
      { field: 'scale', suggestedValue: scaleByDaily(daily), confidence: daily ? 'medium' : 'low', reason: '按日处理量分规模' },
      { field: 'process', suggestedValue: process, confidence: process ? 'high' : 'low', reason: '识别常见污水处理工艺' },
      { field: 'structure', suggestedValue: structure, confidence: structure ? 'medium' : 'low', reason: '按项目名称关键词识别结构形式' },
    ].filter(s => s.suggestedValue !== ''),
    warnings: [],
  });
}

export async function suggestVersionSummary(projectId) {
  const [project, lines, versions] = await Promise.all([
    projectRepo.findById(projectId),
    boqRepo.byProject(projectId),
    versionService.listByProject(projectId),
  ]);
  const total = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const missing = lines.filter(line => hasMissingPrice(line.unitPrice)).length;
  const zeroQty = lines.filter(line => !(Number(line.qty) > 0)).length;
  const prev = versions[0];
  const delta = prev ? total - Number(prev.totalCost || 0) : 0;
  const name = `${missing ? '补价' : prev ? '调整' : '初版'} · ${new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16)}`;
  const note = [
    `${project?.name || '当前项目'}报价版本，清单 ${lines.length} 条，总造价 ${formatMoney(total)}。`,
    prev ? `较上一版本${delta >= 0 ? '增加' : '减少'} ${formatMoney(Math.abs(delta))}。` : '作为后续调价和审查的初始快照。',
    missing ? `仍有 ${missing} 条缺单价，建议补齐后再作为正式报审。` : '当前价格完整度较好。',
    zeroQty ? `存在 ${zeroQty} 条 0 工程量，请复核是否暂估项。` : '',
  ].filter(Boolean).join('\n');
  return wrap({ source: 'local', confidence: 'high', summary: '已生成版本名称和说明。', suggestions: [{ field: 'name', suggestedValue: name, confidence: 'high', reason: '按版本状态和时间生成' }, { field: 'note', suggestedValue: note, confidence: 'high', reason: '按当前清单、上一版本和风险项生成' }], warnings: [] });
}

export async function reviewQuote(projectId) {
  const [project, lines, versions, indicators] = await Promise.all([
    projectRepo.findById(projectId),
    boqRepo.byProject(projectId),
    versionRepo.byProject(projectId),
    indicatorRepo.all(),
  ]);
  const missing = lines.filter(line => hasMissingPrice(line.unitPrice));
  const zeroQty = lines.filter(line => !(Number(line.qty) > 0));
  const factorRisk = lines.filter(line => Number(line.factor || 1) > 1.2 || Number(line.factor || 1) < 0.8);
  const duplicates = duplicateLines(lines);
  const total = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const score = Math.max(0, 100 - missing.length * 12 - zeroQty.length * 10 - factorRisk.length * 5 - duplicates.length * 8 - (versions.length ? 0 : 8));
  const issues = [
    ...issueList('missing_price', '缺单价风险', missing, '先使用 AI 补缺价或手工补价，避免低估总造价。'),
    ...issueList('zero_qty', '工程量风险', zeroQty, '确认是否暂估项；正式归档前建议补齐工程量。'),
    ...issueList('factor_risk', '系数异常', factorRisk, '复核调价系数依据。'),
    ...issueList('duplicate', '疑似重复项', duplicates, '检查是否重复计量。'),
    ...(versions.length ? [] : [{ type: 'no_version', title: '未保存版本', count: 1, lines: [], action: '保存报审版报价快照。' }]),
  ];
  return wrap({
    source: 'local',
    confidence: lines.length ? 'high' : 'low',
    summary: `${project?.name || '当前项目'}审查完成：健康分 ${score}，${issues.length ? `发现 ${issues.length} 类风险` : '暂未发现明显风险'}。`,
    suggestions: issues,
    warnings: indicators.length < 3 ? ['指标样本不足，偏离判断仅作提示。'] : [],
    meta: { score, level: score >= 85 ? '可报审' : score >= 65 ? '需复核' : '高风险', totalCost: total, lineCount: lines.length, versionCount: versions.length },
  });
}

export function draftExperience(source = {}) {
  const title = source.title || `${source.projectName || '当前项目'}报价复盘`;
  return wrap({
    source: 'local',
    confidence: 'medium',
    summary: '已生成经验卡草稿。',
    suggestions: [{
      title,
      category: source.category || '报价审查',
      trigger: source.trigger || '报价审查、版本保存或项目归档后生成',
      lesson: source.lesson || '先处理缺单价、0 工程量和异常系数，再保存版本并归档指标样本。',
      applicability: source.applicability || '适用于污水处理项目报价编制、报审前复核和归档复盘。',
      risks: source.risks || '样本不足或清单口径不一致时，经验仅作为参考。',
      confidence: '中',
      expiresAt: nextYear(),
      tags: ['报价审查', '风险复盘', 'AI 草稿'],
    }],
    warnings: [],
  });
}

export function parseEstimatePrompt(text = '') {
  const daily = extractDailyCapacity(text);
  const areaMatch = String(text).match(/(\d+(?:\.\d+)?)\s*(?:公顷|ha)/i);
  const areaSqm = areaMatch ? Number(areaMatch[1]) * 10000 : Number(String(text).match(/(\d+(?:\.\d+)?)\s*(?:㎡|平米|平方米)/)?.[1] || '');
  const process = (String(text).match(/AAO|A2O|MBR|SBR|氧化沟|CAST|CASS/i)?.[0] || '').toUpperCase();
  const type = /住宅|住宅楼|商品房/.test(text) ? '住宅建筑' : /房建|房屋建筑|建筑工程/.test(text) ? '房屋建筑' : /公共建筑|学校|医院|办公楼|商业综合体/.test(text) ? '公共建筑' : /工业厂房|厂房|工业园/.test(text) ? '工业厂房' : /工业废水|工业污水/.test(text) ? '工业废水' : /道路|公路|路基|路面/.test(text) ? '市政道路' : /桥梁|隧道/.test(text) ? '桥梁隧道' : /管廊/.test(text) ? '综合管廊' : /水利|河道|闸站|灌溉/.test(text) ? '水利工程' : /电力|输电|配电/.test(text) ? '电力工程' : /再生水|中水/.test(text) ? '再生水厂' : /污泥/.test(text) ? '污泥处理' : /泵站/.test(text) ? '泵站' : /管网/.test(text) ? '管网' : /污水|水厂|处理厂/.test(text) ? '污水处理厂' : '';
  return wrap({
    source: 'local',
    confidence: daily || areaSqm || process ? 'high' : 'low',
    summary: '已从描述中提取估算参数。',
    suggestions: [
      { field: 'dailyCapacity', suggestedValue: daily || '', confidence: daily ? 'high' : 'low', reason: '识别日处理量' },
      { field: 'area', suggestedValue: areaSqm || '', confidence: areaSqm ? 'high' : 'low', reason: '识别占地/建筑面积' },
      { field: 'process', suggestedValue: process, confidence: process ? 'high' : 'low', reason: '识别工艺' },
      { field: 'type', suggestedValue: type, confidence: type ? 'medium' : 'low', reason: '识别项目类型' },
    ].filter(s => s.suggestedValue !== ''),
    warnings: [],
  });
}

export function explainIndicators(context = {}) {
  const est = context.estimate || {};
  const parts = [];
  if (est.byArea) parts.push(`按单方造价估算中值 ${formatMoney(est.byArea.mid)}，参考样本 ${est.byArea.n || 0} 个。`);
  if (est.byWater) parts.push(`按单水造价估算中值 ${formatMoney(est.byWater.mid)}，参考样本 ${est.byWater.n || 0} 个。`);
  if (!parts.length) parts.push('当前筛选下样本不足，不能形成强结论。');
  const lowSample = [est.byArea, est.byWater].some(v => v && Number(v.n || 0) < 3);
  return wrap({ source: 'local', confidence: lowSample ? 'low' : 'medium', summary: parts.join('\n'), suggestions: [{ title: '指标解读', text: parts.join('\n'), confidence: lowSample ? 'low' : 'medium', reason: lowSample ? '样本数不足' : '基于当前筛选指标区间' }], warnings: lowSample ? ['样本不足，请放宽筛选或补充归档样本。'] : [] });
}

export async function smartSearch(keyword = '') {
  const results = await searchAll(keyword);
  const kw = String(keyword || '');
  const extras = [];
  if (/缺价|缺单价|0单价/.test(kw)) {
    const [projects, lines] = await Promise.all([projectRepo.all(), boqRepo.all()]);
    projects.forEach(project => {
      const missing = lines.filter(line => line.projectId === project.id && hasMissingPrice(line.unitPrice));
      if (missing.length) extras.push({ id: `project-missing:${project.id}`, type: 'project', title: `${project.name} 缺价 ${missing.length} 条`, subtitle: '点击进入清单并筛选缺单价', targetView: 'boq', params: { projectId: project.id, priceStatus: 'missing' }, reason: '自然语言识别为缺价查询', actionLabel: '补缺价', icon: 'folder_managed', score: 120 });
    });
  }
  if (/推荐|定额/.test(kw) && !results.some(r => r.type === 'quota')) {
    extras.push({ id: 'quota-recommend', type: 'quota', title: '打开定额库推荐', subtitle: kw, targetView: 'quota', params: { keyword: kw.replace(/推荐|定额|找|查/g, '').trim() }, reason: '自然语言识别为定额推荐', actionLabel: '打开定额库', icon: 'menu_book', score: 80 });
  }
  return wrap({ source: 'local', confidence: 'medium', summary: `找到 ${results.length + extras.length} 个结果。`, suggestions: [...extras, ...results].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 24), warnings: [] });
}

export async function testAIConnection() {
  const cfg = getAIConfig();
  if (!cfg.api_key) return wrap({ source: 'local', confidence: 'low', summary: '未配置 API Key，远端 AI 不可用；本地 AI 建议仍可使用。', suggestions: [], warnings: ['请先填写 API Key 后再测试远端模型。'] });
  try {
    await remoteTestConnection();
    return wrap({ source: 'remote', confidence: 'high', summary: 'AI 连接成功。', suggestions: [], warnings: [] });
  } catch (err) {
    return wrap({ source: 'local', confidence: 'low', summary: `AI 连接失败：${err.message || err}` , suggestions: [], warnings: ['已保留本地 AI 兜底能力。'] });
  }
}

function wrap(obj) {
  return { source: 'local', confidence: 'medium', summary: '', suggestions: [], warnings: [], ...obj };
}

function suggestion(field, currentValue, suggestedValue, confidence, reason) {
  return { field, currentValue, suggestedValue, confidence, reason, apply: confidence === 'high' || !currentValue };
}

function buildLocalLibrarySuggestion(item = {}, quotas = []) {
  const candidates = rankQuotas(quotas, item).slice(0, 5);
  const best = candidates[0];
  const confidence = best?.score >= 6 ? 'high' : best?.score >= 3 ? 'medium' : 'low';
  const text = `${item.name || ''} ${item.feature || ''}`;
  const major = /水|污水|水池|泵|曝气|格栅/.test(text) ? '水处理工程' : /管道|电缆|阀门/.test(text) ? '安装工程' : /土方|混凝土|砼|钢筋|防水/.test(text) ? '土建工程' : '';
  const scope = /污水|水池|曝气|格栅|泵/.test(text) ? '市政污水处理工程' : '';
  const structureGroup = /土方|混凝土|砼|钢筋|防水/.test(text) ? 'civil' : /管道|电缆|阀门|设备/.test(text) ? 'installation' : '';
  const fields = [
    libraryFieldSuggestion('feature', item.feature, inferFeature(item.name), confidence, best ? `参考相似定额「${best.name}」补充项目特征` : '根据清单名称生成常用项目特征'),
    libraryFieldSuggestion('unit', item.unit, best?.unit || inferUnit(item.name, item.feature), confidence, best ? `参考相似定额单位「${best.unit || '-'}」` : '根据清单名称和项目特征判断单位'),
    libraryFieldSuggestion('major', item.major, major, major ? 'medium' : 'low', '按清单名称识别工程专业'),
    libraryFieldSuggestion('scope', item.scope, scope, scope ? 'medium' : 'low', '按清单名称识别适用范围'),
    libraryFieldSuggestion('structureGroup', item.structureGroup, structureGroup, structureGroup ? 'medium' : 'low', '按清单内容归入土建或安装分组'),
  ].filter(entry => entry.suggestedValue !== '');
  const quotaSuggestions = candidates.map(quota => {
    const quotaConfidence = quota.score >= 6 ? 'high' : quota.score >= 3 ? 'medium' : 'low';
    return { quotaId: quota.id, code: quota.code || '', name: quota.name || '', unit: quota.unit || '', confidence: quotaConfidence, reason: `名称、特征和单位匹配得分 ${quota.score.toFixed(1)}`, apply: quotaConfidence === 'high' };
  });
  return wrap({
    source: 'local', confidence, summary: best ? `已按本地定额库推荐 ${quotaSuggestions.length} 条关联定额。` : '未找到高匹配定额，已生成保守字段建议。',
    suggestions: fields,
    quotaSuggestions,
    warnings: fields.some(entry => entry.confidence === 'low') || quotaSuggestions.some(entry => entry.confidence === 'low') ? ['低置信度建议默认不勾选，请人工确认。'] : [],
  });
}

function libraryFieldSuggestion(field, currentValue, suggestedValue, confidence, reason) {
  return { field, currentValue: String(currentValue || ''), suggestedValue, confidence, reason, apply: !currentValue && confidence === 'high' };
}

async function enhanceLibrarySuggestion(item, local, cfg) {
  const candidates = (local.quotaSuggestions || []).map(quota => ({ id: quota.quotaId, code: quota.code, name: quota.name, unit: quota.unit }));
  const prompt = `为工程量清单库生成保守的辅助建议。仅返回 JSON，不要 Markdown：{"fields":[{"field":"feature|unit|major|scope|structureGroup","suggestedValue":"","confidence":"high|medium|low","reason":""}],"quotaIds":["候选定额ID"]}。不得建议 code、defaultQty、source、version、status、note 或引用字段。当前清单：${JSON.stringify({ code: item.code || '', name: item.name || '', feature: item.feature || '', unit: item.unit || '', major: item.major || '', scope: item.scope || '', structureGroup: item.structureGroup || '' })}。候选定额：${JSON.stringify(candidates)}`;
  const url = String(cfg.base_url || '').replace(/\/$/, '') + '/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: '你是工程造价清单库助手，严格返回 JSON。' }, { role: 'user', content: prompt }], temperature: 0.1, stream: false }),
  });
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw new Error('远端返回为空');
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  if (!Array.isArray(parsed.fields) || !Array.isArray(parsed.quotaIds)) throw new Error('远端返回格式无效');
  return parsed;
}

function mergeRemoteLibrarySuggestion(item, local, remote) {
  const allowed = new Set(['feature', 'unit', 'major', 'scope', 'structureGroup']);
  const remoteFields = new Map((remote.fields || [])
    .filter(entry => allowed.has(entry?.field) && String(entry.suggestedValue || '').trim())
    .map(entry => [entry.field, entry]));
  const localFields = new Set();
  const mergeField = field => {
    const remoteEntry = remoteFields.get(field);
    if (!remoteEntry) return null;
    const confidence = ['high', 'medium', 'low'].includes(remoteEntry.confidence) ? remoteEntry.confidence : 'medium';
    return libraryFieldSuggestion(field, item[field], String(remoteEntry.suggestedValue).trim(), confidence, String(remoteEntry.reason || '远端模型结合候选定额判断'));
  };
  const suggestions = (local.suggestions || []).map(localEntry => {
    localFields.add(localEntry.field);
    return mergeField(localEntry.field) || localEntry;
  });
  // 远端模型可以补足本地关键词规则没有生成的允许字段。
  for (const field of allowed) {
    if (!localFields.has(field) && remoteFields.has(field)) suggestions.push(mergeField(field));
  }
  const allowedQuotaIds = new Set((local.quotaSuggestions || []).map(entry => entry.quotaId));
  const remoteQuotaIds = new Set((remote.quotaIds || []).filter(id => allowedQuotaIds.has(id)));
  const quotaSuggestions = (local.quotaSuggestions || []).map(entry => ({ ...entry, apply: remoteQuotaIds.has(entry.quotaId) && entry.confidence === 'high', reason: remoteQuotaIds.has(entry.quotaId) ? `${entry.reason}；远端模型确认` : entry.reason }));
  return wrap({ ...local, source: 'remote', summary: '已结合远端 AI 与本地定额库生成建议。', suggestions, quotaSuggestions });
}

function rankQuotas(quotas, line) {
  const source = `${line?.name || ''} ${line?.feature || ''}`.trim().toLowerCase();
  const words = source.split(/[\s,，;；、/]+/).filter(word => word.length > 1);
  return quotas.map(item => {
    const blob = `${item.name || ''} ${item.feature || ''} ${(item.tags || []).join(' ')} ${item.category || ''}`.toLowerCase();
    const exact = source && blob.includes(source) ? 4 : 0;
    const wordScore = words.reduce((sum, word) => sum + (blob.includes(word) ? 1 : 0), 0);
    const unitScore = item.unit && line?.unit && item.unit === line.unit ? 1.5 : 0;
    const priceScore = hasMissingPrice(item.priceTotal) ? -1 : 1;
    return { ...item, score: exact + wordScore + unitScore + priceScore };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
}

function categoryAverage(lines, line) {
  const cat = categoryGuess(line?.name || '');
  const matched = lines.filter(item => item.id !== line?.id && !hasMissingPrice(item.unitPrice) && categoryGuess(item.name || '') === cat);
  if (!matched.length) return 0;
  return matched.reduce((sum, item) => sum + Number(item.unitPrice || 0), 0) / matched.length;
}

function rulePrice(line = {}) {
  const unit = line.unit || inferUnit(line.name, line.feature);
  const cat = categoryGuess(line.name || line.feature || '');
  if (unit === 'm³' && /土|挖|回填/.test(cat + line.name)) return 35;
  if (unit === 'm³' && /混凝土|砼/.test(line.name || '')) return 520;
  if (unit === 'm²' && /防水|防腐|涂料/.test(line.name || '')) return 95;
  if (unit === 'm') return 120;
  if (unit === 't') return 4200;
  if (unit === '台' || unit === '套') return 800;
  return 100;
}

function inferUnit(name = '', feature = '') {
  const text = `${name} ${feature}`;
  if (/钢筋/.test(text)) return 't';
  if (/防水|防腐|涂料|模板|抹灰|找平|铺贴/.test(text)) return 'm²';
  if (/管道|管线|电缆|桥架|桩|栏杆/.test(text)) return 'm';
  if (/设备|水泵|泵|阀门|格栅|风机|搅拌机/.test(text)) return '台';
  if (/土方|开挖|回填|混凝土|砼|垫层|砂石|碎石|池壁|底板/.test(text)) return 'm³';
  return '';
}

function inferFeature(name = '', project = {}) {
  const text = String(name || '');
  if (/混凝土|砼|池壁|底板/.test(text)) return '混凝土强度等级：按设计；构件部位：水池构筑物；施工方式：泵送浇筑。';
  if (/防水|防腐|涂料/.test(text)) return '基层类型：钢筋混凝土；部位：污水池内壁；防腐防水等级：按设计。';
  if (/土方|开挖/.test(text)) return '土壤类别：综合；开挖深度：按设计；施工方式：机械为主、人工配合。';
  if (/回填/.test(text)) return '回填材料：按设计；压实系数：按设计；施工方式：分层回填夯实。';
  if (/管道|管线/.test(text)) return `管材及规格：按设计；连接方式：按设计；项目类型：${project?.type || '污水处理工程'}。`;
  return '';
}

function quotaIntent(item) {
  const text = `${item.name || ''} ${item.feature || ''}`;
  if (/防水|防腐|涂料|卷材/.test(text)) return 'waterproof';
  if (/土方|挖土|开挖|回填|运土|弃土/.test(text)) return 'earthwork';
  if (/钢筋/.test(text)) return 'rebar';
  if (/混凝土|砼|垫层|池壁|底板/.test(text)) return 'concrete';
  if (/管道|管线|电缆|桥架|阀门/.test(text)) return 'pipe';
  if (/设备|水泵|泵|格栅|曝气|风机|搅拌机/.test(text)) return 'equipment';
  return 'default';
}

function categoryByIntent(intent) {
  return ({ earthwork: '土石方与支护', concrete: '混凝土与钢筋', rebar: '混凝土与钢筋', waterproof: '防水防腐', pipe: '安装管线', equipment: '安装设备', default: '其他' })[intent] || '其他';
}

function tagsByIntent(intent) {
  return ({ earthwork: ['土方', '机械'], concrete: ['混凝土', '水池'], rebar: ['钢筋', '绑扎'], waterproof: ['防水', '防腐'], pipe: ['管道', '安装'], equipment: ['设备', '安装'], default: ['企业定额'] })[intent] || [];
}

function workByIntent(intent) {
  return ({ earthwork: '测量放线、机械开挖、修坡清底、装车外运。', concrete: '混凝土运输、浇筑、振捣、养护及成品保护。', rebar: '钢筋制作、绑扎、安装定位、保护层控制。', waterproof: '基层清理、节点处理、防水防腐施工、收头密封。', pipe: '材料转运、下料、安装连接、试压检查。', equipment: '开箱检查、吊装就位、找平找正、固定及单机检查。', default: '施工准备、材料转运、安装施工、质量检查。' })[intent] || '';
}

function ruleByUnit(unit) {
  if (unit === 'm³') return '按设计图示尺寸以体积计算。';
  if (unit === 'm²') return '按设计图示尺寸以面积计算。';
  if (unit === 'm') return '按设计图示中心线长度计算。';
  if (unit === 't') return '按设计图示理论重量计算。';
  if (unit === '台' || unit === '套') return `按设计图示设备数量以${unit}计算。`;
  return '按设计图示工程量计算。';
}

function extractDailyCapacity(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*(?:万\s*(?:吨|m³|m3|方)|万吨|万方|万m3|万立方)(?:\/?日|\/d)?/i);
  return m ? Number(m[1]) : '';
}

function scaleByDaily(daily) {
  const n = Number(daily || 0);
  if (!n) return '';
  if (n >= 10) return '大型';
  if (n >= 3) return '中型';
  return '小型';
}

function duplicateLines(lines) {
  const map = new Map();
  lines.forEach(line => {
    const key = [line.name, line.feature, line.unit].map(v => String(v || '').trim()).join('|');
    if (!key.replace(/\|/g, '')) return;
    map.set(key, [...(map.get(key) || []), line]);
  });
  return [...map.values()].filter(group => group.length > 1).flat();
}

function issueList(type, title, rows, action) {
  return rows.length ? [{ type, title, count: rows.length, lines: rows.slice(0, 12), action }] : [];
}

function nextYear() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatMoney(value) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}
