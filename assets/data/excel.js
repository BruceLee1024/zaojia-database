// Excel 解析与导出
// 兼容两种表头:
//   A) 定额库：清单名称/项目特征/工作内容/工程量计算规则/单位/综合单价/综合单价组成
//   B] 工程量清单：序号/项目编码/项目名称/项目特征/计量单位/工程数量/综合单价/合价
import { categoryGuess } from '../utils/stats.js';
import { calculateAmount } from '../utils/costing.js?v=3.9';
import { normalizeImportHeader } from '../services/importMappingService.js';

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
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  for (const sheetName of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    try {
      const rows = rowsFromSheetMatrix(matrix);
      if (rows.length) return rows;
    } catch {
      // 继续寻找第一个具有可识别清单表头的工作表。
    }
  }
  throw new Error('未能识别清单表头，请确认文件包含项目名称、单位、工程量等字段。');
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
