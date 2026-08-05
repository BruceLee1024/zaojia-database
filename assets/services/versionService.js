// 报价版本服务：当前清单的不可变快照、恢复与对比
import { boqRepo, projectBoqQuotaRelationRepo, projectRepo, versionRepo } from '../data/repository.js?v=6.4';
import { uid } from '../utils/dom.js?v=6.4';
import { normalizeCurrency } from '../utils/currency.js?v=6.4';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.4';
import { dataEngineService } from './dataEngineService.js?v=6.4';
import { groupForLine } from './boqService.js?v=6.4';
import { assertProjectEditableById } from './projectLockService.js?v=6.4';

const LINE_FIELDS = [
  'quotaItemId', 'code', 'name', 'feature', 'unit', 'qty', 'factor', 'unitPrice', 'amount', 'priceMissing', 'structureGroup',
  'resourceItemId', 'resourcePriceId', 'resourceSnapshot', 'resourcePriceSnapshot', 'resourceReferenceStatus', 'resourceReferenceNote',
  'linkedResourceItemId', 'linkedResourceSnapshot', 'linkedEquipmentLineId', 'linkedResourceReferenceStatus', 'linkedResourceReferenceNote',
  'installationResourceItemId', 'manualInstallationResourceId',
  'pricingMode', 'compositionUnitPrice', 'quotaRelations',
];

export const versionService = {
  async createFromCurrent(projectId, { name, note = '' } = {}) {
    const [project, lines, quotaRelations] = await Promise.all([
      projectRepo.findById(projectId),
      boqRepo.byProject(projectId),
      projectBoqQuotaRelationRepo.byProject(projectId),
    ]);
    if (!project) throw new Error('项目不存在');

    const snapshotLines = lines.map(line => snapshotLine(line, quotaRelations.filter(relation => relation.projectBoqLineId === line.id)));
    const totalCost = snapshotLines.reduce((sum, line) => sum + (line.amount || 0), 0);
    const version = {
      id: uid(),
      projectId,
      name: (name || '').trim() || defaultVersionName(),
      note: (note || '').trim(),
      createdAt: new Date().toISOString(),
      totalCost,
      currency: normalizeCurrency(project.currency),
      lineCount: snapshotLines.length,
      missingPriceCount: snapshotLines.filter(line => hasMissingPrice(line.unitPrice)).length,
      lines: snapshotLines,
    };
    await versionRepo.upsert(version);
    await dataEngineService.ingestVersion(version.id);
    return version;
  },

  async listByProject(projectId) {
    const versions = await versionRepo.byProject(projectId);
    return versions.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  },

  async get(versionId) {
    return await versionRepo.findById(versionId);
  },

  async restore(versionId) {
    const version = await versionRepo.findById(versionId);
    if (!version) throw new Error('版本不存在');
    await assertProjectEditableById(version.projectId);
    const [allLines, allQuotaRelations] = await Promise.all([boqRepo.all(), projectBoqQuotaRelationRepo.all()]);
    const currentLines = allLines.filter(line => line.projectId === version.projectId);
    let backup = null;
    if (currentLines.length) {
      backup = {
        id: uid(),
        projectId: version.projectId,
        name: `恢复前备份 ${defaultVersionName().replace('报价版本 ', '')}`,
        note: `恢复「${version.name}」前自动生成，避免误覆盖工作稿。`,
        createdAt: new Date().toISOString(),
        totalCost: currentLines.reduce((sum, line) => sum + calculateAmount(line.qty, line.unitPrice, line.factor), 0),
        currency: normalizeCurrency(version.currency),
        lineCount: currentLines.length,
        missingPriceCount: currentLines.filter(line => hasMissingPrice(line.unitPrice)).length,
        backupOfRestoreId: version.id,
        lines: currentLines.map(line => snapshotLine(line, allQuotaRelations.filter(relation => relation.projectBoqLineId === line.id))),
      };
      await versionRepo.upsert(backup);
      await dataEngineService.ingestVersion(backup.id);
    }
    const restoredQuotaRelations = [];
    const restored = (version.lines || []).map(source => {
      const id = uid();
      (source.quotaRelations || []).forEach((relation, index) => restoredQuotaRelations.push({
        ...cloneValue(relation), id: uid(), projectId: version.projectId, projectBoqLineId: id,
        sortOrder: Number.isFinite(Number(relation.sortOrder)) ? Number(relation.sortOrder) : index,
      }));
      const line = { ...snapshotLine(source), id, projectId: version.projectId, amount: calculateAmount(source.qty, source.unitPrice, source.factor), priceMissing: hasMissingPrice(source.unitPrice) };
      delete line.quotaRelations;
      return line;
    });
    await boqRepo.replaceAll([
      ...allLines.filter(line => line.projectId !== version.projectId),
      ...restored,
    ]);
    await projectBoqQuotaRelationRepo.replaceAll([
      ...allQuotaRelations.filter(relation => relation.projectId !== version.projectId),
      ...restoredQuotaRelations,
    ]);
    const total = restored.reduce((sum, line) => sum + (line.amount || 0), 0);
    await projectRepo.update(version.projectId, { totalCost: total });
    return { version, backup, restoredCount: restored.length, totalCost: total };
  },

  async compare(leftId, rightId) {
    const [left, right] = await Promise.all([
      versionRepo.findById(leftId),
      versionRepo.findById(rightId),
    ]);
    if (!left || !right) throw new Error('请选择两个有效版本');
    const leftMap = mapByLineKey(left.lines || []);
    const rightMap = mapByLineKey(right.lines || []);
    const added = [];
    const removed = [];
    const modified = [];

    rightMap.forEach((rightLine, key) => {
      const leftLine = leftMap.get(key);
      if (!leftLine) {
        added.push(rightLine);
        return;
      }
      const changes = diffLine(leftLine, rightLine);
      if (changes.length) modified.push({ key, left: leftLine, right: rightLine, changes });
    });
    leftMap.forEach((leftLine, key) => {
      if (!rightMap.has(key)) removed.push(leftLine);
    });

    return {
      left,
      right,
      totalDelta: (right.totalCost || 0) - (left.totalCost || 0),
      added,
      removed,
      modified,
      categorySummary: categoryDiff(left.lines || [], right.lines || []),
    };
  },

  async remove(versionId) {
    return await versionRepo.remove(versionId);
  },
};

export function exportVersionDiffText(diff) {
  const lines = [
    `报价版本对比：${diff.left.name} -> ${diff.right.name}`,
    `版本A总价：${formatMoney(diff.left.totalCost || 0)}`,
    `版本B总价：${formatMoney(diff.right.totalCost || 0)}`,
    `总价变化：${diff.totalDelta >= 0 ? '+' : ''}${formatMoney(diff.totalDelta)}`,
    '',
    '分类汇总差异',
    ...diff.categorySummary.map(row => `${row.label}：${formatMoney(row.leftAmount)} -> ${formatMoney(row.rightAmount)}，变化 ${row.delta >= 0 ? '+' : ''}${formatMoney(row.delta)}`),
    '',
    `新增项 ${diff.added.length} 条`,
    ...diff.added.map(line => `+ ${line.name || '未命名'} ${line.qty || 0}${line.unit || ''} ${formatMoney(line.amount || 0)}`),
    '',
    `删除项 ${diff.removed.length} 条`,
    ...diff.removed.map(line => `- ${line.name || '未命名'} ${line.qty || 0}${line.unit || ''} ${formatMoney(line.amount || 0)}`),
    '',
    `修改项 ${diff.modified.length} 条`,
    ...diff.modified.map(item => `* ${item.right.name || '未命名'}：${item.changes.map(c => `${c.label} ${c.before} -> ${c.after}`).join('；')}`),
  ];
  return lines.join('\n');
}

export function defaultVersionName(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `报价版本 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function lineKey(line) {
  return line.quotaItemId || (line.resourceItemId ? `resource:${line.resourceItemId}` : '') || [line.code, line.name, line.feature, line.unit].map(v => v || '').join('|');
}

function snapshotLine(line, quotaRelations = line.quotaRelations || []) {
  const copy = {};
  LINE_FIELDS.forEach(field => {
    const value = line[field] ?? (field === 'factor' ? 1 : '');
    copy[field] = cloneValue(value);
  });
  copy.qty = Number(copy.qty) || 0;
  copy.factor = Number(copy.factor) || 1;
  copy.unitPrice = Number(copy.unitPrice) || 0;
  copy.amount = calculateAmount(copy.qty, copy.unitPrice, copy.factor);
  copy.priceMissing = hasMissingPrice(copy.unitPrice);
  copy.structureGroup = copy.structureGroup || groupForLine(copy);
  copy.quotaRelations = cloneValue(quotaRelations);
  copy.id = line.id || uid();
  return copy;
}

function cloneValue(value) {
  if (!value || typeof value !== 'object') return value;
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function mapByLineKey(lines) {
  const map = new Map();
  lines.forEach((line, index) => {
    let key = lineKey(line);
    if (!key.replace(/\|/g, '')) key = `line-${index}`;
    while (map.has(key)) key += `#${index}`;
    map.set(key, line);
  });
  return map;
}

function diffLine(left, right) {
  const checks = [
    ['qty', '工程量'],
    ['unitPrice', '综合单价'],
    ['factor', '系数'],
    ['amount', '合价'],
  ];
  return checks
    .filter(([field]) => Number(left[field] || 0) !== Number(right[field] || 0))
    .map(([field, label]) => ({ field, label, before: left[field] || 0, after: right[field] || 0 }));
}

function categoryDiff(leftLines, rightLines) {
  const left = categoryTotals(leftLines);
  const right = categoryTotals(rightLines);
  const ids = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return ids.map(id => ({
    id,
    label: groupLabel(id),
    leftAmount: left[id] || 0,
    rightAmount: right[id] || 0,
    delta: (right[id] || 0) - (left[id] || 0),
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function categoryTotals(lines) {
  return lines.reduce((acc, line) => {
    const group = groupForLine(line);
    acc[group] = (acc[group] || 0) + Number(line.amount || calculateAmount(line.qty, line.unitPrice, line.factor));
    return acc;
  }, {});
}

function groupLabel(id) {
  return {
    civil: '土建工程',
    equipment: '设备安装',
    electric: '电气自控',
    pipe: '管网管道',
    other: '其他',
  }[id] || id || '未分类';
}

function formatMoney(value) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}
