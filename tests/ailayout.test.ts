import { describe, expect, it } from 'vitest';
import { planToFlow } from '../src/core/ailayout';
import type { PageLayout } from '../src/pdf/blocks';

const blk = (i: number, x: number, y: number, text: string, role = 'text') =>
  ({ i, x, y, w: 200, h: 20, size: 10, pitch: 12, align: 'left', text, map: [], translatable: true, role }) as never;

const layout = {
  width: 600,
  height: 800,
  raw: '',
  pieces: [],
  blocks: [blk(0, 50, 50, 'Title', 'heading'), blk(1, 50, 100, 'First half of a paragraph'), blk(2, 300, 100, 'second half.'), blk(3, 300, 400, 'Level 3'), blk(4, 50, 700, 'Lost paragraph')],
  flow: [0, 1, 2, 3, 4].map((i) => ({ kind: 'block', i })),
} as unknown as PageLayout;

describe('AI 版面计划', () => {
  it('按计划排序、合并段落、裁剪图（包含图中文字），漏掉的块补回', () => {
    const flow = planToFlow(
      {
        items: [
          { type: 'heading', ids: [0] },
          { type: 'text', ids: [1, 2] },
          { type: 'figure', box: [450, 450, 900, 600], ids: [3] },
          { type: 'drop', ids: [99] },
        ],
      },
      layout,
    );
    expect(flow.map((f) => (f.kind === 'block' ? `${f.i}${f.cont ? '+' : ''}:${f.role}` : 'crop'))).toEqual(['0:heading', '1:text', '2+:text', 'crop', '4:text']);
    const crop = flow.find((f) => f.kind === 'crop')!;
    if (crop.kind !== 'crop') throw new Error();
    // 框被扩大到包含 "Level 3"（x=300/600=0.5 → 0.45 的框左边保持，y=400/800=0.5 ≤ 0.45+…）
    expect(crop.x).toBeLessThanOrEqual(0.45);
    expect(crop.y + crop.h).toBeGreaterThanOrEqual(0.6);
  });
});
