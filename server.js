'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { locate, CONTEXT_LEN } = require('./lib/match');
const { computeOverlapGroups } = require('./lib/overlap');
const {
  REVIEW_DECISIONS,
  reviewBinding,
  getValidReview,
  pruneInvalidReviews,
  reviewCounts,
} = require('./lib/review');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DOCS_DIR = path.join(DATA_DIR, 'documents');

fs.mkdirSync(DOCS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 存储（每份文稿一个 JSON 文件） ----------

function docFile(id) {
  return path.join(DOCS_DIR, `${id}.json`);
}

function loadDoc(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  const f = docFile(id);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveDoc(doc) {
  doc.updatedAt = new Date().toISOString();
  fs.writeFileSync(docFile(doc.id), JSON.stringify(doc, null, 2));
}

function summary(doc) {
  const counts = reviewCounts(doc); // 仅统计当前有效的复核，旧结论已失效时不计入
  return {
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    annotationCount: doc.annotations.length,
    pendingCount: doc.annotations.filter((a) => a.status === 'pending').length,
    approvedCount: counts.approved,
    changesCount: counts.changes,
    hasOldText: Boolean(doc.oldText),
    hasNewText: Boolean(doc.newText),
  };
}

function resetMigration(a) {
  a.status = 'unmigrated';
  a.reason = null;
  a.newStart = null;
  a.newEnd = null;
  a.candidates = [];
}

/**
 * 返回给前端的文稿视图：附带按当前位置即时计算的重叠冲突组与有效复核计数。
 * 派生数据不写入磁盘，每次迁移、人工定位或任何位置变动后随响应重新计算。
 * 失效的旧复核（如直接改动了磁盘 JSON）不展示、不计入；正式清除在写操作时落盘。
 */
function docJson(doc) {
  const annotations = doc.annotations.map((a) =>
    a.review && !getValidReview(doc, a) ? { ...a, review: null } : a
  );
  const view = { ...doc, annotations };
  const counts = reviewCounts(view);
  return {
    ...view,
    overlapGroups: computeOverlapGroups(annotations),
    approvedCount: counts.approved,
    changesCount: counts.changes,
  };
}

function notFound(res) {
  res.status(404).json({ error: '文稿不存在' });
}

// ---------- API ----------

// 文稿列表
app.get('/api/documents', (req, res) => {
  const docs = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), 'utf8')))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(summary);
  res.json(docs);
});

// 新建文稿
app.post('/api/documents', (req, res) => {
  const title = String((req.body && req.body.title) || '').trim() || '未命名文稿';
  const now = new Date().toISOString();
  const doc = {
    id: crypto.randomBytes(8).toString('hex'),
    title,
    oldText: '',
    newText: '',
    annotations: [],
    createdAt: now,
    updatedAt: now,
  };
  saveDoc(doc);
  res.status(201).json(docJson(doc));
});

// 文稿详情
app.get('/api/documents/:id', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  res.json(docJson(doc));
});

// 删除文稿
app.delete('/api/documents/:id', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  fs.unlinkSync(docFile(doc.id));
  res.json({ ok: true });
});

// 保存/替换旧稿：按已有批注的偏移量重算选中文本与前后文，越界批注被移除
app.put('/api/documents/:id/old', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const oldText = req.body && req.body.oldText;
  if (typeof oldText !== 'string' || !oldText.trim()) {
    return res.status(400).json({ error: '旧稿内容不能为空' });
  }
  doc.oldText = oldText;
  let dropped = 0;
  doc.annotations = doc.annotations.filter((a) => {
    if (a.oldEnd > oldText.length) {
      dropped++;
      return false;
    }
    a.quote = oldText.slice(a.oldStart, a.oldEnd);
    a.prefix = oldText.slice(Math.max(0, a.oldStart - CONTEXT_LEN), a.oldStart);
    a.suffix = oldText.slice(a.oldEnd, a.oldEnd + CONTEXT_LEN);
    resetMigration(a);
    return true;
  });
  pruneInvalidReviews(doc); // 原文与位置已变，旧复核一律失效
  saveDoc(doc);
  res.json({ doc: docJson(doc), dropped });
});

// 添加批注（记录选中文本及其前后文，供迁移时消歧）
app.post('/api/documents/:id/annotations', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const { start, end, comment } = req.body || {};
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > doc.oldText.length ||
    start >= end
  ) {
    return res.status(400).json({ error: '选区无效' });
  }
  if (!comment || !String(comment).trim()) {
    return res.status(400).json({ error: '批注内容不能为空' });
  }
  const a = {
    id: crypto.randomBytes(8).toString('hex'),
    oldStart: start,
    oldEnd: end,
    quote: doc.oldText.slice(start, end),
    prefix: doc.oldText.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: doc.oldText.slice(end, end + CONTEXT_LEN),
    comment: String(comment).trim(),
    createdAt: new Date().toISOString(),
  };
  resetMigration(a);
  doc.annotations.push(a);
  saveDoc(doc);
  res.status(201).json(docJson(doc));
});

// 删除批注
app.delete('/api/documents/:id/annotations/:aid', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const before = doc.annotations.length;
  doc.annotations = doc.annotations.filter((a) => a.id !== req.params.aid);
  if (doc.annotations.length === before) {
    return res.status(404).json({ error: '批注不存在' });
  }
  saveDoc(doc);
  res.json(docJson(doc));
});

// 保存/替换新稿：所有批注的迁移结果作废，需重新迁移
app.put('/api/documents/:id/new', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const newText = req.body && req.body.newText;
  if (typeof newText !== 'string' || !newText.trim()) {
    return res.status(400).json({ error: '新稿内容不能为空' });
  }
  doc.newText = newText;
  doc.annotations.forEach(resetMigration);
  pruneInvalidReviews(doc); // 新稿全文已替换，所有旧复核失效
  saveDoc(doc);
  res.json(docJson(doc));
});

// 执行迁移：对每条批注在新稿中重新定位
app.post('/api/documents/:id/migrate', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  if (!doc.newText) return res.status(400).json({ error: '请先保存新稿' });
  for (const a of doc.annotations) {
    const r = locate(a, doc.newText);
    a.status = r.status;
    a.reason = r.reason;
    a.newStart = r.newStart;
    a.newEnd = r.newEnd;
    a.candidates = r.candidates;
  }
  // 结果与上次完全相同（状态、区间及各绑定值未变）时保留复核结论；
  // 任一绑定值改变（如被重新定位到新位置、变为待处理）则自动清除旧结论。
  pruneInvalidReviews(doc);
  saveDoc(doc);
  res.json(docJson(doc));
});

// 人工指定批注在新稿中的位置（采用候选或框选后调用）
app.put('/api/documents/:id/annotations/:aid/position', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const a = doc.annotations.find((x) => x.id === req.params.aid);
  if (!a) return res.status(404).json({ error: '批注不存在' });
  const { start, end } = req.body || {};
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > doc.newText.length ||
    start >= end
  ) {
    return res.status(400).json({ error: '位置无效' });
  }
  a.newStart = start;
  a.newEnd = end;
  a.status = 'manual';
  a.reason = 'human';
  // 指定到完全相同的区间时保留结论；位置一旦改变，旧核准立即清除
  pruneInvalidReviews(doc);
  saveDoc(doc);
  res.json(docJson(doc));
});

// 人工复核签收：把已定位 / 人工指定的批注标记为「已核准」或「需调整」，
// 结论绑定当时的新稿全文、批注原文与内容、迁移状态及新区间。
app.put('/api/documents/:id/annotations/:aid/review', (req, res) => {
  const doc = loadDoc(req.params.id);
  if (!doc) return notFound(res);
  const a = doc.annotations.find((x) => x.id === req.params.aid);
  if (!a) return res.status(404).json({ error: '批注不存在' });
  // 待处理、未迁移批注没有确定位置，不能核准/签收
  if (
    (a.status !== 'matched' && a.status !== 'manual') ||
    !Number.isInteger(a.newStart) ||
    !Number.isInteger(a.newEnd)
  ) {
    return res.status(400).json({ error: '待处理、未迁移批注不能复核，请先确定新稿位置' });
  }
  const decision = req.body && req.body.decision;
  if (!REVIEW_DECISIONS.includes(decision)) {
    return res.status(400).json({ error: '复核结论须为「已核准」或「需调整」' });
  }
  const note = String((req.body && req.body.note) || '').trim();
  a.review = {
    decision,
    note,
    at: new Date().toISOString(),
    binding: reviewBinding(doc, a),
  };
  saveDoc(doc);
  res.json(docJson(doc));
});

app.listen(PORT, () => {
  console.log(`文稿批注迁移工具已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
