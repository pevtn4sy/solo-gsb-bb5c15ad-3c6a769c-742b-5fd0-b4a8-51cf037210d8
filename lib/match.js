'use strict';

/**
 * 批注重定位核心逻辑。
 *
 * 原则：宁可标为「待处理」，也绝不静默挂到错误段落。
 *
 * 判定规则：
 *  - 选中文本在新稿中出现 0 次  → pending(not_found)，并给出模糊相似片段作为候选；
 *  - 出现 1 次                  → matched(unique)；
 *  - 出现多次                   → 比较每个出现位置的前后文（各取 80 字符），
 *    得分最高且与次高差距 >= MIN_GAP 才自动定位 matched(context)；
 *    否则 pending(ambiguous)，把候选位置全部交给人工选择。
 */

const CONTEXT_LEN = 80; // 前后文截取长度（字符）
const MIN_GAP = 0.3; // 自动定位所需的最小得分差（0~2 分制）
const FUZZY_MIN = 0.45; // 模糊候选的最低相似度（Dice 系数）

/** 折叠空白并保留到原文的下标映射，使匹配对换行/多空格差异不敏感 */
function normalizeWithMap(text) {
  const map = [];
  let out = '';
  let inWs = false;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (!inWs && out.length > 0) {
        out += ' ';
        map.push(i);
      }
      inWs = true;
    } else {
      out += text[i];
      map.push(i);
      inWs = false;
    }
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { norm: out, map };
}

/** 归一化前后文：折叠空白为单个空格，但保留首尾空格，以便与正文中的空格边界对齐 */
function normalizeContext(text) {
  return String(text).replace(/\s+/g, ' ');
}

function commonSuffixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function bigramCounts(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 上下文得分：前缀匹配度 + 后缀匹配度，范围 0~2 */
function contextScore(prefix, suffix, norm, s, e) {
  const before = norm.slice(Math.max(0, s - CONTEXT_LEN), s);
  const after = norm.slice(e, e + CONTEXT_LEN);
  const ps = prefix.length ? commonSuffixLen(prefix, before) / prefix.length : 0;
  const ss = suffix.length ? commonPrefixLen(suffix, after) / suffix.length : 0;
  return ps + ss;
}

/**
 * 找不到精确片段时，用滑动窗口 + 二元组 Dice 系数找相似片段，
 * 仅供人工参考，绝不自动采用。
 */
function fuzzyCandidates(q, norm, map) {
  if (q.length < 4 || norm.length === 0) return [];
  const qg = bigramCounts(q);
  const qTotal = Math.max(1, q.length - 1);
  const sizes = [
    Math.max(2, Math.round(q.length * 0.75)),
    q.length,
    Math.round(q.length * 1.25),
  ];
  const hits = [];

  for (const L of new Set(sizes)) {
    if (L < 2 || L > norm.length) continue;
    // 滑动窗口，滚动维护窗口内二元组计数与命中数
    const counts = new Map();
    for (let i = 0; i < L - 1; i++) {
      const g = norm.slice(i, i + 2);
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    let hit = 0;
    for (const [g, c] of counts) hit += Math.min(c, qg.get(g) || 0);
    const wTotal = L - 1;

    for (let i = 0; i + L <= norm.length; i++) {
      const sim = (2 * hit) / (qTotal + wTotal);
      if (sim >= FUZZY_MIN) hits.push({ ns: i, ne: i + L, sim });
      if (i + L >= norm.length) break;
      // 滑出左端二元组
      const out = norm.slice(i, i + 2);
      const cOut = counts.get(out);
      if (cOut !== undefined) {
        if (cOut <= (qg.get(out) || 0)) hit -= 1;
        if (cOut === 1) counts.delete(out);
        else counts.set(out, cOut - 1);
      }
      // 滑入右端二元组
      const inn = norm.slice(i + L - 1, i + L + 1);
      const cIn = counts.get(inn) || 0;
      if (cIn < (qg.get(inn) || 0)) hit += 1;
      counts.set(inn, cIn + 1);
    }
  }

  hits.sort((a, b) => b.sim - a.sim);
  // 去掉彼此重叠的候选，只保留前 3 个
  const kept = [];
  for (const h of hits) {
    if (kept.every((k) => Math.abs(k.ns - h.ns) > q.length / 2)) kept.push(h);
    if (kept.length >= 3) break;
  }
  return kept.map((h) => ({
    start: map[h.ns],
    end: map[h.ne - 1] + 1,
    score: round2(h.sim),
    fuzzy: true,
  }));
}

/**
 * 在新稿中为一条批注定定位。
 * @param {{quote:string, prefix:string, suffix:string}} annotation 批注（含旧稿中的前后文）
 * @param {string} newText 新稿全文
 * @returns {{status:'matched'|'pending', reason:string, newStart:number|null,
 *            newEnd:number|null, candidates:Array}}
 */
function locate(annotation, newText) {
  const { norm, map } = normalizeWithMap(newText || '');
  const q = normalizeWithMap(annotation.quote || '').norm;
  const prefix = normalizeContext(annotation.prefix || '');
  const suffix = normalizeContext(annotation.suffix || '');
  const none = { newStart: null, newEnd: null };

  if (!q) return { status: 'pending', reason: 'not_found', candidates: [], ...none };

  // 找出所有出现位置（归一化空间）
  const occ = [];
  let idx = norm.indexOf(q);
  while (idx !== -1) {
    occ.push(idx);
    idx = norm.indexOf(q, idx + 1);
  }

  if (occ.length === 0) {
    return {
      status: 'pending',
      reason: 'not_found',
      candidates: fuzzyCandidates(q, norm, map),
      ...none,
    };
  }

  const toOrig = (ns, ne) => ({ start: map[ns], end: map[ne - 1] + 1 });
  const scored = occ
    .map((s) => {
      const e = s + q.length;
      const { start, end } = toOrig(s, e);
      return { start, end, score: round2(contextScore(prefix, suffix, norm, s, e)) };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1) {
    const c = scored[0];
    return { status: 'matched', reason: 'unique', newStart: c.start, newEnd: c.end, candidates: scored };
  }

  const best = scored[0];
  const second = scored[1];
  if (best.score > 0 && best.score - second.score >= MIN_GAP) {
    return { status: 'matched', reason: 'context', newStart: best.start, newEnd: best.end, candidates: scored.slice(0, 5) };
  }
  // 多个位置上下文相近，无法可靠区分 → 交人工
  return { status: 'pending', reason: 'ambiguous', candidates: scored.slice(0, 5), ...none };
}

module.exports = { locate, CONTEXT_LEN };
