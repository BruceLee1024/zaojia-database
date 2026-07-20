// 本地字段映射模板：仅保存配置，不保存 Excel 行数据。
const TEMPLATE_STORAGE_KEY = 'costdb_import_mapping_templates_v2';
const LEGACY_TEMPLATE_STORAGE_KEY = 'costdb_import_mapping_templates_v1';

export function createMappingTemplate(input = {}) {
  const now = new Date().toISOString();
  const scope = input.scope === 'project' ? 'project' : 'global';
  if (scope === 'project' && !input.projectId) throw new Error('项目专属模板必须选择项目');
  return {
    id: input.id || createId(),
    name: String(input.name || '').trim(),
    scope,
    projectId: scope === 'project' ? String(input.projectId) : '',
    targetType: String(input.targetType || 'project_boq'),
    headerFingerprint: input.headerFingerprint || { version: 1, headers: [], columnCount: 0 },
    mapping: { ...(input.mapping || {}) },
    columnPaths: { ...(input.columnPaths || {}) },
    fixedValues: { ...(input.fixedValues || {}) },
    amountRule: ['calculated', 'sourceAmount', 'deriveUnitPrice'].includes(input.amountRule) ? input.amountRule : 'calculated',
    version: 2,
    createdAt: input.createdAt || now,
    updatedAt: now,
    lastUsedAt: input.lastUsedAt || '',
  };
}

export function listMappingTemplates({ projectId = '' } = {}, { storage = localStorage } = {}) {
  return readTemplates(storage)
    .filter(template => template.scope === 'global' || template.projectId === projectId)
    .sort((a, b) => String(b.lastUsedAt || b.updatedAt).localeCompare(String(a.lastUsedAt || a.updatedAt)));
}

export function getMappingTemplate(id, { storage = localStorage } = {}) {
  return readTemplates(storage).find(template => template.id === id) || null;
}

export function saveMappingTemplate(input, { storage = localStorage } = {}) {
  const next = createMappingTemplate(input);
  if (!next.name) throw new Error('请输入模板名称');
  const templates = readTemplates(storage);
  const duplicate = templates.find(template => template.id !== next.id
    && template.name === next.name
    && template.scope === next.scope
    && template.projectId === next.projectId);
  if (duplicate) throw new Error('该范围内已存在同名模板');
  const index = templates.findIndex(template => template.id === next.id);
  if (index >= 0) {
    next.createdAt = templates[index].createdAt;
    next.lastUsedAt = templates[index].lastUsedAt || '';
    templates[index] = next;
  } else {
    templates.push(next);
  }
  writeTemplates(templates, storage);
  return next;
}

export function deleteMappingTemplate(id, { storage = localStorage } = {}) {
  const templates = readTemplates(storage);
  const next = templates.filter(template => template.id !== id);
  writeTemplates(next, storage);
  return next.length !== templates.length;
}

export function duplicateMappingTemplate(id, { storage = localStorage } = {}) {
  const template = getMappingTemplate(id, { storage });
  if (!template) throw new Error('未找到模板');
  return createMappingTemplate({ ...template, id: '', name: `${template.name} 副本`, createdAt: '', lastUsedAt: '' });
}

export function markMappingTemplateUsed(id, { storage = localStorage } = {}) {
  const template = getMappingTemplate(id, { storage });
  if (!template) return null;
  return saveMappingTemplate({ ...template, lastUsedAt: new Date().toISOString() }, { storage });
}

function readTemplates(storage) {
  try {
    const current = JSON.parse(storage?.getItem(TEMPLATE_STORAGE_KEY) || '[]');
    if (Array.isArray(current) && current.length) return current.map(normalizeStoredTemplate);
    const legacy = JSON.parse(storage?.getItem(LEGACY_TEMPLATE_STORAGE_KEY) || '[]');
    return Array.isArray(legacy) ? legacy.map(template => normalizeStoredTemplate({ ...template, version: 1 })) : [];
  } catch {
    return [];
  }
}

function normalizeStoredTemplate(template = {}) {
  return {
    ...template,
    targetType: String(template.targetType || 'project_boq'),
    columnPaths: { ...(template.columnPaths || {}) },
    version: 2,
  };
}

function writeTemplates(templates, storage) {
  storage?.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `maptpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
