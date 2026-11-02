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

import { joinContinuations, looksWrong, splitTranslation } from '../src/core/translate';

describe('跨栏段落', () => {
  it('句子未结束且下一块以小写开头时合并，连字符断词直接拼接', () => {
    const u = joinContinuations(
      [{ text: 'These planners are optimized for natural-' }, { text: 'istic driving distributions. Consequently, they remain brittle.' }, { text: 'A new paragraph.' }],
      [false, false, false],
    );
    expect(u.map((x) => x.blocks)).toEqual([[0, 1], [2]]);
    expect(u[0].text).toBe('These planners are optimized for naturalistic driving distributions. Consequently, they remain brittle.');
  });

  it('译文按长度比例分回，切在标点处', () => {
    const parts = splitTranslation('这些规划器主要针对自然驾驶分布进行优化。因此，它们在交互式长尾场景中仍然脆弱。', [40, 40]);
    expect(parts).toHaveLength(2);
    expect(parts.join('')).toBe('这些规划器主要针对自然驾驶分布进行优化。因此，它们在交互式长尾场景中仍然脆弱。');
    expect(parts[0].endsWith('。') || parts[0].endsWith('，')).toBe(true);
  });
});

describe('looksWrong', () => {
  const src = 'Consequently, they remain brittle on interactive long-tail cases that are rare but safety-critical.';
  it('照抄原文句子或夹带附注时判为可疑', () => {
    expect(looksWrong('因此，Consequently, they remain brittle on interactive long-tail cases... 译：它们仍然脆弱。', src, 'zh-CN')).toBe(true);
    expect(looksWrong('自然istic? —应译"自然驾驶分布"', 'naturalistic driving distributions', 'zh-CN')).toBe(true);
  });
  it('正常译文不受影响', () => {
    expect(looksWrong('因此，它们在罕见但关乎安全的交互式长尾场景（long-tail cases）中仍然脆弱。', src, 'zh-CN')).toBe(false);
  });
});
