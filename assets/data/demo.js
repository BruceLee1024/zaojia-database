// 演示数据加载 + 智能兜底单价
import { quotaRepo, boqLibraryRepo, projectRepo, boqRepo, versionRepo, indicatorRepo, dataFactRepo, dataCandidateRepo, dataJobRepo, dataQualityReportRepo, experienceSessionRepo, experienceCardRepo } from './repository.js?v=1.0';
import { parseExcel, detectRowKind, rowToQuotaItem, rowToBOQ } from './excel.js?v=3.9';
import { categoryGuess } from '../utils/stats.js';
import { uid } from '../utils/dom.js';
import { calculateAmount } from '../utils/costing.js?v=3.9';
import { versionService } from '../services/versionService.js?v=3.9';
import { dataEngineService } from '../services/dataEngineService.js?v=3.9';

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

const BUILTIN_PROJECTS = [
  { key: 'demo-pool', name: '产品水池扩建工程', type: '水池', area: 1650, dailyCapacity: 5, structure: '钢筋砼', process: 'AAO', scale: '中型', status: 'doing' },
  { key: 'demo-pre', name: '预处理车间改造', type: '车间', area: 2400, dailyCapacity: 5, structure: '钢筋砼', process: '预处理', scale: '中型', status: 'archived' },
  { key: 'demo-sub', name: '10kV 变电站配套', type: '变电站', area: 680, dailyCapacity: 5, structure: '框架', process: '供配电', scale: '中型', status: 'archived' },
];

const BUILTIN_QUOTAS = [
  ['土石方与支护', '人工挖一般土方', '土壤类别：综合；开挖深度：2m 内', 'm³', 20, 'civil'],
  ['土石方与支护', '机械挖一般土方', '土壤类别：综合；机械类型：挖掘机', 'm³', 5, 'civil'],
  ['土石方与支护', '回填方', '密实度要求：符合规范；材料：素土', 'm³', 8, 'civil'],
  ['混凝土与钢筋', 'C30 钢筋混凝土池壁', '混凝土强度：C30；抗渗等级：P6', 'm³', 780, 'civil'],
  ['混凝土与钢筋', 'C30 钢筋混凝土底板', '混凝土强度：C30；厚度：400mm', 'm³', 760, 'civil'],
  ['混凝土与钢筋', '现浇构件钢筋', '钢筋种类：HRB400；综合规格', 't', 6800, 'civil'],
  ['防水防腐', '池体内壁防腐涂料', '环氧玻璃鳞片；两底两面', 'm²', 118, 'civil'],
  ['防水防腐', '水池卷材防水', 'SBS 改性沥青卷材；厚度 4mm', 'm²', 95, 'civil'],
  ['设备安装', '潜水搅拌机安装', '含支架、吊装、单机调试', '台', 18500, 'equipment'],
  ['设备安装', '回转式格栅除污机', '渠宽 1000mm；含安装调试', '台', 68000, 'equipment'],
  ['管网管道', 'HDPE 排水管 DN300', '热熔连接；含管件安装', 'm', 220, 'pipe'],
  ['管网管道', '阀门井砌筑', '砖砌井；含井盖井座', '座', 3200, 'pipe'],
  ['电气自控', '低压配电柜安装', '含基础槽钢、接线、调试', '台', 9800, 'electric'],
  ['电气自控', '动力电缆敷设', 'YJV 电缆；桥架/管内敷设', 'm', 180, 'electric'],
  ['电气自控', 'PLC 控制柜安装', '含 I/O 检查、联动调试', '台', 26000, 'electric'],
];

const BUILTIN_LINES = {
  'demo-pool': [
    ['人工挖一般土方', 420, 1],
    ['回填方', 310, 1],
    ['C30 钢筋混凝土底板', 520, 1],
    ['C30 钢筋混凝土池壁', 680, 1],
    ['现浇构件钢筋', 92, 1],
    ['池体内壁防腐涂料', 2100, 1],
    ['水池卷材防水', 950, 1],
    ['潜水搅拌机安装', 4, 1],
    ['HDPE 排水管 DN300', 180, 1],
    ['低压配电柜安装', 2, 1],
  ],
  'demo-pre': [
    ['机械挖一般土方', 680, 1],
    ['回填方', 520, 1],
    ['C30 钢筋混凝土底板', 360, 1],
    ['现浇构件钢筋', 58, 1],
    ['回转式格栅除污机', 2, 1],
    ['潜水搅拌机安装', 3, 1.05],
    ['HDPE 排水管 DN300', 260, 1],
    ['阀门井砌筑', 6, 1],
    ['低压配电柜安装', 3, 1],
  ],
  'demo-sub': [
    ['机械挖一般土方', 180, 1],
    ['C30 钢筋混凝土底板', 120, 1],
    ['现浇构件钢筋', 18, 1],
    ['低压配电柜安装', 8, 1],
    ['动力电缆敷设', 420, 1],
    ['PLC 控制柜安装', 1, 1],
  ],
};

const BUILTIN_BOQ_LIBRARY = [
  ['030101001001', '土方开挖', '土壤类别：三类土；挖土深度：≤3m', 'm³', 100, '水处理工程', '市政污水处理工程', 'civil', ['机械挖一般土方']],
  ['030201002001', '钢筋混凝土池壁', '混凝土强度等级：C30；抗渗等级：P6', 'm³', 80, '水处理工程', '污水厂池体工程', 'civil', ['C30 钢筋混凝土池壁']],
  ['030501001001', '潜水搅拌机安装', '含支架、吊装、单机调试', '台', 2, '设备安装工程', '污水处理设备安装', 'equipment', ['潜水搅拌机安装']],
  ['030601001001', 'HDPE 排水管安装', 'DN300；热熔连接；含管件安装', 'm', 120, '管网工程', '厂区污水管网', 'pipe', ['HDPE 排水管 DN300', '阀门井砌筑']],
  ['030701001001', 'PLC 控制柜安装', '含 I/O 检查、联动调试', '台', 1, '电气自控工程', '污水处理自控系统', 'electric', []],
];

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
          item.breakdown = { 人工: 0, 材料: 0, 设备: 0, 机械: 0, 管理费: 0, 利润: 0, 风险: 0 };
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
              breakdown: { 人工: 0, 材料: 0, 设备: 0, 机械: 0, 管理费: 0, 利润: 0, 风险: 0 },
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
  await ensureBuiltinDemoData();
  await autoFillMissingPrices();
  await seedDemoVersionsAndFacts();
}

export async function ensureDemoData({ force = false } = {}) {
  const [projects, quota, boq] = await Promise.all([projectRepo.all(), quotaRepo.all(), boqRepo.all()]);
  if (!force && (projects.length || quota.length || boq.length)) return { loaded: false };
  if (force) {
    await Promise.all([
      quotaRepo.replaceAll([]),
      boqLibraryRepo.replaceAll([]),
      projectRepo.replaceAll([]),
      boqRepo.replaceAll([]),
      versionRepo.replaceAll([]),
      indicatorRepo.replaceAll([]),
      dataFactRepo.replaceAll([]),
      dataCandidateRepo.replaceAll([]),
      dataJobRepo.replaceAll([]),
      dataQualityReportRepo.replaceAll([]),
      experienceSessionRepo.replaceAll([]),
      experienceCardRepo.replaceAll([]),
    ]);
  }
  await ensureBuiltinDemoData();
  await seedDemoVersionsAndFacts();
  return { loaded: true };
}

async function ensureBuiltinDemoData() {
  const now = new Date().toISOString();
  const quota = await quotaRepo.all();
  const quotaByName = new Map(quota.map(q => [q.name, q]));
  for (const [category, name, feature, unit, priceTotal, structureGroup] of BUILTIN_QUOTAS) {
    if (quotaByName.has(name)) continue;
    const item = {
      id: uid(),
      category,
      name,
      feature,
      work: '',
      rule: '',
      unit,
      priceTotal,
      priceMissing: false,
      structureGroup,
      breakdown: { 人工: 0, 材料: 0, 设备: 0, 机械: 0, 管理费: 0, 利润: 0, 风险: 0 },
      useBreakdown: false,
      tags: [category.replace(/与.*/, ''), structureGroup],
      updatedAt: now,
    };
    quota.push(item);
    quotaByName.set(name, item);
  }
  await quotaRepo.replaceAll(quota);

  const library = await boqLibraryRepo.all();
  const libraryCodes = new Set(library.map(item => item.code));
  for (const [code, name, feature, unit, defaultQty, major, scope, structureGroup, quotaNames] of BUILTIN_BOQ_LIBRARY) {
    if (libraryCodes.has(code)) continue;
    library.push({ id: uid(), code, name, feature, unit, defaultQty, major, scope, structureGroup,
      quotaItemIds: quotaNames.map(name => quotaByName.get(name)?.id).filter(Boolean), source: '系统示例', version: 'v1.0', note: '', status: 'active', referenceCount: 0, lastReferencedAt: '', lastReferencedProjectName: '', createdAt: now, updatedAt: now });
  }
  await boqLibraryRepo.replaceAll(library);

  const projects = await projectRepo.all();
  const projectByKey = new Map(projects.map(p => [p.demoKey, p]));
  const boq = await boqRepo.all();
  for (const meta of BUILTIN_PROJECTS) {
    let project = projectByKey.get(meta.key);
    if (!project) {
      project = {
        id: uid(),
        demoKey: meta.key,
        name: meta.name,
        type: meta.type,
        scale: meta.scale,
        dailyCapacity: meta.dailyCapacity,
        area: meta.area,
        structure: meta.structure,
        process: meta.process,
        status: meta.status,
        archivedAt: meta.status === 'archived' ? now : '',
        createdAt: now,
        updatedAt: now,
        totalCost: 0,
        typeKey: [meta.type, meta.scale, meta.structure].join(' / '),
        structureGroups: [],
      };
      projects.push(project);
    }
    if (!boq.some(line => line.projectId === project.id)) {
      (BUILTIN_LINES[meta.key] || []).forEach(([name, qty, factor]) => {
        const item = quotaByName.get(name);
        if (!item) return;
        const amount = calculateAmount(qty, item.priceTotal, factor);
        boq.push({
          id: uid(),
          projectId: project.id,
          quotaItemId: item.id,
          code: '',
          name: item.name,
          feature: item.feature,
          unit: item.unit,
          qty,
          factor,
          unitPrice: item.priceTotal,
          amount,
          priceMissing: false,
          structureGroup: item.structureGroup,
        });
      });
    }
  }
  projects.forEach(p => {
    p.totalCost = boq.filter(line => line.projectId === p.id).reduce((sum, line) => sum + Number(line.amount || 0), 0);
  });
  await projectRepo.replaceAll(projects);
  await boqRepo.replaceAll(boq);
}

async function seedDemoVersionsAndFacts() {
  const projects = await projectRepo.all();
  const versions = await versionRepo.all();
  for (const project of projects.filter(p => p.demoKey)) {
    if (!versions.some(v => v.projectId === project.id)) {
      await versionService.createFromCurrent(project.id, {
        name: `${project.status === 'archived' ? '归档版' : '演示版'} · ${project.name}`,
        note: '系统内置演示数据自动生成，用于体验报价版本、指标和样本池。',
      });
    }
    if (project.status === 'archived') await dataEngineService.ingestArchivedProject(project.id);
  }
  await dataEngineService.rebuildIndicators();
}
