import type { TransBlock } from '../core/translate';

/**
 * 把译文直接绘制到页面位图上，替换原文：
 * 1. 取原文块周围的背景色（纸面色，支持底色与深色模式）覆盖原文；
 * 2. 在原位置用原字号排入译文，超出块高度时逐步缩小字号；
 * 3. 之后的夜间模式处理（墨色等）会一并作用于译文，保持一致。
 */

const FONT_STACK = '"Source Serif 4", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", serif';
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const PAD = 1;
/** 不能出现在行首的标点（避头尾） */
const NO_LINE_START = /^[，。、；：！？）》」』”’,.;:!?)\]]/;

/** k = 页面缩放 × 设备像素比（块坐标为 scale=1 的 CSS 像素） */
export function drawTranslation(ctx: CanvasRenderingContext2D, blocks: TransBlock[], k: number): void {
  for (const b of blocks) {
    const x = Math.floor((b.x - PAD) * k);
    const y = Math.floor((b.y - PAD) * k);
    const w = Math.ceil((b.w + PAD * 2) * k);
    const h = Math.ceil((b.h + PAD * 2) * k);
    if (w <= 0 || h <= 0) continue;
    const bg = backgroundOf(ctx, x, y, w, h);
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);

    const fg = luminance(bg) < 0.5 ? '#e4e7ea' : '#1e2226';
    const maxW = b.w * k;
    const maxH = b.h * k;
    const startSize = b.size * k;
    // 沿用原文行距：字号缩小时行距按比例缩小，但不小于字号的 1.15 倍
    const pitch = (b.lh && b.lh > b.size ? b.lh : b.size * 1.25) * k;
    let size = startSize;
    let lines: string[] = [];
    let lh = pitch;
    for (; size >= startSize * 0.55; size -= 0.5) {
      ctx.font = `${size}px ${FONT_STACK}`;
      lines = wrap(ctx, b.t, maxW);
      lh = Math.max(pitch * (size / startSize), size * 1.15);
      if ((lines.length - 1) * lh + size <= maxH + 1) break;
    }
    ctx.font = `${size}px ${FONT_STACK}`;
    ctx.fillStyle = fg;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, b.x * k, b.y * k + i * lh, maxW * 1.02));
  }
}

/** 取块外圈像素中出现最多的颜色（量化后统计），作为覆盖颜色。 */
function backgroundOf(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): string {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const x0 = Math.max(0, x - 1);
  const y0 = Math.max(0, y - 1);
  const x1 = Math.min(cw, x + w + 1);
  const y1 = Math.min(ch, y + h + 1);
  if (x1 <= x0 || y1 <= y0) return '#ffffff';
  const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const counts = new Map<number, number>();
  const cols = x1 - x0;
  const rows = y1 - y0;
  const push = (px: number, py: number) => {
    const i = (py * cols + px) * 4;
    const key = ((img[i] >> 4) << 8) | ((img[i + 1] >> 4) << 4) | (img[i + 2] >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let px = 0; px < cols; px++) {
    push(px, 0);
    push(px, rows - 1);
  }
  for (let py = 1; py < rows - 1; py++) {
    push(0, py);
    push(cols - 1, py);
  }
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
  return `rgb(${r}, ${g}, ${bl})`;
}

function luminance(css: string): number {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(css);
  if (!m) return 1;
  return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
}

/** 贪心换行：中日韩按字符断行，西文按单词断行。 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const cjk = CJK.test(text) && (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length > text.length * 0.3;
  const tokens = cjk ? [...text] : text.split(/(\s+)/).filter((s) => s.length > 0);
  const lines: string[] = [];
  let cur = '';
  for (const tok of tokens) {
    const cand = cur + tok;
    if (ctx.measureText(cand.trimEnd()).width <= maxW || !cur || NO_LINE_START.test(tok)) {
      cur = cand;
    } else {
      lines.push(cur.trimEnd());
      cur = cjk ? tok : tok.trimStart();
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}
