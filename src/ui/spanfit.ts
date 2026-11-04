import type { PDFPage } from '../pdf/engine';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

/**
 * 校正文字层每个 span 的宽度。
 *
 * pdf.js 先用 canvas.measureText 量出文字宽度，再给 span 设 scaleX(目标宽度 / 量得宽度)，
 * 前提是 DOM 排版出的宽度与 canvas 量得的一致。WebKit 的 DOM 与 canvas 在字距、连字等细节上不一致，
 * 于是 span 比 PDF 里的真实文字宽几个百分点：选区右边超出文字，行内越靠右字符对应越偏。
 *
 * 这里直接以 PDF 给出的文字宽度为准，用 DOM 里实际量得的自然宽度重新计算 scaleX。
 * 只在 WebKit 上调用；Blink 的两者一致，不需要这一步，也没有额外开销。
 */

const itemCache = new WeakMap<PDFPage, Promise<{ items: TextItem[]; vertical: boolean[] }>>();

function loadItems(page: PDFPage) {
  let p = itemCache.get(page);
  if (!p) {
    p = page.getTextContent().then((c) => {
      const items = c.items.filter((i): i is TextItem => 'str' in i);
      return { items, vertical: items.map((i) => !!c.styles[i.fontName]?.vertical) };
    });
    itemCache.set(page, p);
  }
  return p;
}

export async function fitSpans(page: PDFPage, cssScale: number, divs: HTMLElement[], pageEl: HTMLElement): Promise<void> {
  const { items, vertical } = await loadItems(page);
  if (items.length !== divs.length) return;

  // 1) 去掉 scaleX，只保留其余变换（旋转等），让 span 以自然宽度排版
  const jobs: { div: HTMLElement; target: number; rest: string }[] = [];
  for (let i = 0; i < divs.length; i++) {
    const div = divs[i];
    const it = items[i];
    if (!div.isConnected || !it.str || vertical[i]) continue;
    const m = /^scaleX\([^)]*\)\s*(.*)$/.exec(div.style.transform);
    if (!m) continue;
    jobs.push({ div, target: it.width * cssScale, rest: m[1] });
    div.style.transform = m[1];
  }
  if (jobs.length === 0) return;

  // 2) 统一读取（只触发一次布局）。页面可能处于缩放手势的 CSS 变换中，用 offsetWidth 校准比例。
  const box = pageEl.getBoundingClientRect();
  const k = pageEl.offsetWidth > 0 ? box.width / pageEl.offsetWidth : 1;
  const widths = jobs.map((j) => j.div.getBoundingClientRect().width / (k || 1));

  // 3) 统一写回
  jobs.forEach((j, i) => {
    const w = widths[i];
    j.div.style.transform = w > 0 ? `scaleX(${j.target / w}) ${j.rest}`.trim() : j.rest;
  });
}
