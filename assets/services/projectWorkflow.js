// 项目工作流规则：项目页、清单页和服务层共用
import { hasMissingPrice } from '../utils/costing.js?v=6.7';

export const ARCHIVE_BLOCKERS = {
  no_lines: {
    id: 'no_lines',
    label: '没有清单',
    desc: '先导入或添加工程量清单，再归档为正式指标样本。',
    params: {},
  },
  missing_price: {
    id: 'missing_price',
    label: '存在缺单价',
    desc: '缺单价会低估总造价，请先定位并补齐综合单价。',
    params: { priceStatus: 'missing' },
  },
  zero_qty: {
    id: 'zero_qty',
    label: '存在 0 工程量',
    desc: '0 工程量会影响样本可信度，请先复核风险项。',
    params: { riskStatus: 'zeroQty' },
  },
  no_version: {
    id: 'no_version',
    label: '没有报价版本',
    desc: '归档前请先保存一个不可变报价版本，便于回溯和复盘。',
    params: {},
  },
};

export function archiveEligibility(project, lines = [], versions = []) {
  const blockers = [];
  const missing = lines.filter(line => hasMissingPrice(line.unitPrice)).length;
  const zeroQty = lines.filter(line => !(Number(line.qty) > 0)).length;

  if (!lines.length) blockers.push({ ...ARCHIVE_BLOCKERS.no_lines, count: 0 });
  if (missing) blockers.push({ ...ARCHIVE_BLOCKERS.missing_price, count: missing });
  if (zeroQty) blockers.push({ ...ARCHIVE_BLOCKERS.zero_qty, count: zeroQty });
  if (!versions.length) blockers.push({ ...ARCHIVE_BLOCKERS.no_version, count: 0 });

  const primary = blockers[0] || null;
  return {
    allowed: Boolean(project) && project.status !== 'archived' && blockers.length === 0,
    isArchived: project?.status === 'archived',
    blockers,
    primaryAction: primary ? {
      label: actionLabel(primary.id),
      targetView: 'boq',
      params: { projectId: project?.id || '', ...primary.params },
    } : {
      label: project?.status === 'archived' ? '查看指标' : '归档项目',
      targetView: project?.status === 'archived' ? 'indicators' : 'boq',
      params: { projectId: project?.id || '' },
    },
    stats: {
      lineCount: lines.length,
      missing,
      zeroQty,
      versionCount: versions.length,
    },
  };
}

function actionLabel(id) {
  if (id === 'no_lines') return '去添加清单';
  if (id === 'missing_price') return '去补缺价';
  if (id === 'zero_qty') return '复核工程量';
  if (id === 'no_version') return '去保存版本';
  return '处理阻断项';
}

export function archiveBlockerText(eligibility) {
  if (!eligibility?.blockers?.length) return '价格完整且已有版本，可归档为正式指标样本。';
  return eligibility.blockers.map(blocker => {
    const countText = blocker.count ? `${blocker.count} 条` : '';
    return `${blocker.label}${countText ? `（${countText}）` : ''}`;
  }).join('、');
}
