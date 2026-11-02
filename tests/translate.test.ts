import { describe, expect, it } from 'vitest';
import { parseSegments } from '../src/core/ai';
import { classifyReference } from '../src/core/translate';

describe('parseSegments', () => {
  it('按标记切分，忽略推理段与多余空白', () => {
    const m = parseSegments('<think>let me see [[9]]</think>\n[[1]]\n第一段 "引号" 也没问题\n\n[[2]] 第二段\n[[3]]\n');
    expect(m.get(1)).toBe('第一段 "引号" 也没问题');
    expect(m.get(2)).toBe('第二段');
    expect(m.has(3)).toBe(false);
    expect(m.has(9)).toBe(false);
  });
});

describe('classifyReference', () => {
  it('参考文献标题之后的条目跳过，遇到新标题恢复', () => {
    let inRefs = false;
    const run = (t: string) => {
      const r = classifyReference(t, inRefs);
      inRefs = r.inRefs;
      return r.skip;
    };
    expect(run('We propose a planner that is robust to adversarial agents.')).toBe(false);
    expect(run('References')).toBe(true);
    expect(run('A. Smith and B. Lee. Planning under uncertainty. In CVPR, 2021.')).toBe(true);
    expect(run('[12] C. Wang. Scenario generation. arXiv preprint, 2024.')).toBe(true);
    expect(run('A Additional Experiments')).toBe(false);
    expect(run('We further evaluate the method on closed-loop benchmarks.')).toBe(false);
  });
});
