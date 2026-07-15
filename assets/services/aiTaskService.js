const ARRAY_FIELDS = ['sections', 'evidence', 'risks', 'nextQuestions', 'proposedActions'];

export function createAiResponse(input = {}) {
  const response = {
    summary: String(input.summary || input.msg || '暂未得到可用结论。'),
    sections: Array.isArray(input.sections) ? input.sections : [],
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    risks: Array.isArray(input.risks) ? input.risks : [],
    nextQuestions: Array.isArray(input.nextQuestions) ? input.nextQuestions : [],
    proposedActions: Array.isArray(input.proposedActions || input.actions)
      ? (input.proposedActions || input.actions).map(action => ({
        ...action,
        requiresConfirmation: action.requiresConfirmation === true || ['write', 'create', 'update', 'delete'].includes(action.type),
      }))
      : [],
    confidence: input.confidence || 'medium',
    source: input.source || 'local',
  };
  for (const field of ARRAY_FIELDS) response[field] = response[field].filter(Boolean);
  return response;
}

export function parseRemoteResponse(text) {
  const raw = String(text || '').trim();
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return createAiResponse({ ...parsed, source: 'remote' });
  } catch { /* Remote providers may return plain text despite the contract. */ }
  return createAiResponse({ summary: raw || '（无回复）', source: 'remote' });
}

export function sanitizeRemoteContext(context = {}) {
  const project = context.currentProject ? { ...context.currentProject, name: '当前项目' } : null;
  if (project) delete project.id;
  const lines = (context.currentLines || []).map(({ id, projectId, ...line }) => line);
  return { ...context, currentProject: project, currentLines: lines };
}
