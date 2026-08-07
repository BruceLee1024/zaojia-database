import { aiSessionRepo } from '../data/repository.js?v=6.14';

const MAX_SESSIONS = 30;
const MAX_MESSAGES = 80;

export async function listAiSessions(projectId = '') {
  const all = await aiSessionRepo.all();
  return all
    .filter(item => !projectId || item.projectId === projectId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function createAiSession({ projectId = '', title = '新对话' } = {}) {
  const now = new Date().toISOString();
  const session = await aiSessionRepo.upsert({ projectId, title, messages: [], createdAt: now, updatedAt: now });
  await trimAiSessions(projectId);
  return session;
}

export async function saveAiSessionMessage(sessionId, message) {
  const session = await aiSessionRepo.findById(sessionId);
  if (!session) throw new Error('AI 会话不存在。');
  const messages = [...(session.messages || []), { ...message, createdAt: message.createdAt || new Date().toISOString() }].slice(-MAX_MESSAGES);
  const title = session.title === '新对话' && message.role === 'user'
    ? String(message.text || '').trim().slice(0, 22) || session.title
    : session.title;
  return aiSessionRepo.update(sessionId, { messages, title, updatedAt: new Date().toISOString() });
}

export async function removeAiSession(sessionId) {
  return aiSessionRepo.remove(sessionId);
}

async function trimAiSessions(projectId) {
  const sessions = await listAiSessions(projectId);
  await Promise.all(sessions.slice(MAX_SESSIONS).map(item => aiSessionRepo.remove(item.id)));
}
