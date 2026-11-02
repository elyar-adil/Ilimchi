import { describe, expect, it } from 'vitest';
import { guessMeta, guessTitle } from '../src/core/titleguess';

describe('guessTitle', () => {
  it('取页面上部字号最大的文字作为标题', () => {
    const items = [
      { str: 'arXiv:1706.03762v5 [cs.CL]', transform: [1, 0, 0, 9, 40, 780], height: 9 },
      { str: 'Attention', transform: [1, 0, 0, 20, 150, 700], height: 20 },
      { str: 'Is All You Need', transform: [1, 0, 0, 20, 200, 672], height: 20 },
      { str: 'Ashish Vaswani', transform: [1, 0, 0, 10, 200, 600], height: 10 },
      { str: 'Abstract', transform: [1, 0, 0, 10, 60, 500], height: 10 },
    ];
    expect(guessTitle(items, 842)).toBe('Attention Is All You Need');
  });

  it('侧边竖排水印不会被当作标题', () => {
    const items = [
      { str: 'arXiv:2301.00001v1', transform: [0, 1, -1, 30, 10, 300], height: 30 },
      { str: 'A Real Title Of A Paper', transform: [1, 0, 0, 16, 120, 700], height: 16 },
    ];
    expect(guessTitle(items, 842)).toBe('A Real Title Of A Paper');
  });

  it('找不到合理标题时返回空串', () => {
    expect(guessTitle([], 800)).toBe('');
    expect(guessTitle([{ str: 'x', transform: [1, 0, 0, 10, 0, 700], height: 10 }], 800)).toBe('');
  });
});

describe('guessMeta 作者', () => {
  const H = 842;
  const title = [
    { str: 'Attention', transform: [1, 0, 0, 20, 150, 700], height: 20 },
    { str: 'Is All You Need', transform: [1, 0, 0, 20, 200, 672], height: 20 },
  ];

  it('取标题下方、摘要之前的作者行并去掉脚注符号', () => {
    const items = [
      ...title,
      { str: 'Ashish Vaswani∗', transform: [1, 0, 0, 11, 180, 640], height: 11 },
      { str: 'Noam Shazeer∗', transform: [1, 0, 0, 11, 330, 640], height: 11 },
      { str: 'University of Toronto', transform: [1, 0, 0, 9, 180, 620], height: 9 },
      { str: 'Abstract', transform: [1, 0, 0, 10, 60, 580], height: 10 },
    ];
    const m = guessMeta(items, H);
    expect(m.title).toBe('Attention Is All You Need');
    expect(m.authors).toBe('Ashish Vaswani, Noam Shazeer');
  });

  it('作者跨两行时合并，并去掉上标数字', () => {
    const items = [
      ...title,
      { str: 'Alice Smith1,', transform: [1, 0, 0, 11, 180, 640], height: 11 },
      { str: 'Bob Lee2', transform: [1, 0, 0, 11, 180, 626], height: 11 },
      { str: 'Abstract', transform: [1, 0, 0, 10, 60, 580], height: 10 },
    ];
    expect(guessMeta(items, H).authors).toBe('Alice Smith, Bob Lee');
  });

  it('没有作者区（直接进入摘要）时返回空串', () => {
    const items = [...title, { str: 'Abstract', transform: [1, 0, 0, 10, 60, 640], height: 10 }];
    expect(guessMeta(items, H).authors).toBe('');
  });
});

describe('作者上标编号', () => {
  const H = 842;
  const title = [{ str: 'A Long Enough Paper Title', transform: [1, 0, 0, 18, 150, 700], height: 18 }];

  it('上标为独立的小字号文字时不并入名字', () => {
    const items = [
      ...title,
      { str: 'Alice Smith', transform: [1, 0, 0, 11, 150, 660], height: 11 },
      { str: '1,2', transform: [1, 0, 0, 7, 212, 664], height: 7 },
      { str: 'Bob Lee', transform: [1, 0, 0, 11, 240, 660], height: 11 },
      { str: '2∗', transform: [1, 0, 0, 7, 282, 664], height: 7 },
      { str: '1', transform: [1, 0, 0, 7, 150, 646], height: 7 },
      { str: 'Tsinghua University', transform: [1, 0, 0, 10, 156, 642], height: 10 },
      { str: 'Abstract', transform: [1, 0, 0, 12, 60, 600], height: 12 },
    ];
    expect(guessMeta(items, H).authors).toBe('Alice Smith, Bob Lee');
  });

  it('清理粘连或分开的编号与符号', async () => {
    const { cleanAuthors } = await import('../src/core/titleguess');
    expect(cleanAuthors('Alice Smith1,2, Bob Lee2∗, Carol Wang1')).toBe('Alice Smith, Bob Lee, Carol Wang');
    expect(cleanAuthors('Alice Smith 1,2 Bob Lee 3† and Carol Wang 1')).toBe('Alice Smith, Bob Lee, Carol Wang');
    expect(cleanAuthors('Alice Smith a,b, Bob Lee b')).toBe('Alice Smith, Bob Lee');
    expect(cleanAuthors('Yann LeCun, J. R. R. Tolkien')).toBe('Yann LeCun, J. R. R. Tolkien');
  });
});
