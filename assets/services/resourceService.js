import { boqRepo, quotaResourceUsageRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=4.1';
import { uid } from '../utils/dom.js';

const RESOURCE_TYPES = new Set(['material', 'equipment']);
const RESOURCE_STATUSES = new Set(['active', 'inactive']);

export function resourceIdentity(resource = {}) {
  const code = normalizeIdentityPart(resource.code);
  if (code) return `code:${code}`;
  return [
    normalizeIdentityPart(resource.resourceType),
    normalizeIdentityPart(resource.name),
    normalizeIdentityPart(resource.specModel),
    normalizeIdentityPart(resource.unit),
    normalizeIdentityPart(resource.brand || resource.manufacturer),
  ].join('|');
}

export const resourceService = {
  async list({ keyword = '', resourceType = '', category = '', status = '' } = {}) {
    const normalizedKeyword = String(keyword).trim().toLowerCase();
    return (await resourceRepo.all()).filter(item => {
      if (resourceType && item.resourceType !== resourceType) return false;
      if (category && item.category !== category) return false;
      if (status && item.status !== status) return false;
      if (!normalizedKeyword) return true;
      return [item.code, item.category, item.name, item.specModel, item.brand, item.manufacturer, item.standard, item.processStage, ...(item.tags || [])]
        .some(value => String(value || '').toLowerCase().includes(normalizedKeyword));
    });
  },

  async get(id) {
    return await resourceRepo.findById(id);
  },

  async copy(id) {
    const source = await resourceRepo.findById(id);
    if (!source) throw new Error('材料或设备不存在');
    const existing = await resourceRepo.all();
    let suffix = 1;
    let code = source.code ? `${source.code}-COPY` : '';
    while (code && existing.some(item => normalizeIdentityPart(item.code) === normalizeIdentityPart(code))) {
      suffix += 1;
      code = `${source.code}-COPY-${suffix}`;
    }
    let name = `${source.name} - 副本`;
    while (!code && existing.some(item => resourceIdentity(item) === resourceIdentity({ ...source, id: '', code, name }))) {
      suffix += 1;
      name = `${source.name} - 副本 ${suffix}`;
    }
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...payload } = source;
    return await this.save({ ...payload, code, name, preferredPriceId: '' });
  },

  async setStatus(id, status) {
    if (!RESOURCE_STATUSES.has(status)) throw new Error('状态必须为 active 或 inactive');
    const resource = await resourceRepo.findById(id);
    if (!resource) throw new Error('材料或设备不存在');
    return await resourceRepo.update(id, { status, updatedAt: new Date().toISOString() });
  },

  async save(payload = {}) {
    validateResource(payload);
    const existing = payload.id ? await resourceRepo.findById(payload.id) : null;
    if (payload.id && !existing) throw new Error('材料或设备不存在');
    if (payload.preferredPriceId) {
      const preferredPrice = await resourcePriceRepo.findById(payload.preferredPriceId);
      if (!preferredPrice) throw new Error('首选价格不存在');
      if (!existing || preferredPrice.resourceId !== existing.id) throw new Error('首选价格不属于当前材料或设备');
    }
    const now = new Date().toISOString();
    const item = {
      id: existing?.id || uid(),
      resourceType: payload.resourceType,
      code: String(payload.code || '').trim(),
      category: String(payload.category || '').trim(),
      name: String(payload.name || '').trim(),
      specModel: String(payload.specModel || '').trim(),
      unit: String(payload.unit || '').trim(),
      brand: String(payload.brand || '').trim(),
      manufacturer: String(payload.manufacturer || '').trim(),
      standard: String(payload.standard || '').trim(),
      processStage: String(payload.processStage || '').trim(),
      attributes: isPlainObject(payload.attributes) ? { ...payload.attributes } : {},
      tags: Array.isArray(payload.tags) ? [...new Set(payload.tags.map(tag => String(tag).trim()).filter(Boolean))] : [],
      status: payload.status || existing?.status || 'active',
      preferredPriceId: payload.preferredPriceId ?? existing?.preferredPriceId ?? '',
      note: String(payload.note || '').trim(),
      createdAt: existing?.createdAt || payload.createdAt || now,
      updatedAt: now,
    };
    const identity = resourceIdentity(item);
    const duplicate = (await resourceRepo.all()).find(candidate => candidate.id !== item.id && resourceIdentity(candidate) === identity);
    if (duplicate) {
      const error = new Error('已存在相同编码或相同类型、名称、规格、单位和品牌的材料/设备');
      error.code = 'RESOURCE_DUPLICATE';
      error.duplicate = duplicate;
      throw error;
    }
    return await resourceRepo.upsert(item);
  },

  async usage(id) {
    const [quotaUsages, projectLines] = await Promise.all([
      quotaResourceUsageRepo.byResource(id),
      boqRepo.all(),
    ]);
    const lines = projectLines.filter(line => line.resourceItemId === id || line.linkedResourceItemId === id);
    return {
      quotaUsageCount: quotaUsages.length,
      quotaItemIds: [...new Set(quotaUsages.map(item => item.quotaItemId).filter(Boolean))],
      projectLineCount: lines.length,
      projectIds: [...new Set(lines.map(line => line.projectId).filter(Boolean))],
      total: quotaUsages.length + lines.length,
    };
  },

  async remove(id, { force = false } = {}) {
    const usage = await this.usage(id);
    if (usage.total && !force) {
      const error = new Error('该材料或设备仍被定额或项目清单引用');
      error.code = 'RESOURCE_IN_USE';
      error.usage = usage;
      throw error;
    }
    if (force && usage.total) {
      const [usages, lines] = await Promise.all([quotaResourceUsageRepo.all(), boqRepo.all()]);
      await Promise.all([
        quotaResourceUsageRepo.replaceAll(usages.filter(item => item.resourceId !== id)),
        boqRepo.replaceAll(lines.map(line => {
          let next = line;
          if (line.resourceItemId === id) {
            next = {
              ...next,
              resourceReferenceStatus: 'missing',
              resourceReferenceNote: '关联材料或设备已删除，当前价格快照仍保留。',
            };
          }
          if (line.linkedResourceItemId === id) {
            next = {
              ...next,
              linkedResourceReferenceStatus: 'missing',
              linkedResourceReferenceNote: '关联设备已删除，安装定额与设备快照仍保留。',
            };
          }
          return next;
        })),
      ]);
    }
    await resourceRepo.remove(id);
    return usage;
  },

  async setPreferredPrice(resourceId, priceId) {
    const resource = await resourceRepo.findById(resourceId);
    if (!resource) throw new Error('材料或设备不存在');
    if (priceId) {
      const price = await resourcePriceRepo.findById(priceId);
      if (!price || price.resourceId !== resourceId) throw new Error('价格记录不存在或不属于当前材料/设备');
    }
    return await resourceRepo.update(resourceId, { preferredPriceId: priceId || '', updatedAt: new Date().toISOString() });
  },
};

function validateResource(payload) {
  if (!RESOURCE_TYPES.has(payload.resourceType)) throw new Error('材料/设备类型必须为 material 或 equipment');
  if (!String(payload.name || '').trim()) throw new Error('名称不能为空');
  if (!String(payload.unit || '').trim()) throw new Error('单位不能为空');
  if (payload.status && !RESOURCE_STATUSES.has(payload.status)) throw new Error('状态必须为 active 或 inactive');
  if (payload.attributes != null && !isPlainObject(payload.attributes)) throw new Error('扩展属性必须为对象');
  if (payload.tags != null && !Array.isArray(payload.tags)) throw new Error('标签必须为数组');
}

function normalizeIdentityPart(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
