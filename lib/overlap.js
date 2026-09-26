'use strict';

/**
 * 新稿批注重叠复核。
 *
 * 规则：
 *  - 仅统计在新稿中已有确定位置的批注（matched / manual），
 *    待处理（pending）与未迁移（unmigrated）批注一律不入组；
 *  - 区间按半开区间 [start, end) 判定重叠：a.start < b.end 且 b.start < a.end，
 *    端点相接（a.end === b.start）不算重叠；
 *  - 重叠关系按传递闭包合并：A 叠 B、B 叠 C，则 A/B/C 同属一个冲突组；
 *  - 组内所有批注范围完全一致 → identical（完全相同），否则 partial（部分交叠）。
 *
 * 该函数为纯函数：每次迁移或人工定位后用最新位置重新调用，即得最新分组。
 */

function computeOverlapGroups(annotations) {
  const located = (annotations || []).filter(
    (a) =>
      (a.status === 'matched' || a.status === 'manual') &&
      Number.isInteger(a.newStart) &&
      Number.isInteger(a.newEnd) &&
      a.newStart < a.newEnd
  );
  // 按起点升序扫描，维护当前组的并集右端点，实现重叠的传递合并
  const sorted = located
    .slice()
    .sort((a, b) => a.newStart - b.newStart || a.newEnd - b.newEnd);

  const raw = [];
  let cur = null;
  for (const a of sorted) {
    if (cur && a.newStart < cur.end) {
      // 与当前组相交（严格小于：端点相接即 a.newStart === cur.end 时另起新组）
      cur.members.push(a);
      if (a.newEnd > cur.end) cur.end = a.newEnd;
    } else {
      cur = { start: a.newStart, end: a.newEnd, members: [a] };
      raw.push(cur);
    }
  }

  // 单条批注自成一组不算冲突，只保留 ≥2 条的组
  return raw
    .filter((g) => g.members.length > 1)
    .map((g, i) => {
      const first = g.members[0];
      const identical = g.members.every(
        (m) => m.newStart === first.newStart && m.newEnd === first.newEnd
      );
      return {
        id: i + 1,
        type: identical ? 'identical' : 'partial',
        start: g.start, // 组覆盖范围（成员区间并集）
        end: g.end,
        members: g.members.map((m) => ({
          id: m.id,
          status: m.status,
          newStart: m.newStart,
          newEnd: m.newEnd,
          quote: m.quote,
          comment: m.comment,
        })),
      };
    });
}

module.exports = { computeOverlapGroups };
