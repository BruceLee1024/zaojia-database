import { projectLifecycleEventRepo, projectRepo } from '../data/repository.js?v=6.7';
import { uid } from '../utils/dom.js?v=6.7';

export function assertProjectEditable(project) {
  if (!project) throw new Error('项目不存在');
  if (project.status === 'archived') {
    const error = new Error('该项目已收录为案例并处于只读状态。请先解锁修订，再修改清单。');
    error.code = 'PROJECT_ARCHIVED_READONLY';
    error.projectId = project.id;
    throw error;
  }
  return project;
}

export async function assertProjectEditableById(projectId) {
  return assertProjectEditable(await projectRepo.findById(projectId));
}

export async function recordProjectLifecycleEvent(projectId, type, detail = {}) {
  const event = {
    id: uid(), projectId, type, detail: { ...detail }, createdAt: new Date().toISOString(),
  };
  await projectLifecycleEventRepo.upsert(event);
  return event;
}
