import { describe, expect, it } from 'vitest';
import { contextOf, dice, locateQuote, mergeLineRects, squash } from '../src/core/anchor';

const PAGE =
  'Attention is all you need. We propose the Transformer, a model architecture eschewing recurrence. ' +
  'The Transformer achieves state of the art. Attention is all you need, again.';

describe('locateQuote 文本锚点', () => {
  it('精确找到选区', () => {
    const quote = 'a model architecture eschewing recurrence';
    const start = PAGE.indexOf(quote);
    const ctx = contextOf(PAGE, start, start + quote.length);
    const m = locateQuote(PAGE, { quote, ...ctx, start });
    expect(m).not.toBeNull();
    expect(PAGE.slice(m!.start, m!.end)).toBe(quote);
    expect(m!.score).toBe(1);
  });

  it('重复文本时依靠上下文消歧', () => {
    const quote = 'Attention is all you need';
    const second = PAGE.lastIndexOf(quote);
    const ctx = contextOf(PAGE, second, second + quote.length);
    const m = locateQuote(PAGE, { quote, ...ctx, start: 0 });
    expect(m!.start).toBe(second);
  });

  it('忽略空白差异（不同 PDF 版本换行/空格不同）', () => {
    const page = 'the  Transformer\nachieves\tstate of the art';
    const m = locateQuote(page, { quote: 'Transformer achieves state', prefix: '', suffix: '', start: 0 });
    expect(m).not.toBeNull();
    expect(page.slice(m!.start, m!.end).replace(/\s/g, '')).toBe('Transformerachievesstate');
  });

  it('模糊匹配：文字有少量改动（如 OCR/版本修订）仍可定位', () => {
    const quote = 'The Transformer achieves state of the art results';
    const page = 'Intro. The Transformer achieves state-of-the-art results on tasks.';
    const m = locateQuote(page, { quote, prefix: '', suffix: '', start: 0 });
    expect(m).not.toBeNull();
    expect(m!.score).toBeGreaterThanOrEqual(0.85);
  });

  it('完全不相关的文字不会误匹配', () => {
    const m = locateQuote(PAGE, { quote: 'quantum chromodynamics lattice gauge theory', prefix: '', suffix: '', start: 0 });
    expect(m).toBeNull();
  });

  it('短引用不做模糊匹配（避免误报）', () => {
    expect(locateQuote(PAGE, { quote: 'Transfrmer', prefix: '', suffix: '', start: 0 })).toBeNull();
  });
});

describe('辅助函数', () => {
  it('squash 去掉空白并保留原始下标', () => {
    const s = squash('a b­ c');
    expect(s.s).toBe('abc');
    expect(s.map).toEqual([0, 2, 5]);
  });
  it('dice 相似度边界', () => {
    expect(dice('abc', 'abc')).toBe(1);
    expect(dice('abc', 'xyz')).toBe(0);
  });
});

describe('mergeLineRects', () => {
  it('同一行的相邻矩形合并', () => {
    const out = mergeLineRects([
      { x: 0.1, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.201, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.302, y: 0.2, w: 0.1, h: 0.02 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBeCloseTo(0.1);
    expect(out[0].w).toBeCloseTo(0.302 + 0.1 - 0.1);
  });
  it('不同行保持分开', () => {
    const out = mergeLineRects([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.02 },
      { x: 0.1, y: 0.25, w: 0.3, h: 0.02 },
    ]);
    expect(out).toHaveLength(2);
  });
  it('丢弃退化与异常矩形', () => {
    expect(mergeLineRects([{ x: 0, y: 0, w: 0, h: 0.02 }, { x: 0, y: 0, w: 0.2, h: 0.9 }])).toEqual([]);
  });
});
