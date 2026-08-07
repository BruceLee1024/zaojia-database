// Repository 层：所有业务数据访问的唯一入口
// 业务层不准直接碰 IndexedDB 或本地文件夹，必须走这里
import { storageGet, storageSet } from './storage.js?v=6.12';

export const STORES = {
  quota_items: 'quota_items',
  boq_library_items: 'boq_library_items',
  boq_library_quota_relations: 'boq_library_quota_relations',
  projects:    'projects',
  project_boq: 'project_boq',
  project_boq_quota_relations: 'project_boq_quota_relations',
  boq_versions: 'boq_versions',
  indicators:  'indicators',
  data_facts: 'data_facts',
  data_candidates: 'data_candidates',
  data_jobs: 'data_jobs',
  data_quality_reports: 'data_quality_reports',
  experience_sessions: 'experience_sessions',
  experience_cards: 'experience_cards',
  resource_items: 'resource_items',
  resource_prices: 'resource_prices',
  quota_resource_usages: 'quota_resource_usages',
  resource_attachments: 'resource_attachments',
  ai_sessions: 'ai_sessions',
  project_lifecycle_events: 'project_lifecycle_events',
};

export const dbGetAll = async store => (await storageGet(store)) || [];
export const dbSetAll = (store, arr) => storageSet(store, arr);

// 通用 CRUD
export async function dbAdd(store, obj) {
  const arr = await dbGetAll(store);
  arr.push(obj);
  await dbSetAll(store, arr);
  return obj;
}
export async function dbUpdate(store, id, patch) {
  const arr = await dbGetAll(store);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return null;
  arr[idx] = { ...arr[idx], ...patch };
  await dbSetAll(store, arr);
  return arr[idx];
}
export async function dbRemove(store, id) {
  const arr = await dbGetAll(store);
  await dbSetAll(store, arr.filter(x => x.id !== id));
}
export async function dbFind(store, id) {
  const arr = await dbGetAll(store);
  return arr.find(x => x.id === id) || null;
}
export async function dbQuery(store, fn) {
  const arr = await dbGetAll(store);
  return arr.filter(fn);
}

// 业务级便捷方法
export const quotaRepo = {
  all: () => dbGetAll(STORES.quota_items),
  findById: id => dbFind(STORES.quota_items, id),
  upsert: obj => {
    if (!obj.id) obj.id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
    return dbAdd(STORES.quota_items, obj);
  },
  update: (id, patch) => dbUpdate(STORES.quota_items, id, patch),
  remove: id => dbRemove(STORES.quota_items, id),
  replaceAll: arr => dbSetAll(STORES.quota_items, arr),
};

export const boqLibraryRepo = {
  all: () => dbGetAll(STORES.boq_library_items),
  findById: id => dbFind(STORES.boq_library_items, id),
  upsert: obj => {
    if (!obj.id) obj.id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
    return dbAdd(STORES.boq_library_items, obj);
  },
  update: (id, patch) => dbUpdate(STORES.boq_library_items, id, patch),
  remove: id => dbRemove(STORES.boq_library_items, id),
  replaceAll: arr => dbSetAll(STORES.boq_library_items, arr),
};

export const boqLibraryQuotaRelationRepo = createRepo(STORES.boq_library_quota_relations, {
  byBoqLibraryItem: boqLibraryItemId => dbQuery(STORES.boq_library_quota_relations, item => item.boqLibraryItemId === boqLibraryItemId),
  byQuota: quotaItemId => dbQuery(STORES.boq_library_quota_relations, item => item.quotaItemId === quotaItemId),
});

export const projectRepo = {
  all: () => dbGetAll(STORES.projects),
  findById: id => dbFind(STORES.projects, id),
  upsert: obj => dbAdd(STORES.projects, obj),
  update: (id, patch) => dbUpdate(STORES.projects, id, patch),
  remove: id => dbRemove(STORES.projects, id),
  replaceAll: arr => dbSetAll(STORES.projects, arr),
};

export const boqRepo = {
  all: () => dbGetAll(STORES.project_boq),
  byProject: pid => dbQuery(STORES.project_boq, b => b.projectId === pid),
  upsert: obj => dbAdd(STORES.project_boq, obj),
  update: (id, patch) => dbUpdate(STORES.project_boq, id, patch),
  remove: id => dbRemove(STORES.project_boq, id),
  removeByProject: async pid => dbSetAll(STORES.project_boq,
    (await dbGetAll(STORES.project_boq)).filter(b => b.projectId !== pid)
  ),
  replaceAll: arr => dbSetAll(STORES.project_boq, arr),
};

export const projectBoqQuotaRelationRepo = createRepo(STORES.project_boq_quota_relations, {
  byProject: projectId => dbQuery(STORES.project_boq_quota_relations, item => item.projectId === projectId),
  byBoqLine: projectBoqLineId => dbQuery(STORES.project_boq_quota_relations, item => item.projectBoqLineId === projectBoqLineId),
  byQuota: quotaItemId => dbQuery(STORES.project_boq_quota_relations, item => item.quotaItemId === quotaItemId),
});

export const versionRepo = {
  all: () => dbGetAll(STORES.boq_versions),
  byProject: pid => dbQuery(STORES.boq_versions, v => v.projectId === pid),
  findById: id => dbFind(STORES.boq_versions, id),
  upsert: obj => dbAdd(STORES.boq_versions, obj),
  remove: id => dbRemove(STORES.boq_versions, id),
  replaceAll: arr => dbSetAll(STORES.boq_versions, arr),
};

export const indicatorRepo = {
  all: () => dbGetAll(STORES.indicators),
  replaceAll: arr => dbSetAll(STORES.indicators, arr),
};

export const dataFactRepo = {
  all: () => dbGetAll(STORES.data_facts),
  byProject: pid => dbQuery(STORES.data_facts, f => f.projectId === pid),
  replaceAll: arr => dbSetAll(STORES.data_facts, arr),
  upsert: obj => dbAdd(STORES.data_facts, obj),
  remove: id => dbRemove(STORES.data_facts, id),
};

export const dataCandidateRepo = {
  all: () => dbGetAll(STORES.data_candidates),
  byProject: pid => dbQuery(STORES.data_candidates, f => f.projectId === pid),
  replaceAll: arr => dbSetAll(STORES.data_candidates, arr),
  upsert: obj => dbAdd(STORES.data_candidates, obj),
  remove: id => dbRemove(STORES.data_candidates, id),
};

export const dataJobRepo = {
  all: () => dbGetAll(STORES.data_jobs),
  replaceAll: arr => dbSetAll(STORES.data_jobs, arr),
  upsert: obj => dbAdd(STORES.data_jobs, obj),
};

export const dataQualityReportRepo = {
  all: () => dbGetAll(STORES.data_quality_reports),
  replaceAll: arr => dbSetAll(STORES.data_quality_reports, arr),
  upsert: obj => dbAdd(STORES.data_quality_reports, obj),
};

export const experienceSessionRepo = {
  all: () => dbGetAll(STORES.experience_sessions),
  byProject: pid => dbQuery(STORES.experience_sessions, s => s.projectId === pid),
  findById: id => dbFind(STORES.experience_sessions, id),
  replaceAll: arr => dbSetAll(STORES.experience_sessions, arr),
  upsert: obj => dbAdd(STORES.experience_sessions, obj),
  update: (id, patch) => dbUpdate(STORES.experience_sessions, id, patch),
  remove: id => dbRemove(STORES.experience_sessions, id),
};

export const experienceCardRepo = {
  all: () => dbGetAll(STORES.experience_cards),
  byProject: pid => dbQuery(STORES.experience_cards, c => c.projectId === pid),
  findById: id => dbFind(STORES.experience_cards, id),
  replaceAll: arr => dbSetAll(STORES.experience_cards, arr),
  upsert: obj => dbAdd(STORES.experience_cards, obj),
  update: (id, patch) => dbUpdate(STORES.experience_cards, id, patch),
  remove: id => dbRemove(STORES.experience_cards, id),
};

function createRepo(store, helpers = {}) {
  return {
    all: () => dbGetAll(store),
    findById: id => dbFind(store, id),
    async upsert(obj) {
      if (!obj.id) obj.id = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10);
      return await dbFind(store, obj.id)
        ? await dbUpdate(store, obj.id, obj)
        : await dbAdd(store, obj);
    },
    update: (id, patch) => dbUpdate(store, id, patch),
    remove: id => dbRemove(store, id),
    replaceAll: arr => dbSetAll(store, arr),
    ...helpers,
  };
}

export const resourceRepo = createRepo(STORES.resource_items);
export const resourcePriceRepo = createRepo(STORES.resource_prices, {
  byResource: resourceId => dbQuery(STORES.resource_prices, item => item.resourceId === resourceId),
});
export const quotaResourceUsageRepo = createRepo(STORES.quota_resource_usages, {
  byQuota: quotaItemId => dbQuery(STORES.quota_resource_usages, item => item.quotaItemId === quotaItemId),
  byResource: resourceId => dbQuery(STORES.quota_resource_usages, item => item.resourceId === resourceId),
});
export const resourceAttachmentRepo = createRepo(STORES.resource_attachments, {
  byResource: resourceId => dbQuery(STORES.resource_attachments, item => item.resourceId === resourceId),
});

export const aiSessionRepo = createRepo(STORES.ai_sessions, {
  byProject: projectId => dbQuery(STORES.ai_sessions, item => item.projectId === projectId),
});

export const projectLifecycleEventRepo = createRepo(STORES.project_lifecycle_events, {
  byProject: projectId => dbQuery(STORES.project_lifecycle_events, item => item.projectId === projectId),
});
