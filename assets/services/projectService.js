// 项目服务
import { projectRepo, boqRepo, projectBoqQuotaRelationRepo, versionRepo, dataCandidateRepo, dataFactRepo, dataJobRepo, dataQualityReportRepo, projectLifecycleEventRepo } from '../data/repository.js?v=6.9';
import { uid } from '../utils/dom.js?v=6.9';
import { normalizeCurrency } from '../utils/currency.js?v=6.9';
import { recomputeProjectCost } from './boqService.js?v=6.9';
import { dataEngineService } from './dataEngineService.js?v=6.9';
import { archiveEligibility } from './projectWorkflow.js?v=6.9';
import { versionService } from './versionService.js?v=6.9';
import { recordProjectLifecycleEvent } from './projectLockService.js?v=6.9';

export function normalizeProjectMetadata(data = {}) {
  const priceYear = String(data.priceYear || '').trim();
  return {
    ...data,
    code: String(data.code || '').trim(),
    client: String(data.client || '').trim(),
    region: String(data.region || '').trim(),
    pricingRegion: normalizePricingRegion(data.pricingRegion),
    pricingDate: isLocalDate(data.pricingDate) ? data.pricingDate : '',
    stage: String(data.stage || '').trim(),
    priceYear: /^\d{4}$/.test(priceYear) ? priceYear : '',
    currency: normalizeCurrency(data.currency),
  };
}

function normalizePricingRegion(region = {}) {
  return {
    province: String(region?.province || '').trim(), city: String(region?.city || '').trim(), district: String(region?.district || '').trim(),
  };
}

function isLocalDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }

export const projectService = {
  async list() { return await projectRepo.all(); },
  async get(id) { return await projectRepo.findById(id); },

  async save(data) {
    const obj = normalizeProjectMetadata(data);
    const current = obj.id ? await projectRepo.findById(obj.id) : null;
    const currentCurrency = normalizeCurrency(current?.currency);
    if (current && currentCurrency !== obj.currency) {
      const [lines, versions] = await Promise.all([boqRepo.byProject(obj.id), versionRepo.byProject(obj.id)]);
      if (lines.length || versions.length || Number(current.totalCost || 0) !== 0) {
        const error = new Error('项目已有计价数据，不能直接修改本位币。请新建项目后按目标币种重新导入或编制。');
        error.code = 'PROJECT_CURRENCY_LOCKED';
        throw error;
      }
    }
    if (current?.status === 'archived') {
      const error = new Error('已收录案例不能直接编辑。请先解锁修订。');
      error.code = 'PROJECT_ARCHIVED_READONLY';
      throw error;
    }
    obj.typeKey = [obj.type, obj.scale, obj.structure].filter(Boolean).join(' / ');
    if (obj.status === 'archived') {
      const [current, lines, versions] = await Promise.all([
        Promise.resolve(current),
        obj.id ? boqRepo.byProject(obj.id) : Promise.resolve([]),
        obj.id ? versionRepo.byProject(obj.id) : Promise.resolve([]),
      ]);
      if (current?.status !== 'archived') {
        const eligibility = archiveEligibility({ ...(current || obj), ...obj }, lines, versions);
        if (!eligibility.allowed) {
          const err = new Error('项目暂不能归档，请先处理阻断项');
          err.code = 'ARCHIVE_BLOCKED';
          err.eligibility = eligibility;
          throw err;
        }
      }
      if (!obj.archivedAt) obj.archivedAt = new Date().toISOString();
    }
    if (obj.id && current?.status !== 'archived' && obj.status === 'archived') {
      await projectRepo.update(obj.id, { ...obj, status: 'doing' });
      return await this.archive(obj.id, { snapshotName: obj.archiveSnapshotName || '' });
    }
    if (obj.id) {
      const updated = await projectRepo.update(obj.id, obj);
      return updated;
    }
    obj.id = uid();
    await projectRepo.upsert(obj);
    return obj;
  },

  async remove(id) {
    const project = await projectRepo.findById(id);
    if (!project) return;
    const snapshot = await snapshotProjectStores();
    const event = await recordProjectLifecycleEvent(id, 'delete_requested', { name: project.name || '' });
    try {
      await projectRepo.replaceAll(snapshot.projects.filter(item => item.id !== id));
      await boqRepo.replaceAll(snapshot.boq.filter(item => item.projectId !== id));
      await projectBoqQuotaRelationRepo.replaceAll(snapshot.quotaRelations.filter(item => item.projectId !== id));
      await versionRepo.replaceAll(snapshot.versions.filter(item => item.projectId !== id));
      await dataEngineService.discardProjectArtifacts(id, { includeVersions: true });
      await recordProjectLifecycleEvent(id, 'deleted', { deletionRequestId: event.id, name: project.name || '' });
    } catch (cause) {
      try { await restoreProjectStores(snapshot); }
      catch (rollbackCause) {
        throw Object.assign(new Error('删除项目失败，且原数据未能完全恢复。'), { code: 'PROJECT_DELETE_PARTIAL_RECOVERY', cause, rollbackCause });
      }
      throw Object.assign(new Error('删除项目失败，原数据已恢复。'), { code: 'PROJECT_DELETE_ROLLED_BACK', cause });
    }
  },

  async archive(id, { snapshotName = '' } = {}) {
    const [p, lines, versions] = await Promise.all([
      projectRepo.findById(id),
      boqRepo.byProject(id),
      versionRepo.byProject(id),
    ]);
    if (!p) return null;
    if (p.status !== 'archived') {
      const eligibility = archiveEligibility(p, lines, versions);
      if (!eligibility.allowed) {
        const err = new Error('项目暂不能归档，请先处理阻断项');
        err.code = 'ARCHIVE_BLOCKED';
        err.eligibility = eligibility;
        throw err;
      }
    }
    if (p.status === 'archived') return p;
    const snapshot = await versionService.createFromCurrent(id, {
      name: snapshotName || `案例归档快照 · ${p.name || '项目'}`,
      note: '项目收录为案例时自动创建的不可变快照。',
    });
    const archivedAt = new Date().toISOString();
    const updated = await projectRepo.update(id, {
      status: 'archived', archivedAt, archivedSnapshotVersionId: snapshot.id,
      revisionCount: Number(p.revisionCount || 0),
    });
    const event = await recordProjectLifecycleEvent(id, 'archived', { snapshotVersionId: snapshot.id, revisionCount: Number(p.revisionCount || 0) });
    await dataEngineService.ingestArchivedProject(id, { versionId: snapshot.id });
    return { ...updated, archivedSnapshotVersionId: snapshot.id, lifecycleEvent: event };
  },

  async unlockForRevision(id, reason = '') {
    const project = await projectRepo.findById(id);
    if (!project) throw new Error('项目不存在');
    if (project.status !== 'archived') return project;
    const revisionCount = Number(project.revisionCount || 0) + 1;
    await dataEngineService.discardProjectArtifacts(id);
    const updated = await projectRepo.update(id, {
      status: 'doing', revisionCount, unlockedAt: new Date().toISOString(),
      unlockReason: String(reason || '').trim(),
    });
    const event = await recordProjectLifecycleEvent(id, 'unlocked_for_revision', {
      snapshotVersionId: project.archivedSnapshotVersionId || '', revisionCount, reason: String(reason || '').trim(),
    });
    return { ...updated, lifecycleEvent: event };
  },

  /** 项目总造价 = 清单合价汇总（不直接调用，从 boqService 走） */
  async refreshCost(id) {
    return await recomputeProjectCost(id);
  },
};

async function snapshotProjectStores() {
  const [projects, boq, quotaRelations, versions, facts, candidates, jobs, reports, events] = await Promise.all([
    projectRepo.all(), boqRepo.all(), projectBoqQuotaRelationRepo.all(), versionRepo.all(), dataFactRepo.all(), dataCandidateRepo.all(), dataJobRepo.all(), dataQualityReportRepo.all(), projectLifecycleEventRepo.all(),
  ]);
  return { projects, boq, quotaRelations, versions, facts, candidates, jobs, reports, events };
}

async function restoreProjectStores(snapshot) {
  await Promise.all([
    projectRepo.replaceAll(snapshot.projects), boqRepo.replaceAll(snapshot.boq), projectBoqQuotaRelationRepo.replaceAll(snapshot.quotaRelations), versionRepo.replaceAll(snapshot.versions),
    dataFactRepo.replaceAll(snapshot.facts), dataCandidateRepo.replaceAll(snapshot.candidates), dataJobRepo.replaceAll(snapshot.jobs),
    dataQualityReportRepo.replaceAll(snapshot.reports), projectLifecycleEventRepo.replaceAll(snapshot.events),
  ]);
}
