import { describe, expect, it, vi } from 'vitest';

// pdf.js 的 worker 依赖浏览器环境；这里只需要矩阵乘法
vi.mock('../src/pdf/engine', () => ({
  pdfjs: {
    Util: {
      transform: (m1: number[], m2: number[]) => [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
      ],
    },
  },
}));

const { extractBlocks } = await import('../src/pdf/blocks');

const PAGE_H = 792;
/** PDF 坐标（原点左下）中的一段文字 */
const item = (str: string, x: number, yFromTop: number, size = 10, width = str.length * size * 0.45) => ({
  str,
  transform: [size, 0, 0, size, x, PAGE_H - yFromTop],
  width,
  height: size,
});
const fakePage = (items: ReturnType<typeof item>[]) =>
  ({
    getViewport: () => ({ width: 612, height: PAGE_H, transform: [1, 0, 0, -1, 0, PAGE_H] }),
    getTextContent: async () => ({ items }),
  }) as never;

const LINE = 'word word word word word word word word word word word word';

describe('extractBlocks：段落块提取', () => {
  it('双栏：同一基线的左右两栏分成不同的块，每栏的连续行合并为段落', async () => {
    const items = [];
    for (let i = 0; i < 4; i++) {
      items.push(item(LINE, 54, 100 + i * 12, 10, 240));
      items.push(item(LINE, 318, 100 + i * 12, 10, 240));
    }
    const blocks = await extractBlocks(fakePage(items));
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.w < 260)).toBe(true);
    expect(blocks.every((b) => Math.abs(b.pitch - 12) < 0.01)).toBe(true);
    expect(blocks[0].text.split('word').length - 1).toBe(48);
  });

  it('标题与正文分开；短的末行之后另起一段', async () => {
    const items = [
      item('1 Introduction', 54, 80, 12, 90),
      item(LINE, 54, 100, 10, 240),
      item(LINE, 54, 112, 10, 240),
      item('word word end.', 54, 124, 10, 70),
      item(LINE, 66, 136, 10, 228),
      item(LINE, 54, 148, 10, 240),
    ];
    const blocks = await extractBlocks(fakePage(items));
    expect(blocks.map((b) => b.text.slice(0, 14))).toEqual(['1 Introduction', 'word word word', 'word word word']);
  });

  it('跳过公式等符号密集的行', async () => {
    const items = [item('h = softmax(QK^T / sqrt(d)) V + b (1)', 120, 200, 10, 200), item(LINE, 54, 240, 10, 240), item(LINE, 54, 252, 10, 240)];
    const blocks = await extractBlocks(fakePage(items));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.startsWith('word')).toBe(true);
  });

  it('行尾连字符直接相连', async () => {
    const items = [item('we study the pro-', 54, 100, 10, 240), item('cessing of long input texts here', 54, 112, 10, 240)];
    const blocks = await extractBlocks(fakePage(items));
    expect(blocks[0].text).toContain('processing');
  });

  it('两端对齐的宽词距不会把一行切成两块', async () => {
    const items = [];
    for (let i = 0; i < 6; i++) {
      items.push(item(LINE, 54, 100 + i * 12, 10, 240));
      items.push(item(LINE, 318, 100 + i * 12, 10, 240));
    }
    // 第 3 行左栏：词距很大（两段之间空 25px），但不在栏间空白上
    items.splice(4, 1, item('sequence', 54, 124, 10, 60), item('representation embedding representation', 139, 124, 10, 155));
    const blocks = await extractBlocks(fakePage(items));
    expect(blocks).toHaveLength(2);
  });
});
