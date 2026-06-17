// AI 本地指令路由
import { projectRepo, quotaRepo, boqRepo } from '../data/repository.js?v=3.2';
import { pickBestQuota, categoryGuess } from '../utils/stats.js';
import { fmtMoney, fmt } from '../utils/dom.js';
import { boqService } from '../services/boqService.js?v=3.2';
import { versionService } from '../services/versionService.js?v=3.2';
import { indicatorService } from '../services/indicatorService.js?v=3.2';
import { hasMissingPrice } from '../utils/costing.js?v=3.2';

export async function tryLocalCommand(text) {
  const t = text.trim();

  // 1) 加清单：给 X 加 Y N 单位
  let m = t.match(/(?:给|为|在|往)\s*([^\s,，。、]+?)\s*(?:项目)?(?:里|中)?(?:添加?|加|录入|增加|插入|新建)\s*(?:一?条?)?(.+?)\s*[，,\s]*(\d+(?:\.\d+)?)\s*([a-zA-Z²³㎡m³m2立方米吨t个根座块台套]*)[\s,。]*$/);
  if (m) {
    const [, projName, quotaHint, qty, unit] = m;
    return await cmdAddBOQ(projName, quotaHint, parseFloat(qty), unit);
  }

  // 2) 项目造价：X 项目造价多少？
  m = t.match(/^([^\s,，。？?]{2,15}?)\s*(?:项目|工程)\s*(?:造价|费用|总造价|投资)\s*(?:多少|多少元|是多少|情况)[？?]?$/);
  if (m) {
    const projName = m[1].replace(/这个|当前|那|该/g, '');
    return await cmdProjectCost(projName);
  }

  // 3) 批量调价
  m = t.match(/(?:把|给|将)\s*([^\s,，。]+?)\s*(?:项目)?(?:里|中)?(?:的)?(.+?)\s*(?:全部|所有)?(?:调价|调|乘以|×|x|乘)\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const [, projName, target, factor] = m;
    return await cmdAdjustPrice(projName, target, parseFloat(factor));
  }

  // 4) 缺单价检查
  m = t.match(/(?:检查|查看|找出|列出).*(?:缺单价|缺少单价|0单价|零单价|价格为空)/);
  if (m) return await cmdMissingPrices();

  // 5) 推荐定额
  m = t.match(/(?:推荐|查找|搜索|找).{0,6}(?:定额|清单)?[：:，,\s]*(.+)$/);
  if (m) return await cmdRecommendQuota(m[1]);

  // 6) 成本结构总结
  m = t.match(/([^\s,，。？?]{2,15}?)\s*(?:项目|工程)?.*(?:成本结构|分项占比|费用结构|造价构成)/);
  if (m) return await cmdCostStructure(m[1]);

  // 7) 报价审查
  m = t.match(/(?:审查|检查|诊断|审核|风险).*(?:报价|清单|项目|造价)|(?:报价|清单).*(?:有没有问题|风险|漏项|审查|诊断)/);
  if (m) return await cmdQuoteAudit(t);

  // 8) 项目对标
  m = t.match(/([^\s,，。？?]{2,20}?)?\s*(?:项目|工程)?(?:对标|贵不贵|偏高|偏低|合理吗|指标比较)/);
  if (m) return await cmdBenchmark(m[1] || '');

  // 9) 快速估算
  m = t.match(/(?:估算|预估|测算|造价区间).*(\d+(?:\.\d+)?)\s*(?:万?m³\/d|万吨|万方|万m3|万立方|m³\/d)?(?:.*?)(\d+(?:\.\d+)?)?\s*(?:㎡|平米)?/);
  if (m) return await cmdEstimate(t);

  // 10) 报价版本
  m = t.match(/(?:版本|快照).*(?:列表|有哪些|查看|历史|对比|差异)/);
  if (m) return await cmdVersions(t);

  return null;
}

async function findProject(projName = '') {
  const projects = await projectRepo.all();
  const name = (projName || '').replace(/当前|这个|该|项目|工程/g, '').trim();
  if (name) {
    const hit = projects.find(p => p.name.includes(name));
    if (hit) return hit;
  }
  const currentId = window.__app?.state?.currentProjectId;
  return projects.find(p => p.id === currentId) || projects[0] || null;
}

async function cmdAddBOQ(projName, quotaHint, qty, unit) {
  const projects = await projectRepo.all();
  const proj = projects.find(p => p.name.includes(projName)) || projects[0];
  if (!proj) return { handled: true, msg: '没找到匹配的项目，请先在「项目管理」里建一个。' };

  try {
    const line = await boqService.addByText(proj.id, quotaHint, qty);
    const newTotal = (await projectRepo.findById(proj.id)).totalCost;
    return {
      handled: true,
      msg: `✅ 已给「${proj.name}」添加清单\n\n• 名称：${line.name}\n• 工程量：${qty} ${line.unit || ''}\n• 综合单价：${hasMissingPrice(line.unitPrice) ? '缺失/为 0' : fmtMoney(line.unitPrice) + '/' + (line.unit || '')}\n• 合价：${fmtMoney(line.amount)}\n\n项目最新总造价：${fmtMoney(newTotal)}${hasMissingPrice(line.unitPrice) ? '\n\n注意：该条缺少有效综合单价，请补价后再作为正式报价。' : ''}`,
      actions: [{ label: '📂 打开项目查看', onClick: () => { window.__app.go('boq', { projectId: proj.id }); window.__app.closeAI(); } }],
    };
  } catch (e) {
    return { handled: true, msg: e.message };
  }
}

async function cmdMissingPrices() {
  const [quota, projects, boq] = await Promise.all([quotaRepo.all(), projectRepo.all(), boqRepo.all()]);
  const badQuota = quota.filter(q => hasMissingPrice(q.priceTotal));
  const badBoq = boq.filter(b => hasMissingPrice(b.unitPrice));
  const projectName = id => projects.find(p => p.id === id)?.name || '未知项目';
  const lines = badBoq.slice(0, 8).map(b => `• ${projectName(b.projectId)}：${b.name}（${b.unit || '-'}）`).join('\n');
  return {
    handled: true,
    msg: `缺单价检查\n\n定额库缺单价：${badQuota.length} 条\n项目清单缺单价：${badBoq.length} 条\n\n${lines || '当前项目清单没有缺单价条目。'}${badBoq.length > 8 ? `\n…另有 ${badBoq.length - 8} 条未显示` : ''}`,
    actions: [
      { label: '打开定额库筛选', onClick: () => { window.__app.go('quota'); window.__app.closeAI(); } },
      { label: '打开清单', onClick: () => { window.__app.go('boq'); window.__app.closeAI(); } },
    ],
  };
}

async function cmdRecommendQuota(hint) {
  const items = await quotaRepo.all();
  const words = hint.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const hits = items
    .map(q => {
      const blob = `${q.name} ${q.feature} ${(q.tags || []).join(' ')}`.toLowerCase();
      const score = words.reduce((s, w) => s + (blob.includes(w) ? 1 : 0), 0) + (blob.includes(hint.toLowerCase()) ? 2 : 0);
      return { q, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(x => x.q);
  return {
    handled: true,
    msg: hits.length
      ? `为「${hint}」找到 ${hits.length} 条候选定额：\n\n${hits.map(q => `• ${q.name}｜${q.unit || '-'}｜${hasMissingPrice(q.priceTotal) ? '缺单价' : fmtMoney(q.priceTotal)}\n  ${q.feature || '无项目特征'}`).join('\n')}`
      : `没有找到「${hint}」相关定额。可以先在定额库导入或新增条目。`,
    actions: [{ label: '打开定额库', onClick: () => { window.__app.go('quota'); window.__app.closeAI(); } }],
  };
}

async function cmdCostStructure(projName) {
  const proj = await findProject(projName);
  if (!proj) return { handled: true, msg: '还没有项目可分析。' };
  const breakdown = await boqService.breakdown(proj.id);
  const missing = (await boqService.listByProject(proj.id)).filter(b => hasMissingPrice(b.unitPrice)).length;
  return {
    handled: true,
    msg: `「${proj.name}」成本结构\n\n总造价：${fmtMoney(breakdown.total)}\n清单条数：${breakdown.count}\n缺单价条数：${missing}\n\n分项占比：\n${breakdown.groups.slice(0, 8).map(g => `• ${g.cat}：${fmtMoney(g.amount)}（${(g.ratio * 100).toFixed(1)}%）`).join('\n') || '暂无清单数据'}${missing ? '\n\n注意：缺单价条目会低估当前总造价。' : ''}`,
    actions: [{ label: '打开清单', onClick: () => { window.__app.go('boq', { projectId: proj.id }); window.__app.closeAI(); } }],
  };
}

async function cmdProjectCost(projName) {
  const proj = await findProject(projName);
  if (!proj) return { handled: true, msg: `没找到「${projName}」项目。` };
  const breakdown = await boqService.breakdown(proj.id);
  return {
    handled: true,
    msg: `📊「${proj.name}」造价概览\n\n总造价：${fmtMoney(breakdown.total)}\n清单条数：${breakdown.count}\n${proj.area ? `建筑面积：${proj.area} ㎡\n单方造价：${fmt(breakdown.total / proj.area)} 元/㎡\n` : ''}${proj.dailyCapacity ? `日处理量：${proj.dailyCapacity} 万m³/d\n单水造价：${fmt(breakdown.total / (proj.dailyCapacity * 10000))} 元/(m³·d)\n` : ''}\n分项 TOP5：\n${breakdown.groups.slice(0, 5).map(g => `  ${g.cat.padEnd(8, '　')} ${fmtMoney(g.amount).padStart(14)}  ${(g.ratio * 100).toFixed(1)}%`).join('\n')}`,
    actions: [
      { label: '📂 打开清单', onClick: () => { window.__app.go('boq', { projectId: proj.id }); window.__app.closeAI(); } },
      { label: '📈 查看指标', onClick: () => window.__app.go('indicators') },
    ],
  };
}

async function cmdAdjustPrice(projName, target, factor) {
  const proj = await findProject(projName);
  if (!proj) return { handled: true, msg: '没找到匹配的项目' };
  const count = await boqService.batchAdjust(proj.id, target, factor);
  const newTotal = (await projectRepo.findById(proj.id)).totalCost;
  return {
    handled: true,
    msg: `✅ 已对「${proj.name}」中 ${count} 条${target === '全部' ? '' : `含「${target}」的`}清单应用 ×${factor} 调价。\n\n项目最新造价：${fmtMoney(newTotal)}`,
    actions: [{ label: '📂 查看清单', onClick: () => { window.__app.go('boq', { projectId: proj.id }); window.__app.closeAI(); } }],
  };
}

async function cmdQuoteAudit(text) {
  const proj = await findProject(text);
  if (!proj) return { handled: true, msg: '还没有项目可审查，请先新建项目并添加清单。' };
  const [lines, versions] = await Promise.all([
    boqService.listByProject(proj.id),
    versionService.listByProject(proj.id),
  ]);
  const missing = lines.filter(b => hasMissingPrice(b.unitPrice));
  const zeroQty = lines.filter(b => !(Number(b.qty) > 0));
  const highFactor = lines.filter(b => Number(b.factor || 1) > 1.2 || Number(b.factor || 1) < 0.8);
  const duplicateMap = {};
  lines.forEach(b => {
    const key = `${b.name || ''}|${b.feature || ''}|${b.unit || ''}`;
    duplicateMap[key] = (duplicateMap[key] || 0) + 1;
  });
  const duplicates = Object.entries(duplicateMap).filter(([, count]) => count > 1).length;
  const breakdown = await boqService.breakdown(proj.id);
  const risks = [
    missing.length ? `缺综合单价 ${missing.length} 条，会低估报价。` : '',
    zeroQty.length ? `工程量为 0 或空 ${zeroQty.length} 条，请确认是否暂估项。` : '',
    highFactor.length ? `调整系数异常 ${highFactor.length} 条，建议复核调价依据。` : '',
    duplicates ? `疑似重复清单 ${duplicates} 组，建议检查是否重复计量。` : '',
    versions.length ? '' : '尚未保存报价版本，建议关键调整前先保存快照。',
  ].filter(Boolean);
  const top = breakdown.groups.slice(0, 5).map(g => `• ${g.cat}：${fmtMoney(g.amount)}（${(g.ratio * 100).toFixed(1)}%）`).join('\n');
  return {
    handled: true,
    msg: `「${proj.name}」报价审查\n\n总造价：${fmtMoney(breakdown.total)}\n清单条数：${lines.length}\n已保存版本：${versions.length} 个\n\n风险结论：\n${risks.length ? risks.map(r => `• ${r}`).join('\n') : '• 暂未发现明显价格或工程量风险。'}\n\n成本结构 TOP5：\n${top || '暂无清单数据'}\n\n建议动作：先补缺单价，再复核 0 工程量和异常系数，最后保存报价版本。`,
    actions: [
      { label: '打开清单', onClick: () => { window.__app.go('boq', { projectId: proj.id }); window.__app.closeAI(); } },
      { label: '打开定额库', onClick: () => { window.__app.go('quota'); window.__app.closeAI(); } },
      { label: '确认保存报审版', onClick: async () => {
        if (!confirm(`为「${proj.name}」保存一个报审版报价快照？`)) return;
        const version = await versionService.createFromCurrent(proj.id, {
          name: `报审版 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
          note: '由 AI 报价审查建议后，经用户确认保存。',
        });
        alert(`已保存报价版本：${version.name}`);
      } },
    ],
  };
}

async function cmdBenchmark(projName) {
  const proj = await findProject(projName);
  if (!proj) return { handled: true, msg: '还没有项目可对标。' };
  await indicatorService.recompute();
  const bm = await indicatorService.benchmarkProject(proj.id);
  if (!bm) return { handled: true, msg: '项目对标失败，请确认项目存在。' };
  const metricLines = bm.metrics.map(m => {
    const sample = m.indicator ? `同类中位 ${fmt(m.indicator.median)}，样本 ${m.indicator.n}，${m.indicator.confidence}` : '暂无同类样本';
    return `• ${m.label}：${fmt(m.value)}（${m.status.label}；${sample}）`;
  }).join('\n');
  const devLines = bm.deviations.slice(0, 5).map(d => `• ${d.category}：本项目 ${fmtMoney(d.amount)}，同类中位 ${fmtMoney(d.median)}，偏差 ${d.delta >= 0 ? '+' : ''}${fmtMoney(d.delta)}`).join('\n');
  return {
    handled: true,
    msg: `「${proj.name}」项目对标\n\n${metricLines}\n\n偏差来源：\n${devLines || '暂无可对比分项。'}\n\n结论：${bm.conclusion}`,
    actions: [
      { label: '打开指标分析', onClick: () => { window.__app.go('indicators'); window.__app.closeAI(); } },
      { label: '打开项目清单', onClick: () => { window.__app.go('boq', { projectId: proj.id }); window.__app.closeAI(); } },
    ],
  };
}

async function cmdEstimate(text) {
  await indicatorService.recompute();
  const nums = [...text.matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
  const dailyCapacity = nums[0] || 0;
  const area = nums[1] || 0;
  const type = ['水厂', '泵站', '管网', '变电站', '水池', '车间'].find(k => text.includes(k)) || '';
  const process = ['AAO', 'A2O', 'MBR', 'SBR', '预处理', '供配电'].find(k => text.toUpperCase().includes(k.toUpperCase())) || '';
  const est = await indicatorService.estimate({ type, process }, { area, dailyCapacity });
  const lines = [];
  if (est.byWater) lines.push(`按单水造价：${fmtMoney(est.byWater.low)} ~ ${fmtMoney(est.byWater.high)}，推荐中值 ${fmtMoney(est.byWater.mid)}（样本 ${est.byWater.n}）`);
  if (est.byArea) lines.push(`按单方造价：${fmtMoney(est.byArea.low)} ~ ${fmtMoney(est.byArea.high)}，推荐中值 ${fmtMoney(est.byArea.mid)}（样本 ${est.byArea.n}）`);
  return {
    handled: true,
    msg: lines.length
      ? `快速估算结果\n\n口径：${type || '全部类型'} / ${process || '全部工艺'}\n输入：日处理量 ${dailyCapacity || '-'} 万m³/d，面积 ${area || '-'} ㎡\n\n${lines.join('\n')}\n\n说明：区间使用历史指标 P25~P75，样本少时仅作参考。`
      : '当前筛选口径下没有足够指标样本，或缺少面积/日处理量。可以先归档更多项目，或在指标分析页放宽筛选条件。',
    actions: [{ label: '打开指标分析', onClick: () => { window.__app.go('indicators'); window.__app.closeAI(); } }],
  };
}

async function cmdVersions(text) {
  const proj = await findProject(text);
  if (!proj) return { handled: true, msg: '还没有项目可查看版本。' };
  const versions = await versionService.listByProject(proj.id);
  if (!versions.length) {
    return {
      handled: true,
      msg: `「${proj.name}」还没有保存报价版本。建议在关键调价、导出报价前点击「保存版本」。`,
      actions: [{ label: '打开清单', onClick: () => { window.__app.go('boq', { projectId: proj.id }); window.__app.closeAI(); } }],
    };
  }
  let diffText = '';
  if (/对比|差异/.test(text) && versions.length >= 2) {
    const diff = await versionService.compare(versions[1].id, versions[0].id);
    diffText = `\n\n最近两版差异：\n• 总价变化：${diff.totalDelta >= 0 ? '+' : ''}${fmtMoney(diff.totalDelta)}\n• 新增 ${diff.added.length} 项，删除 ${diff.removed.length} 项，修改 ${diff.modified.length} 项`;
  }
  return {
    handled: true,
    msg: `「${proj.name}」报价版本\n\n${versions.slice(0, 6).map(v => `• ${v.name}｜${fmtMoney(v.totalCost || 0)}｜${v.lineCount || 0} 条｜缺单价 ${v.missingPriceCount || 0}｜${new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false })}`).join('\n')}${diffText}`,
    actions: [
      { label: '打开版本管理', onClick: () => { window.__app.go('boq', { projectId: proj.id }); window.__app.closeAI(); } },
      { label: '生成差异说明', onClick: () => sendVersionPrompt(proj.name) },
    ],
  };
}

function sendVersionPrompt(projectName) {
  const input = document.getElementById('aiInput');
  if (!input) return;
  input.value = `请用业主能看懂的话总结「${projectName}」最近两个报价版本的差异，说明总价变化、主要分项变化和风险提示`;
  input.focus();
}
