// 全局搜索：聚合定额、项目、指标、经验和常用入口
import { quotaRepo, boqLibraryRepo, projectRepo, boqRepo, versionRepo, indicatorRepo, experienceCardRepo, resourceRepo } from '../data/repository.js?v=6.3';
import { fmtMoney } from '../utils/dom.js?v=6.3';
import { hasMissingPrice } from '../utils/costing.js?v=6.3';

const TYPE_META = {
  quota: { label: '定额', icon: 'menu_book' },
  boq_library: { label: '清单库', icon: 'format_list_bulleted' },
  project: { label: '项目', icon: 'folder_managed' },
  indicator: { label: '指标', icon: 'analytics' },
  experience: { label: '经验', icon: 'psychology_alt' },
  import_action: { label: '导入', icon: 'upload_file' },
  material: { label: '材料', icon: 'category' },
  equipment: { label: '设备', icon: 'precision_manufacturing' },
};

export async function searchAll(keyword = '') {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const [quotas, libraryItems, projects, boq, versions, indicators, cards, resources] = await Promise.all([
    quotaRepo.all(),
    boqLibraryRepo.all(),
    projectRepo.all(),
    boqRepo.all(),
    versionRepo.all(),
    indicatorRepo.all(),
    experienceCardRepo.all(),
    resourceRepo.all(),
  ]);
  return [
    ...importActionResults(kw),
    ...quotaResults(quotas, kw),
    ...boqLibraryResults(libraryItems, kw),
    ...projectResults(projects, boq, versions, kw),
    ...indicatorResults(indicators, kw),
    ...experienceResults(cards, kw),
    ...resourceResults(resources, kw),
  ].sort((a, b) => b.score - a.score).slice(0, 24);
}

export function searchGroups(results = []) {
  return ['material', 'equipment', 'quota', 'boq_library', 'project', 'indicator', 'experience', 'import_action']
    .map(type => ({ type, meta: TYPE_META[type], items: results.filter(r => r.type === type) }))
    .filter(group => group.items.length);
}

function resourceResults(rows, kw) {
  const matches = rows.filter(item => item.status !== 'inactive')
    .filter(item => includes(item, kw, ['code', 'category', 'name', 'specModel', 'unit', 'brand', 'manufacturer', 'standard', 'processStage', 'tags']));
  return ['material', 'equipment'].flatMap(resourceType => matches
    .filter(item => item.resourceType === resourceType)
    .slice(0, 8)
    .map(item => result(
      item.resourceType,
      item.id,
      item.name || (item.resourceType === 'equipment' ? '未命名设备' : '未命名材料'),
      `${item.code || '未编码'} · ${item.specModel || '无规格'} · ${item.unit || '-'}`,
      item.resourceType === 'equipment' ? 'equipment' : 'materials',
      { keyword: kw, selectedId: item.id },
      scoreText(`${item.code} ${item.name}`, kw) + 21,
      [item.category, item.brand || item.manufacturer, item.processStage].filter(Boolean).join(' / ')
    )));
}

function boqLibraryResults(rows, kw) {
  return rows.filter(item => item.status !== 'inactive')
    .filter(item => includes(item, kw, ['code', 'name', 'feature', 'major', 'scope', 'unit']))
    .slice(0, 8)
    .map(item => result(
      'boq_library', item.id, item.name || '未命名清单',
      `${item.code || '未编码'} · ${item.unit || '-'} · ${(item.quotaItemIds || []).length ? `关联定额 ${(item.quotaItemIds || []).length} 条` : '未关联定额'}`,
      'boq-library', { keyword: item.name || kw, selectedId: item.id },
      scoreText(`${item.code} ${item.name}`, kw) + 19, item.feature || ''
    ));
}

function result(type, id, title, subtitle, targetView, params, score = 1, excerpt = '') {
  return {
    id: `${type}:${id}`,
    type,
    title,
    subtitle,
    excerpt,
    score,
    icon: TYPE_META[type]?.icon || 'search',
    actionLabel: `打开${TYPE_META[type]?.label || ''}`,
    targetView,
    params,
  };
}

function quotaResults(rows, kw) {
  return rows.filter(item => includes(item, kw, ['name', 'feature', 'category', 'unit', 'tags']))
    .slice(0, 8)
    .map(item => result(
      'quota',
      item.id,
      item.name || '未命名定额',
      `${item.category || '未分类'} · ${item.unit || '-'} · ${hasMissingPrice(item.priceTotal) ? '缺单价' : fmtMoney(item.priceTotal)}`,
      'quota',
      { keyword: item.name || kw, selectedId: item.id, priceStatus: hasMissingPrice(item.priceTotal) ? 'missing' : '' },
      scoreText(item.name, kw) + 20,
      item.feature || ''
    ));
}

function projectResults(projects, lines, versions, kw) {
  return projects.filter(project => includes(project, kw, ['name', 'type', 'scale', 'process', 'structure', 'status']))
    .slice(0, 8)
    .map(project => {
      const projectLines = lines.filter(line => line.projectId === project.id);
      const missing = projectLines.filter(line => hasMissingPrice(line.unitPrice)).length;
      const projectVersions = versions.filter(version => version.projectId === project.id).length;
      return result(
        'project',
        project.id,
        project.name || '未命名项目',
        `${project.type || '未分类'} · ${projectLines.length} 条清单 · ${missing ? `缺价 ${missing}` : '价格完整'} · ${projectVersions} 个版本`,
        missing ? 'boq' : 'projects',
        missing ? { projectId: project.id, priceStatus: 'missing' } : { keyword: project.name || kw, selectedId: project.id },
        scoreText(project.name, kw) + 18,
        [project.scale, project.process, project.structure].filter(Boolean).join(' / ')
      );
    });
}

function indicatorResults(rows, kw) {
  return rows.filter(item => includes(item, kw, ['metric', 'typeKey', 'category', 'confidence']))
    .slice(0, 6)
    .map(item => result(
      'indicator',
      `${item.metric}:${item.typeKey}`,
      item.metric || '未命名指标',
      `${item.typeKey || '未分桶'} · 样本 ${item.n || 0} · ${item.confidence || '无评级'}`,
      'indicators',
      { keyword: item.metric || kw, selectedFamily: familyOf(item.metric) },
      scoreText(item.metric, kw) + 12,
      item.category || ''
    ));
}

function experienceResults(rows, kw) {
  return rows.filter(card => (card.reviewStatus || card.status) !== 'archived')
    .filter(card => includes(card, kw, ['title', 'lesson', 'summary', 'projectNameSnapshot', 'costCategory', 'processType', 'keywords', 'tags']))
    .slice(0, 6)
    .map(card => result(
      'experience',
      card.id,
      card.title || '未命名经验',
      `${card.projectNameSnapshot || '未关联项目'} · ${card.reviewStatus || card.status || '经验'}`,
      'experience',
      { keyword: kw, selectedId: card.id, projectId: card.projectId || '' },
      scoreText(card.title, kw) + 10,
      card.lesson || card.summary || ''
    ));
}

function importActionResults(kw) {
  const actions = [
    ['boq', 'AI 导入项目工程量清单', '上传任意 Excel，由 AI 识别字段并确认后写入项目', { view: 'ai-import', params: { targetType: 'project_boq' } }],
    ['quota', '导入企业定额库', '上传定额 Excel，进入定额库检查价格', { view: 'importer', params: { action: 'quota' } }],
    ['backup', '导入 JSON 备份', '恢复本地 IndexedDB 业务数据', { view: 'settings', params: { section: 'backup' } }],
    ['version', '历史报价 / 版本', '打开工程量清单保存或管理报价版本', { view: 'boq', params: {} }],
  ];
  return actions
    .filter(([id, title, subtitle]) => `${id} ${title} ${subtitle}`.toLowerCase().includes(kw))
    .map(([id, title, subtitle, target]) => result('import_action', id, title, subtitle, target.view, target.params, 8));
}

function includes(obj, kw, fields) {
  return fields.some(field => {
    const value = obj?.[field];
    return Array.isArray(value)
      ? value.join(' ').toLowerCase().includes(kw)
      : String(value || '').toLowerCase().includes(kw);
  });
}

function scoreText(value, kw) {
  const text = String(value || '').toLowerCase();
  if (text === kw) return 100;
  if (text.startsWith(kw)) return 70;
  if (text.includes(kw)) return 40;
  return 0;
}

function familyOf(metric = '') {
  if (metric.includes('单水')) return '单水造价';
  if (metric.includes('单方')) return '单方造价';
  if (metric.includes('分项')) return '分项造价';
  return '总造价';
}
