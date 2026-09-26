'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { locate } = require('../lib/match');

function ann(quote, prefix = '', suffix = '') {
  return { quote, prefix, suffix };
}

test('唯一出现 → 直接定位', () => {
  const r = locate(ann('苹果'), '第一段：苹果很美味。第二段：香蕉很新鲜。');
  assert.equal(r.status, 'matched');
  assert.equal(r.reason, 'unique');
  assert.equal(r.newStart, 4);
});

test('重复片段：前后文可区分 → 自动定位到正确位置', () => {
  // 旧稿中标注的是中间那个 abc（前缀 "abc "，后缀 " abc"）
  const r = locate(ann('abc', 'abc ', ' abc'), 'abc abc abc');
  assert.equal(r.status, 'matched');
  assert.equal(r.reason, 'context');
  assert.equal(r.newStart, 4);
});

test('重复片段：前后文并列 → 待处理并给出全部候选', () => {
  const r = locate(ann('abc', '', ' abc'), 'abc abc abc abc');
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.newStart, null);
  assert.ok(r.candidates.length >= 2);
});

test('原文已删除 → 待处理，不静默挂载', () => {
  const r = locate(ann('这句已经被删掉了'), '完全不同的新文稿内容。');
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, 'not_found');
  assert.equal(r.newStart, null);
});

test('原文被改写 → 待处理并给出相似片段候选', () => {
  const r = locate(ann('今天我们一起去爬山'), '今天我们一起去游泳，玩得很开心。');
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, 'not_found');
  assert.ok(r.candidates.length >= 1);
  assert.ok(r.candidates[0].fuzzy);
});

test('空白差异（换行/多空格）不影响匹配', () => {
  const text = 'say  hello   world  please';
  const r = locate(ann('hello world'), text);
  assert.equal(r.status, 'matched');
  assert.equal(text.slice(r.newStart, r.newEnd), 'hello   world');
});

test('多处出现但只有一个上下文吻合 → 定位到该处', () => {
  const old = '他说：天气不错。她说：天气不错。';
  const prefix = old.slice(0, old.lastIndexOf('天气不错'));
  const r = locate(ann('天气不错', prefix, '。'), '他说：天气不错。她说：天气不错。');
  assert.equal(r.status, 'matched');
  assert.equal(r.newStart, 11);
});
