// 报价版本服务：当前清单的不可变快照、恢复与对比
import { boqRepo, projectRepo, versionRepo } from '../data/repository.js?v=2.8';
import { uid } from '../utils/dom.js';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=2.8';
import { dataEngineService } from './dataEngineService.js?v=2.8';

const LINE_FIELDS = ['quotaItemId', 'code', 'name', 'feature', 'unit', 'qty', 'factor', 'unitPrice', 'amount', 'priceMissing'];

export const versionService = {
  async createFromCurrent(projectId, { name, note = '' } = {}) {
    const [project, lines] = await Promise.all([
      projectRepo.findById(projectId),
      boqRepo.byProject(projectId),
    ]);
    if (!project) throw new Error('项目不存在');

    const snapshotLines = lines.map(snapshotLine);
    const totalCost = snapshotLines.reduce((sum, line) => sum + (line.amount || 0), 0);
    const version = {
      id: uid(),
      projectId,
      name: (name || '').trim() || defaultVersionName(),
      note: (note || '').trim(),
      createdAt: new Date().toISOString(),
      totalCost,
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
    const allLines = await boqRepo.all();
    const restored = (version.lines || []).map(line => ({
      ...snapshotLine(line),
      id: uid(),
      projectId: version.projectId,
      amount: calculateAmount(line.qty, line.unitPrice, line.factor),
      priceMissing: hasMissingPrice(line.unitPrice),
    }));
    await boqRepo.replaceAll([
      ...allLines.filter(line => line.projectId !== version.projectId),
      ...restored,
    ]);
    const total = restored.reduce((sum, line) => sum + (line.amount || 0), 0);
    await projectRepo.update(version.projectId, { totalCost: total });
    return { version, restoredCount: restored.length, totalCost: total };
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
    };
  },

  async remove(versionId) {
    return await versionRepo.remove(versionId);
  },
};

export function defaultVersionName(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `报价版本 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function lineKey(line) {
  return line.quotaItemId || [line.code, line.name, line.feature, line.unit].map(v => v || '').join('|');
}

function snapshotLine(line) {
  const copy = {};
  LINE_FIELDS.forEach(field => {
    copy[field] = line[field] ?? (field === 'factor' ? 1 : '');
  });
  copy.qty = Number(copy.qty) || 0;
  copy.factor = Number(copy.factor) || 1;
  copy.unitPrice = Number(copy.unitPrice) || 0;
  copy.amount = calculateAmount(copy.qty, copy.unitPrice, copy.factor);
  copy.priceMissing = hasMissingPrice(copy.unitPrice);
  copy.id = line.id || uid();
  return copy;
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
