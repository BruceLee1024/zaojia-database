import assert from 'node:assert/strict';
import { createAiResponse, parseRemoteResponse, sanitizeRemoteContext } from '../assets/services/aiTaskService.js?v=ai-copilot-test';
import { aiSessionRepo } from '../assets/data/repository.js?v=6.3';
import { createAiSession, listAiSessions, saveAiSessionMessage } from '../assets/services/aiSessionService.js?v=ai-copilot-test';

export function testAiCopilot() {
  const response = createAiResponse({
    summary: '发现 2 项待复核内容',
    source: 'local',
    confidence: 'medium',
    risks: ['存在缺单价'],
    proposedActions: [{ type: 'open_view', label: '打开清单', payload: { view: 'boq' } }],
  });
  assert.equal(response.summary, '发现 2 项待复核内容');
  assert.equal(response.source, 'local');
  assert.equal(response.proposedActions[0].requiresConfirmation, false);
  assert.deepEqual(response.evidence, []);

  const remote = parseRemoteResponse('```json\n{"summary":"建议补价","risks":["单价缺失"],"nextQuestions":["是否按当前地区补价？"]}\n```');
  assert.equal(remote.summary, '建议补价');
  assert.deepEqual(remote.risks, ['单价缺失']);
  assert.equal(remote.nextQuestions[0], '是否按当前地区补价？');

  const fallback = parseRemoteResponse('这是普通的模型回复');
  assert.equal(fallback.summary, '这是普通的模型回复');
  assert.equal(fallback.source, 'remote');

  const context = sanitizeRemoteContext({
    currentProject: { id: 'project-1', name: '个人污水厂项目', totalCost: 100 },
    currentLines: [{ id: 'line-1', name: '池壁', qty: 20, unitPrice: 600 }],
  });
  assert.equal(context.currentProject.name, '当前项目');
  assert.equal(context.currentLines[0].id, undefined);
  assert.equal(context.currentLines[0].name, '池壁');
}

export async function testAiSessionPersistence() {
  await aiSessionRepo.replaceAll([]);
  const session = await createAiSession({ projectId: 'ai-project', title: '新对话' });
  await saveAiSessionMessage(session.id, { role: 'user', text: '检查缺单价' });
  await saveAiSessionMessage(session.id, { role: 'assistant', text: '发现 2 项待补价' });
  const sessions = await listAiSessions('ai-project');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, '检查缺单价');
  assert.equal(sessions[0].messages.length, 2);
  await aiSessionRepo.replaceAll([]);
}
