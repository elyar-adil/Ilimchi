import type { PDFDoc } from './engine';
import { extractLayout, type PageLayout } from './blocks';

/** 每个已打开的 PDF 的版面分析结果（按页缓存，重排视图与译文高亮共用） */
const cache = new WeakMap<PDFDoc, Map<number, Promise<PageLayout>>>();

export function pageLayout(pdf: PDFDoc, n: number): Promise<PageLayout> {
  let m = cache.get(pdf);
  if (!m) {
    m = new Map();
    cache.set(pdf, m);
  }
  let p = m.get(n);
  if (!p) {
    p = pdf.getPage(n).then(extractLayout);
    m.set(n, p);
    p.catch(() => m!.delete(n));
  }
  return p;
}
