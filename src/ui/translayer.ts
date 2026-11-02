import type { TransBlock } from '../core/translate';

/**
 * 把译文直接绘制到页面位图上，替换原文：
 * 1. 取原文块周围的背景色（纸面色，支持底色与深色模式）覆盖原文；
 * 2. 在原位置用原字号排入译文，超出块高度时逐步缩小字号；
 * 3. 之后的夜间模式处理（墨色等）会一并作用于译文，保持一致。
 */

const FONT_STACK = '"Source Serif 4", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", serif';
const PAD = 1;
/** 不能出现在行首的标点（避头尾） */
const NO_LINE_START = /^[，。、；：！？）》」』”’,.;:!?)\]%]/;
/** 断行单位：中日韩单字、全角标点各自成一段；西文单词连同其后的空格为一段 */
const TOKEN = /[぀-ヿ㐀-鿿가-힯豈-﫿]|[　-〿＀-￯]|[^\s぀-ヿ㐀-鿿가-힯豈-﫿　-〿＀-￯]+\s*|\s+/g;
/** 不能出现在行尾的标点（避尾）：与后一段连在一起 */
const NO_LINE_END = /[（《「『“‘(\[]$/;
/** 两端对齐时每个间隙最多加宽的量（字号的倍数），超过则该行改为左对齐，避免字距过于稀疏 */
const MAX_STRETCH = 0.35;
/** 每个间隙最多压缩的量：下一段只差一点放不下时，略微挤紧本行而不是整段换到下一行 */
const MAX_SQUEEZE = 0.08;

/** 译文中需要显示高亮的区间（对应译文块在 blocks 数组中的序号 k） */
export interface TransMarkSpan {
  id: string;
  ts: number;
  te: number;
}

/**
 * k = 页面缩放 × 设备像素比（块坐标为 scale=1 的 CSS 像素）。
 * marks：译文块序号 → 需要高亮的译文区间；返回每个高亮在画布上的矩形（画布像素）。
 */
export function drawTranslation(
  ctx: CanvasRenderingContext2D,
  blocks: TransBlock[],
  k: number,
  marks?: Map<number, TransMarkSpan[]>,
): Map<string, { x: number; y: number; w: number; h: number }[]> {
  const hits = new Map<string, { x: number; y: number; w: number; h: number }[]>();
  blocks.forEach((b, bi) => {
    const x = Math.floor((b.x - PAD) * k);
    const y = Math.floor((b.y - PAD) * k);
    const w = Math.ceil((b.w + PAD * 2) * k);
    const h = Math.ceil((b.h + PAD * 2) * k);
    if (w <= 0 || h <= 0) return;
    const bg = backgroundOf(ctx, x, y, w, h);
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);

    const fg = luminance(bg) < 0.5 ? '#e4e7ea' : '#1e2226';
    const maxW = b.w * k;
    const maxH = b.h * k;
    const startSize = b.size * k;
    // 沿用原文行距：字号缩小时行距按比例缩小，但不小于字号的 1.15 倍
    const pitch = (b.lh && b.lh > b.size ? b.lh : b.size * 1.25) * k;
    const { toks, offs } = tokenize(b.t);
    let size = startSize;
    let lines: Line[] = [];
    let lh = pitch;
    for (; size >= startSize * 0.55; size -= 0.5) {
      ctx.font = `${size}px ${FONT_STACK}`;
      lines = wrap(ctx, toks, maxW, size);
      lh = Math.max(pitch * (size / startSize), size * 1.15);
      if ((lines.length - 1) * lh + size <= maxH + 1) break;
    }
    ctx.font = `${size}px ${FONT_STACK}`;
    ctx.fillStyle = fg;
    ctx.textBaseline = 'top';
    // 旧缓存没有对齐信息：多行按两端对齐（论文正文最常见）
    const align = b.al ?? (b.h > b.size * 2 ? 'justify' : 'left');
    const spans = marks?.get(bi) ?? [];
    lines.forEach((line, i) => {
      const ly = b.y * k + i * lh;
      const xs = drawLine(ctx, line, toks, b.x * k, ly, maxW, size, align, i === lines.length - 1);
      // 高亮：按字符位置求出本行内的横向范围
      for (const m of spans) {
        let x0 = Infinity;
        let x1 = -Infinity;
        line.idx.forEach((ti, j) => {
          const tok = toks[ti].trimEnd();
          const o = offs[ti];
          const a = Math.max(m.ts, o);
          const e = Math.min(m.te, o + tok.length);
          if (a >= e) return;
          const left = xs[j] + ctx.measureText(tok.slice(0, a - o)).width;
          const right = xs[j] + ctx.measureText(tok.slice(0, e - o)).width;
          x0 = Math.min(x0, left);
          x1 = Math.max(x1, right);
        });
        if (x1 > x0) {
          const list = hits.get(m.id) ?? [];
          list.push({ x: x0, y: ly - size * 0.12, w: x1 - x0, h: size * 1.24 });
          hits.set(m.id, list);
        }
      }
    });
  });
  return hits;
}

interface Line {
  /** 本行的断行单位在 toks 中的序号 */
  idx: number[];
  widths: number[];
  /** 不含行尾空白的宽度 */
  width: number;
}

/** 画一行，返回每个断行单位的起始横坐标 */
function drawLine(ctx: CanvasRenderingContext2D, line: Line, toks: string[], x0: number, y: number, maxW: number, size: number, align: string, last: boolean): number[] {
  const { widths } = line;
  const tokens = line.idx.map((i) => toks[i]);
  const xs: number[] = [];
  // 行尾空白不参与排版
  let n = tokens.length;
  while (n > 0 && !tokens[n - 1].trim()) n--;
  if (n === 0) return xs;
  const extra = maxW - line.width;
  const gaps = n - 1;
  // 挤紧过的行（extra < 0）无论对齐方式都要按间隙分配，否则会超出右边界
  if (gaps > 0 && (extra < 0 || (align === 'justify' && !last && extra / gaps <= size * MAX_STRETCH))) {
    const add = extra / gaps;
    let x = x0;
    for (let i = 0; i < n; i++) {
      xs.push(x);
      ctx.fillText(tokens[i].trimEnd(), x, y);
      x += widths[i] + add;
    }
    return xs;
  }
  const dx = align === 'center' ? Math.max(0, extra / 2) : 0;
  let x = x0 + dx;
  for (let i = 0; i < n; i++) {
    xs.push(x);
    x += widths[i];
  }
  ctx.fillText(tokens.slice(0, n).join('').trimEnd(), x0 + dx, y, maxW * 1.02);
  return xs;
}

/** 切分断行单位，并记录每个单位在原字符串中的起始位置；单独的空白并入前一段 */
function tokenize(text: string): { toks: string[]; offs: number[] } {
  const raw: { t: string; o: number }[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    const t = m[0];
    if (!t.trim()) {
      if (raw.length) raw[raw.length - 1].t += t;
      continue;
    }
    // 带连字符的长词可以在连字符后断开（closed-loop → closed- / loop）
    if (/[A-Za-z]-[A-Za-z]/.test(t)) {
      let o = m.index;
      for (const part of t.split(/(?<=[A-Za-z]-)(?=[A-Za-z])/)) {
        raw.push({ t: part, o });
        o += part.length;
      }
    } else raw.push({ t, o: m.index });
  }
  // 开括号、开引号与后一段绑定，避免落在行尾
  const out: { t: string; o: number }[] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && NO_LINE_END.test(last.t)) last.t += r.t;
    else out.push({ ...r });
  }
  return { toks: out.map((r) => r.t), offs: out.map((r) => r.o) };
}

/** 贪心换行（按断行单位），遵守避头规则；记录每段宽度供两端对齐使用。 */
function wrap(ctx: CanvasRenderingContext2D, tokens: string[], maxW: number, size: number): Line[] {
  const lines: Line[] = [];
  let cur: number[] = [];
  let ws: number[] = [];
  let width = 0; // 当前行含末尾空白的宽度
  const flush = () => {
    if (cur.length) {
      const lastTok = tokens[cur[cur.length - 1]];
      const lastTrim = ctx.measureText(lastTok.trimEnd()).width;
      const total = ws.reduce((a, b) => a + b, 0) - ws[ws.length - 1] + lastTrim;
      lines.push({ idx: cur, widths: ws.map((w, i) => (i === ws.length - 1 ? lastTrim : w)), width: total });
    }
    cur = [];
    ws = [];
    width = 0;
  };
  tokens.forEach((tok, ti) => {
    const tw = ctx.measureText(tok).width;
    // 允许按间隙数略微挤紧
    const slack = cur.length * size * MAX_SQUEEZE;
    const fits = width + ctx.measureText(tok.trimEnd()).width <= maxW + slack;
    if (cur.length && !fits && !NO_LINE_START.test(tok)) flush();
    cur.push(ti);
    ws.push(tw);
    width += tw;
  });
  flush();
  return lines;
}

/**
 * 取块外圈像素中出现最多的颜色作为覆盖色。
 *
 * pdf.js 总是先把页面铺成白色，所以正常情况下论文纸面就是白色；只有确实是一大片均匀色块
 * （例如带底色的算法框）时才采用取到的颜色。读不到像素、像素透明（部分浏览器的防指纹策略
 * 或画布内存不足时会返回全 0），或者取到的颜色混杂（外圈压到了文字）时，一律回退为白色，
 * 避免出现原文是白底、译文却变成黑底白字的情况。
 */
function backgroundOf(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): string {
  const WHITE = 'rgb(255, 255, 255)';
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const x0 = Math.max(0, x - 1);
  const y0 = Math.max(0, y - 1);
  const x1 = Math.min(cw, x + w + 1);
  const y1 = Math.min(ch, y + h + 1);
  if (x1 <= x0 || y1 <= y0) return WHITE;
  let img: Uint8ClampedArray;
  try {
    img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  } catch {
    return WHITE;
  }
  const counts = new Map<number, number>();
  const cols = x1 - x0;
  const rows = y1 - y0;
  let total = 0;
  const push = (px: number, py: number) => {
    const i = (py * cols + px) * 4;
    if (img[i + 3] < 250) return; // 透明像素说明读回失败，不计入
    const key = ((img[i] >> 4) << 8) | ((img[i + 1] >> 4) << 4) | (img[i + 2] >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  };
  for (let px = 0; px < cols; px++) {
    push(px, 0);
    push(px, rows - 1);
  }
  for (let py = 1; py < rows - 1; py++) {
    push(0, py);
    push(cols - 1, py);
  }
  if (total < 8) return WHITE;
  let best = 0;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  const r = ((best >> 8) & 15) * 17;
  const g = ((best >> 4) & 15) * 17;
  const bl = (best & 15) * 17;
  const color = `rgb(${r}, ${g}, ${bl})`;
  // 深色底只在外圈几乎全是同一颜色时才可信；否则多半是压到了文字或读回异常
  if (luminance(color) < 0.6 && bestN < total * 0.85) return WHITE;
  return color;
}

function luminance(css: string): number {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(css);
  if (!m) return 1;
  return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
}
