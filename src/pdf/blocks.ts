import { pdfjs, type PDFPage } from './engine';

/**
 * 从一页 PDF 中提取可替换的文本块（段落级）。
 * 坐标单位为「scale = 1」下的 CSS 像素，原点在页面左上角，与 pdf.js 的 viewport 一致。
 */

export interface TextBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 估计字号（同单位） */
  size: number;
  /** 行距（相邻基线间距）；单行块为字号的 1.25 倍 */
  pitch: number;
  /** 原文对齐方式：两端对齐 / 居中 / 左对齐 */
  align: Align;
  text: string;
}

export type Align = 'justify' | 'center' | 'left';

interface Piece {
  str: string;
  x0: number;
  x1: number;
  base: number;
  size: number;
  top: number;
  bottom: number;
}

interface Line {
  pieces: Piece[];
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  base: number;
  size: number;
  text: string;
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/;
/** arXiv 自动加上的编号戳，例如 "arXiv:2607.10630v1 [cs.RO] 12 Jul 2026" */
const ARXIV_STAMP = /^\s*arXiv:\d{4}\.\d{4,5}(v\d+)?\s*\[/;

export async function extractBlocks(page: PDFPage): Promise<TextBlock[]> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const pieces: Piece[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    // 旋转或倾斜的文字（如 arXiv 左侧竖排的编号水印）不参与替换：按水平排版处理会盖住正文
    const [a, b, c, d] = item.transform;
    if (Math.abs(b) > Math.abs(a) * 0.05 || Math.abs(c) > Math.abs(d) * 0.05) continue;
    if (ARXIV_STAMP.test(item.str)) continue;
    const m = pdfjs.Util.transform(vp.transform, item.transform);
    const size = Math.hypot(m[2], m[3]) || item.height || 10;
    const x0 = m[4];
    const base = m[5];
    pieces.push({
      str: item.str,
      x0,
      x1: x0 + (item.width || item.str.length * size * 0.5),
      base,
      size,
      // 覆盖范围包含升部与降部（g、p、y 等），避免原文残留
      top: base - size * 0.85,
      bottom: base + size * 0.28,
    });
  }
  const lines = groupLines(pieces, vp.width);
  // 页面正文的左右边界，用来判断单行文字是否居中
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  return readingOrder(groupBlocks(lines, left, right), (left + right) / 2).filter(isTranslatable);
}

function groupLines(pieces: Piece[], pageWidth: number): Line[] {
  const sorted = [...pieces].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  // 先按基线聚类，再在栏间空白处切开（双栏排版左右两栏同一基线不能并成一行）
  const rows: Piece[][] = [];
  for (const p of sorted) {
    const row = rows.find((r) => Math.abs(r[0].base - p.base) < Math.max(r[0].size, p.size) * 0.45);
    if (row) row.push(p);
    else rows.push([p]);
  }
  const isGutter = gutterTest(rows, pageWidth);
  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    let cur: Piece[] = [];
    let right = -Infinity;
    for (const p of row) {
      const gap = p.x0 - right;
      const size = Math.max(p.size, cur[0]?.size ?? 0);
      // 两端对齐的正文词距可能很大，所以只有落在栏间空白上的间隔才切开；特别大的间隔（表格）也切开
      if (cur.length && ((gap > size * 0.8 && isGutter(right, p.x0)) || gap > size * 4)) {
        lines.push(newLine(cur));
        cur = [];
        right = -Infinity;
      }
      cur.push(p);
      right = Math.max(right, p.x1);
    }
    if (cur.length) lines.push(newLine(cur));
  }
  for (const l of lines) {
    l.pieces.sort((a, b) => a.x0 - b.x0);
    l.x0 = Math.min(...l.pieces.map((p) => p.x0));
    l.x1 = Math.max(...l.pieces.map((p) => p.x1));
    l.top = Math.min(...l.pieces.map((p) => p.top));
    l.bottom = Math.max(...l.pieces.map((p) => p.bottom));
    l.size = median(l.pieces.map((p) => p.size));
    l.base = median(l.pieces.map((p) => p.base));
    l.text = joinPieces(l.pieces);
  }
  lines.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  return lines;
}

/**
 * 栏间空白：整页中几乎没有文字行穿过的竖条。
 * 统计每个横坐标被多少行覆盖；覆盖率很低且两侧都有大量文字的位置视为栏间。
 */
function gutterTest(rows: Piece[][], pageWidth: number): (from: number, to: number) => boolean {
  const W = Math.max(1, Math.ceil(pageWidth));
  const cov = new Uint16Array(W);
  for (const row of rows) {
    for (const p of row) {
      const a = Math.max(0, Math.floor(p.x0));
      const b = Math.min(W, Math.ceil(p.x1));
      for (let x = a; x < b; x++) cov[x]++;
    }
  }
  const limit = Math.max(1, rows.length * 0.15);
  return (from, to) => {
    const a = Math.max(0, Math.ceil(from));
    const b = Math.min(W, Math.floor(to));
    for (let x = a; x < b; x++) if (cov[x] <= limit) return true;
    return false;
  };
}

function newLine(pieces: Piece[]): Line {
  const p = pieces[0];
  return { pieces, x0: p.x0, x1: p.x1, top: p.top, bottom: p.bottom, base: p.base, size: p.size, text: '' };
}

/** 同一行内的文字片段：间距明显时补空格 */
function joinPieces(pieces: Piece[]): string {
  let out = '';
  let prev: Piece | null = null;
  for (const p of pieces) {
    if (prev && !out.endsWith(' ') && !p.str.startsWith(' ') && p.x0 - prev.x1 > prev.size * 0.15) out += ' ';
    out += p.str;
    prev = p;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 把行合并为段落块：同一栏（水平范围重叠）、行距接近、字号接近的连续行归为一块。
 * 首行缩进（明显右移）视为新段落。
 */
function groupBlocks(lines: Line[], left: number, right: number): TextBlock[] {
  type Acc = { lines: Line[]; x0: number; x1: number; top: number; bottom: number; size: number; pitch: number };
  const blocks: Acc[] = [];
  // 一行能否接在某个块后面：同一栏、紧挨在下方、字号与行距一致、不是新段落
  const fits = (cur: Acc, line: Line): number | null => {
    const overlaps = line.x0 < cur.x1 - 2 && line.x1 > cur.x0 + 2;
    const gap = line.top - cur.bottom;
    if (!overlaps || gap < -line.size * 0.3 || gap > line.size * 0.6) return null;
    if (Math.abs(line.size - cur.size) >= cur.size * 0.2) return null;
    const prev = cur.lines[cur.lines.length - 1];
    // 上一行明显短于本行：段落结尾或标题，下一行另起一块
    if (prev.x1 - prev.x0 < (line.x1 - line.x0) * 0.6) return null;
    // 首行缩进且上一行以句号等结尾：新段落
    if (line.x0 - cur.x0 > line.size * 1.2 && /[.!?。！？:;]\s*$/.test(prev.text)) return null;
    // 行距需与块内已有行距一致
    if (cur.lines.length > 1 && Math.abs(line.base - prev.base - cur.pitch) >= line.size * 0.25) return null;
    return gap;
  };
  for (const line of lines) {
    // 双栏排版中左右两栏的行交错出现，因此在所有块中找最贴近的一块，而不只看上一块
    let cur: Acc | undefined;
    let best = Infinity;
    for (const b of blocks) {
      const g = fits(b, line);
      if (g !== null && g < best) {
        best = g;
        cur = b;
      }
    }
    if (cur) {
      if (cur.lines.length === 1) cur.pitch = line.base - cur.lines[0].base;
      cur.lines.push(line);
      cur.x0 = Math.min(cur.x0, line.x0);
      cur.x1 = Math.max(cur.x1, line.x1);
      cur.bottom = Math.max(cur.bottom, line.bottom);
    } else {
      blocks.push({ lines: [line], x0: line.x0, x1: line.x1, top: line.top, bottom: line.bottom, size: line.size, pitch: 0 });
    }
  }
  return blocks.map((b) => ({
    x: b.x0,
    y: b.top,
    w: b.x1 - b.x0,
    h: b.bottom - b.top,
    size: median(b.lines.map((l) => l.size)),
    pitch: b.lines.length > 1 ? median(b.lines.slice(1).map((l, i) => l.base - b.lines[i].base)) : median(b.lines.map((l) => l.size)) * 1.25,
    align: alignOf(b.lines, b.x0, b.x1, left, right),
    text: joinLines(b.lines),
  }));
}

/**
 * 阅读顺序：横跨两栏的块（标题、通栏图注）把页面分成若干段，每段内先左栏、后右栏，各自从上到下。
 * 单栏页面中所有块都按从上到下排列。
 */
function readingOrder(blocks: TextBlock[], mid: number): TextBlock[] {
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: TextBlock[] = [];
  let leftCol: TextBlock[] = [];
  let rightCol: TextBlock[] = [];
  const flush = () => {
    out.push(...leftCol, ...rightCol);
    leftCol = [];
    rightCol = [];
  };
  for (const b of sorted) {
    const spans = b.x < mid - b.size && b.x + b.w > mid + b.size;
    if (spans) {
      flush();
      out.push(b);
    } else if (b.x + b.w / 2 < mid) leftCol.push(b);
    else rightCol.push(b);
  }
  flush();
  return out;
}

/**
 * 推断对齐方式：
 * - 多行且除末行外右端齐平 → 两端对齐；
 * - 各行中点重合而宽度不同，或单行、不贴左边界且位于版心正中（标题、作者） → 居中；
 * - 其余为左对齐。
 */
function alignOf(lines: Line[], x0: number, x1: number, left: number, right: number): Align {
  const size = median(lines.map((l) => l.size));
  const tol = size * 0.6;
  if (lines.length >= 2) {
    const body = lines.slice(0, -1);
    const flushRight = body.filter((l) => Math.abs(x1 - l.x1) < tol).length;
    if (flushRight >= body.length * 0.7) return 'justify';
    const mid = (x0 + x1) / 2;
    const centered = lines.every((l) => Math.abs((l.x0 + l.x1) / 2 - mid) < tol);
    const ragged = lines.some((l) => x1 - l.x1 > size * 2);
    if (centered && ragged) return 'center';
    return 'left';
  }
  const mid = (x0 + x1) / 2;
  if (Math.abs(mid - (left + right) / 2) < size * 0.6 && x0 - left > size * 1.5) return 'center';
  return 'left';
}

/** 行尾连字符（如 "pro-" + "cessing"）直接相连，其余用空格连接 */
function joinLines(lines: Line[]): string {
  let out = '';
  for (const l of lines) {
    const t = l.text;
    if (!out) out = t;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out += (CJK.test(out.slice(-1)) || CJK.test(t[0] ?? '') ? '' : ' ') + t;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 跳过公式、图表标注、页码等不适合替换的块 */
function isTranslatable(b: TextBlock): boolean {
  if (b.size < 6) return false;
  if (b.text.length < 12) return false;
  const letters = (b.text.match(/[\p{L}]/gu) ?? []).length;
  const symbols = (b.text.match(/[=+\-*/^_{}|<>∑∫√≈≤≥∈∀∃→←]/g) ?? []).length;
  if (letters < b.text.length * 0.4) return false;
  if (symbols > b.text.length * 0.08) return false;
  return true;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
