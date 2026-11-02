import { describe, expect, it } from 'vitest';
import { rangesInBlock, rawRangeOf } from '../src/core/reflowmap';
import { heuristicAlign, spanFromMarked } from '../src/core/hlalign';

describe('重排文字与原文偏移', () => {
  // "abc def" 来自原文 "abcdef"（中间的空格是补出来的）
  const block = { map: [10, 11, 12, -1, 13, 14, 15] };
  it('原文区间映射到块内字符区间，跨过补出的空格', () => {
    expect(rangesInBlock(block, 11, 15)).toEqual([[1, 6]]);
    expect(rangesInBlock(block, 13, 16)).toEqual([[4, 7]]);
    expect(rangesInBlock(block, 0, 5)).toEqual([]);
  });
  it('块内选区映射回原文区间', () => {
    expect(rawRangeOf(block, 1, 6)).toEqual({ start: 11, end: 15 });
    expect(rawRangeOf(block, 3, 4)).toBeNull();
  });
});

describe('译文中的高亮位置', () => {
  const src = 'Recent work has shifted toward generative motion modeling. However, these planners are optimized for naturalistic driving distributions. Consequently, they remain brittle on long-tail cases.';
  const tr = '近来的工作已转向生成式运动建模。然而，这些规划器针对自然驾驶分布进行优化。因此，它们在长尾场景中仍然脆弱。';
  it('按句子对应，落在正确的句子里', () => {
    const q = 'Consequently, they remain brittle on long-tail cases.';
    const cs = src.indexOf(q);
    const sp = heuristicAlign(src, cs, cs + q.length, tr);
    expect(tr.slice(sp.ts, sp.te)).toContain('因此');
    expect(tr.slice(sp.ts, sp.te)).not.toContain('然而');
  });
  it('原文片段在译文中原样出现时直接使用', () => {
    const t2 = '我们在 nuPlan 上评估。';
    const s2 = 'We evaluate on nuPlan.';
    const sp = heuristicAlign(s2, s2.indexOf('nuPlan'), s2.indexOf('nuPlan') + 6, t2);
    expect(t2.slice(sp.ts, sp.te)).toBe('nuPlan');
  });
  it('解析 AI 标记的译文，必须与原译文一致', () => {
    expect(spanFromMarked('近来的工作已转向⟦生成式运动建模⟧。', '近来的工作已转向生成式运动建模。')).toEqual({ ts: 8, te: 15 });
    expect(spanFromMarked('改写了⟦内容⟧', '原来的内容')).toBeNull();
  });
});
