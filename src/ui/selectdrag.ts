import { positionForOffset, textNodes } from '../pdf/text';

/**
 * WebKit 上的鼠标拖选。
 *
 * 文字层的 span 都是绝对定位，彼此没有 DOM 上的几何关系。鼠标经过空白处（行间、页边、图片）时，
 * WebKit 原生命中测试找不到文字，会把选区终点落到文字层末尾，于是“把下面全选上”。
 * 这里改用几何命中：把指针位置映射到最近一行、再映射到该行里最近的字符，
 * 然后把结果写回原生 Selection，复制、高亮、批注条等下游逻辑都不用改。
 * 仅在 WebKit 的鼠标左键单击 / 三击时接管；双击（选词）仍走原生。
 * 三击：原生会从点击处一路选到文字层末尾（绝对定位的 span 没有“段落”边界），
 * 这里改为只选中被点击的那一段文字（与 Blink 的行为一致）。
 */

interface Item {
  node: Text;
  start: number;
  len: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface Line {
  top: number;
  bottom: number;
  items: Item[];
}

function buildLines(layer: HTMLElement): { lines: Line[]; total: number } {
  const items: Item[] = [];
  let acc = 0;
  for (const t of textNodes(layer)) {
    const len = t.data.length;
    const el = t.parentElement;
    if (el && len > 0 && /\S/.test(t.data)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) items.push({ node: t, start: acc, len, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    acc += len;
  }
  const sorted = [...items].sort((a, b) => a.top + a.bottom - (b.top + b.bottom));
  const lines: Line[] = [];
  for (const it of sorted) {
    const cy = (it.top + it.bottom) / 2;
    const h = it.bottom - it.top;
    const line = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - cy) < Math.min(h, l.bottom - l.top) * 0.5);
    if (line) {
      line.items.push(it);
      line.top = Math.min(line.top, it.top);
      line.bottom = Math.max(line.bottom, it.bottom);
    } else lines.push({ top: it.top, bottom: it.bottom, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.left - b.left);
  lines.sort((a, b) => a.top + a.bottom - (b.top + b.bottom));
  return { lines, total: acc };
}

/** 文本节点内与横坐标 x 最接近的字符边界。 */
function charAt(item: Item, x: number): number {
  const range = document.createRange();
  const edge = (k: number): number => {
    range.setStart(item.node, 0);
    range.setEnd(item.node, k);
    const r = range.getBoundingClientRect();
    return k === 0 ? item.left : r.right;
  };
  let lo = 0;
  let hi = item.len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edge(mid) < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && x - edge(lo - 1) < edge(lo) - x) lo -= 1;
  return item.start + lo;
}

interface Hit {
  offset: number;
  /** 指针到最近一行的竖直距离（像素），用于判断是否点在空白处 */
  dy: number;
  lineHeight: number;
}

function offsetAt(model: { lines: Line[]; total: number }, x: number, y: number): Hit | null {
  const { lines, total } = model;
  if (lines.length === 0) return null;
  let best = lines[0];
  let bestD = Infinity;
  for (const l of lines) {
    const d = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0;
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  const lineHeight = best.bottom - best.top;
  const first = lines[0];
  const last = lines[lines.length - 1];
  // 在整页文字之上 / 之下：夹到文字层的起点 / 终点
  if (y < first.top) return { offset: first.items[0].start, dy: first.top - y, lineHeight };
  if (y > last.bottom) {
    const li = last.items[last.items.length - 1];
    return { offset: Math.min(total, li.start + li.len), dy: y - last.bottom, lineHeight };
  }
  const items = best.items;
  if (x <= items[0].left) return { offset: items[0].start, dy: bestD, lineHeight };
  const tail = items[items.length - 1];
  if (x >= tail.right) return { offset: tail.start + tail.len, dy: bestD, lineHeight };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (x >= it.left && x <= it.right) return { offset: charAt(it, x), dy: bestD, lineHeight };
    const next = items[i + 1];
    if (next && x > it.right && x < next.left) {
      // 两段文字之间的空隙：取更近的一侧
      return { offset: x - it.right < next.left - x ? it.start + it.len : next.start, dy: bestD, lineHeight };
    }
  }
  return null;
}

let installed = false;

export function installPointerSelection(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('mousedown', onDown, true);
}

function onDown(e: MouseEvent): void {
  if (e.button !== 0 || e.detail === 2 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  const pageEl = target?.closest<HTMLElement>('.pdf-page');
  const reader = target?.closest<HTMLElement>('.reader');
  if (!pageEl || !reader || reader.dataset.tool !== 'select') return;
  // 手柄、删除钮、文字框、触摸选区把手等自带交互的控件不接管
  if (target?.closest('.hl-ctl, .tbox, button, textarea, input, [data-touch-selection-handle]')) return;
  const layer = pageEl.querySelector<HTMLElement>(':scope > .textLayer');
  if (!layer) return;

  const model = buildLines(layer);
  const hit = offsetAt(model, e.clientX, e.clientY);
  e.preventDefault();
  const sel = document.getSelection();
  sel?.removeAllRanges();
  if (e.detail >= 3) {
    if (hit && hit.dy <= hit.lineHeight * 1.5) {
      const it = model.lines.flatMap((l) => l.items).find((i) => hit.offset >= i.start && hit.offset <= i.start + i.len);
      if (it) sel?.setBaseAndExtent(it.node, 0, it.node, it.len);
    }
    return;
  }
  // 离任何文字都太远（大块空白）：只清除选区，不开始拖选
  if (!hit || hit.dy > hit.lineHeight * 1.5) return;

  const anchor = hit.offset;
  const scroller = pageEl.closest<HTMLElement>('.viewer');
  let lx = e.clientX;
  let ly = e.clientY;
  let moved = false;
  let raf = 0;
  let live = buildLines(layer);
  let dirty = false;
  const onScroll = () => (dirty = true);
  scroller?.addEventListener('scroll', onScroll);

  const apply = () => {
    if (dirty) {
      live = buildLines(layer);
      dirty = false;
    }
    const h = offsetAt(live, lx, ly);
    if (!h) return;
    const a = positionForOffset(layer, anchor);
    const f = positionForOffset(layer, h.offset);
    if (!a || !f || !sel) return;
    if (a.node === f.node && a.offset === f.offset) {
      sel.removeAllRanges();
      return;
    }
    sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
  };
  // 接近滚动容器上下边缘时自动滚动，并在滚动后重算几何
  const tick = () => {
    raf = 0;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const zone = 40;
    let dy = 0;
    if (ly < box.top + zone) dy = -Math.ceil((box.top + zone - ly) / 4);
    else if (ly > box.bottom - zone) dy = Math.ceil((ly - (box.bottom - zone)) / 4);
    if (dy !== 0) {
      scroller.scrollTop += dy;
      dirty = true;
      apply();
      raf = requestAnimationFrame(tick);
    }
  };
  const onMove = (ev: MouseEvent) => {
    lx = ev.clientX;
    ly = ev.clientY;
    if (!moved && Math.abs(lx - e.clientX) + Math.abs(ly - e.clientY) < 3) return;
    moved = true;
    apply();
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const end = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', end, true);
    window.removeEventListener('blur', end);
    scroller?.removeEventListener('scroll', onScroll);
    if (raf) cancelAnimationFrame(raf);
  };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', end, true);
  window.addEventListener('blur', end);
}
