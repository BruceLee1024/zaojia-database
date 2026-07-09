// 项目服务
import { projectRepo, boqRepo, versionRepo } from '../data/repository.js?v=3.9';
import { uid } from '../utils/dom.js';
import { recomputeProjectCost } from './boqService.js?v=3.9';
import { dataEngineService } from './dataEngineService.js?v=3.9';
import { archiveEligibility } from './projectWorkflow.js?v=1.0';

export const projectService = {
  async list() { return await projectRepo.all(); },
  async get(id) { return await projectRepo.findById(id); },

  async save(data) {
    const obj = { ...data };
    obj.typeKey = [obj.type, obj.scale, obj.structure].filter(Boolean).join(' / ');
    if (obj.status === 'archived') {
      const [current, lines, versions] = await Promise.all([
        obj.id ? projectRepo.findById(obj.id) : Promise.resolve(null),
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
    if (obj.id) {
      const updated = await projectRepo.update(obj.id, obj);
      if (updated?.status === 'archived') await dataEngineService.ingestArchivedProject(obj.id);
      return updated;
    }
    obj.id = uid();
    await projectRepo.upsert(obj);
    return obj;
  },

  async remove(id) {
    await projectRepo.remove(id);
    // 级联删清单
    const boq = await boqRepo.all();
    await boqRepo.replaceAll(boq.filter(b => b.projectId !== id));
    const versions = await versionRepo.all();
    await versionRepo.replaceAll(versions.filter(v => v.projectId !== id));
  },

  async archive(id) {
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
    p.status = p.status === 'archived' ? 'doing' : 'archived';
    if (p.status === 'archived') p.archivedAt = new Date().toISOString();
    await projectRepo.update(id, p);
    if (p.status === 'archived') await dataEngineService.ingestArchivedProject(id);
    return p;
  },

  /** 项目总造价 = 清单合价汇总（不直接调用，从 boqService 走） */
  async refreshCost(id) {
    return await recomputeProjectCost(id);
  },
};
