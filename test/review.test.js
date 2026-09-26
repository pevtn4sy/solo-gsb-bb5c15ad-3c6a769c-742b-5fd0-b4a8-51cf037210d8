'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  reviewBinding,
  getValidReview,
  pruneInvalidReviews,
  reviewCounts,
} = require('../lib/review');

function makeDoc() {
  return {
    oldText: '旧稿：苹果很美味。',
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
        comment: '待处理的一条',
        status: 'pending',
        newStart: null,
        newEnd: null,
      },
    ],
  };
}

function signReview(doc, a, decision = 'approved', note = '没问题') {
  a.review = {
    decision,
    note,
    at: '2026-09-26T00:00:00.000Z',
    binding: reviewBinding(doc, a),
  };
}

test('刚签收的结论对当前绑定有效', () => {
  const doc = makeDoc();
  signReview(doc, doc.annotations[0]);
  const r = getValidReview(doc, doc.annotations[0]);
  assert.ok(r);
  assert.equal(r.decision, 'approved');
  assert.equal(getValidReview(doc, doc.annotations[1]), null); // 无结论
});

test('重复迁移得到完全相同结果（绑定值不变）→ 结论保留', () => {
  const doc = makeDoc();
  signReview(doc, doc.annotations[0]);
  // 模拟再次迁移：状态、区间完全一致，candidates 等非绑定字段变化不影响
  doc.annotations[0].candidates = [{ start: 3, end: 8, score: 2 }];
  assert.ok(getValidReview(doc, doc.annotations[0]));
  assert.deepEqual(pruneInvalidReviews(doc), []);
  assert.ok(doc.annotations[0].review);
});

test('新区间改变 → 旧结论自动清除', () => {
  const doc = makeDoc();
  signReview(doc, doc.annotations[0]);
  doc.annotations[0].newStart = 20;
  doc.annotations[0].newEnd = 25;
  assert.equal(getValidReview(doc, doc.annotations[0]), null);
  const cleared = pruneInvalidReviews(doc);
  assert.deepEqual(cleared, ['a1']);
  assert.equal(doc.annotations[0].review, null);
});

test('迁移状态改变（如变为待处理）→ 旧结论失效', () => {
  const doc = makeDoc();
  signReview(doc, doc.annotations[0]);
  doc.annotations[0].status = 'pending';
  doc.annotations[0].newStart = null;
  doc.annotations[0].newEnd = null;
  assert.equal(getValidReview(doc, doc.annotations[0]), null);
  pruneInvalidReviews(doc);
  assert.equal(doc.annotations[0].review, null);
});

test('批注原文或内容改变 → 旧结论失效', () => {
  const doc = makeDoc();
  signReview(doc, doc.annotations[0]);
  doc.annotations[0].comment = '修改后的批注内容';
  pruneInvalidReviews(doc);
  assert.equal(doc.annotations[0].review, null);

  signReview(doc, doc.annotations[0]);
  doc.annotations[0].quote = '苹果很美味！'; // 原文变了
  pruneInvalidReviews(doc);
  assert.equal(doc.annotations[0].review, null);
});

test('新稿全文改变（哪怕区间数字没变）→ 旧结论失效，避免误用于新位置', () => {
  const doc = makeDoc();
  signReview(doc, doc.annotations[0]);
  doc.newText = '完全不同的新稿：苹果很美味，香蕉也新鲜。'; // 同区间数字但文字不同
  assert.equal(getValidReview(doc, doc.annotations[0]), null);
  pruneInvalidReviews(doc);
  assert.equal(doc.annotations[0].review, null);
});

test('有效复核计数只统计当前有效结论', () => {
  const doc = makeDoc();
  signReview(doc, doc.annotations[0], 'approved');
  assert.deepEqual(reviewCounts(doc), { approved: 1, changes: 0 });

  // 给 a2 也签收（人工指定了位置后）
  Object.assign(doc.annotations[1], { status: 'manual', newStart: 9, newEnd: 14 });
  signReview(doc, doc.annotations[1], 'changes', '这里要调整');
  assert.deepEqual(reviewCounts(doc), { approved: 1, changes: 1 });

  // a1 区间改变后失效，计数只剩 a2
  doc.annotations[0].newStart = 30;
  doc.annotations[0].newEnd = 35;
  assert.deepEqual(reviewCounts(doc), { approved: 0, changes: 1 });
});

test('字段残缺或 decision 非法的结论视为无效（兼容旧/脏数据）', () => {
  const doc = makeDoc();
  const a = doc.annotations[0];
  a.review = { decision: 'approved', at: '2026-09-26T00:00:00.000Z' }; // 缺 binding
  assert.equal(getValidReview(doc, a), null);
  a.review = { decision: 'unknown', at: '2026-09-26T00:00:00.000Z', binding: reviewBinding(doc, a) };
  assert.equal(getValidReview(doc, a), null);
  a.review = { decision: 'approved', binding: reviewBinding(doc, a) }; // 缺 at
  assert.equal(getValidReview(doc, a), null);
});
