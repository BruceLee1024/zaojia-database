// 演示数据加载 + 智能兜底单价
import { quotaRepo, projectRepo, boqRepo } from './repository.js?v=2.8';
import { parseExcel, detectRowKind, rowToQuotaItem, rowToBOQ } from './excel.js?v=2.8';
import { categoryGuess } from '../utils/stats.js';
import { uid } from '../utils/dom.js';

const FILES = [
  '定额数据库.xlsx',
  '工程量清单-产品水池.xlsx',
  '工程量清单-预处理车间.xlsx',
  '工程量清单-变电站.xlsx',
];

const META = {
  '产品水池':   { type: '水池', area: 1500, dailyCapacity: 5, structure: '钢筋砼', process: 'AAO',   scale: '中型' },
  '预处理车间': { type: '车间', area: 2200, dailyCapacity: 5, structure: '钢筋砼', process: '预处理', scale: '中型' },
  '变电站':     { type: '变电站', area: 600, dailyCapacity: 5, structure: '框架',  process: '供配电', scale: '中型' },
};

// 关键词兜底单价（行业经验值）
const KW_PRICE = [
  [/挖一般土方|机械挖/, 5],
  [/回填/, 8],
  [/平整场地/, 0.5],
  [/竣工清理/, 1],
  [/钢板桩/, 800],
  [/土钉/, 40],
  [/强夯/, 2],
  [/搅拌桩|旋喷桩/, 150],
  [/井点降水|深井降水/, 35],
  [/砖基础|砖胎膜/, 600],
  [/零星砌砖/, 700],
  [/砌块墙|加气混凝土砌块/, 550],
  [/垫层/, 520],
  [/满堂基础|桩承台|设备基础|基础梁|油池防水底板/, 700],
  [/混凝土护坡|喷射混凝土/, 80],
  [/泡沫混凝土/, 480],
  [/现浇混凝土柱|现浇混凝土梁|现浇混凝土板|混凝土/, 750],
  [/钢筋笼/, 7200],
  [/钢管内填芯/, 900],
  [/截桩/, 80],
  [/预埋铁件/, 9500],
  [/预制钢筋混凝土方桩|方桩压桩/, 280],
  [/防水/, 95],
  [/防腐|环氧|玻璃鳞片/, 120],
  [/保温|泡沫/, 200],
  [/涂料|乳胶漆|抹灰|找平|砂浆/, 35],
  [/面层|楼地面|瓷砖/, 180],
  [/屋面|排水管|PVC/, 65],
  [/门窗|塑钢|卷帘|防盗门/, 850],
  [/栏杆|扶手|不锈钢|玻璃栏板/, 1200],
  [/管道|钢管|铸铁管|焊接|法兰/, 220],
  [/阀门/, 3500],
  [/电缆/, 180],
  [/桥架/, 120],
  [/配电箱|开关柜|配电柜|控制柜/, 8500],
  [/灯具|照明|LED/, 280],
  [/开关|插座/, 35],
  [/弱电|监控|传感器|仪表|自控/, 1200],
  [/防雷|接地|避雷/, 95],
  [/集水井|检查井|排水沟|截水沟|隔油池/, 1500],
  [/招牌|发光字|标识/, 800],
  [/活动地板|防静电/, 380],
  [/脚手架|措施/, 25],
  [/钢筋/, 6800],
];

function kwPrice(name) {
  for (const [re, price] of KW_PRICE) {
    if (re.test(name)) return price;
  }
  return 0;
}

/** 兜底填价 */
export async function autoFillMissingPrices() {
  const items = await quotaRepo.all();
  const boq = await boqRepo.all();
  const quotaByName = new Map();
  items.forEach(it => quotaByName.set(it.name, it));

  // 分类中位价
  const catMedian = {};
  items.forEach(it => {
    if (it.priceTotal > 0) {
      (catMedian[it.category || '其他'] = catMedian[it.category || '其他'] || []).push(it.priceTotal);
    }
  });
  Object.keys(catMedian).forEach(k => {
    const arr = catMedian[k].sort((a, b) => a - b);
    catMedian[k] = arr[Math.floor(arr.length / 2)];
  });

  let filled = 0;
  for (const b of boq) {
    if (b.unitPrice > 0) continue;
    let price = 0;
    const it = quotaByName.get(b.name);
    if (it && it.priceTotal > 0) price = it.priceTotal;
    if (!price) {
      const cat = categoryGuess(b.name);
      price = catMedian[cat] || 0;
    }
    if (!price) price = kwPrice(b.name);
    if (price > 0) {
      b.unitPrice = price;
      b.amount = b.qty * price * (b.factor || 1);
      if (it && !it.priceTotal) { it.priceTotal = price; it.updatedAt = new Date().toISOString(); }
      filled++;
    }
  }
  await boqRepo.replaceAll(boq);
  await quotaRepo.replaceAll(items);

  // 回写项目造价
  const projects = await projectRepo.all();
  projects.forEach(p => {
    p.totalCost = boq.filter(b => b.projectId === p.id).reduce((s, b) => s + (b.amount || 0), 0);
  });
  await projectRepo.replaceAll(projects);
  console.log(`[autoFill] 兜底填了 ${filled} 条清单单价`);
  return filled;
}

/** 加载演示数据 */
export async function loadDemoData() {
  const items = await quotaRepo.all();
  const seen = new Set(items.map(i => i.name + '|' + (i.feature || '').slice(0, 30)));

  for (const fn of FILES) {
    try {
      const resp = await fetch(`../${encodeURIComponent(fn)}`);
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      // 走标准 SheetJS 解析
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) continue;

      const kind = detectRowKind(rows[0]);
      if (kind === 'quota') {
        for (const r of rows) {
          const item = rowToQuotaItem(r);
          if (!item.name) continue;
          const k = item.name + '|' + (item.feature || '').slice(0, 30);
          if (seen.has(k)) continue;
          seen.add(k);
          item.id = uid();
          item.breakdown = { 人工: 0, 材料: 0, 机械: 0, 管理费: 0, 利润: 0, 风险: 0 };
          item.useBreakdown = false;
          item.tags = [];
          item.updatedAt = new Date().toISOString();
          items.push(item);
        }
      } else if (kind === 'boq') {
        const projName = fn.replace('工程量清单-', '').replace('.xlsx', '');
        const meta = META[projName] || {};
        const projects = await projectRepo.all();
        const pid = uid();
        projects.push({
          id: pid,
          name: projName,
          type: meta.type || '其他',
          scale: meta.scale || '中型',
          dailyCapacity: meta.dailyCapacity || '',
          area: meta.area || '',
          structure: meta.structure || '钢筋砼',
          process: meta.process || '',
          status: 'doing',
          typeKey: '',
          totalCost: 0,
        });
        const boq = await boqRepo.all();
        for (const r of rows) {
          const line = rowToBOQ(r, pid);
          if (!line.name) continue;
          // 自动建/补定额
          const k = line.name + '|' + (line.feature || '').slice(0, 30);
          let it = items.find(x => x.name === line.name && (x.feature || '').slice(0, 30) === (line.feature || '').slice(0, 30));
          if (!it) {
            it = {
              id: uid(),
              category: categoryGuess(line.name),
              name: line.name,
              feature: line.feature,
              work: '',
              rule: '',
              unit: line.unit,
              priceTotal: line.unitPrice,
              breakdown: { 人工: 0, 材料: 0, 机械: 0, 管理费: 0, 利润: 0, 风险: 0 },
              useBreakdown: false,
              tags: [],
              updatedAt: new Date().toISOString(),
            };
            items.push(it);
          }
          line.id = uid();
          line.quotaItemId = it.id;
          boq.push(line);
        }
        await projectRepo.replaceAll(projects);
        await boqRepo.replaceAll(boq);
      }
    } catch (e) {
      console.warn('加载失败', fn, e);
    }
  }

  await quotaRepo.replaceAll(items);
  await autoFillMissingPrices();
}
