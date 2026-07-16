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

export function buildAiSharePreview(context = {}, scope = {}) {
  const lines = context.currentLines || context.currentProject?.lines || [];
  return {
    scope: { boqSummary: scope.boqSummary === true },
    projectIncluded: Boolean(context.currentProject),
    boqLineCount: scope.boqSummary ? Math.min(lines.length, 30) : 0,
    indicatorCount: Math.min((context.indicators || []).length, 30),
    excluded: ['项目名称、客户、地址、编号、供应商、附件名、经验卡正文'],
  };
}

export function sanitizeRemoteContext(context = {}, scope = {}) {
  const lines = context.currentLines || context.currentProject?.lines || [];
  const project = context.currentProject ? {
    type: context.currentProject.type || '', scale: context.currentProject.scale || '', structure: context.currentProject.structure || '',
    process: context.currentProject.process || '', status: context.currentProject.status || '', totalCost: Number(context.currentProject.totalCost || 0),
    lineCount: Number(context.currentProject.lineCount || lines.length || 0), missingPriceCount: Number(context.currentProject.missingPriceCount || 0),
    categoryCost: context.currentProject.categoryCost || [], versions: (context.currentProject.versions || []).map(({ totalCost, lineCount, missingPriceCount, createdAt }) => ({ totalCost, lineCount, missingPriceCount, createdAt })),
  } : null;
  return {
    projectCount: Number(context.projectCount || 0), archivedCount: Number(context.archivedCount || 0), quotaCount: Number(context.quotaCount || 0),
    boqLineCount: Number(context.boqLineCount || 0), missingQuotaCount: Number(context.missingQuotaCount || 0), missingBoqCount: Number(context.missingBoqCount || 0),
    currentProject: project,
    indicators: (context.indicators || []).map(({ metric, n, median, p25, p75, min, max, confidence, dispersion }) => ({ metric, n, median, p25, p75, min, max, confidence, dispersion })),
    experienceSummary: { confirmedCount: (context.experienceCards || []).length },
    boqSummary: scope.boqSummary === true ? lines.slice(0, 30).map(line => ({ unit: line.unit || '', qty: Number(line.qty || 0), unitPrice: Number(line.unitPrice || 0), factor: Number(line.factor || 1), amount: Number(line.amount || 0), priceMissing: Boolean(line.priceMissing) })) : [],
  };
}
