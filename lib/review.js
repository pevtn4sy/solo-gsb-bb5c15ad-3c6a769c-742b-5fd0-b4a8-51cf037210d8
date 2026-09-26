'use strict';

/**
 * 迁移结果的人工复核签收。
 *
 * 每条已定位（matched）/ 人工指定（manual）的批注可携带一条 review：
 *   { decision: 'approved' | 'changes', note, at, binding }
 *
 * 复核结论必须绑定签收当时的：
 *   - 新稿全文（以 SHA-256 摘要入绑定，避免全文在每条批注下重复存储）；
 *   - 批注原文（quote）与批注内容（comment）；
 *   - 迁移状态（status）；
 *   - 新区间（newStart / newEnd）。
 *
 * 重复迁移得到完全相同的结果时绑定值不变，结论继续有效；
 * 任一绑定值改变（重新迁移到别处、人工改位、替换新旧稿、修改批注等），
 * 旧结论立即失效并被清除，避免旧核准误用于新位置。
 */

const crypto = require('crypto');

const REVIEW_DECISIONS = ['approved', 'changes'];

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** 计算一条批注在当前文稿下的复核绑定值（快照） */
function reviewBinding(doc, a) {
  return {
    newTextHash: hashText(doc && doc.newText),
    quote: a.quote || '',
    comment: a.comment || '',
    status: a.status,
    newStart: a.newStart == null ? null : a.newStart,
    newEnd: a.newEnd == null ? null : a.newEnd,
  };
}

function bindingEqual(b1, b2) {
  return Boolean(
    b1 && b2 &&
      b1.newTextHash === b2.newTextHash &&
      b1.quote === b2.quote &&
      b1.comment === b2.comment &&
      b1.status === b2.status &&
      b1.newStart === b2.newStart &&
      b1.newEnd === b2.newEnd
  );
}

/** 返回当前仍有效的复核结论；无结论、字段残缺或任一绑定值已变化时返回 null */
function getValidReview(doc, a) {
  if (!a || !a.review || !a.review.binding) return null;
  const r = a.review;
  if (!REVIEW_DECISIONS.includes(r.decision) || !r.at) return null;
  return bindingEqual(r.binding, reviewBinding(doc, a)) ? r : null;
}

/**
 * 自动清除失效的旧结论（原地修改）。
 * 在每次迁移、人工定位、保存新旧稿等写操作前/后调用。
 * @returns {string[]} 被清除结论的批注 id 列表
 */
function pruneInvalidReviews(doc) {
  const cleared = [];
  for (const a of (doc && doc.annotations) || []) {
    if (a.review && !getValidReview(doc, a)) {
      a.review = null;
      cleared.push(a.id);
    }
  }
  return cleared;
}

/** 统计当前有效的各类复核数量（失效结论不计入） */
function reviewCounts(doc) {
  const counts = { approved: 0, changes: 0 };
  for (const a of (doc && doc.annotations) || []) {
    const r = getValidReview(doc, a);
    if (r && r.decision === 'approved') counts.approved += 1;
    else if (r && r.decision === 'changes') counts.changes += 1;
  }
  return counts;
}

module.exports = {
  REVIEW_DECISIONS,
  reviewBinding,
  getValidReview,
  pruneInvalidReviews,
  reviewCounts,
};
