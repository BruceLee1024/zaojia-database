// 统计工具
export function stats(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const q = p => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return {
    n,
    min: sorted[0],
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    max: sorted[n - 1],
    mean: arr.reduce((a, b) => a + b, 0) / n,
  };
}

// 关键词打分匹配：返回最佳候选
export function pickBestQuota(items, hint) {
  if (!hint || !items.length) return null;
  const tokens = hint.toLowerCase().split(/[\s,，、]+/).filter(s => s.length >= 1);
  let best = null, bestScore = 0;
  for (const it of items) {
    const blob = `${it.name} ${it.feature || ''} ${(it.tags || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const tk of tokens) {
      if (!tk) continue;
      if (blob.includes(tk)) score += tk.length;
      if (it.name.toLowerCase().includes(tk)) score += 2;
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 2 ? best : null;
}

// 分类启发（按名称猜分类）
export function categoryGuess(name) {
  if (!name) return '其他';
  if (/土|石方|挖|填|夯|桩|降水|挡土|钢板桩|土钉/.test(name)) return '土石方与支护';
  if (/混凝土|钢筋|模板|砖|砌块|垫层|满堂|承台|基础梁|设备基础/.test(name)) return '混凝土与钢筋';
  if (/防水|防腐|保温|涂料|砂浆|抹灰|找平/.test(name)) return '防水防腐';
  if (/墙|柱|梁|板|屋面|楼地面|门窗/.test(name)) return '建筑装饰';
  if (/管道|阀门|管件|套管/.test(name)) return '工艺管道';
  if (/电缆|桥架|配电|灯具|开关|插座|弱电|防雷|接地/.test(name)) return '电气';
  return '其他';
}
