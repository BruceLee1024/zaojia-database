import { resourcePriceRepo, resourceRepo } from '../data/repository.js?v=6.2';
import { uid } from '../utils/dom.js?v=6.2';
import { localDateKey } from '../utils/localDate.js?v=6.2';

const SOURCE_TYPES = new Set(['official', 'supplier_quote', 'transaction']);
const PRICE_BASES = new Set(['ex_factory', 'delivered', 'installed_composite']);
const COMPONENT_KEYS = ['base', 'freight', 'transportLoss', 'procurementStorage', 'installation', 'commissioning', 'other'];

export const resourcePriceService = {
  async listByResource(resourceId) {
    return (await resourcePriceRepo.byResource(resourceId))
      .sort((a, b) => comparePriceDate(b, a));
  },

  async save(payload = {}) {
    if (payload.id && await resourcePriceRepo.findById(payload.id)) {
      const error = new Error('价格记录为不可变快照，不能修改');
      error.code = 'PRICE_IMMUTABLE';
      throw error;
    }
    const resource = await resourceRepo.findById(payload.resourceId);
    if (!resource) throw new Error('材料或设备不存在');
    validatePrice(payload);
    const components = Object.fromEntries(COMPONENT_KEYS.map(key => [key, numberOrZero(payload.components?.[key])]));
    const price = {
      id: payload.id || uid(),
      resourceId: payload.resourceId,
      sourceType: payload.sourceType,
      priceBasis: payload.priceBasis,
      unitPrice: Number(payload.unitPrice),
      currency: payload.currency || 'CNY',
      taxIncluded: Boolean(payload.taxIncluded),
      taxRate: numberOrZero(payload.taxRate),
      region: normalizeRegion(payload.region),
      priceDate: payload.priceDate,
      validFrom: payload.validFrom || '',
      validTo: payload.validTo || '',
      supplier: String(payload.supplier || '').trim(),
      projectId: payload.projectId || '',
      components,
      installationScope: String(payload.installationScope || '').trim(),
      note: String(payload.note || '').trim(),
      status: 'active',
      createdAt: payload.createdAt || new Date().toISOString(),
    };
    await resourcePriceRepo.upsert(price);
    return price;
  },

  async withdraw(id) {
    return withdrawPrice(id);
  },

  /** @deprecated Use withdraw(id). */
  async remove(id) {
    return withdrawPrice(id);
  },

  async getCurrentPrice(resourceId) {
    const [resource, prices] = await Promise.all([resourceRepo.findById(resourceId), resourcePriceRepo.byResource(resourceId)]);
    return selectCurrentResourcePrice(resource, prices, localDateKey());
  },
};

export function isPriceEffective(price, today = localDateKey()) {
  return Boolean(price
    && price.status !== 'withdrawn'
    && (!price.validFrom || price.validFrom <= today)
    && (!price.validTo || price.validTo >= today));
}

export function assertPriceUsableForCosting(price, resource, { context = 'quota' } = {}) {
  if (!price || price.resourceId !== resource?.id) throw new Error('价格记录不存在或不属于当前材料/设备');
  if (!isPriceEffective(price)) throw new Error('所选价格尚未生效、已过期或已撤回，不能用于新计价');
  if (context === 'quota' && price.priceBasis !== 'delivered') {
    throw new Error('定额资源组成只能使用到场价');
  }
  if (context === 'equipment' && !['delivered', 'installed_composite'].includes(price.priceBasis)) {
    throw new Error('设备项目包只能使用到场价或安装综合价');
  }
  return price;
}

async function withdrawPrice(id) {
  const price = await resourcePriceRepo.findById(id);
  if (!price) return null;
  const withdrawn = {
    ...price,
    status: 'withdrawn',
    withdrawnAt: price.withdrawnAt || new Date().toISOString(),
  };
  await resourcePriceRepo.upsert(withdrawn);
  const resource = await resourceRepo.findById(price.resourceId);
  if (resource?.preferredPriceId === id) {
    await resourceRepo.update(resource.id, { preferredPriceId: '', updatedAt: new Date().toISOString() });
  }
  return withdrawn;
}

export function selectCurrentResourcePrice(resource, prices = [], today = localDateKey()) {
  return selectResourcePrice(resource, prices, today);
}

export function selectResourcePrice(resource, prices = [], today = localDateKey(), { latestRegardlessOfValidity = false } = {}) {
  if (!resource) return null;
  const resourcePrices = prices.filter(price => price.resourceId === resource.id && price.status !== 'withdrawn');
  const preferred = resourcePrices.find(price => price.id === resource.preferredPriceId);
  if (preferred && (latestRegardlessOfValidity || isPriceEffective(preferred, today))) return preferred;
  if (latestRegardlessOfValidity) return resourcePrices.sort((a, b) => comparePriceDate(b, a))[0] || null;
  const latestValid = resourcePrices
    .filter(price => isPriceEffective(price, today))
    .sort((a, b) => comparePriceDate(b, a))[0] || null;
  return latestValid;
}

function validatePrice(payload) {
  if (!SOURCE_TYPES.has(payload.sourceType)) throw new Error('价格来源类型无效');
  if (!PRICE_BASES.has(payload.priceBasis)) throw new Error('价格口径无效');
  if (!(Number(payload.unitPrice) > 0)) throw new Error('单价必须大于 0');
  if (payload.currency && payload.currency !== 'CNY') throw new Error('币种仅支持 CNY');
  const taxRate = Number(payload.taxRate || 0);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new Error('税率必须在 0 到 100 之间');
  if (!payload.priceDate || !isDate(payload.priceDate)) throw new Error('价格日期不能为空且必须有效');
  const region = normalizeRegion(payload.region);
  if (!region.province && !region.city && !region.district) throw new Error('价格地区至少填写省、市、区中的一项');
  if (payload.validFrom && !isDate(payload.validFrom)) throw new Error('生效日期无效');
  if (payload.validTo && !isDate(payload.validTo)) throw new Error('失效日期无效');
  if (payload.validFrom && payload.validTo && payload.validFrom > payload.validTo) throw new Error('失效日期不能早于生效日期');
  if (payload.priceBasis === 'installed_composite' && !String(payload.installationScope || '').trim()) throw new Error('安装综合价必须填写安装范围');
}

function normalizeRegion(region = {}) {
  return {
    province: String(region?.province || '').trim(),
    city: String(region?.city || '').trim(),
    district: String(region?.district || '').trim(),
  };
}

function isDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function comparePriceDate(a, b) {
  return String(a.priceDate || '').localeCompare(String(b.priceDate || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
