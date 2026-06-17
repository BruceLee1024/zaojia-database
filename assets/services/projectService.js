// 项目服务
import { projectRepo, boqRepo, versionRepo } from '../data/repository.js?v=3.4';
import { uid } from '../utils/dom.js';
import { recomputeProjectCost } from './boqService.js?v=3.4';
import { dataEngineService } from './dataEngineService.js?v=3.4';

export const projectService = {
  async list() { return await projectRepo.all(); },
  async get(id) { return await projectRepo.findById(id); },

  async save(data) {
    const obj = { ...data };
    obj.typeKey = [obj.type, obj.scale, obj.structure].filter(Boolean).join(' / ');
    if (obj.status === 'archived' && !obj.archivedAt) obj.archivedAt = new Date().toISOString();
    if (obj.id) {
      return await projectRepo.update(obj.id, obj);
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
    const p = await projectRepo.findById(id);
    if (!p) return null;
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
