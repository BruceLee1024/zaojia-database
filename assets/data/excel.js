// Excel 解析与导出
// 兼容两种表头:
//   A) 定额库：清单名称/项目特征/工作内容/工程量计算规则/单位/综合单价/综合单价组成
//   B] 工程量清单：序号/项目编码/项目名称/项目特征/计量单位/工程数量/综合单价/合价
import { categoryGuess } from '../utils/stats.js?v=6.7';
import { calculateAmount } from '../utils/costing.js?v=6.7';
import { normalizeImportHeader } from '../services/importMappingService.js?v=6.7';
import { detectImportRegions } from './importEngine.js?v=6.7';

const HEADER_QUOTA  = ['清单名称', '项目特征', '工作内容', '工程量计算规则', '单位', '综合单价', '综合单价组成'];
const HEADER_BOQ    = ['序号', '项目编码', '项目名称', '项目特征', '计量单位', '工程数量', '综合单价', '合价'];

function firstValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return '';
}

function splitNameFeature(row) {
  const explicitName = firstValue(row, ['项目名称', '清单名称', '名称']);
  const explicitFeature = firstValue(row, ['项目特征']);
  const combined = firstValue(row, ['项目名称\n项目特征', '项目名称 项目特征', '清单名称\n项目特征']);
  if (explicitName) {
    const combinedText = String(combined || '');
    const lines = combinedText.split(/\r?\n/).filter(Boolean);
    const rest = lines[0] && lines[0].trim() === String(explicitName).trim() ? lines.slice(1) : lines;
    return { name: String(explicitName).trim(), feature: String(explicitFeature || rest.join('\n')).trim() };
  }
  const [name, ...rest] = String(combined || '').split(/\r?\n/);
  return { name: String(name || '').trim(), feature: String(explicitFeature || rest.join('\n')).trim() };
}

/** 从 file 解析为行数据 */
export async function parseExcel(file) {
  const workbook = await parseImportFile(file);
  const region = detectImportRegions(workbook).find(item => !item.hidden && item.rows.length);
  if (region) return legacyRowsFromRegion(region);
  throw new Error('未能识别清单表头，请确认文件包含项目名称、单位、工程量等字段。');
}

/**
 * 读取完整导入工作簿，保留合并区域、可见性、原始矩阵和公式警告。
 */
export async function parseImportFile(file, options = {}) {
  if (!file?.arrayBuffer) throw new Error('请选择可读取的表格文件');
  const fileName = String(file.name || '未命名表格');
  const extension = (fileName.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(extension)) throw new Error('仅支持 .xlsx、.xls 和 .csv 文件');
  const maxFileSizeBytes = Number(options.maxFileSizeBytes || 200 * 1024 * 1024);
  if (Number(file.size || 0) > maxFileSizeBytes) throw new Error(`文件超过 ${Math.round(maxFileSizeBytes / 1024 / 1024)}MB 上限，请拆分后导入`);
  if (!globalThis.XLSX?.read || !globalThis.XLSX?.utils?.sheet_to_json) throw new Error('Excel 解析组件未加载');
  const buffer = await file.arrayBuffer();
  let workbook;
  let csvMeta = null;
  const warnings = [];
  try {
    if (extension === 'csv') {
      const decoded = decodeCsvBuffer(buffer, options.csvEncoding, options.csvDelimiter);
      csvMeta = { encoding: decoded.encoding, delimiter: decoded.delimiter, delimiterConfidence: decoded.delimiterConfidence };
      warnings.push(...decoded.warnings);
      workbook = XLSX.read(decoded.text, { type: 'string', raw: true, cellText: true, cellFormula: true, nodim: true, FS: decoded.delimiter });
    } else {
      workbook = XLSX.read(buffer, { type: 'array', cellText: true, cellFormula: true, cellNF: true, nodim: true });
    }
  } catch (error) {
    throw new Error(`文件解析失败：${error.message || '文件损坏或格式不支持'}`);
  }
  const sheets = (workbook.SheetNames || []).map((name, index) => {
    const worksheet = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true, blankrows: true });
    const formulaWarnings = findFormulaWarnings(worksheet, name);
    return {
      name,
      index,
      hidden: Number(workbook.Workbook?.Sheets?.[index]?.Hidden || 0) > 0,
      visibility: Number(workbook.Workbook?.Sheets?.[index]?.Hidden || 0),
      matrix,
      merges: (worksheet?.['!merges'] || []).map(range => ({ s: { ...range.s }, e: { ...range.e } })),
      ref: worksheet?.['!ref'] || '',
      fullRef: worksheet?.['!fullref'] || '',
      warnings: formulaWarnings,
    };
  });
  sheets.forEach(sheet => warnings.push(...sheet.warnings));
  if (!sheets.some(sheet => sheet.matrix.some(row => row.some(cell => String(cell ?? '').trim())))) throw new Error('文件中没有可读取的数据');
  return {
    fileName,
    fileType: extension,
    size: Number(file.size || buffer.byteLength || 0),
    sheets,
    warnings: [...new Set(warnings)],
    csv: csvMeta,
  };
}

/**
 * 为 AI 导入向导读取整个工作簿摘要。它不要求标准清单表头，供用户先选工作表，
 * 真正的字段合法性仍由确认页控制。
 */
export async function readWorkbookSummary(file) {
  const workbook = await parseImportFile(file);
  return summarizeSheetMatrices(workbook.sheets).map(sheet => {
    const source = workbook.sheets.find(item => item.name === sheet.name);
    return {
    ...sheet,
    hidden: Boolean(source?.hidden),
    merges: source?.merges || [],
    warnings: source?.warnings || [],
    };
  });
}

function legacyRowsFromRegion(region) {
  const labels = new Map();
  const seen = new Map();
  region.columns.forEach(column => {
    const base = column.path.length === 1
      ? `${column.leaf}${column.unitHint ? ` ${column.unitHint}` : ''}`
      : `${column.path.join(' ')}${column.unitHint ? ` ${column.unitHint}` : ''}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    labels.set(column.id, count === 1 ? base : `${base}_${count}`);
  });
  return region.rows.map(row => Object.fromEntries(region.columns.map(column => [labels.get(column.id), row.values[column.id] ?? ''])));
}

export function decodeCsvBuffer(buffer, requestedEncoding = '', requestedDelimiter = '') {
  const bytes = new Uint8Array(buffer);
  const warnings = [];
  const normalized = String(requestedEncoding || '').toLowerCase();
  const encodings = normalized ? [normalized] : ['utf-8', 'gb18030'];
  for (const encoding of encodings) {
    try {
      const text = new TextDecoder(encoding, { fatal: encoding === 'utf-8' }).decode(bytes).replace(/^\ufeff/, '');
      if (!normalized && encoding !== 'utf-8') warnings.push(`CSV 未能按 UTF-8 解码，已改用 ${encoding.toUpperCase()}`);
      const delimiterResult = detectCsvDelimiter(text, requestedDelimiter);
      warnings.push(...delimiterResult.warnings);
      return { text, encoding, delimiter: delimiterResult.delimiter, delimiterConfidence: delimiterResult.confidence, warnings };
    } catch {
      // 继续尝试下一种常见编码。
    }
  }
  throw new Error('CSV 编码无法识别，请手动选择 UTF-8 或 GB18030');
}

function detectCsvDelimiter(text, requestedDelimiter = '') {
  const allowed = [',', '\t', ';'];
  const explicit = requestedDelimiter === 'tab' ? '\t' : requestedDelimiter;
  if (allowed.includes(explicit)) return { delimiter: explicit, confidence: 1, warnings: [] };
  const lines = String(text || '').split(/\r?\n/).filter(line => line.trim()).slice(0, 12);
  const scores = allowed.map(delimiter => {
    const counts = lines.map(line => countCsvDelimiter(line, delimiter));
    const positive = counts.filter(Boolean);
    const common = positive.length ? Math.max(...positive.map(count => positive.filter(value => value === count).length)) : 0;
    return { delimiter, score: positive.length ? (positive.length / Math.max(1, lines.length)) * 0.6 + (common / positive.length) * 0.4 : 0 };
  }).sort((a, b) => b.score - a.score);
  const best = scores[0] || { delimiter: ',', score: 0 };
  const confidence = Math.max(0, Math.min(1, best.score - (scores[1]?.score || 0) * 0.35));
  return {
    delimiter: best.score ? best.delimiter : ',',
    confidence,
    warnings: confidence < 0.6 ? ['CSV 分隔符识别置信度较低，可在上传页手动选择'] : [],
  };
}

function countCsvDelimiter(line, delimiter) {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else if (!quoted && line[index] === delimiter) count += 1;
  }
  return count;
}

function findFormulaWarnings(worksheet, sheetName) {
  const warnings = [];
  if (!worksheet || Array.isArray(worksheet)) return warnings;
  Object.entries(worksheet).forEach(([address, cell]) => {
    if (address.startsWith('!') || !cell?.f) return;
    if (cell.v === undefined || cell.v === null || cell.v === '') warnings.push(`工作表「${sheetName}」${address} 的公式没有可用缓存结果`);
  });
  return warnings.slice(0, 50);
}

export function summarizeSheetMatrices(sheets = []) {
  return sheets.map(sheet => summarizeSheetMatrix(sheet.name, sheet.matrix)).filter(sheet => sheet.rowCount > 0);
}

function summarizeSheetMatrix(name, matrix = []) {
  const rows = matrix.map(row => Array.isArray(row) ? row : []);
  const nonEmpty = rows.filter(row => row.some(cell => String(cell ?? '').trim() !== ''));
  const detectedHeader = findHeaderRow(rows);
  const fallbackHeader = detectedHeader < 0 ? findFallbackHeaderRow(rows) : -1;
  const headerIndex = detectedHeader >= 0 ? detectedHeader : fallbackHeader;
  if (headerIndex < 0) {
    return { name, rowCount: nonEmpty.length, headerIndex: -1, headers: [], rows: [], previewRows: [] };
  }
  const firstHeader = rows[headerIndex];
  const secondHeader = rows[headerIndex + 1] || [];
  const hasSecondHeader = detectedHeader >= 0 && headerSignalCount(secondHeader) > 0 && secondHeader.some(isHeaderContinuation);
  const headers = dedupeHeaders(firstHeader.map((cell, index) => mergeHeaderCell(cell, hasSecondHeader ? secondHeader[index] : '')));
  const dataStart = headerIndex + (hasSecondHeader ? 2 : 1);
  const records = rows.slice(dataStart)
    .filter(row => row.some(cell => String(cell ?? '').trim() !== ''))
    .map(row => headers.reduce((record, header, index) => {
      if (header) record[header] = row[index] ?? '';
      return record;
    }, {}));
  return {
    name,
    rowCount: nonEmpty.length,
    headerIndex,
    headers,
    rows: records,
    previewRows: records.slice(0, 5),
    combinedNameFeature: detectCombinedNameFeatureMeta(headers, records),
  };
}

export function detectCombinedNameFeatureMeta(headers = [], rows = []) {
  const source = headers.find(header => normalizeImportHeader(header) === '项目名称项目特征');
  if (!source) return null;
  const samples = rows
    .map(row => splitCombinedNameFeature(row?.[source]))
    .filter(item => item.raw)
    .slice(0, 50);
  const validSampleCount = samples.filter(item => item.name && item.feature).length;
  return {
    source,
    strategy: 'first_line_name_rest_feature',
    status: samples.length && validSampleCount === samples.length ? 'ready' : 'invalid',
    sampleCount: samples.length,
    validSampleCount,
    preview: samples.slice(0, 3).map(({ name, feature }) => ({ name, feature })),
  };
}

function splitCombinedNameFeature(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  return { raw: String(value ?? '').trim(), name: lines[0] || '', feature: lines.slice(1).join('\n') };
}

export function rowsFromSheetMatrix(matrix = []) {
  const rows = matrix.map(row => Array.isArray(row) ? row : []);
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) throw new Error('未能识别清单表头');
  const firstHeader = rows[headerIndex];
  const secondHeader = rows[headerIndex + 1] || [];
  const hasSecondHeader = headerSignalCount(secondHeader) > 0 && secondHeader.some(isHeaderContinuation);
  const headers = firstHeader.map((cell, index) => mergeHeaderCell(cell, hasSecondHeader ? secondHeader[index] : ''));
  const uniqueHeaders = dedupeHeaders(headers);
  const dataStart = headerIndex + (hasSecondHeader ? 2 : 1);

  return rows.slice(dataStart)
    .filter(row => row.some(cell => String(cell ?? '').trim() !== ''))
    .map(row => uniqueHeaders.reduce((record, header, index) => {
      if (header) record[header] = row[index] ?? '';
      return record;
    }, {}));
}

function findHeaderRow(rows) {
  const candidateRows = rows.slice(0, 8);
  let bestIndex = -1;
  let bestScore = 0;
  candidateRows.forEach((row, index) => {
    const score = headerSignalCount(row) * 100 + row.filter(cell => String(cell ?? '').trim() !== '').length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestScore >= 200 ? bestIndex : -1;
}

function findFallbackHeaderRow(rows) {
  const max = Math.min(rows.length, 12);
  for (let index = 0; index < max; index += 1) {
    const filled = rows[index].filter(cell => String(cell ?? '').trim() !== '');
    if (filled.length >= 2 && filled.some(cell => /名称|内容|单位|数量|工程|编码|编号|描述|项目/i.test(String(cell)))) return index;
  }
  return -1;
}

function headerSignalCount(row) {
  return row.filter(cell => isHeaderLike(cell)).length;
}

function isHeaderLike(value) {
  const header = normalizeImportHeader(value);
  return ['项目名称', '清单名称', '项目特征', '计量单位', '单位', '工程量', '工程数量', '综合单价', '合价', '金额', '项目编码', '序号']
    .some(signal => header === normalizeImportHeader(signal) || header.includes(normalizeImportHeader(signal)));
}

function isHeaderContinuation(value) {
  const raw = String(value ?? '').trim();
  const normalized = normalizeImportHeader(value);
  return isHeaderLike(value) || /^(m2|m3|m²|m³|元|含税|不含税|数量|单价|合价)$/i.test(raw) || /^(m2|m3|m²|m³|数量|单价|合价)$/.test(normalized);
}

function mergeHeaderCell(first, second) {
  const left = String(first ?? '').trim();
  const right = String(second ?? '').trim();
  if (!right || !isHeaderContinuation(right)) return left;
  if (!left) return right;
  return normalizeImportHeader(left) === normalizeImportHeader(right) ? left : `${left} ${right}`;
}

function dedupeHeaders(headers) {
  const seen = new Map();
  return headers.map((header, index) => {
    const value = String(header || '').trim() || `未命名列${index + 1}`;
    const count = (seen.get(value) || 0) + 1;
    seen.set(value, count);
    return count === 1 ? value : `${value}_${count}`;
  });
}

/** 判断一行属于哪种格式 */
export function detectRowKind(row) {
  if (row['清单名称'] || row['综合单价组成']) return 'quota';
  if (row['项目名称'] || row['项目编码'] || row['名称'] || row['项目名称\n项目特征']) return 'boq';
  return 'unknown';
}

/** 把 Excel 行转成 quota_item */
export function rowToQuotaItem(row) {
  const rawPrice = row['综合单价'];
  const priceTotal = parseFloat(rawPrice) || 0;
  const { name, feature } = splitNameFeature(row);
  return {
    code: firstValue(row, ['定额编码', '编码', '项目编码']) || '',
    category: categoryGuess(name),
    name,
    feature,
    work:     row['工作内容'] || '',
    rule:     row['工程量计算规则'] || '',
    unit:     firstValue(row, ['单位', '计量单位']),
    priceTotal,
    priceMissing: !(priceTotal > 0),
  };
}

/** 把 Excel 行转成 boq 行（不依赖项目 id，由调用方注入） */
export function rowToBOQ(row, projectId) {
  const { name, feature } = splitNameFeature(row);
  const qty = parseFloat(firstValue(row, ['工程数量', '工程量', '数量'])) || 0;
  const price = parseFloat(firstValue(row, ['综合单价', '单价'])) || 0;
  return {
    projectId,
    code: firstValue(row, ['项目编码', '编码']) || '',
    name,
    feature,
    unit: firstValue(row, ['计量单位', '单位']) || '',
    qty,
    factor: 1,
    unitPrice: price,
    amount: calculateAmount(qty, price, 1),
    priceMissing: !(price > 0),
  };
}

/** 把 Excel 行转为独立清单库条目（不写入存储） */
export function rowToBoqLibraryItem(row) {
  const { name, feature } = splitNameFeature(row);
  return {
    major: firstValue(row, ['专业', '适用专业']),
    code: firstValue(row, ['清单编码', '项目编码', '编码']),
    name,
    feature,
    unit: firstValue(row, ['单位', '计量单位']),
    defaultQty: parseFloat(firstValue(row, ['默认工程量', '工程数量', '工程量', '数量'])) || 0,
    scope: firstValue(row, ['适用范围']),
    structureGroup: firstValue(row, ['结构分组', '费用分类']),
    quotaRefs: firstValue(row, ['关联定额编码', '关联定额', '定额编码']),
    source: firstValue(row, ['来源']),
    version: firstValue(row, ['版本']),
    note: firstValue(row, ['备注']),
  };
}

/** 导出 Excel 报价单 */
export function exportBOQExcel(project, boq) {
  const total = boq.reduce((s, b) => s + (b.amount || 0), 0);
  const aoa = [
    [`项目名称：${project.name}      类型：${project.type || ''}      规模：${project.scale || ''}`],
    [`日处理量：${project.dailyCapacity || ''} 万m³/d      面积：${project.area || ''} ㎡      导出时间：${new Date().toLocaleString('zh-CN')}`],
    [],
    HEADER_BOQ,
  ];
  boq.forEach((b, i) => aoa.push([
    i + 1, b.code || '', b.name, b.feature || '', b.unit || '',
    Number(b.qty || 0), Number(b.unitPrice || 0), Number(b.amount || 0),
  ]));
  aoa.push([]);
  aoa.push(['', '', '', '', '', '合计', '', total]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 36 }, { wch: 50 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '工程量清单');
  XLSX.writeFile(wb, `${project.name}-报价单-${Date.now()}.xlsx`);
}

/** 导出定额库模板 */
export function exportQuotaTemplate() {
  const data = [
    ['分类', '清单名称', '项目特征', '工作内容', '工程量计算规则', '单位', '综合单价', '综合单价组成'],
    ['土石方与支护', '机械挖一般土方', '土壤类别：综合；开挖深度：按实际', '挖土、弃土、清理机下余土', '按开挖前天然密实体积计算', 'm³', 5, '人工+机械+管理+利润+风险'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '定额库模板');
  XLSX.writeFile(wb, '定额库模板.xlsx');
}

/** 导出独立清单库 Excel 模板 */
export function exportBoqLibraryTemplate() {
  const data = [
    ['专业', '清单编码', '清单名称', '项目特征', '单位', '默认工程量', '适用范围', '结构分组', '关联定额编码', '来源', '版本', '备注'],
    ['水处理工程', '030101001001', '土方开挖', '土壤类别：三类土；挖土深度：≤3m', 'm³', 100, '市政污水处理工程', 'civil', '机械挖一般土方', '企业自建', 'v1.0', '适用于一般场地开挖'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [14, 18, 24, 50, 10, 14, 26, 14, 24, 16, 10, 30].map(wch => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '清单库模板');
  XLSX.writeFile(wb, '清单库模板.xlsx');
}

export function getResourceTemplateData(resourceType) {
  const equipment = resourceType === 'equipment';
  const nameHeader = equipment ? '设备名称' : '材料名称';
  const headers = [
    '编码', '分类', nameHeader, '规格型号', '单位', '品牌', '生产厂家', '执行标准', '工艺段', '标签', '状态', '备注',
    '单价', '价格日期', '生效日期', '失效日期', '省', '市', '区县', '价格来源', '价格口径', '含税', '税率', '供应商', '安装范围', '基础价', '运杂费', '安装费', '调试费', '价格备注',
  ];
  const sample = equipment
    ? ['E-001', '泵类', '潜水排污泵', 'Q=25m³/h H=15m', '台', '示例品牌', '示例厂家', 'GB/T 24674', '污泥泵房', '泵,污泥', 'active', '', 12800, '2026-07-01', '', '', '四川', '成都', '', '供应商报价', '到场价', '是', 13, '示例供应商', '', 11000, 800, 800, 200, '']
    : ['M-001', '管材', 'UPVC 管', 'DN200 PN1.0', 'm', '示例品牌', '示例厂家', 'GB/T 10002.1', '生化池', '管材,UPVC', 'active', '', 126, '2026-07-01', '', '', '四川', '成都', '', '官方信息价', '到场价', '否', 13, '', '', 110, 16, 0, 0, ''];
  return {
    rows: [headers, sample],
    sheetName: equipment ? '设备库模板' : '材料库模板',
    fileName: equipment ? '设备库导入模板.xlsx' : '材料库导入模板.xlsx',
  };
}

export function exportResourceTemplate(resourceType) {
  const template = getResourceTemplateData(resourceType);
  const ws = XLSX.utils.aoa_to_sheet(template.rows);
  ws['!cols'] = template.rows[0].map((header, index) => ({ wch: index === 2 ? 24 : Math.max(10, String(header).length * 2 + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, template.sheetName);
  XLSX.writeFile(wb, template.fileName);
}

export const exportMaterialTemplate = () => exportResourceTemplate('material');
export const exportEquipmentTemplate = () => exportResourceTemplate('equipment');
