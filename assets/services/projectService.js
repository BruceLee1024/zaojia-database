// 项目服务
import { projectRepo, boqRepo, versionRepo } from '../data/repository.js?v=6.2';
import { uid } from '../utils/dom.js?v=6.2';
import { recomputeProjectCost } from './boqService.js?v=6.2';
import { dataEngineService } from './dataEngineService.js?v=6.2';
import { archiveEligibility } from './projectWorkflow.js?v=6.2';
import { versionService } from './versionService.js?v=6.2';
import { recordProjectLifecycleEvent } from './projectLockService.js?v=6.2';

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
    await recordProjectLifecycleEvent(id, 'delete_requested', { name: project.name || '' });
    await projectRepo.remove(id);
    // 级联删清单
    const boq = await boqRepo.all();
    await boqRepo.replaceAll(boq.filter(b => b.projectId !== id));
    const versions = await versionRepo.all();
    await versionRepo.replaceAll(versions.filter(v => v.projectId !== id));
    await dataEngineService.discardProjectArtifacts(id, { includeVersions: true });
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
