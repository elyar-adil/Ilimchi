import { mergeLineRects } from './anchor';
import type { Rect } from './types';
import { CAPTION, type PageLayout, type LayoutBlock } from '../pdf/blocks';
import type { TransBlock } from './translate';

/**
 * 重排视图与页面原始文本之间的映射（纯函数，便于测试）。
 * 原始文本 = 文本层所有文字按顺序拼接；高亮的锚点（start / quote）都基于它。
 */

/** 块文字中落在原始文本区间 [s, e) 内的字符区间（可能有多段） */
export function rangesInBlock(block: { map: number[] }, s: number, e: number): [number, number][] {
  const out: [number, number][] = [];
  let cur: [number, number] | null = null;
  block.map.forEach((off, i) => {
    // 补出来的空格（-1）跟随前一个字符的归属
    const inside = off >= 0 ? off >= s && off < e : !!cur;
    if (inside) {
      if (cur && cur[1] === i) cur[1] = i + 1;
      else {
        cur = [i, i + 1];
        out.push(cur);
      }
    } else cur = null;
  });
  // 去掉区间末尾的补空格
  for (const r of out) while (r[1] > r[0] && block.map[r[1] - 1] < 0) r[1]--;
  return out.filter((r) => r[1] > r[0]);
}

/** 块内字符区间 → 原始文本区间 */
export function rawRangeOf(block: { map: number[] }, cs: number, ce: number): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let i = Math.max(0, cs); i < Math.min(ce, block.map.length); i++) {
    const off = block.map[i];
    if (off < 0) continue;
    if (start < 0 || off < start) start = off;
    if (off + 1 > end) end = off + 1;
  }
  return start < 0 ? null : { start, end };
}

/** 原始文本区间 → 页面比例坐标的矩形（按字符数在文字片段内插值，精度足以显示高亮） */
export function rectsForRaw(layout: PageLayout, s: number, e: number): Rect[] {
  const rects: Rect[] = [];
  for (const p of layout.pieces) {
    const a = Math.max(s, p.off);
    const b = Math.min(e, p.off + p.len);
    if (a >= b || p.len === 0) continue;
    const w = p.x1 - p.x0;
    rects.push({ x: p.x0 + (w * (a - p.off)) / p.len, y: p.top, w: (w * (b - a)) / p.len, h: p.bottom - p.top });
  }
  return mergeLineRects(rects);
}

/** 译文块对应的版面块序号：新缓存记录了 i，旧缓存按位置匹配 */
export function transByBlock(layout: PageLayout, trans: TransBlock[] | null | undefined): Map<number, { tb: TransBlock; k: number }> {
  const out = new Map<number, { tb: TransBlock; k: number }>();
  if (!trans) return out;
  trans.forEach((tb, k) => {
    let i = tb.i;
    if (i === undefined || !layout.blocks[i] || !samePlace(layout.blocks[i], tb)) {
      i = layout.blocks.findIndex((b) => samePlace(b, tb));
    }
    if (i >= 0) out.set(i, { tb, k });
  });
  return out;
}

function samePlace(b: LayoutBlock, tb: TransBlock): boolean {
  return Math.abs(b.x - tb.x) < 0.5 && Math.abs(b.y - tb.y) < 0.5 && Math.abs(b.w - tb.w) < 1;
}

/**
 * 在阅读顺序的文字中查找引用（忽略空白与大小写）。
 * PDF 内容流的顺序可能与视觉顺序不同（例如表格穿插在段落中间），这时在原始文本里找不到连续的引用，
 * 但在按阅读顺序拼好的块文字中可以找到。返回各块内的字符区间。
 */
export function locateInBlocks(layout: PageLayout, quote: string): { i: number; s: number; e: number }[] | null {
  const q = quote.replace(/\s+/g, '').toLowerCase();
  if (q.length < 2) return null;
  const chars: { i: number; c: number }[] = [];
  let t = '';
  const order = layout.flow.filter((f) => f.kind === 'block').map((f) => (f as { i: number }).i);
  for (const b of layout.blocks) if (!order.includes(b.i)) order.push(b.i);
  for (const i of order) {
    // 跳过图注、图表与页眉：段落被浮动的图表打断时，前后两部分在这里能接上
    const blk = layout.blocks[i];
    if (blk.role === 'figure' || blk.role === 'inside' || blk.role === 'skip' || CAPTION.test(blk.text.trim())) continue;
    const text = blk.text;
    for (let c = 0; c < text.length; c++) {
      if (/\s/.test(text[c])) continue;
      t += text[c].toLowerCase();
      chars.push({ i, c });
    }
  }
  const at = t.indexOf(q);
  if (at < 0) return null;
  const out: { i: number; s: number; e: number }[] = [];
  for (let k = at; k < at + q.length; k++) {
    const { i, c } = chars[k];
    const last = out[out.length - 1];
    if (last && last.i === i) last.e = c + 1;
    else out.push({ i, s: c, e: c + 1 });
  }
  return out;
}

/** 块内字符区间 → 原始文本中的若干连续区间 */
export function rawRunsOf(layout: PageLayout, segs: { i: number; s: number; e: number }[]): [number, number][] {
  const offs = new Set<number>();
  for (const g of segs) for (let c = g.s; c < g.e; c++) {
    const o = layout.blocks[g.i].map[c];
    if (o >= 0) offs.add(o);
  }
  const sorted = [...offs].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const o of sorted) {
    const last = runs[runs.length - 1];
    if (last && o === last[1]) last[1] = o + 1;
    else runs.push([o, o + 1]);
  }
  return runs;
}
