'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { reviewBinding, getValidReview, reviewCounts } = require('../lib/review');
const {
  exportReviews,
  validatePackage,
  docFingerprint,
  previewImport,
  applyImport,
} = require('../lib/handoff');

function makeDoc() {
  return {
    id: '0123456789abcdef',
    title: '交接测试文稿',
    oldText: '旧稿：苹果很美味。',
    newText: '新稿：苹果很美味，香蕉也新鲜。',
    annotations: [
      { id: 'a1', quote: '苹果很美味', comment: '核对苹果', status: 'matched', newStart: 3, newEnd: 8 },
      { id: 'a2', quote: '香蕉也新鲜', comment: '核对香蕉', status: 'manual', newStart: 9, newEnd: 14 },
    ],
  };
}

function sign(doc, aid, decision = 'approved', note = '备注', at = '2026-09-26T01:00:00.000Z') {
  const a = doc.annotations.find((x) => x.id === aid);
  a.review = { decision, note, at, binding: reviewBinding(doc, a) };
}

test('导出仅包含当前有效的签收，并记录文稿/批注 ID、结论、备注、签收时间与绑定值', () => {
  const doc = makeDoc();
  sign(doc, 'a1', 'approved', '没问题');
  sign(doc, 'a2', 'changes', '要调整');
  doc.annotations[1].newStart = 20; // a2 绑定失效，不应导出
  doc.annotations[1].newEnd = 25;

  const pkg = exportReviews(doc);
  assert.equal(pkg.type, 'review-handoff');
  assert.equal(pkg.version, 1);
  assert.equal(pkg.docId, doc.id);
  assert.ok(pkg.exportedAt);
  assert.equal(pkg.reviews.length, 1);
  const r = pkg.reviews[0];
  assert.equal(r.annotationId, 'a1');
  assert.equal(r.decision, 'approved');
  assert.equal(r.note, '没问题');
  assert.equal(r.at, '2026-09-26T01:00:00.000Z');
  assert.deepEqual(r.binding, reviewBinding(doc, doc.annotations[0]));
});

test('交接包校验：类型 / 版本 / 归属文稿 / 记录列表', () => {
  const doc = makeDoc();
  sign(doc, 'a1');
  const pkg = exportReviews(doc);
  assert.equal(validatePackage(pkg, doc.id), null);
  assert.ok(validatePackage(null, doc.id));
  assert.ok(validatePackage('not-an-object', doc.id));
  assert.ok(validatePackage({ ...pkg, type: 'other' }, doc.id));
  assert.ok(validatePackage({ ...pkg, version: 2 }, doc.id));
  assert.ok(validatePackage({ ...pkg, docId: 'ffffffffffffffff' }, doc.id)); // 其他文稿
  assert.ok(validatePackage({ ...pkg, reviews: null }, doc.id));
});

test('预览分类：可导入 / 冲突 / 一致 / 缺失批注跳过', () => {
  const src = makeDoc();
  sign(src, 'a1', 'approved', '源备注1');
  sign(src, 'a2', 'changes', '源备注2');
  const pkg = exportReviews(src);
  pkg.reviews.push({
    annotationId: 'zz',
    decision: 'approved',
    note: '',
    at: '2026-09-26T02:00:00.000Z',
    binding: { newTextHash: 'x', quote: 'q', comment: 'c', status: 'matched', newStart: 0, newEnd: 1 },
  });

  // a1 本地无有效结论 → 可导入；a2 双方备注不同 → 冲突；zz 批注不存在 → 跳过
  const dst = makeDoc();
  sign(dst, 'a2', 'changes', '本地备注2', '2026-09-26T02:00:00.000Z');
  const { items, counts } = previewImport(dst, pkg);
  const byId = Object.fromEntries(items.map((it) => [it.annotationId, it]));
  assert.equal(byId.a1.status, 'import');
  assert.equal(byId.a2.status, 'conflict');
  assert.equal(byId.a2.local.note, '本地备注2');
  assert.equal(byId.a2.imported.note, '源备注2');
  assert.equal(byId.zz.status, 'skip');
  assert.equal(byId.zz.reason, 'missing_annotation');
  assert.deepEqual(counts, { skip: 1, same: 0, import: 1, conflict: 1 });

  // 本地结论与导入完全一致（结论与备注均相同）→ 一致，无需导入
  const dst2 = makeDoc();
  sign(dst2, 'a1', 'approved', '源备注1');
  const again = previewImport(dst2, pkg);
  const byId2 = Object.fromEntries(again.items.map((it) => [it.annotationId, it]));
  assert.equal(byId2.a1.status, 'same');
  assert.equal(again.counts.same, 1);
});

test('预览分类：绑定与当前新稿 / 批注 / 位置不符的结论跳过', () => {
  const src = makeDoc();
  sign(src, 'a1');
  const pkg = exportReviews(src);

  // 位置变了
  const d1 = makeDoc();
  d1.annotations[0].newStart = 30;
  d1.annotations[0].newEnd = 35;
  // 批注内容变了
  const d2 = makeDoc();
  d2.annotations[0].comment = '改过的批注';
  // 新稿全文变了
  const d3 = makeDoc();
  d3.newText = '完全不同的新稿。';

  for (const d of [d1, d2, d3]) {
    const { items, counts } = previewImport(d, pkg);
    assert.equal(items[0].status, 'skip');
    assert.equal(items[0].reason, 'binding_mismatch');
    assert.equal(counts.skip, 1);
  }
});

test('重复记录与字段残缺的记录在预览中跳过', () => {
  const src = makeDoc();
  sign(src, 'a1');
  const pkg = exportReviews(src);
  pkg.reviews.push(pkg.reviews[0]); // 重复记录
  pkg.reviews.push({ annotationId: 'a2', decision: 'nope' }); // 字段残缺
  const { items, counts } = previewImport(makeDoc(), pkg);
  assert.equal(items[0].status, 'import');
  assert.equal(items[1].status, 'skip');
  assert.equal(items[1].reason, 'duplicate');
  assert.equal(items[2].status, 'skip');
  assert.equal(items[2].reason, 'invalid_record');
  assert.equal(counts.skip, 2);
});

test('文稿内容指纹：位置、结论、新稿变化都会改变指纹，非绑定字段不影响', () => {
  const doc = makeDoc();
  const f0 = docFingerprint(doc);
  assert.equal(docFingerprint(structuredClone(doc)), f0); // 内容相同 → 指纹相同

  const d1 = structuredClone(doc);
  d1.annotations[0].newStart = 30;
  assert.notEqual(docFingerprint(d1), f0); // 位置变化

  const d2 = structuredClone(doc);
  sign(d2, 'a1');
  assert.notEqual(docFingerprint(d2), f0); // 新签收结论

  const d3 = structuredClone(doc);
  d3.newText = '新稿改动了：苹果很美味，香蕉也新鲜。';
  assert.notEqual(docFingerprint(d3), f0); // 新稿变化

  const d4 = structuredClone(doc);
  d4.annotations.push({ id: 'a9', quote: '新增', comment: '新增批注', status: 'unmigrated' });
  assert.notEqual(docFingerprint(d4), f0); // 批注增删

  const d5 = structuredClone(doc);
  d5.annotations[0].candidates = [{ start: 3, end: 8, score: 2 }]; // 非绑定字段
  assert.equal(docFingerprint(d5), f0);
});

test('确认导入：可导入项一次写入并保留原签收时间；冲突缺省保留本地、不默认覆盖', () => {
  const src = makeDoc();
  sign(src, 'a1', 'approved', '源备注1', '2026-09-26T01:00:00.000Z');
  sign(src, 'a2', 'changes', '源备注2', '2026-09-26T01:05:00.000Z');
  const pkg = exportReviews(src);

  // 冲突项未做选择 → 保留本地
  const dst = makeDoc();
  sign(dst, 'a2', 'approved', '本地备注2', '2026-09-26T02:00:00.000Z');
  const r1 = applyImport(dst, pkg, {});
  assert.deepEqual(r1, { applied: 1, kept: 1, skipped: 0 });
  const a1 = dst.annotations[0];
  assert.equal(a1.review.decision, 'approved');
  assert.equal(a1.review.note, '源备注1');
  assert.equal(a1.review.at, '2026-09-26T01:00:00.000Z'); // 保留原签收时间
  assert.ok(getValidReview(dst, a1)); // 写入后对当前文稿有效
  assert.equal(dst.annotations[1].review.note, '本地备注2'); // 本地结论未被覆盖
  assert.deepEqual(reviewCounts(dst), { approved: 2, changes: 0 });

  // 冲突项明确选择「采用导入」→ 覆盖本地
  const dst2 = makeDoc();
  sign(dst2, 'a2', 'approved', '本地备注2', '2026-09-26T02:00:00.000Z');
  const r2 = applyImport(dst2, pkg, { a2: 'import' });
  assert.deepEqual(r2, { applied: 2, kept: 0, skipped: 0 });
  const b2 = dst2.annotations[1];
  assert.equal(b2.review.decision, 'changes');
  assert.equal(b2.review.note, '源备注2');
  assert.equal(b2.review.at, '2026-09-26T01:05:00.000Z');
  assert.ok(getValidReview(dst2, b2));
});

test('确认导入：按当前文稿重新分类，跳过项即使被指定 import 也不写入', () => {
  const src = makeDoc();
  sign(src, 'a1');
  const pkg = exportReviews(src);
  pkg.reviews.push({
    annotationId: 'zz',
    decision: 'approved',
    note: '',
    at: '2026-09-26T02:00:00.000Z',
    binding: { newTextHash: 'x', quote: 'q', comment: 'c', status: 'matched', newStart: 0, newEnd: 1 },
  });
  const dst = makeDoc();
  dst.annotations[0].newStart = 30; // a1 绑定已不符 → skip
  dst.annotations[0].newEnd = 35;
  const r = applyImport(dst, pkg, { a1: 'import', zz: 'import' });
  assert.deepEqual(r, { applied: 0, kept: 0, skipped: 2 });
  assert.equal(dst.annotations[0].review, undefined); // 未被写入
});
