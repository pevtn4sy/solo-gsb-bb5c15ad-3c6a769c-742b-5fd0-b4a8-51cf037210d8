'use strict';

/**
 * 复核结论离线交接。
 *
 * 用于在两台机器（或两份独立部署的数据目录）之间离线交接当前有效的复核签收：
 *  - exportHandoff：在文稿结果页导出仅含「当前有效签收」的 JSON 交接包，
 *    每条记录文稿 ID、批注 ID、结论、备注、签收时间及完整绑定值；
 *  - previewHandoff：导入同一文稿时先逐条预览，绝不直接落盘：
 *      · 缺失批注                          → skipped(missing_annotation)
 *      · 绑定与当前新稿、批注及位置不符     → skipped(binding_mismatch)
 *      · 目标批注当前无有效结论            → importable（可导入）
 *      · 双方结论或备注不同                → conflict（须人工二选一，不默认覆盖）
 *      · 双方结论与备注完全一致            → identical（无需导入）
 *  - handoffFingerprint：预览所依据的文稿内容指纹（新稿全文 + 每条批注的
 *    原文/内容/状态/区间），确认提交时重新核对；期间文稿一旦变化，整批拒绝；
 *  - commitHandoff：重新校验指纹与逐条结果后一次写入，
 *    导入的结论一律重新绑定到当前文稿（沿用既有复核绑定规则）。
 */

const crypto = require('crypto');
const {
  REVIEW_DECISIONS,
  reviewBinding,
  bindingEqual,
  getValidReview,
} = require('./review');

const HANDOFF_KIND = 'annotation-review-handoff';
const HANDOFF_VERSION = 1;
const HANDOFF_FP_VERSION = 1;
const HANDOFF_STALE_ERROR = '文稿自预览后已变化，请重新预览后再导入';

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** 规范字符串：null/undefined 统一为空串 */
function s(v) {
  return v == null ? '' : String(v);
}

/**
 * 导出交接包：仅收录当前仍有效的复核结论（失效/残缺结论不导出）。
 * 绑定值完整记录，导入端据此判断与当前新稿、批注及位置是否相符。
 */
function exportHandoff(doc) {
  const items = [];
  for (const a of (doc && doc.annotations) || []) {
    const r = getValidReview(doc, a);
    if (!r) continue;
    items.push({
      docId: doc.id,
      annotationId: a.id,
      decision: r.decision,
      note: r.note || '',
      at: r.at,
      binding: {
        newTextHash: r.binding.newTextHash,
        quote: r.binding.quote,
        comment: r.binding.comment,
        status: r.binding.status,
        newStart: r.binding.newStart,
        newEnd: r.binding.newEnd,
      },
    });
  }
  items.sort((x, y) => x.annotationId.localeCompare(y.annotationId));
  return {
    kind: HANDOFF_KIND,
    version: HANDOFF_VERSION,
    docId: doc.id,
    title: doc.title || '',
    exportedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
}

/**
 * 解析并校验交接包。
 * @returns {{error?:string, pkg:object|null}}
 */
function parseHandoff(body, expectedDocId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '交接数据格式不正确', pkg: null };
  }
  const pkg = body.pkg && typeof body.pkg === 'object' ? body.pkg : body;
  if (pkg.kind !== HANDOFF_KIND) {
    return { error: '不是有效的复核交接包（缺少 kind 标识）', pkg: null };
  }
  if (pkg.version !== HANDOFF_VERSION) {
    return { error: `不支持的交接包版本：${s(pkg.version)}`, pkg: null };
  }
  if (!s(pkg.docId)) return { error: '交接包缺少文稿 ID', pkg: null };
  if (expectedDocId && pkg.docId !== expectedDocId) {
    return { error: '该交接包属于其他文稿，不能导入当前文稿', pkg: null };
  }
  if (!Array.isArray(pkg.items)) return { error: '交接包内容不完整（缺少 items）', pkg: null };
  return { pkg };
}

/** 单条交接记录字段是否完整、结论是否合法 */
function validItem(item) {
  return Boolean(
    item &&
      typeof item === 'object' &&
      s(item.annotationId) &&
      REVIEW_DECISIONS.includes(item.decision) &&
      s(item.at) &&
      item.binding &&
      typeof item.binding === 'object' &&
      s(item.binding.newTextHash) &&
      typeof item.binding.newStart === 'number' &&
      typeof item.binding.newEnd === 'number'
  );
}

/**
 * 逐条预览导入结果（不修改文稿）。
 * @returns {{fingerprint:string, items:Array, counts:object}}
 */
function previewHandoff(doc, pkg) {
  const items = [];
  const counts = { importable: 0, conflict: 0, identical: 0, skipped: 0 };

  for (const raw of pkg.items) {
    if (!validItem(raw)) {
      items.push({
        annotationId: raw && s(raw.annotationId) ? String(raw.annotationId) : '(未知)',
        outcome: 'skipped',
        reason: 'malformed',
        incoming: normalizeItem(raw),
      });
      counts.skipped += 1;
      continue;
    }
    const incoming = normalizeItem(raw);
    const a = doc.annotations.find((x) => x.id === incoming.annotationId);
    if (!a) {
      items.push({ annotationId: incoming.annotationId, outcome: 'skipped', reason: 'missing_annotation', incoming });
      counts.skipped += 1;
      continue;
    }
    // 绑定必须与当前新稿、批注原文/内容、迁移状态及新区间完全相符，否则跳过，
    // 绝不把旧结论挂到新稿或新位置上。
    if (!bindingEqual(incoming.binding, reviewBinding(doc, a))) {
      items.push({
        annotationId: a.id,
        quote: a.quote || '',
        comment: a.comment || '',
        outcome: 'skipped',
        reason: 'binding_mismatch',
        current: { decision: null, note: '', binding: reviewBinding(doc, a) },
        incoming,
      });
      counts.skipped += 1;
      continue;
    }
    const local = getValidReview(doc, a);
    const base = {
      annotationId: a.id,
      quote: a.quote || '',
      comment: a.comment || '',
      incoming,
      current: local
        ? { decision: local.decision, note: local.note || '', at: local.at, binding: reviewBinding(doc, a) }
        : { decision: null, note: '', binding: reviewBinding(doc, a) },
    };
    if (!local) {
      items.push({ ...base, outcome: 'importable' });
      counts.importable += 1;
    } else if (local.decision === incoming.decision && (local.note || '') === incoming.note) {
      items.push({ ...base, outcome: 'identical' });
      counts.identical += 1;
    } else {
      items.push({ ...base, outcome: 'conflict' });
      counts.conflict += 1;
    }
  }

  return { fingerprint: handoffFingerprint(doc), items, counts };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') {
    return { annotationId: '', decision: null, note: '', at: '', binding: null };
  }
  return {
    annotationId: s(raw.annotationId),
    decision: REVIEW_DECISIONS.includes(raw.decision) ? raw.decision : null,
    note: s(raw.note),
    at: s(raw.at),
    binding: raw.binding && typeof raw.binding === 'object'
      ? {
          newTextHash: s(raw.binding.newTextHash),
          quote: s(raw.binding.quote),
          comment: s(raw.binding.comment),
          status: s(raw.binding.status),
          newStart: typeof raw.binding.newStart === 'number' ? raw.binding.newStart : null,
          newEnd: typeof raw.binding.newEnd === 'number' ? raw.binding.newEnd : null,
        }
      : null,
  };
}

/**
 * 预览所依据的文稿内容指纹：新稿全文摘要 + 每条批注（按 id 排序）的
 * 原文、批注内容、迁移状态与新区间。绑定值未变即指纹不变。
 */
function handoffFingerprint(doc) {
  const parts = [
    HANDOFF_FP_VERSION,
    doc.id,
    hashText(doc.newText || ''),
    (doc.annotations || [])
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) =>
      [a.id, hashText(a.quote || ''), hashText(a.comment || ''), s(a.status), s(a.newStart), s(a.newEnd)].join('|')
    )
      .join('\n'),
  ];
  return hashText(parts.join('\n'));
}

/**
 * 确认导入：重新核对指纹并重新逐条判定，通过后一次写入（原地修改 doc）。
 * @param {object} doc 当前文稿
 * @param {object} pkg 交接包
 * @param {string} fingerprint 预览时返回的指纹
 * @param {Record<string, 'incoming'|'local'>|undefined} resolutions 冲突条目的逐条选择；
 *        importable 条目也可显式给 'local' 表示不导入；缺省一律不覆盖本地
 * @returns {{applied:number, skipped:number, items:Array}}
 * @throws {{code:'stale', message:string}} 文稿自预览后已变化，整批拒绝
 */
function commitHandoff(doc, pkg, fingerprint, resolutions) {
  if (typeof fingerprint !== 'string' || handoffFingerprint(doc) !== fingerprint) {
    const err = new Error(HANDOFF_STALE_ERROR);
    err.code = 'stale';
    throw err;
  }
  const preview = previewHandoff(doc, pkg);
  // 理论上指纹一致时分类必一致；再次比对，杜绝任何意外漂移
  if (preview.fingerprint !== fingerprint) {
    const err = new Error(HANDOFF_STALE_ERROR);
    err.code = 'stale';
    throw err;
  }

  const choice = (id) => (resolutions && Object.prototype.hasOwnProperty.call(resolutions, id)
    ? resolutions[id]
    : undefined);
  let applied = 0;
  let skipped = 0;

  for (const row of preview.items) {
    const takeIncoming =
      (row.outcome === 'importable' && choice(row.annotationId) !== 'local') ||
      (row.outcome === 'conflict' && choice(row.annotationId) === 'incoming');
    if (!takeIncoming) {
      skipped += 1;
      continue;
    }
    const a = doc.annotations.find((x) => x.id === row.annotationId);
    if (!a) {
      skipped += 1;
      continue;
    }
    // 沿用现有 review 结构与绑定规则：导入后绑定当前文稿快照，
    // 保留原始签收时间，并记录交接来源。
    a.review = {
      decision: row.incoming.decision,
      note: row.incoming.note,
      at: row.incoming.at,
      binding: reviewBinding(doc, a),
      importedFrom: {
        docId: pkg.docId,
        binding: row.incoming.binding,
        at: new Date().toISOString(),
      },
    };
    applied += 1;
  }

  return { applied, skipped, items: preview.items };
}

module.exports = {
  HANDOFF_KIND,
  HANDOFF_VERSION,
  HANDOFF_STALE_ERROR,
  exportHandoff,
  parseHandoff,
  previewHandoff,
  handoffFingerprint,
  commitHandoff,
};
