// 特征解析：从项目名称里抽"（碳钢）/(半地下)/- 砖混"等修饰
// 命名清洗：去掉噪音词、规格号、补全主名

const NOISE_TOKENS = [
  /^[A-Z0-9_\-]{3,}$/i,  // 纯编号 EBM-1200
  /^[IVX]+$/,              // 罗马数字
  /^[0-9]+(\.[0-9]+)?$/,   // 纯数字
  /^mm$/i, /^cm$/i, /^m$/i, /^m[23]$/i, /^[²³]$/,
  /^[a-z]{1,3}$/i,        // 单字母
];

// 抽取括号特征：(XXX) （XXX） [XXX]
const BRACKET_RE = /[（(]([^）)]+?)[）)]/g;
// 破折号/逗号/顿号分隔的修饰
const SEPARATORS = /[，,、；;]/;

function isNoise(tok) {
  if (!tok) return true;
  const t = tok.trim();
  if (!t) return true;
  if (t.length > 30) return true;
  return NOISE_TOKENS.some(re => re.test(t));
}

/**
 * 解析项目名称，返回 { baseName, features, code }
 * 例如:
 *   "预处理车间（碳钢）" -> { baseName: "预处理车间", features: ["碳钢"] }
 *   "二沉池(半地下)C30" -> { baseName: "二沉池", features: ["半地下"], code: "C30" }
 *   "AAO 生物池-钢筋砼" -> { baseName: "AAO 生物池", features: ["钢筋砼"] }
 */
export function parseName(raw) {
  if (!raw) return { baseName: '', features: [], code: null };
  let text = String(raw).trim();
  const features = [];

  // 1) 抽括号
  let m;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(text)) !== null) {
    const v = m[1].trim();
    if (v && !isNoise(v)) features.push(v);
  }
  text = text.replace(BRACKET_RE, '');

  // 2) 抽逗号/顿号/分号
  if (SEPARATORS.test(text)) {
    const parts = text.split(SEPARATORS).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      const head = parts[0];
      const tail = parts.slice(1).filter(p => !isNoise(p));
      text = head;
      features.push(...tail);
    }
  }

  // 3) 抽破折号 "-", "—" 后的修饰
  const dash = text.match(/^(.+?)[-—–]\s*(.+)$/);
  if (dash) {
    const [, head, tail] = dash;
    if (!isNoise(tail)) {
      text = head.trim();
      features.push(tail.trim());
    }
  }

  // 4) 抽规格号 C30, φ25, Φ20, DN200
  let code = null;
  const codeMatch = text.match(/(C\d+|[Φφ][\d.]+|DN\d+|M\d+|Q\d+|HPB\d+|HRB\d+|φ?\d+mm|\d+级)/);
  if (codeMatch) {
    code = codeMatch[0];
    // 规格号保留在主名里也行（看场景）
  }

  // 清理尾部空格/标点
  text = text.replace(/[\s\-—–:,，、]+$/g, '').trim();

  // 去重
  const uniq = [];
  const seen = new Set();
  for (const f of features) {
    const k = f.toLowerCase();
    if (!seen.has(k)) { seen.add(k); uniq.push(f); }
  }

  return { baseName: text, features: uniq, code };
}

/** 给主名+特征打分类（多特征投票） */
export function categorize(baseName, features = []) {
  // 复用 utils/stats.js 的 categoryGuess
  return categoryGuessFromName(baseName, features);
}

import { categoryGuess as _cg } from './stats.js?v=6.4';

function categoryGuessFromName(name, features) {
  const blob = [name, ...features].join(' ');
  return _cg(blob);
}

/** 给定多个样本合并为「主名+共性特征」模板 */
export function commonName(samples) {
  if (!samples.length) return '';
  if (samples.length === 1) return samples[0];
  // 取最短的当主名
  const sorted = [...samples].sort((a, b) => a.length - b.length);
  return sorted[0];
}
