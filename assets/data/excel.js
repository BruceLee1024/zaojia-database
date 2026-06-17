// Excel 解析与导出
// 兼容两种表头:
//   A) 定额库：清单名称/项目特征/工作内容/工程量计算规则/单位/综合单价/综合单价组成
//   B] 工程量清单：序号/项目编码/项目名称/项目特征/计量单位/工程数量/综合单价/合价
import { categoryGuess } from '../utils/stats.js';
import { calculateAmount } from '../utils/costing.js?v=3.9';

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
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
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
