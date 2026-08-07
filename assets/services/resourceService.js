import { boqRepo, quotaResourceUsageRepo, resourceAttachmentRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=6.10';
import { uid } from '../utils/dom.js?v=6.10';

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

export function resourceCodeIdentity(resource = {}) {
  const code = normalizeIdentityPart(resource.code);
  return code ? `code:${code}` : '';
}

export function resourceCompositeIdentity(resource = {}) {
  return [
    normalizeIdentityPart(resource.resourceType),
    normalizeIdentityPart(resource.name),
    normalizeIdentityPart(resource.specModel),
    normalizeIdentityPart(resource.unit),
    normalizeIdentityPart(resource.brand || resource.manufacturer),
  ].join('|');
}

export function findResourceConflict(candidate, resources = []) {
  const codeIdentity = resourceCodeIdentity(candidate);
  const compositeIdentity = resourceCompositeIdentity(candidate);
  return resources.find(item => item.id !== candidate.id && (
    (codeIdentity && resourceCodeIdentity(item) === codeIdentity)
    || resourceCompositeIdentity(item) === compositeIdentity
  )) || null;
}

export function validateResourceCollection(resources = []) {
  resources.forEach(item => validateResource(item));
  resources.forEach((item, index) => {
    const conflict = findResourceConflict(item, resources.slice(0, index));
    if (conflict) throw duplicateResourceError(conflict);
  });
  return resources;
}

export function assertResourceAvailableForNewUse(resource) {
  if (!resource) throw new Error('材料或设备不存在');
  if (resource.status === 'inactive') throw new Error('已停用的材料或设备不能用于新计价');
  return resource;
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
      if (preferredPrice.status === 'withdrawn') throw new Error('已撤回价格不能设为首选价格');
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
    const duplicate = findResourceConflict(item, await resourceRepo.all());
    if (duplicate) {
      throw duplicateResourceError(duplicate);
    }
    return await resourceRepo.upsert(item);
  },

  async usage(id) {
    const [quotaUsages, projectLines, prices, attachments] = await Promise.all([
      quotaResourceUsageRepo.byResource(id),
      boqRepo.all(),
      resourcePriceRepo.byResource(id),
      resourceAttachmentRepo.byResource(id),
    ]);
    const lines = projectLines.filter(line => [
      line.resourceItemId,
      line.linkedResourceItemId,
      line.installationResourceItemId,
      line.manualInstallationResourceId,
    ].includes(id));
    return {
      quotaUsageCount: quotaUsages.length,
      quotaItemIds: [...new Set(quotaUsages.map(item => item.quotaItemId).filter(Boolean))],
      projectLineCount: lines.length,
      projectIds: [...new Set(lines.map(line => line.projectId).filter(Boolean))],
      priceCount: prices.length,
      attachmentCount: attachments.length,
      activeReferenceTotal: quotaUsages.length + lines.length,
      total: quotaUsages.length + lines.length + prices.length + attachments.length,
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
    if (usage.total) {
      const resource = await resourceRepo.findById(id);
      if (!resource) return usage;
      await resourceRepo.update(id, {
        status: 'inactive',
        preferredPriceId: '',
        withdrawnAt: resource.withdrawnAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return { ...usage, tombstoned: true };
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
      if (price.status === 'withdrawn') throw new Error('已撤回价格不能设为首选价格');
    }
    return await resourceRepo.update(resourceId, { preferredPriceId: priceId || '', updatedAt: new Date().toISOString() });
  },

  async merge(sourceId, targetId) {
    if (!sourceId || sourceId === targetId) throw new Error('请选择两个不同的材料或设备进行合并');
    const [source, target, resources, prices, attachments, usages, lines] = await Promise.all([
      resourceRepo.findById(sourceId), resourceRepo.findById(targetId), resourceRepo.all(), resourcePriceRepo.all(),
      resourceAttachmentRepo.all(), quotaResourceUsageRepo.all(), boqRepo.all(),
    ]);
    if (!source || !target) throw new Error('待合并材料或设备不存在');
    if (source.resourceType !== target.resourceType) throw new Error('只能合并同类型的材料或设备');
    const now = new Date().toISOString();
    const nextResources = resources.map(item => item.id === sourceId ? {
      ...item, status: 'inactive', preferredPriceId: '', mergedIntoResourceId: targetId, mergedAt: now, updatedAt: now,
    } : item);
    const nextPrices = prices.map(item => item.resourceId === sourceId ? { ...item, resourceId: targetId, mergedFromResourceId: sourceId } : item);
    const nextAttachments = attachments.map(item => item.resourceId === sourceId ? { ...item, resourceId: targetId } : item);
    const nextUsages = usages.map(item => item.resourceId === sourceId ? { ...item, resourceId: targetId, mergedFromResourceId: sourceId, updatedAt: now } : item);
    const nextLines = lines.map(item => replaceResourceReferences(item, sourceId, targetId));
    try {
      await resourceRepo.replaceAll(nextResources);
      await resourcePriceRepo.replaceAll(nextPrices);
      await resourceAttachmentRepo.replaceAll(nextAttachments);
      await quotaResourceUsageRepo.replaceAll(nextUsages);
      await boqRepo.replaceAll(nextLines);
    } catch (cause) {
      await Promise.allSettled([
        resourceRepo.replaceAll(resources), resourcePriceRepo.replaceAll(prices), resourceAttachmentRepo.replaceAll(attachments),
        quotaResourceUsageRepo.replaceAll(usages), boqRepo.replaceAll(lines),
      ]);
      throw Object.assign(new Error('资源合并失败，已尝试恢复原数据'), { code: 'RESOURCE_MERGE_FAILED', cause });
    }
    return { sourceId, targetId, mergedAt: now };
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

function duplicateResourceError(duplicate) {
  const error = new Error('已存在相同编码或相同类型、名称、规格、单位和品牌的材料/设备');
  error.code = 'RESOURCE_DUPLICATE';
  error.duplicate = duplicate;
  return error;
}

function replaceResourceReferences(line, sourceId, targetId) {
  const fields = ['resourceItemId', 'linkedResourceItemId', 'installationResourceItemId', 'manualInstallationResourceId'];
  const next = { ...line };
  fields.forEach(field => { if (next[field] === sourceId) next[field] = targetId; });
  return next;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
