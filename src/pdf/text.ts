import { mergeLineRects } from '../core/anchor';
import type { Rect } from '../core/types';

/**
 * 文本层 <-> 字符偏移 的互相映射。
 * 锚点只依赖「文本层所有文本节点按 DOM 顺序拼接」得到的字符串（raw），
 * 因此同一页在不同缩放、不同设备上得到的偏移完全一致。
 */

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/**
 * 选区的可读文本：文本层按行切成多个 span，直接拼接会丢失行尾空格（"small" + "fraction"）。
 * 这里在换行处补一个空格；连字符结尾的行直接相连。锚定比较会忽略空白，因此不影响定位。
 */
export function readableSlice(layer: HTMLElement, start: number, end: number): string {
  let acc = 0;
  let out = '';
  let prev: Text | null = null;
  for (const t of textNodes(layer)) {
    const len = t.data.length;
    const s = Math.max(start, acc);
    const e = Math.min(end, acc + len);
    if (e > s) {
      const piece = t.data.slice(s - acc, e - acc);
      if (prev && out && !/\s$/.test(out) && !/^\s/.test(piece) && !out.endsWith('-') && breaksLine(prev, t)) out += ' ';
      out += piece;
      prev = t;
    }
    acc += len;
    if (acc >= end) break;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function breaksLine(a: Text, b: Text): boolean {
  const sa = a.parentElement;
  const sb = b.parentElement;
  if (!sa || !sb || sa === sb) return false;
  for (let n = sa.nextSibling; n && n !== sb; n = n.nextSibling) if (n.nodeName === 'BR') return true;
  const ra = sa.getBoundingClientRect();
  const rb = sb.getBoundingClientRect();
  return rb.top > ra.top + ra.height * 0.5;
}

export function rawText(layer: HTMLElement): string {
  return textNodes(layer)
    .map((t) => t.data)
    .join('');
}

/** 把 DOM 中的 (node, offset) 边界转换为 raw 字符偏移。 */
export function rawOffsetOf(layer: HTMLElement, node: Node, offset: number): number {
  let acc = 0;
  for (const t of textNodes(layer)) {
    if (t === node) return acc + offset;
    if (node.nodeType !== Node.TEXT_NODE) {
      // 边界落在元素上：offset 指向第 offset 个子节点之前
      const child = node.childNodes[offset];
      if (child && (child === t || child.contains(t))) return acc;
    }
    if (node.nodeType !== Node.TEXT_NODE && !node.contains(t) && node !== layer) {
      // 边界在其它元素中，忽略
    }
    acc += t.data.length;
  }
  return acc;
}

/** 视口坐标 → raw 字符偏移（用于拖动高亮端点）；不在文本层内时返回 null。 */
export function rawOffsetAtPoint(layer: HTMLElement, x: number, y: number): number | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let off = 0;
  const cp = d.caretPositionFromPoint?.(x, y);
  if (cp) {
    node = cp.offsetNode;
    off = cp.offset;
  } else {
    const r = document.caretRangeFromPoint?.(x, y);
    if (r) {
      node = r.startContainer;
      off = r.startOffset;
    }
  }
  if (!node || !layer.contains(node)) return null;
  return rawOffsetOf(layer, node, off);
}

/** raw 偏移区间 [start, end) → 相对页面的归一化矩形。 */
export function rectsForOffsets(layer: HTMLElement, pageEl: HTMLElement, start: number, end: number): Rect[] {
  const pb = pageEl.getBoundingClientRect();
  const W = pb.width;
  const H = pb.height;
  if (!W || !H) return [];
  const out: Rect[] = [];
  let acc = 0;
  for (const t of textNodes(layer)) {
    const s = acc;
    const e = acc + t.data.length;
    acc = e;
    const a = Math.max(start, s);
    const b = Math.min(end, e);
    if (a >= b) continue;
    const range = document.createRange();
    range.setStart(t, a - s);
    range.setEnd(t, b - s);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ x: (r.left - pb.left) / W, y: (r.top - pb.top) / H, w: r.width / W, h: r.height / H });
    }
  }
  return mergeLineRects(out);
}

export interface PendingSelection {
  page: number;
  pageEl: HTMLElement;
  layer: HTMLElement;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  rects: Rect[];
  anchorTop: number;
  anchorLeft: number;
}

const CTX = 40;

/** 把当前浏览器选区转换为锚点信息；选区跨页时只取起始页部分。 */
export function selectionToPending(sel: Selection): PendingSelection | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startEl = elementOf(range.startContainer);
  const layer = startEl?.closest('.textLayer') as HTMLElement | null;
  const pageEl = layer?.closest('[data-page]') as HTMLElement | null;
  if (!layer || !pageEl) return null;

  const raw = rawText(layer);
  const start = rawOffsetOf(layer, range.startContainer, range.startOffset);
  const endInLayer = layer.contains(range.endContainer);
  const end = endInLayer ? rawOffsetOf(layer, range.endContainer, range.endOffset) : raw.length;
  if (end <= start) return null;

  const quote = readableSlice(layer, start, end);
  if (quote === '') return null;
  const rect = range.getBoundingClientRect();
  return {
    page: Number(pageEl.dataset.page),
    pageEl,
    layer,
    start,
    end,
    quote,
    prefix: raw.slice(Math.max(0, start - CTX), start),
    suffix: raw.slice(end, end + CTX),
    rects: rectsForOffsets(layer, pageEl, start, end),
    anchorTop: rect.top,
    anchorLeft: rect.left + rect.width / 2,
  };
}

function elementOf(n: Node): Element | null {
  return n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
}
