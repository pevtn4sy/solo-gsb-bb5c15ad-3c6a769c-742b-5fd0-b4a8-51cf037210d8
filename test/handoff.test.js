'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { reviewBinding } = require('../lib/review');
const {
  exportHandoff,
  parseHandoff,
  previewHandoff,
  handoffFingerprint,
  commitHandoff,
  HANDOFF_STALE_ERROR,
} = require('../lib/handoff');

function makeDoc() {
  return {
    id: 'doc1',
    title: '测试文稿',
    oldText: '旧稿：苹果很美味，香蕉也新鲜。',
    newText: '新稿：苹果很美味，香蕉也新鲜。',
    annotations: [
      {
        id: 'a1',
        quote: '苹果很美味',
        comment: '这里核对一下',
        status: 'matched',
        newStart: 3,
        newEnd: 8,
      },
      {
        id: 'a2',
        quote: '香蕉也新鲜',
        comment: '另一条',
        status: 'manual',
        newStart: 9,
        newEnd: 14,
      },
      {
        id: 'a3',
        quote: '苹果很美味',
        comment: '待处理的一条',
        status: 'pending',
        newStart: null,
        newEnd: null,
      },
    ],
  };
}

function signReview(doc, a, decision = 'approved', note = '没问题', at = '2026-09-26T00:00:00.000Z') {
  a.review = { decision, note, at, binding: reviewBinding(doc, a) };
}

function annot(doc, id) {
  return doc.annotations.find((a) => a.id === id);
}

test('导出仅含当前有效签收，并记录文稿/批注 ID、结论、备注、签收时间与绑定值', () => {
  const doc = makeDoc();
  signReview(doc, annot(doc, 'a1'), 'approved', '核对无误');
  signReview(doc, annot(doc, 'a2'), 'changes', '需要调整');
  // a2 位置随后被改动 → 结论失效，不应导出
  annot(doc, 'a2').newStart = 20;
  annot(doc, 'a2').newEnd = 25;

  const pkg = exportHandoff(doc);
  assert.equal(pkg.kind, 'annotation-review-handoff');
  assert.equal(pkg.docId, 'doc1');
  assert.equal(pkg.count, 1);
  assert.equal(pkg.items.length, 1);
  const item = pkg.items[0];
  assert.equal(item.docId, 'doc1');
  assert.equal(item.annotationId, 'a1');
  assert.equal(item.decision, 'approved');
  assert.equal(item.note, '核对无误');
  assert.equal(item.at, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(item.binding, reviewBinding(doc, annot(doc, 'a1')));
});

test('预览：缺失批注 → 跳过；绑定与当前新稿/批注/位置不符 → 跳过', () => {
  const src = makeDoc();
  signReview(src, annot(src, 'a1'));
  signReview(src, annot(src, 'a2'), 'changes', '需要调整');
  const pkg = exportHandoff(src);
  pkg.items.push({ ...pkg.items[0], annotationId: 'ghost', note: '不存在的批注' });

  const dst = makeDoc();
  annot(dst, 'a2').newStart = 20; // 绑定与当前位置不符
  annot(dst, 'a2').newEnd = 25;

  const { items, counts } = previewHandoff(dst, pkg);
  const byId = Object.fromEntries(items.map((r) => [r.annotationId, r]));
  assert.equal(byId.a1.outcome, 'importable');
  assert.equal(byId.a2.outcome, 'skipped');
  assert.equal(byId.a2.reason, 'binding_mismatch');
  assert.equal(byId.ghost.outcome, 'skipped');
  assert.equal(byId.ghost.reason, 'missing_annotation');
  assert.deepEqual(counts, { importable: 1, conflict: 0, identical: 0, skipped: 2 });
});

test('预览：目标无有效结论 → 可导入；结论或备注不同 → 冲突；完全一致 → 无需导入', () => {
  const src = makeDoc();
  signReview(src, annot(src, 'a1'), 'approved', '核对无误');
  signReview(src, annot(src, 'a2'), 'changes', '需要调整');
  const pkg = exportHandoff(src);

  const dst = makeDoc();
  signReview(dst, annot(dst, 'a1'), 'approved', '核对无误'); // 完全一致
  signReview(dst, annot(dst, 'a2'), 'approved', '本地意见'); // 结论与备注均不同

  const { items, counts } = previewHandoff(dst, pkg);
  const byId = Object.fromEntries(items.map((r) => [r.annotationId, r]));
  assert.equal(byId.a1.outcome, 'identical');
  assert.equal(byId.a2.outcome, 'conflict');
  assert.equal(byId.a2.current.decision, 'approved');
  assert.equal(byId.a2.incoming.decision, 'changes');
  assert.deepEqual(counts, { importable: 0, conflict: 1, identical: 1, skipped: 0 });
});

test('提交：可导入与选择「采用导入」的冲突一次写入并重新绑定；未选择的冲突不覆盖本地', () => {
  const src = makeDoc();
  signReview(src, annot(src, 'a1'), 'approved', '核对无误');
  signReview(src, annot(src, 'a2'), 'changes', '需要调整');
  const pkg = exportHandoff(src);

  const dst = makeDoc();
  signReview(dst, annot(dst, 'a2'), 'approved', '本地意见'); // 冲突

  const preview = previewHandoff(dst, pkg);
  const result = commitHandoff(dst, pkg, preview.fingerprint, {
    a2: 'local', // 冲突选择保留本地
  });
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 1); // a2 冲突选择保留本地，不导入

  const r1 = annot(dst, 'a1').review;
  assert.equal(r1.decision, 'approved');
  assert.equal(r1.note, '核对无误');
  assert.equal(r1.at, '2026-09-26T00:00:00.000Z'); // 保留原始签收时间
  assert.deepEqual(r1.binding, reviewBinding(dst, annot(dst, 'a1'))); // 重新绑定当前文稿
  assert.equal(r1.importedFrom.docId, 'doc1');

  const r2 = annot(dst, 'a2').review;
  assert.equal(r2.decision, 'approved'); // 本地结论未被覆盖
  assert.equal(r2.note, '本地意见');
});

test('提交：冲突选择「采用导入」时覆盖本地', () => {
  const src = makeDoc();
  signReview(src, annot(src, 'a2'), 'changes', '需要调整');
  const pkg = exportHandoff(src);

  const dst = makeDoc();
  signReview(dst, annot(dst, 'a2'), 'approved', '本地意见');

  const preview = previewHandoff(dst, pkg);
  const result = commitHandoff(dst, pkg, preview.fingerprint, { a2: 'incoming' });
  assert.equal(result.applied, 1);
  const r = annot(dst, 'a2').review;
  assert.equal(r.decision, 'changes');
  assert.equal(r.note, '需要调整');
  assert.deepEqual(r.binding, reviewBinding(dst, annot(dst, 'a2')));
});

test('提交：预览后文稿变化 → 指纹不符，整批拒绝且不写入任何结论', () => {
  const src = makeDoc();
  signReview(src, annot(src, 'a1'), 'approved', '核对无误');
  signReview(src, annot(src, 'a2'), 'changes', '需要调整');
  const pkg = exportHandoff(src);

  const dst = makeDoc();
  const preview = previewHandoff(dst, pkg);
  // 预览后文稿被改动（如重新迁移改变了区间）
  annot(dst, 'a1').newStart = 30;
  annot(dst, 'a1').newEnd = 35;

  assert.throws(
    () => commitHandoff(dst, pkg, preview.fingerprint, {}),
    (e) => e.code === 'stale' && e.message === HANDOFF_STALE_ERROR
  );
  assert.equal(annot(dst, 'a1').review, undefined);
  assert.equal(annot(dst, 'a2').review, undefined);
});

test('指纹：批注顺序无关；新稿、批注原文/内容、状态或区间变化即改变', () => {
  const doc = makeDoc();
  const fp = handoffFingerprint(doc);

  const reordered = makeDoc();
  reordered.annotations.reverse();
  assert.equal(handoffFingerprint(reordered), fp);

  const changedText = makeDoc();
  changedText.newText += '。';
  assert.notEqual(handoffFingerprint(changedText), fp);

  const changedPos = makeDoc();
  changedPos.annotations[0].newStart = 30;
  assert.notEqual(handoffFingerprint(changedPos), fp);

  const changedComment = makeDoc();
  changedComment.annotations[0].comment = '改了';
  assert.notEqual(handoffFingerprint(changedComment), fp);
});

test('解析：非交接包、版本不符、文稿 ID 不符均报错；支持 {pkg} 包装', () => {
  const src = makeDoc();
  signReview(src, annot(src, 'a1'));
  const pkg = exportHandoff(src);

  assert.ok(parseHandoff(pkg, 'doc1').pkg);
  assert.ok(parseHandoff({ pkg }, 'doc1').pkg); // 提交接口的包装形式
  assert.ok(parseHandoff(pkg, 'doc2').error.includes('其他文稿'));
  assert.ok(parseHandoff({ kind: 'other' }, 'doc1').error);
  assert.ok(parseHandoff({ ...pkg, version: 99 }, 'doc1').error.includes('版本'));
  assert.ok(parseHandoff(null, 'doc1').error);
  assert.ok(parseHandoff({ ...pkg, items: null }, 'doc1').error);
});

test('预览：交接记录字段残缺 → 跳过（malformed），不影响其他记录', () => {
  const src = makeDoc();
  signReview(src, annot(src, 'a1'));
  const pkg = exportHandoff(src);
  pkg.items.push({ annotationId: 'a2', decision: 'approved' }); // 缺 at / binding

  const dst = makeDoc();
  const { items, counts } = previewHandoff(dst, pkg);
  const bad = items.find((r) => r.annotationId === 'a2');
  assert.equal(bad.outcome, 'skipped');
  assert.equal(bad.reason, 'malformed');
  assert.equal(counts.importable, 1);
  assert.equal(counts.skipped, 1);
});
