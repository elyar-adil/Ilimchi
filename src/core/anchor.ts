import type { Rect } from './types';

/**
 * 文本锚点：把「选中的文字」稳定地映射回页面文本中的位置。
 * 类似 W3C Web Annotation 的 TextQuoteSelector + TextPositionSelector：
 * 先靠 quote + 前后文精确定位；PDF 版本变化、文字有细微差异时用模糊匹配兜底。
 * 本模块是纯函数，不依赖 DOM，便于测试。
 */

export interface Selector {
  quote: string;
  prefix: string;
  suffix: string;
  /** 创建时在页面文本中的字符偏移，用于在重复文本中偏向原位置 */
  start: number;
}

export interface Match {
  /** 原始页面文本中的 [start, end) */
  start: number;
  end: number;
  /** 0..1，1 为精确匹配 */
  score: number;
}

const CONTEXT = 32;
const STRIP = /[\s­​‌‍﻿]/;

/** 去掉空白与不可见字符，并记录每个字符在原文中的下标。 */
export function squash(text: string): { s: string; map: number[] } {
  let s = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (STRIP.test(ch)) continue;
    s += ch;
    map.push(i);
  }
  return { s, map };
}

export function contextOf(text: string, start: number, end: number): { prefix: string; suffix: string } {
  return {
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Sørensen–Dice 系数（基于字符二元组），用于模糊匹配。 */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

export function locateQuote(pageText: string, sel: Selector, minFuzzy = 0.85): Match | null {
  const { s: S, map } = squash(pageText);
  const Q = squash(sel.quote).s;
  if (!Q || !S) return null;
  const P = squash(sel.prefix).s;
  const X = squash(sel.suffix).s;
  const approx = squash(pageText.slice(0, Math.min(sel.start, pageText.length))).s.length;

  const toMatch = (i: number, len: number, score: number): Match => ({
    start: map[i],
    end: map[Math.min(i + len, map.length) - 1] + 1,
    score,
  });

  const scoreAt = (i: number, len: number): number => {
    const before = S.slice(Math.max(0, i - P.length), i);
    const after = S.slice(i + len, i + len + X.length);
    const pctx = P ? commonSuffixLen(before, P) / P.length : 1;
    const sctx = X ? commonPrefixLen(after, X) / X.length : 1;
    const dist = Math.abs(i - approx) / Math.max(S.length, 1);
    return pctx * 0.45 + sctx * 0.45 + (1 - dist) * 0.1;
  };

  // 1) 精确匹配（区分大小写），多处命中时用上下文与原位置消歧
  let hits = allIndexes(S, Q);
  if (hits.length === 0) hits = allIndexes(S.toLowerCase(), Q.toLowerCase());
  if (hits.length > 0) {
    let best = hits[0];
    let bestScore = -1;
    for (const i of hits) {
      const sc = scoreAt(i, Q.length);
      if (sc > bestScore) {
        bestScore = sc;
        best = i;
      }
    }
    return toMatch(best, Q.length, 1);
  }

  // 2) 模糊匹配：滑动窗口比较二元组相似度（过短的引用不做模糊，容易误报）
  if (Q.length < 12) return null;
  const step = Math.max(1, Math.floor(Q.length / 25));
  let bestI = -1;
  let bestSim = 0;
  for (let i = 0; i + Q.length <= S.length; i += step) {
    const sim = dice(S.slice(i, i + Q.length), Q);
    if (sim > bestSim) {
      bestSim = sim;
      bestI = i;
    }
  }
  if (bestI < 0 || bestSim < minFuzzy - 0.1) return null;
  // 在最佳窗口附近精修起点与长度
  let refined = { i: bestI, len: Q.length, sim: bestSim };
  for (let di = -step; di <= step; di++) {
    for (const dl of [-2, -1, 0, 1, 2]) {
      const i = bestI + di;
      const len = Q.length + dl;
      if (i < 0 || len < 4 || i + len > S.length) continue;
      const sim = dice(S.slice(i, i + len), Q);
      if (sim > refined.sim) refined = { i, len, sim };
    }
  }
  if (refined.sim < minFuzzy) return null;
  return toMatch(refined.i, refined.len, refined.sim);
}

// ---------- 矩形处理 ----------

/** 同一行内的矩形合并，去掉被包含的碎片和异常矩形，减少存储体积并让高亮连续。 */
export function mergeLineRects(rects: Rect[]): Rect[] {
  const valid = rects.filter((r) => r.w > 0.0005 && r.h > 0.0005 && r.w <= 1.01 && r.h <= 0.5);
  if (valid.length === 0) return [];

  const heights = valid.map((r) => r.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const sane = valid.filter((r) => r.h <= median * 3);

  const sorted = [...sane].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Rect[][] = [];
  for (const r of sorted) {
    const cy = r.y + r.h / 2;
    const line = lines.find((l) => {
      const ref = l[0];
      return Math.abs(ref.y + ref.h / 2 - cy) < Math.min(ref.h, r.h) * 0.5;
    });
    if (line) line.push(r);
    else lines.push([r]);
  }

  const out: Rect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let cur = { ...line[0] };
    for (let i = 1; i < line.length; i++) {
      const r = line[i];
      const gap = r.x - (cur.x + cur.w);
      if (gap <= Math.max(cur.h, r.h) * 0.6) {
        const x2 = Math.max(cur.x + cur.w, r.x + r.w);
        const y1 = Math.min(cur.y, r.y);
        const y2 = Math.max(cur.y + cur.h, r.y + r.h);
        cur = { x: cur.x, y: y1, w: x2 - cur.x, h: y2 - y1 };
      } else {
        out.push(cur);
        cur = { ...r };
      }
    }
    out.push(cur);
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function pointInRects(rects: Rect[], x: number, y: number, pad = 0.002): boolean {
  return rects.some((r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad);
}

export function rectsTop(rects: Rect[]): number {
  return rects.length ? Math.min(...rects.map((r) => r.y)) : 0;
}
