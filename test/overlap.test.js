'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeOverlapGroups } = require('../lib/overlap');

function ann(id, newStart, newEnd, status = 'matched') {
  return { id, newStart, newEnd, status, quote: `q${id}`, comment: `c${id}` };
}

test('无重叠 → 无冲突组', () => {
  assert.deepEqual(computeOverlapGroups([ann('a', 0, 5), ann('b', 10, 15)]), []);
  assert.deepEqual(computeOverlapGroups([]), []);
  assert.deepEqual(computeOverlapGroups([ann('a', 0, 5)]), []);
});

test('端点相接（半开区间）不算重叠', () => {
  assert.deepEqual(computeOverlapGroups([ann('a', 0, 5), ann('b', 5, 10)]), []);
});

test('部分交叠 → 同组，类型 partial，范围为成员并集', () => {
  const groups = computeOverlapGroups([ann('a', 0, 6), ann('b', 3, 10)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'partial');
  assert.equal(groups[0].start, 0);
  assert.equal(groups[0].end, 10);
  assert.deepEqual(groups[0].members.map((m) => m.id), ['a', 'b']);
});

test('范围完全相同 → 类型 identical', () => {
  const groups = computeOverlapGroups([ann('a', 2, 8), ann('b', 2, 8), ann('c', 2, 8)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'identical');
  assert.equal(groups[0].members.length, 3);
});

test('包含关系也算重叠（一条完全包住另一条）', () => {
  const groups = computeOverlapGroups([ann('a', 0, 100), ann('b', 10, 20)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'partial');
});

test('重叠传递：A 叠 B、B 叠 C → 三条同组', () => {
  const groups = computeOverlapGroups([ann('a', 0, 5), ann('b', 4, 9), ann('c', 8, 12)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 3);
  assert.equal(groups[0].end, 12);
});

test('待处理与未迁移批注不入组（即使带有位置字段）', () => {
  const groups = computeOverlapGroups([
    ann('a', 0, 10),
    { ...ann('b', 2, 8), status: 'pending', newStart: null, newEnd: null },
    { ...ann('c', 1, 9), status: 'unmigrated', newStart: null, newEnd: null },
    { ...ann('d', 3, 7), status: 'pending' }, // 防御：状态不符即使带位置也不入组
  ]);
  assert.deepEqual(groups, []);
});

test('人工指定的批注参与分组', () => {
  const groups = computeOverlapGroups([ann('a', 0, 10), ann('b', 5, 15, 'manual')]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.status), ['matched', 'manual']);
});

test('修改任一位置后重算分组', () => {
  const list = [ann('a', 0, 10), ann('b', 5, 15), ann('c', 20, 25)];
  assert.equal(computeOverlapGroups(list).length, 1);

  list[1].newStart = 30; // 把 b 移走 → 不再有任何重叠
  list[1].newEnd = 35;
  assert.equal(computeOverlapGroups(list).length, 0);

  list[1].newStart = 8; // b 同时搭上 a 和 c → 三条经传递合并为一组
  list[1].newEnd = 22;
  const groups = computeOverlapGroups(list);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 3);
});

test('多个独立冲突组分别编号，按起始位置排序', () => {
  const groups = computeOverlapGroups([
    ann('c', 100, 110),
    ann('a', 0, 5),
    ann('d', 105, 120),
    ann('b', 2, 6),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].id, 1);
  assert.deepEqual(groups[0].members.map((m) => m.id), ['a', 'b']);
  assert.equal(groups[1].id, 2);
  assert.deepEqual(groups[1].members.map((m) => m.id), ['c', 'd']);
});
