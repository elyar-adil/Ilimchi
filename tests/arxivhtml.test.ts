// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitize } from '../src/core/arxivhtml';

describe('arXiv HTML 净化', () => {
  const body = 'Lorem ipsum dolor sit amet. '.repeat(30);
  const page = `<html><head><script>alert(1)</script></head><body><nav>menu</nav>
    <article class="ltx_document"><h1 class="ltx_title">T</h1><p onclick="x()" style="color:red">${body}</p>
    <img src="x1.png"><a href="javascript:alert(1)">bad</a><a href="#S1">ok</a><a href="/abs/1234">ext</a>
    <math><mi>x</mi><annotation encoding="application/x-tex">x</annotation></math><script>bad()</script></article>
    <footer class="ltx_page_footer">f</footer></body></html>`;
  it('只保留正文，去掉脚本、事件与危险链接，图片改为绝对地址', () => {
    const out = sanitize(page, 'https://arxiv.org/html/2602.07000v1/')!;
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('style=');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('annotation');
    expect(out).toContain('src="https://arxiv.org/html/2602.07000v1/x1.png"');
    expect(out).toContain('href="#S1"');
    expect(out).toContain('href="https://arxiv.org/abs/1234"');
    expect(out).not.toContain('menu');
  });
  it('没有正文（论文没有 HTML 版）时返回 null', () => {
    expect(sanitize('<html><body><p>HTML is not available for the source.</p></body></html>', 'https://arxiv.org/html/x/')).toBeNull();
  });
});
