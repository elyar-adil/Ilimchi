import { mergeLineRects } from './anchor';
import type { Rect } from './types';
import type { PageLayout, LayoutBlock } from '../pdf/blocks';
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
