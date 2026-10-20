import { describe, expect, it } from 'vitest';
import { parseArxivId, resolvePaper, normalizeVersion, withVersion, arxivRef } from '../src/core/ids';

describe('arXiv 标识解析', () => {
  it.each([
    ['1706.03762', '1706.03762', ''],
    ['1706.03762v5', '1706.03762', 'v5'],
    ['arXiv:2301.00001v2', '2301.00001', 'v2'],
    ['https://arxiv.org/abs/1706.03762v7', '1706.03762', 'v7'],
    ['https://arxiv.org/pdf/1706.03762.pdf', '1706.03762', ''],
    ['https://arxiv.org/pdf/1706.03762v1', '1706.03762', 'v1'],
    ['https://www.arxiv.org/html/2301.00001v3', '2301.00001', 'v3'],
    ['https://arxiv.org/abs/hep-th/9901001v2', 'hep-th/9901001', 'v2'],
  ])('%s → %s %s', async (input, id, v) => {
    const ref = await resolvePaper(input);
    expect(ref.kind).toBe('arxiv');
    expect(ref.arxivId).toBe(id);
    expect(ref.version).toBe(v);
  });

  it('同一篇论文的不同入口得到同一个 id（笔记跨入口对齐）', async () => {
    const a = await resolvePaper('https://arxiv.org/abs/1706.03762');
    const b = await resolvePaper('https://arxiv.org/pdf/1706.03762.pdf');
    expect(a.id).toBe(b.id);
    expect(a.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762');
  });

  it('版本不同则 PDF 链接不同，但 id 相同', async () => {
    const v1 = withVersion(await resolvePaper('1706.03762'), 'v1');
    expect(v1.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762v1');
    expect(v1.id).toBe(arxivRef('1706.03762', '').id);
  });

  it('拒绝非法输入', async () => {
    await expect(resolvePaper('')).rejects.toThrow();
    await expect(resolvePaper('javascript:alert(1)')).rejects.toThrow();
    await expect(resolvePaper('ftp://example.com/a.pdf')).rejects.toThrow();
    await expect(resolvePaper('https://arxiv.org/listing/new')).rejects.toThrow();
  });

  it('解析 parseArxivId 对非编号返回 null', () => {
    expect(parseArxivId('hello')).toBeNull();
  });
});

describe('其他来源', () => {
  it('OpenReview / ACL 生成稳定链接', async () => {
    const o = await resolvePaper('https://openreview.net/forum?id=abc-123');
    expect(o.pdfUrl).toBe('https://openreview.net/pdf?id=abc-123');
    const a = await resolvePaper('https://aclanthology.org/2023.acl-long.1.pdf');
    expect(a.pdfUrl).toBe('https://aclanthology.org/2023.acl-long.1.pdf');
  });

  it('任意 PDF 链接：去掉 hash 与跟踪参数后稳定哈希', async () => {
    const a = await resolvePaper('https://example.org/paper.pdf?utm_source=x#page=3');
    const b = await resolvePaper('https://example.org/paper.pdf');
    expect(a.id).toBe(b.id);
    expect(a.id.startsWith('url-')).toBe(true);
  });
});

describe('版本号', () => {
  it.each([
    ['2', 'v2'],
    ['v2', 'v2'],
    ['V10', 'v10'],
    ['', ''],
    ['latest', ''],
  ])('%j → %j', (i, o) => expect(normalizeVersion(i)).toBe(o));
  it('非法版本抛错', () => {
    expect(() => normalizeVersion('abc')).toThrow();
    expect(() => normalizeVersion('v1.2')).toThrow();
  });
});
