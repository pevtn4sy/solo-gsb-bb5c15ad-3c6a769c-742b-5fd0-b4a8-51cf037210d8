'use strict';

/**
 * 复核结论离线交接（导出 / 导入）。
 *
 * 导出：仅打包当前仍有效的签收，逐条记录文稿 ID、批注 ID、结论、备注、
 *       签收时间与绑定值（沿用 lib/review.js 的绑定快照）。
 *
 * 导入：先预览逐条分类，不写盘——
 *   skip     批注不存在、记录残缺/重复，或绑定与当前新稿、批注及位置不符；
 *   same     本地已有完全相同的有效结论（结论与备注均一致），无需导入；
 *   import   目标批注当前无有效结论，可直接导入；
 *   conflict 双方都有有效结论且结论或备注不同，需用户逐条选择
 *            「保留本地」或「采用导入」，不默认覆盖。
 *
 * 预览同时返回文稿内容指纹（docFingerprint）；确认时指纹不符说明预览期间
 * 文稿已变化，整批拒绝，需重新预览。指纹相符才由 applyImport 一次写入。
 */

const {
  REVIEW_DECISIONS,
  hashText,
  reviewBinding,
  bindingEqual,
  getValidReview,
} = require('./review');

const PACKAGE_TYPE = 'review-handoff';
const PACKAGE_VERSION = 1;

/** 导出当前有效的复核签收为交接包（纯函数，不写盘） */
function exportReviews(doc) {
  const reviews = [];
  for (const a of (doc && doc.annotations) || []) {
    const r = getValidReview(doc, a);
    if (!r) continue; // 仅当前有效的签收可导出，失效旧结论不交接
    reviews.push({
      annotationId: a.id,
      decision: r.decision,
      note: r.note || '',
      at: r.at,
      binding: r.binding,
    });
  }
  return {
    type: PACKAGE_TYPE,
    version: PACKAGE_VERSION,
    docId: doc.id,
    docTitle: doc.title || '',
    exportedAt: new Date().toISOString(),
    reviews,
  };
}

/** 校验交接包的格式与归属；合法返回 null，否则返回错误文案 */
function validatePackage(pkg, docId) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return '文件不是有效的复核结论交接包';
  }
  if (pkg.type !== PACKAGE_TYPE || pkg.version !== PACKAGE_VERSION) {
    return '文件不是有效的复核结论交接包（类型或版本不符）';
  }
  if (pkg.docId !== docId) {
    return '该交接包导出自其他文稿，不能导入当前文稿';
  }
  if (!Array.isArray(pkg.reviews)) {
    return '交接包缺少复核记录列表';
  }
  return null;
}

/**
 * 文稿内容指纹：预览分类所依据的全部数据——每条批注的当前绑定值
 * （含新稿摘要、批注原文与内容、迁移状态、新区间）与当前有效结论。
 * 预览与确认用同一函数计算，期间任何相关变化都会改变指纹。
 */
function docFingerprint(doc) {
  const payload = {
    id: doc && doc.id,
    annotations: ((doc && doc.annotations) || []).map((a) => ({
      id: a.id,
      binding: reviewBinding(doc, a),
      review: getValidReview(doc, a),
    })),
  };
  return hashText(JSON.stringify(payload));
}

/** 规整一条导入记录；字段残缺或非法返回 null */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.annotationId !== 'string' || !entry.annotationId) return null;
  if (!REVIEW_DECISIONS.includes(entry.decision)) return null;
  if (typeof entry.at !== 'string' || !entry.at) return null;
  if (!entry.binding || typeof entry.binding !== 'object') return null;
  return {
    annotationId: entry.annotationId,
    decision: entry.decision,
    note: String(entry.note == null ? '' : entry.note).trim(),
    at: entry.at,
    binding: entry.binding,
  };
}

function skipItem(annotationId, reason, quote, comment, imported) {
  return {
    annotationId,
    status: 'skip',
    reason,
    quote: quote || '',
    comment: comment || '',
    imported: imported || null,
    local: null,
  };
}

/**
 * 预览导入：逐条分类（纯函数，不写盘）。
 * @returns {{items: Array, counts: {skip:number, same:number, import:number, conflict:number}}}
 */
function previewImport(doc, pkg) {
  const items = [];
  const seen = new Set();
  for (const raw of pkg.reviews) {
    const entry = normalizeEntry(raw);
    if (!entry) {
      const aid = raw && typeof raw.annotationId === 'string' ? raw.annotationId : '';
      items.push(skipItem(aid, 'invalid_record'));
      continue;
    }
    const imported = { decision: entry.decision, note: entry.note, at: entry.at };
    if (seen.has(entry.annotationId)) {
      items.push(
        skipItem(entry.annotationId, 'duplicate', entry.binding.quote, entry.binding.comment, imported)
      );
      continue;
    }
    seen.add(entry.annotationId);
    const a = doc.annotations.find((x) => x.id === entry.annotationId);
    if (!a) {
      items.push(
        skipItem(entry.annotationId, 'missing_annotation', entry.binding.quote, entry.binding.comment, imported)
      );
      continue;
    }
    if (!bindingEqual(entry.binding, reviewBinding(doc, a))) {
      items.push(skipItem(entry.annotationId, 'binding_mismatch', a.quote, a.comment, imported));
      continue;
    }
    const local = getValidReview(doc, a);
    const base = { annotationId: a.id, reason: null, quote: a.quote, comment: a.comment, imported };
    if (!local) {
      items.push({ ...base, status: 'import', local: null });
      continue;
    }
    const localView = { decision: local.decision, note: local.note || '', at: local.at };
    const identical = local.decision === entry.decision && String(local.note || '') === entry.note;
    items.push({ ...base, status: identical ? 'same' : 'conflict', local: localView });
  }
  const counts = { skip: 0, same: 0, import: 0, conflict: 0 };
  for (const it of items) counts[it.status] += 1;
  return { items, counts };
}

/**
 * 确认导入（原地修改 doc，调用方负责指纹核对与落盘）。
 * 按当前文稿重新分类，不信任调用方给出的分类；冲突项仅当 resolutions
 * 明确选择 'import' 时才覆盖，缺省保留本地。
 * @returns {{applied:number, kept:number, skipped:number}}
 */
function applyImport(doc, pkg, resolutions) {
  const res = resolutions && typeof resolutions === 'object' ? resolutions : {};
  const { items } = previewImport(doc, pkg);
  const result = { applied: 0, kept: 0, skipped: 0 };
  for (const item of items) {
    const useImported =
      item.status === 'import' ||
      (item.status === 'conflict' && res[item.annotationId] === 'import');
    if (useImported) {
      const a = doc.annotations.find((x) => x.id === item.annotationId);
      a.review = {
        decision: item.imported.decision,
        note: item.imported.note,
        at: item.imported.at, // 保留原签收时间
        binding: reviewBinding(doc, a), // 与包内绑定一致（预览已校验），按当前值落盘
      };
      result.applied += 1;
    } else if (item.status === 'conflict') {
      result.kept += 1; // 保留本地，不默认覆盖
    } else {
      result.skipped += 1;
    }
  }
  return result;
}

module.exports = {
  PACKAGE_TYPE,
  PACKAGE_VERSION,
  exportReviews,
  validatePackage,
  docFingerprint,
  previewImport,
  applyImport,
};
