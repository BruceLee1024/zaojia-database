// 经验萃取服务：把报价复盘沉淀为可确认、可检索的经验卡
import {
  projectRepo,
  boqRepo,
  versionRepo,
  dataQualityReportRepo,
  experienceSessionRepo,
  experienceCardRepo,
} from '../data/repository.js?v=6.6';
import { getAIConfig } from './aiService.js?v=6.6';
import { uid } from '../utils/dom.js?v=6.6';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.6';
import { categoryGuess } from '../utils/stats.js?v=6.6';

const DEFAULT_QUESTIONS = [
  { id: 'abnormal', label: '报价异常', prompt: '这次报价里最需要复核或解释的异常是什么？' },
  { id: 'judgement', label: '关键判断', prompt: '你做了哪个关键判断？依据是什么？' },
  { id: 'reuse', label: '可复用口径', prompt: '以后遇到类似项目，可以复用哪条口径或经验？' },
  { id: 'nextRisk', label: '下次风险', prompt: '下次类似报价最容易踩的坑是什么？' },
  { id: 'boundary', label: '适用边界', prompt: '这条经验在哪些条件下不适用？' },
];

const GAP_QUESTIONS = {
  boundary: { id: 'followup_boundary', label: '适用边界', prompt: '这条经验在哪些项目规模、工艺或合同条件下不能直接复用？' },
  evidence: { id: 'followup_evidence', label: '证据链', prompt: '这次判断应保留哪些证据：询价、历史版本、图纸还是质量报告？' },
  risk: { id: 'followup_risk', label: '风险边界', prompt: '如果下次照搬这条口径，最可能在哪个环节出错？' },
  lesson: { id: 'followup_lesson', label: '经验结论', prompt: '请把这次判断压缩成一句以后能直接复用的报价口径。' },
  reuse: { id: 'followup_reuse', label: '复用条件', prompt: '以后遇到什么项目类型、工艺或清单特征时，可以优先引用这条经验？' },
};

export const experienceService = {
  async startReview({ projectId, versionId = '', sourceType = 'manual_review' } = {}) {
    const [project, lines, version, reports] = await Promise.all([
      projectRepo.findById(projectId),
      boqRepo.byProject(projectId),
      versionId ? versionRepo.findById(versionId) : Promise.resolve(null),
      dataQualityReportRepo.all(),
    ]);
    if (!project) throw new Error('项目不存在，无法生成复盘');

    const context = buildContext(project, version?.lines || lines, version, reports);
    const questionResult = await generateQuestions(context, sourceType);
    const now = new Date().toISOString();
    const session = {
      id: uid(),
      projectId,
      projectNameSnapshot: project.name || '',
      versionId,
      versionNameSnapshot: version?.name || '',
      sourceType,
      status: 'drafting',
      questions: questionResult.questions,
      questionSource: questionResult.source,
      answers: {},
      context,
      draft: null,
      confirmedCardId: '',
      createdAt: now,
      updatedAt: now,
    };
    session.extraction = assessExtraction(session);
    await experienceSessionRepo.upsert(session);
    return session;
  },

  async draftCard(sessionId, answers = {}) {
    const session = await experienceSessionRepo.findById(sessionId);
    if (!session) throw new Error('复盘会话不存在');
    const mergedAnswers = { ...(session.answers || {}), ...answers };
    let draft = await draftWithLLM(session, mergedAnswers);
    if (!draft) draft = localDraft(session, mergedAnswers);
    draft = withExtraction(normalizeDraft(draft, session), session, mergedAnswers);
    const now = new Date().toISOString();
    await experienceSessionRepo.update(sessionId, {
      answers: mergedAnswers,
      draft,
      extraction: draft.extraction,
      status: 'draft_ready',
      updatedAt: now,
    });
    return draft;
  },

  async refineQuestions(sessionId, answers = {}) {
    const session = await experienceSessionRepo.findById(sessionId);
    if (!session) throw new Error('复盘会话不存在');
    const mergedAnswers = { ...(session.answers || {}), ...answers };
    const followUpResult = await generateFollowUpQuestions(session, mergedAnswers);
    const currentQuestions = session.questions || [];
    const existingIds = new Set(currentQuestions.map(q => q.id));
    const followUps = followUpResult.questions
      .filter(q => !existingIds.has(q.id))
      .map((q, index) => ({
        ...q,
        id: q.id || `follow_up_${index + 1}`,
        level: 'L2',
      }))
      .slice(0, 2);
    const updatedQuestions = [...currentQuestions, ...followUps];
    const extraction = assessExtraction({ ...session, questions: updatedQuestions }, mergedAnswers, session.draft);
    const now = new Date().toISOString();
    const updated = {
      ...session,
      answers: mergedAnswers,
      questions: updatedQuestions,
      followUpSource: followUpResult.source,
      extraction,
      status: 'follow_up',
      updatedAt: now,
    };
    await experienceSessionRepo.update(sessionId, {
      answers: updated.answers,
      questions: updated.questions,
      followUpSource: updated.followUpSource,
      extraction: updated.extraction,
      status: updated.status,
      updatedAt: now,
    });
    return updated;
  },

  async confirmCard(sessionId, patch = {}) {
    const session = await experienceSessionRepo.findById(sessionId);
    if (!session) throw new Error('复盘会话不存在');
    const draft = withExtraction(normalizeDraft({ ...(session.draft || localDraft(session, session.answers || {})), ...patch }, session), session, session.answers || {});
    const now = new Date().toISOString();
    const card = {
      id: uid(),
      ...knowledgeFields(draft, session),
      ...extractionFields(draft.extraction),
      projectId: session.projectId,
      projectNameSnapshot: session.projectNameSnapshot || '',
      versionId: session.versionId || '',
      versionNameSnapshot: session.versionNameSnapshot || '',
      sessionId,
      sourceType: session.sourceType || 'manual_review',
      status: 'confirmed',
      reviewStatus: 'confirmed',
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await experienceCardRepo.upsert(card);
    await experienceSessionRepo.update(sessionId, {
      status: 'confirmed',
      draft,
      extraction: draft.extraction,
      confirmedCardId: card.id,
      confirmedAt: now,
      updatedAt: now,
    });
    return card;
  },

  async searchCards(query = '', context = {}) {
    const cards = normalizeCards(await experienceCardRepo.all()).filter(c => c.reviewStatus === 'confirmed');
    const terms = tokenize(query);
    const ctxTerms = tokenize([context.type, context.process, context.structure, context.projectName].filter(Boolean).join(' '));
    const hits = cards
      .map(card => ({ card, score: scoreCard(card, terms, ctxTerms, context) }))
      .filter(item => item.score > 0 || (!terms.length && matchesContext(item.card, context)))
      .sort((a, b) => b.score - a.score || (b.card.updatedAt || '').localeCompare(a.card.updatedAt || ''))
      .slice(0, 8)
      .map(item => item.card);
    await Promise.all(hits.map(card => this.recordReuse(card.id)));
    return hits;
  },

  async listKnowledgeBase(filters = {}) {
    const cards = normalizeCards(await experienceCardRepo.all());
    const now = Date.now();
    const terms = tokenize(filters.keyword || '');
    let items = cards.filter(card => {
      if (filters.status && card.reviewStatus !== filters.status) return false;
      if (!filters.status && card.reviewStatus === 'archived') return false;
      if (filters.projectType && card.projectType !== filters.projectType) return false;
      if (filters.processType && card.processType !== filters.processType) return false;
      if (filters.costCategory && card.costCategory !== filters.costCategory) return false;
      if (filters.domainCategory && card.domainCategory !== filters.domainCategory) return false;
      if (filters.expired === 'expired' && !isExpired(card, now)) return false;
      if (filters.expired === 'active' && isExpired(card, now)) return false;
      if (terms.length && !terms.every(term => cardBlob(card).includes(term))) return false;
      return true;
    });
    items = items.sort((a, b) => knowledgeScore(b, terms, now) - knowledgeScore(a, terms, now) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return {
      items,
      stats: knowledgeStats(cards, now),
      facets: knowledgeFacets(cards),
    };
  },

  async updateCard(id, patch = {}) {
    const cards = await experienceCardRepo.all();
    const current = cards.find(card => card.id === id);
    if (!current) throw new Error('经验卡不存在');
    const normalized = normalizeCard({ ...current, ...patch, updatedAt: new Date().toISOString() });
    await experienceCardRepo.update(id, normalized);
    return normalized;
  },

  async markNeedsReview(id, note = '') {
    return await this.updateCard(id, { reviewStatus: 'needs_review', status: 'needs_review', reviewNote: note });
  },

  async archiveCard(id) {
    return await this.updateCard(id, { reviewStatus: 'archived', status: 'archived' });
  },

  async recordReuse(id) {
    const current = normalizeCard(await experienceCardRepo.findById(id));
    if (!current) return null;
    const patch = {
      reuseCount: Number(current.reuseCount || 0) + 1,
      lastUsedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await experienceCardRepo.update(id, patch);
    return { ...current, ...patch };
  },

  async dashboard() {
    const [sessions, cards] = await Promise.all([experienceSessionRepo.all(), experienceCardRepo.all()]);
    const now = Date.now();
    const normalizedCards = normalizeCards(cards);
    return {
      sessions,
      cards: normalizedCards,
      confirmedCards: normalizedCards.filter(c => c.reviewStatus === 'confirmed'),
      reviewCards: normalizedCards.filter(c => c.reviewStatus === 'needs_review'),
      archivedCards: normalizedCards.filter(c => c.reviewStatus === 'archived'),
      pendingSessions: sessions.filter(s => s.status !== 'confirmed'),
      expiredCards: normalizedCards.filter(c => isExpired(c, now)),
      highReuseCards: normalizedCards.filter(c => Number(c.reuseCount || 0) >= 3),
      lowQualityCards: normalizedCards.filter(c => c.reviewStatus === 'confirmed' && Number(c.extractionScore || 0) < 70),
    };
  },
};

function buildContext(project, lines = [], version = null, reports = []) {
  const totalCost = version ? Number(version.totalCost || 0) : lines.reduce((s, line) => s + Number(line.amount || calculateAmount(line.qty, line.unitPrice, line.factor)), 0);
  const missing = lines.filter(line => hasMissingPrice(line.unitPrice));
  const zeroQty = lines.filter(line => !(Number(line.qty) > 0));
  const factorRisk = lines.filter(line => Number(line.factor || 1) > 1.2 || Number(line.factor || 1) < 0.8);
  const unmatched = lines.filter(line => !line.quotaItemId);
  const categoryTotals = {};
  lines.forEach(line => {
    const cat = line.structureGroup || line.majorCategory || line.category || categoryGuess(line.name || '');
    categoryTotals[cat] = (categoryTotals[cat] || 0) + Number(line.amount || calculateAmount(line.qty, line.unitPrice, line.factor));
  });
  const latestReport = reports
    .filter(r => r.projectId === project.id)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0] || null;
  return {
    project: {
      id: project.id,
      name: project.name || '',
      type: project.type || '',
      scale: project.scale || '',
      structure: project.structure || '',
      process: project.process || '',
      totalCost,
      dailyCapacity: project.dailyCapacity || '',
      area: project.area || '',
    },
    version: version ? { id: version.id, name: version.name, note: version.note || '', createdAt: version.createdAt } : null,
    lineCount: lines.length,
    missingPriceCount: missing.length,
    zeroQtyCount: zeroQty.length,
    factorRiskCount: factorRisk.length,
    unmatchedQuotaCount: unmatched.length,
    topCategories: Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).slice(0, 5),
    evidence: {
      qualityLevel: latestReport?.qualityLevel || '',
      qualityScore: latestReport?.qualityScore || '',
      recommendations: latestReport?.recommendations || [],
    },
  };
}

async function generateQuestions(context, sourceType) {
  const aiQuestions = await questionsWithLLM(context, sourceType);
  if (aiQuestions?.length) return { questions: aiQuestions, source: 'ai' };
  return { questions: buildLocalQuestions(context), source: 'local' };
}

async function generateFollowUpQuestions(session, answers) {
  const aiQuestions = await followUpQuestionsWithLLM(session, answers);
  if (aiQuestions?.length) return { questions: aiQuestions, source: 'ai' };
  return { questions: buildLocalFollowUps(session, answers), source: 'local' };
}

function buildLocalQuestions(context) {
  const qs = DEFAULT_QUESTIONS.map(q => ({ ...q }));
  const hints = [];
  if (context.missingPriceCount) hints.push(`缺单价 ${context.missingPriceCount} 条`);
  if (context.zeroQtyCount) hints.push(`0 工程量 ${context.zeroQtyCount} 条`);
  if (context.factorRiskCount) hints.push(`系数异常 ${context.factorRiskCount} 条`);
  if (context.unmatchedQuotaCount) hints.push(`未匹配定额 ${context.unmatchedQuotaCount} 条`);
  if (hints.length) qs[0].prompt = `本次存在${hints.join('、')}。哪些是可接受的报价策略，哪些必须修正？`;
  if (context.topCategories.length) {
    qs[2].prompt = `主要费用集中在 ${context.topCategories.map(([k]) => k).join('、')}。以后类似项目可复用什么分项口径？`;
  }
  return qs;
}

async function questionsWithLLM(context, sourceType) {
  const cfg = getAIConfig();
  if (!cfg.api_key) return null;
  const prompt = `请为一次工程造价报价复盘生成 4-6 个递进追问。只返回 JSON，不要 Markdown。
JSON 格式：{"questions":[{"id":"snake_case","label":"不超过6个字","prompt":"具体追问"}]}
要求：
- 问题必须结合项目类型、工艺、清单风险、质量报告和费用集中项。
- 覆盖报价异常、关键判断、证据来源、复用条件、适用边界。
- 语气要像资深造价负责人追问，不要泛泛而谈。
- 每个 prompt 不超过 60 个汉字。
sourceType=${sourceType}
context=${JSON.stringify(context)}`;
  try {
    const resp = await fetch(cfg.base_url.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.25,
        stream: false,
        messages: [
          { role: 'system', content: '你是工程造价复盘追问智能体。必须输出严格 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const parsed = parseJsonObject(data.choices?.[0]?.message?.content || '');
    return normalizeQuestions(parsed?.questions, 3, 6);
  } catch (e) {
    console.warn('experience questions llm failed', e);
    return null;
  }
}

async function followUpQuestionsWithLLM(session, answers) {
  const cfg = getAIConfig();
  if (!cfg.api_key) return null;
  const extraction = assessExtraction(session, answers);
  const prompt = `请基于一轮报价复盘回答，继续生成 1-2 个上下文补问。只返回 JSON，不要 Markdown。
JSON 格式：{"questions":[{"id":"snake_case","label":"不超过6个字","prompt":"具体补问"}]}
要求：
- 只追问当前回答中缺失、含糊或可能被美化的关键点。
- 优先补证据链、适用边界、灰色口径风险、下一次复用条件。
- 不重复已问问题。
- 每个 prompt 不超过 60 个汉字。
context=${JSON.stringify(session.context)}
questions=${JSON.stringify(session.questions || [])}
answers=${JSON.stringify(answers)}
extraction_quality=${JSON.stringify(extraction)}`;
  try {
    const resp = await fetch(cfg.base_url.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.25,
        stream: false,
        messages: [
          { role: 'system', content: '你是工程造价复盘的递进追问智能体。必须输出严格 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const parsed = parseJsonObject(data.choices?.[0]?.message?.content || '');
    return normalizeQuestions(parsed?.questions, 1, 2);
  } catch (e) {
    console.warn('experience follow-up llm failed', e);
    return null;
  }
}

function buildLocalFollowUps(session, answers) {
  const extraction = assessExtraction(session, answers);
  const gaps = new Map((extraction.gaps || []).map(gap => [gap.key, gap]));
  return ['boundary', 'evidence', 'risk', 'lesson', 'reuse']
    .map(key => gaps.get(key)?.question)
    .filter(Boolean)
    .slice(0, 2);
}

function normalizeQuestions(questions, min = 3, max = 6) {
  if (!Array.isArray(questions)) return null;
  const normalized = questions
    .map((q, index) => ({
      id: String(q.id || `ai_question_${index + 1}`).replace(/[^\w]/g, '_').slice(0, 40),
      label: String(q.label || `追问${index + 1}`).trim().slice(0, 12),
      prompt: String(q.prompt || '').trim(),
    }))
    .filter(q => q.prompt);
  if (normalized.length < min) return null;
  return normalized.slice(0, max);
}

async function draftWithLLM(session, answers) {
  const cfg = getAIConfig();
  if (!cfg.api_key) return null;
  const extraction = assessExtraction(session, answers);
  const prompt = `请把以下工程造价报价复盘整理成一张 JSON 经验卡。只返回 JSON，不要 Markdown。
字段：title, category, tags, trigger, evidence, lesson, applicability, risks, expiresAt, confidence。
要求：必须补足可复用结论、证据来源、适用边界、风险提示、有效期和可信度；对缺口不要编造，应用“需复核”表达。
context=${JSON.stringify(session.context)}
answers=${JSON.stringify(answers)}
extraction_quality=${JSON.stringify(extraction)}`;
  try {
    const resp = await fetch(cfg.base_url.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: '你是工程造价经验萃取助手。必须输出严格 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return parseJsonObject(data.choices?.[0]?.message?.content || '');
  } catch (e) {
    console.warn('experience draft llm failed', e);
    return null;
  }
}

function localDraft(session, answers) {
  const ctx = session.context || {};
  const project = ctx.project || {};
  const answerText = Object.values(answers || {}).filter(Boolean).join('\n');
  const answerByIntent = pickAnswersByIntent(session.questions || [], answers || {});
  const risks = [
    ctx.missingPriceCount ? `缺单价 ${ctx.missingPriceCount} 条会低估报价` : '',
    ctx.zeroQtyCount ? `0 工程量 ${ctx.zeroQtyCount} 条需确认是否暂估` : '',
    ctx.factorRiskCount ? `系数异常 ${ctx.factorRiskCount} 条需保留调价依据` : '',
    ctx.unmatchedQuotaCount ? `未匹配定额 ${ctx.unmatchedQuotaCount} 条影响后续追溯` : '',
  ].filter(Boolean);
  return {
    title: `${project.name || '当前项目'}报价复盘经验`,
    category: '投标报价复盘',
    tags: [project.type, project.process, project.structure].filter(Boolean),
    trigger: session.versionNameSnapshot ? `保存报价版本：${session.versionNameSnapshot}` : sourceLabel(session.sourceType),
    evidence: [
      `项目总价 ${formatMoney(project.totalCost || 0)}，清单 ${ctx.lineCount || 0} 条`,
      ctx.evidence?.qualityLevel ? `质量报告：${ctx.evidence.qualityLevel}（${ctx.evidence.qualityScore || '-'} 分）` : '',
      answerText ? `复盘回答：${answerText.slice(0, 300)}` : '',
    ].filter(Boolean).join('\n'),
    lesson: answerByIntent.lesson || '将本次报价判断、异常处理和适用条件沉淀为后续类似项目的复核依据。',
    applicability: answerByIntent.boundary || `${[project.type, project.scale, project.structure, project.process].filter(Boolean).join(' / ') || '类似工程项目'}可参考，正式复用前需结合最新图纸、市场价和合同边界复核。`,
    risks: answerByIntent.risk || risks.join('；') || '样本不足或边界变化时不要直接套用。',
    expiresAt: nextYearISO(),
    confidence: risks.length ? '需复核' : '中',
  };
}

function pickAnswersByIntent(questions, answers) {
  const normalized = Object.entries(answers || {})
    .map(([id, value]) => {
      const question = questions.find(q => q.id === id) || {};
      return {
        id: String(id || '').toLowerCase(),
        label: String(question.label || '').toLowerCase(),
        prompt: String(question.prompt || '').toLowerCase(),
        value: String(value || '').trim(),
      };
    })
    .filter(item => item.value);
  const find = (patterns, exclude = []) => normalized.find(item => {
    const haystack = `${item.id} ${item.label} ${item.prompt}`;
    return patterns.some(re => re.test(haystack)) && !exclude.some(re => re.test(haystack));
  })?.value || '';
  const first = normalized[0]?.value || '';
  return {
    lesson: answers.reuse || answers.judgement || find([/复用|口径|reuse|判断|依据|经验|结论|condition|basis/], [/风险|risk|异常|abnormal/]) || first,
    boundary: answers.boundary || find([/不适用|适用|复用条件|reuse_condition|applicability|condition/], [/风险|risk|异常|abnormal/]) || find([/边界|boundary/], [/风险|risk/]),
    risk: answers.nextRisk || answers.abnormal || find([/风险|异常|踩坑|risk|abnormal|偏差|缺口|暂估/]),
  };
}

function hasEvidenceAnswer(questions, answers) {
  return Object.entries(answers || {}).some(([id, value]) => {
    if (!String(value || '').trim()) return false;
    const question = questions.find(q => q.id === id) || {};
    const haystack = `${id} ${question.label || ''} ${question.prompt || ''}`.toLowerCase();
    return /证据|依据|询价|报告|版本|图纸|evidence|basis|source/.test(haystack);
  });
}

function normalizeDraft(draft, session) {
  const ctx = session.context || {};
  const project = ctx.project || {};
  const tags = Array.isArray(draft.tags) ? draft.tags : String(draft.tags || '').split(/[，,\s]+/).filter(Boolean);
  return {
    title: String(draft.title || `${project.name || '当前项目'}报价复盘经验`).trim(),
    category: String(draft.category || '投标报价复盘').trim(),
    tags: tags.slice(0, 8),
    trigger: String(draft.trigger || sourceLabel(session.sourceType)).trim(),
    evidence: String(draft.evidence || '').trim(),
    lesson: String(draft.lesson || '').trim(),
    applicability: String(draft.applicability || '').trim(),
    risks: String(draft.risks || '').trim(),
    expiresAt: String(draft.expiresAt || nextYearISO()).slice(0, 10),
    confidence: String(draft.confidence || '中').trim(),
  };
}

function withExtraction(draft, session, answers = {}) {
  const extraction = assessExtraction(session, answers, draft);
  return {
    ...draft,
    ...extractionFields(extraction),
  };
}

function extractionFields(extraction) {
  const normalized = normalizeExtraction(extraction);
  return {
    extraction: normalized,
    extractionScore: normalized.score,
    extractionLevel: normalized.level,
    extractionGaps: normalized.gaps,
    extractionChecks: normalized.checks,
    extractionSummary: normalized.summary,
  };
}

function assessExtraction(session = {}, answers = {}, draft = null) {
  const ctx = session.context || {};
  const project = ctx.project || {};
  const questions = session.questions || [];
  const intents = pickAnswersByIntent(questions, answers || {});
  const allAnswers = Object.values(answers || {}).map(v => String(v || '').trim()).filter(Boolean).join('\n');
  const contextRiskCount = Number(ctx.missingPriceCount || 0) + Number(ctx.zeroQtyCount || 0) + Number(ctx.factorRiskCount || 0) + Number(ctx.unmatchedQuotaCount || 0);
  const hasContextFacts = Boolean(project.name || session.projectNameSnapshot || ctx.lineCount || ctx.topCategories?.length || ctx.evidence?.qualityLevel);
  const lessonText = [draft?.lesson, intents.lesson].filter(Boolean).join('\n');
  const evidenceText = [draft?.evidence, allAnswers].filter(Boolean).join('\n');
  const boundaryText = [draft?.applicability, intents.boundary].filter(Boolean).join('\n');
  const riskText = [draft?.risks, intents.risk].filter(Boolean).join('\n');
  const reuseText = [intents.lesson, answers.reuse, draft?.lesson].filter(Boolean).join('\n');
  const hasUserEvidence = hasEvidenceAnswer(questions, answers || {}) || evidencePattern(evidenceText);
  const checks = [
    extractionCheck('facts', '事实背景', 15, hasContextFacts ? 1 : 0, '已提取项目、版本、清单或质量报告事实', '缺少可引用的项目/清单事实'),
    extractionCheck('lesson', '经验结论', 20, strongText(lessonText, 12) ? 1 : allAnswers ? 0.5 : 0, '已形成可复用报价判断', '结论还没有压缩成可复用口径', GAP_QUESTIONS.lesson),
    extractionCheck('evidence', '证据链', 20, hasUserEvidence ? 1 : hasContextFacts ? 0.55 : 0, '已关联询价、版本、图纸、报告或复盘依据', '缺少能支撑判断的证据来源', GAP_QUESTIONS.evidence),
    extractionCheck('boundary', '适用边界', 18, boundaryPattern(boundaryText) ? 1 : strongText(boundaryText, 12) ? 0.6 : 0, '已说明适用/不适用条件', '适用边界仍不清楚', GAP_QUESTIONS.boundary),
    extractionCheck('risk', '风险提示', 15, strongText(riskText, 10) ? 1 : contextRiskCount ? 0.65 : 0, '已保留复用风险或异常提醒', '缺少照搬时可能出错的风险', GAP_QUESTIONS.risk),
    extractionCheck('reuse', '复用条件', 7, reusePattern(reuseText) ? 1 : strongText(reuseText, 12) ? 0.6 : 0, '已描述后续引用场景', '还没说清什么场景可复用', GAP_QUESTIONS.reuse),
    extractionCheck('lifecycle', '生命周期', 5, draft?.expiresAt && draft?.confidence ? 1 : 0.45, '已有有效期和可信度', '需要补齐有效期与可信度'),
  ];
  const score = Math.round(checks.reduce((sum, item) => sum + item.weight * item.ratio, 0));
  const gaps = checks
    .filter(item => item.ratio < 0.8 && item.question)
    .map(item => ({
      key: item.key,
      label: item.label,
      message: item.missing,
      question: item.question,
    }));
  return normalizeExtraction({
    score,
    level: extractionLevel(score),
    summary: extractionSummary(score, gaps.length),
    checks,
    gaps,
    updatedAt: new Date().toISOString(),
  });
}

function extractionCheck(key, label, weight, ratio, ok, missing, question = null) {
  const clamped = Math.max(0, Math.min(1, Number(ratio || 0)));
  return {
    key,
    label,
    weight,
    ratio: clamped,
    score: Math.round(weight * clamped),
    status: clamped >= 0.8 ? 'ok' : clamped >= 0.45 ? 'partial' : 'missing',
    message: clamped >= 0.8 ? ok : missing,
    missing,
    question,
  };
}

function normalizeExtraction(extraction, source = {}) {
  const hasStoredShape = source.extractionScore !== undefined || Array.isArray(source.extractionChecks) || Array.isArray(source.extractionGaps);
  const base = extraction && typeof extraction === 'object' ? extraction : hasStoredShape ? source : assessCardExtraction(source);
  const score = Math.max(0, Math.min(100, Math.round(Number(base.score ?? source.extractionScore ?? 0))));
  const checks = Array.isArray(base.checks) ? base.checks : Array.isArray(source.extractionChecks) ? source.extractionChecks : [];
  const gaps = Array.isArray(base.gaps) ? base.gaps : Array.isArray(source.extractionGaps) ? source.extractionGaps : [];
  return {
    score,
    level: base.level || source.extractionLevel || extractionLevel(score),
    summary: base.summary || source.extractionSummary || extractionSummary(score, gaps.length),
    checks,
    gaps,
    updatedAt: base.updatedAt || source.updatedAt || '',
  };
}

function assessCardExtraction(card = {}) {
  if (!card || !Object.keys(card).length) return { score: 0, checks: [], gaps: [], level: extractionLevel(0), summary: extractionSummary(0, 0) };
  return assessExtraction({
    projectNameSnapshot: card.projectNameSnapshot || '',
    context: {
      project: {
        name: card.projectNameSnapshot || '',
        type: card.projectType || '',
        process: card.processType || '',
        structure: '',
      },
      lineCount: card.projectId ? 1 : 0,
      topCategories: card.costCategory ? [[card.costCategory, 1]] : [],
      evidence: {},
    },
    questions: [],
  }, {}, card);
}

function extractionLevel(score) {
  if (score >= 85) return '可复用';
  if (score >= 70) return '可入库';
  if (score >= 55) return '需补充';
  return '不完整';
}

function extractionSummary(score, gapCount) {
  if (score >= 85) return '证据、边界和风险较完整，可优先复用。';
  if (score >= 70) return gapCount ? `可入库，但还有 ${gapCount} 个萃取缺口建议补齐。` : '可入库，后续复用前仍建议复核。';
  if (score >= 55) return `建议先补齐 ${gapCount || 1} 个关键缺口，再作为正式经验复用。`;
  return '当前回答还不足以沉淀为可靠经验。';
}

function strongText(text, min = 10) {
  return String(text || '').replace(/\s+/g, '').length >= min;
}

function evidencePattern(text) {
  return /询价|图纸|合同|版本|质量报告|报告|结算|市场价|定额|清单|依据|来源|凭证|报价单|供应商/.test(String(text || ''));
}

function boundaryPattern(text) {
  return /不适用|不能|仅适用|只适用|除非|边界|条件|规模|工艺|合同|图纸|做法|变化|类似|同类/.test(String(text || ''));
}

function reusePattern(text) {
  return /复用|类似|同类|以后|下次|场景|条件|项目类型|工艺|清单特征|口径/.test(String(text || ''));
}

function knowledgeFields(draft, session) {
  const base = normalizeDraft(draft, session);
  const project = session.context?.project || {};
  return normalizeCard({
    ...base,
    knowledgeType: '经验卡',
    domainCategory: base.category || '投标报价复盘',
    projectType: project.type || '',
    processType: project.process || '',
    costCategory: inferCostCategory(base, session.context),
    keywords: inferKeywords(base, project),
    evidenceRefs: inferEvidenceRefs(session),
    reuseCount: 0,
    lastUsedAt: '',
    reviewStatus: 'confirmed',
    reviewNote: '',
  });
}

function normalizeCards(cards = []) {
  return cards.map(normalizeCard).filter(Boolean);
}

function normalizeCard(card) {
  if (!card) return null;
  const tags = Array.isArray(card.tags) ? card.tags : String(card.tags || '').split(/[，,\s]+/).filter(Boolean);
  const keywords = Array.isArray(card.keywords) && card.keywords.length ? card.keywords : inferKeywords({ ...card, tags }, {
    type: card.projectType,
    process: card.processType,
    structure: '',
  });
  const reviewStatus = card.reviewStatus || (card.status === 'archived' ? 'archived' : card.status === 'needs_review' ? 'needs_review' : 'confirmed');
  const extraction = normalizeExtraction(card.extraction, { ...card, tags, keywords, reviewStatus });
  return {
    ...card,
    knowledgeType: card.knowledgeType || '经验卡',
    domainCategory: card.domainCategory || card.category || '投标报价复盘',
    projectType: card.projectType || tags.find(t => ['水厂', '污水处理厂', '再生水厂', '工业废水', '泵站', '管网', '调蓄池', '水池', '污泥处理', '房屋建筑', '住宅建筑', '公共建筑', '工业厂房', '园区建设', '市政道路', '桥梁隧道', '综合管廊', '水利工程', '电力工程', '变电站', '设备安装', '厂区配套', '车间', '其他'].includes(t)) || '',
    processType: card.processType || tags.find(t => /AAO|A2O|MBR|SBR|预处理|供配电/i.test(t)) || '',
    costCategory: card.costCategory || inferCostCategory(card, {}),
    keywords: keywords.slice(0, 12),
    evidenceRefs: Array.isArray(card.evidenceRefs) ? card.evidenceRefs : [],
    reuseCount: Number(card.reuseCount || 0),
    lastUsedAt: card.lastUsedAt || '',
    reviewStatus,
    reviewNote: card.reviewNote || '',
    status: reviewStatus === 'confirmed' ? 'confirmed' : reviewStatus,
    tags,
    ...extractionFields(extraction),
  };
}

function inferCostCategory(card = {}, context = {}) {
  const text = [card.title, card.category, card.evidence, card.lesson, card.applicability, card.risks, ...(card.tags || [])].join(' ');
  const top = context.topCategories?.[0]?.[0] || '';
  if (/防水|混凝土|钢筋|模板|土方|基础|池体|土建/.test(text)) return '土建工程';
  if (/设备|泵|阀|风机|曝气|加药|脱水/.test(text)) return '设备安装';
  if (/电气|自控|电缆|配电|仪表|PLC/i.test(text)) return '电气自控';
  if (/管道|管网|阀门井|检查井/.test(text)) return '管网管道';
  return top || '其他';
}

function inferKeywords(card = {}, project = {}) {
  const text = [card.title, card.category, card.lesson, card.applicability, card.risks, project.type, project.process, project.structure, ...(card.tags || [])].join(' ');
  const seeds = ['防水', '缺单价', '暂估', '系数', '风险', '复核', 'AAO', 'A2O', 'MBR', 'SBR', '水厂', '泵站', '管网', '设备', '电气', '土建', '报价', '归档'];
  const hits = seeds.filter(k => text.toLowerCase().includes(k.toLowerCase()));
  const words = tokenize(text).filter(w => w.length >= 2 && w.length <= 12).slice(0, 8);
  return [...new Set([...hits, ...words])].slice(0, 12);
}

function inferEvidenceRefs(session) {
  const refs = [];
  if (session.projectId) refs.push({ type: 'project', id: session.projectId, label: session.projectNameSnapshot || '项目' });
  if (session.versionId) refs.push({ type: 'version', id: session.versionId, label: session.versionNameSnapshot || '报价版本' });
  if (session.context?.evidence?.qualityLevel) refs.push({ type: 'quality_report', id: session.context.evidence.qualityLevel, label: `质量报告：${session.context.evidence.qualityLevel}` });
  return refs;
}

function scoreCard(card, terms, ctxTerms, context) {
  const blob = cardBlob(card);
  let score = 0;
  terms.forEach(term => { if (blob.includes(term)) score += 3; });
  ctxTerms.forEach(term => { if (blob.includes(term)) score += 1; });
  (card.keywords || []).forEach(keyword => { if (terms.includes(String(keyword).toLowerCase())) score += 2; });
  if (context.projectId && card.projectId === context.projectId) score += 4;
  if (context.versionId && card.versionId === context.versionId) score += 2;
  if (card.expiresAt && new Date(card.expiresAt).getTime() < Date.now()) score -= 2;
  score += Math.min(2, Math.floor(Number(card.extractionScore || 0) / 40));
  if (Number(card.extractionScore || 0) < 55) score -= 2;
  score += Math.min(3, Number(card.reuseCount || 0));
  return score;
}

function matchesContext(card, context) {
  return Boolean((context.projectId && card.projectId === context.projectId) || context.type || context.process || context.structure);
}

function cardBlob(card) {
  return [
    card.title, card.category, card.projectNameSnapshot, card.versionNameSnapshot,
    card.domainCategory, card.projectType, card.processType, card.costCategory,
    ...(card.tags || []), ...(card.keywords || []), card.trigger, card.evidence, card.lesson, card.applicability, card.risks,
  ].join(' ').toLowerCase();
}

function knowledgeScore(card, terms, now) {
  let score = Number(card.reuseCount || 0);
  if (card.reviewStatus === 'confirmed') score += 5;
  if (card.reviewStatus === 'needs_review') score -= 1;
  if (Number(card.extractionScore || 0) >= 85) score += 1;
  if (Number(card.extractionScore || 0) < 55) score -= 2;
  if (isExpired(card, now)) score -= 2;
  const blob = cardBlob(card);
  terms.forEach(term => { if (blob.includes(term)) score += 3; });
  return score;
}

function knowledgeStats(cards, now = Date.now()) {
  return {
    total: cards.length,
    confirmed: cards.filter(c => c.reviewStatus === 'confirmed').length,
    needsReview: cards.filter(c => c.reviewStatus === 'needs_review').length,
    archived: cards.filter(c => c.reviewStatus === 'archived').length,
    expired: cards.filter(c => isExpired(c, now)).length,
    highReuse: cards.filter(c => Number(c.reuseCount || 0) >= 3).length,
    lowQuality: cards.filter(c => c.reviewStatus === 'confirmed' && Number(c.extractionScore || 0) < 70).length,
  };
}

function knowledgeFacets(cards) {
  return {
    projectTypes: [...new Set(cards.map(c => c.projectType).filter(Boolean))],
    processTypes: [...new Set(cards.map(c => c.processType).filter(Boolean))],
    costCategories: [...new Set(cards.map(c => c.costCategory).filter(Boolean))],
    domainCategories: [...new Set(cards.map(c => c.domainCategory).filter(Boolean))],
  };
}

function isExpired(card, now = Date.now()) {
  return Boolean(card?.expiresAt && new Date(card.expiresAt).getTime() < now);
}

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[\s,，。；;：:、/]+/).filter(t => t.length > 1);
}

function parseJsonObject(text) {
  const raw = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { return null; }
}

function sourceLabel(sourceType = '') {
  return {
    version_saved: '保存报价版本',
    quote_audit: '报价审查',
    project_archive: '项目归档',
    ai_review: 'AI 助手复盘',
  }[sourceType] || '手动复盘';
}

function nextYearISO() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function formatMoney(value) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}
