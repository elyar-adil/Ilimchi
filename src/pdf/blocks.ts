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
  /** text 中每个字符在页面原始文本（与文本层一致）中的偏移；补出来的空格为 -1 */
  map: number[];
}

export type Align = 'justify' | 'center' | 'left';

/** 带原文偏移的文字：s 的每个字符对应 m 中的一个偏移（-1 表示补出来的字符） */
interface Txt {
  s: string;
  m: number[];
}

function txt(): Txt {
  return { s: '', m: [] };
}

function push(t: Txt, str: string, off: number | null): void {
  for (let i = 0; i < str.length; i++) {
    t.s += str[i];
    t.m.push(off === null ? -1 : off + i);
  }
}

/** 连续空白合并为一个空格并去掉首尾空白，偏移随之保留 */
function squashWs(t: Txt): Txt {
  const out = txt();
  for (let i = 0; i < t.s.length; i++) {
    const ch = t.s[i];
    if (/\s/.test(ch)) {
      if (out.s.length && !out.s.endsWith(' ')) {
        out.s += ' ';
        out.m.push(t.m[i]);
      }
    } else {
      out.s += ch;
      out.m.push(t.m[i]);
    }
  }
  if (out.s.endsWith(' ')) {
    out.s = out.s.slice(0, -1);
    out.m.pop();
  }
  return out;
}

interface Piece {
  str: string;
  /** str 在页面原始文本中的起始偏移 */
  off: number;
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
  txt: Txt;
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/;
/** arXiv 自动加上的编号戳，例如 "arXiv:2607.10630v1 [cs.RO] 12 Jul 2026" */
const ARXIV_STAMP = /^\s*arXiv:\d{4}\.\d{4,5}(v\d+)?\s*\[/;

/** 一个文字片段在页面上的位置（页面比例坐标），用于从字符偏移推算矩形 */
export interface PieceBox {
  off: number;
  len: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

/** inside：位于图表区域内的文字（图中标注），随图一起截图 */
export type BlockRole = 'text' | 'heading' | 'figure' | 'skip' | 'inside';

export interface LayoutBlock extends TextBlock {
  /** 在 layout.blocks 中的序号 */
  i: number;
  translatable: boolean;
  role: BlockRole;
}

/** 重排视图中的一项：文字块，或需要按原样截图显示的区域（图、表、公式） */
export type FlowItem =
  /** role 覆盖块自己的角色；cont 表示接着上一块，属于同一段 */
  | { kind: 'block'; i: number; role?: 'text' | 'heading' | 'caption'; cont?: boolean }
  | { kind: 'crop'; x: number; y: number; w: number; h: number };

export interface PageLayout {
  width: number;
  height: number;
  /** 页面原始文本：所有文本项按顺序拼接，与文本层的 rawText 一致 */
  raw: string;
  blocks: LayoutBlock[];
  pieces: PieceBox[];
  /** 阅读顺序 */
  flow: FlowItem[];
}

export async function extractBlocks(page: PDFPage): Promise<LayoutBlock[]> {
  return (await extractLayout(page)).blocks.filter((b) => b.translatable);
}

export async function extractLayout(page: PDFPage): Promise<PageLayout> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const pieces: Piece[] = [];
  let raw = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const off = raw.length;
    raw += item.str;
    if (!item.str.trim()) continue;
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
      off,
      x0,
      x1: x0 + (item.width || item.str.length * size * 0.5),
      base,
      size,
      // 覆盖范围包含升部与降部（g、p、y 等），避免原文残留
      top: base - size * 0.85,
      bottom: base + size * 0.28,
    });
  }
  const W = vp.width;
  const H = vp.height;
  const boxes: PieceBox[] = pieces.map((p) => ({ off: p.off, len: p.str.length, x0: p.x0 / W, x1: p.x1 / W, top: p.top / H, bottom: p.bottom / H }));
  if (!pieces.length) return { width: W, height: H, raw, blocks: [], pieces: boxes, flow: [] };
  const lines = groupLines(pieces, vp.width);
  // 页面正文的左右边界，用来判断单行文字是否居中
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  const ordered = readingOrder(groupBlocks(lines, left, right), (left + right) / 2);
  const body = median(ordered.filter((b) => b.text.length > 80).map((b) => b.size)) || median(ordered.map((b) => b.size));
  const blocks: LayoutBlock[] = ordered.map((b, i) => {
    const translatable = isTranslatable(b);
    return { ...b, i, translatable, role: roleOf(b, translatable, body, H) };
  });
  // 页码：最上方或最下方、只有数字的块
  const numeric = blocks.filter((b) => /^\d{1,4}$/.test(b.text.trim()));
  const maxBottom = Math.max(...blocks.map((b) => b.y + b.h));
  const minTop = Math.min(...blocks.map((b) => b.y));
  for (const b of numeric) if (b.y + b.h >= maxBottom - 1 || b.y <= minTop + 1) b.role = 'skip';
  // 页眉（"4 Z. Shen et al."、短标题）：除第一页外，最上方贴近页边的单行短文字
  const top = blocks.filter((b) => b.role !== 'skip').reduce<LayoutBlock | null>((m, b) => (!m || b.y < m.y ? b : m), null);
  if (page.pageNumber > 1 && top && top.role !== 'heading' && top.y < H * 0.14 && top.text.length < 90 && top.h < top.size * 1.8) {
    // 与下方正文之间有明显空隙才算页眉
    const below = blocks.filter((b) => b !== top && b.role !== 'skip' && b.y > top.y).reduce((m, b) => Math.min(m, b.y), Infinity);
    if (below - (top.y + top.h) > top.size * 0.8) top.role = 'skip';
  }
  // 表格：紧挨着 "Table N" 图注、数字很多的块按原样截图（表格线太少时识别不出图形区域）
  blocks.forEach((b, k) => {
    if (b.role !== 'text' || CAPTION.test(b.text.trim())) return;
    const neighbors = [blocks[k - 1], blocks[k + 1]].filter(Boolean);
    const nearTable = neighbors.some((n) => /^(table|tab)\.?\s*\d/i.test(n.text.trim()) && Math.abs(n.x - b.x) < Math.max(n.w, b.w));
    const digits = (b.text.match(/\d/g) ?? []).length;
    if (nearTable && digits > b.text.length * 0.12) b.role = 'figure';
  });
  const graphics = await graphicBoxes(page, vp.transform, W, H);
  const regions = graphics ? figureRegions(graphics, blocks, W, H) : [];
  return { width: W, height: H, raw, blocks, pieces: boxes, flow: buildFlow(blocks, regions, !!graphics, (left + right) / 2, body, W, H) };
}

/** 块在重排视图中的角色 */
function roleOf(b: TextBlock, translatable: boolean, body: number, pageH: number): BlockRole {
  const t = b.text.trim();
  // 页眉页脚：页码、会议名等短文字贴着页面上下边缘
  if (t.length < 80 && (b.y < pageH * 0.07 || b.y + b.h > pageH * 0.94)) return 'skip';
  if (!translatable && t.length >= 12) {
    const letters = (t.match(/[\p{L}]/gu) ?? []).length;
    const symbols = (t.match(/[=+\-*/^_{}|<>∑∫√≈≤≥∈∀∃→←]/g) ?? []).length;
    // 公式、表格数字：按原样截图
    if (letters < t.length * 0.4 || symbols > t.length * 0.08) return 'figure';
  }
  const short = t.length < 90 && !/[.:;,]$/.test(t);
  if (short && (/^(\d+(\.\d+)*\.?|[A-Z](\.\d+)*\.?|[IVX]+\.)\s+\p{Lu}/u.test(t) || /^(abstract|references|acknowledg|appendix|bibliography)/i.test(t))) return 'heading';
  if (short && b.size > body * 1.12 && t.length >= 4) return 'heading';
  // 很短、又不像正文的碎片：图中标注、公式的上下标、编号等，归入图表区域
  if (!translatable && t.length < 12) return 'figure';
  return 'text';
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 页面上的图形：图片与矢量路径（填充或描边）的外接框，坐标同文字（scale = 1 的视口坐标）。
 * 来自 pdf.js 的绘制指令；取不到时返回 null（退回按空白推断图表区域）。
 */
async function graphicBoxes(page: PDFPage, vpTransform: number[], W: number, H: number): Promise<Box[] | null> {
  let ol: { fnArray: number[]; argsArray: unknown[] };
  try {
    ol = await page.getOperatorList();
  } catch {
    return null;
  }
  const OPS = pdfjs.OPS as Record<string, number>;
  const paint = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const images = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintSolidColorImageMask, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup].filter((x) => x !== undefined));
  const mul = (m1: number[], m2: number[]) => pdfjs.Util.transform(m1, m2) as number[];
  let ctm = vpTransform.slice();
  const stack: number[][] = [];
  const out: Box[] = [];
  const add = (pts: [number, number][]) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [x, y] of pts) {
      const q = [x, y];
      pdfjs.Util.applyTransform(q, ctm);
      xs.push(q[0]);
      ys.push(q[1]);
    }
    const box = { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(W, Math.max(...xs)), y1: Math.min(H, Math.max(...ys)) };
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    // 整页底色、页面边框之类的大框不算图
    if (w <= 0 && h <= 0) return;
    if (w * h > W * H * 0.5) return;
    out.push(box);
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0] as number[] | null;
      if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const op = args?.[0] as number;
      const mm = args?.[2] as number[] | null;
      if (paint.has(op) && mm && mm.length === 4 && mm.every(Number.isFinite)) add([[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]]);
    } else if (images.has(fn)) add([[0, 0], [1, 0], [0, 1], [1, 1]]);
  }
  return out;
}

export const CAPTION = /^(fig(ure)?|table|tab|algorithm|alg)\.?\s*[\dA-Z]/i;

/**
 * 图表区域：把相互挨着的图形合成一块，再并入落在其中或紧贴边上的短文字（图中标注、坐标轴等）。
 * 图注（Figure 1: …）与长段落不并入；圈住长段落的框（带底色的文字框）不当作图。
 */
function figureRegions(graphics: Box[], blocks: LayoutBlock[], W: number, H: number): Box[] {
  // 1) 图形聚类
  const TOL = 10;
  let clusters = graphics.map((g) => ({ ...g }));
  for (let changed = true; changed; ) {
    changed = false;
    const next: Box[] = [];
    for (const c of clusters) {
      const hit = next.find((n) => c.x0 <= n.x1 + TOL && c.x1 >= n.x0 - TOL && c.y0 <= n.y1 + TOL && c.y1 >= n.y0 - TOL);
      if (hit) {
        hit.x0 = Math.min(hit.x0, c.x0);
        hit.y0 = Math.min(hit.y0, c.y0);
        hit.x1 = Math.max(hit.x1, c.x1);
        hit.y1 = Math.max(hit.y1, c.y1);
        changed = true;
      } else next.push({ ...c });
    }
    clusters = next;
  }
  // 太小的（分隔线、表格横线、脚注线）不算图
  const regions = clusters.filter((c) => c.x1 - c.x0 >= 24 && c.y1 - c.y0 >= 18 && (c.x1 - c.x0) * (c.y1 - c.y0) < W * H * 0.6);
  const out: Box[] = [];
  for (const r0 of regions) {
    const r = { ...r0 };
    const absorbed: LayoutBlock[] = [];
    for (let changed = true; changed; ) {
      changed = false;
      for (const b of blocks) {
        if (b.role === 'skip' || absorbed.includes(b) || CAPTION.test(b.text.trim())) continue;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const inside = cx >= r.x0 - 2 && cx <= r.x1 + 2 && cy >= r.y0 - 2 && cy <= r.y1 + 2;
        const pad = Math.max(6, b.size * 1.2);
        const near = b.x <= r.x1 + pad && b.x + b.w >= r.x0 - pad && b.y <= r.y1 + pad && b.y + b.h >= r.y0 - pad;
        if (inside || (near && b.text.length < 60 && b.role !== 'heading')) {
          absorbed.push(b);
          r.x0 = Math.min(r.x0, b.x);
          r.y0 = Math.min(r.y0, b.y);
          r.x1 = Math.max(r.x1, b.x + b.w);
          r.y1 = Math.max(r.y1, b.y + b.h);
          changed = true;
        }
      }
    }
    if (absorbed.some((b) => b.text.length > 200)) continue;
    for (const b of absorbed) b.role = 'inside';
    out.push(r);
  }
  // 同一张图的几部分（上下几行子图）：横向重叠、纵向间隔很小的区域合并；中间夹着正文的不合并
  const GAP = 16;
  let merged = out.sort((a, b) => a.y0 - b.y0).map((r) => ({ ...r }));
  for (let changed = true; changed; ) {
    changed = false;
    const next: Box[] = [];
    for (const r of merged) {
      const hit = next.find((m) => {
        if (!(r.x0 <= m.x1 + GAP && r.x1 >= m.x0 - GAP && r.y0 <= m.y1 + GAP && r.y1 >= m.y0 - GAP)) return false;
        // 合并后的范围里不能有正文（否则是两张图之间夹着文字）
        const u = { x0: Math.min(m.x0, r.x0), y0: Math.min(m.y0, r.y0), x1: Math.max(m.x1, r.x1), y1: Math.max(m.y1, r.y1) };
        return !blocks.some((b) => b.role !== 'inside' && b.role !== 'skip' && b.x + b.w / 2 > u.x0 && b.x + b.w / 2 < u.x1 && b.y + b.h / 2 > u.y0 && b.y + b.h / 2 < u.y1);
      });
      if (hit) {
        hit.x0 = Math.min(hit.x0, r.x0);
        hit.y0 = Math.min(hit.y0, r.y0);
        hit.x1 = Math.max(hit.x1, r.x1);
        hit.y1 = Math.max(hit.y1, r.y1);
        changed = true;
      } else next.push(r);
    }
    merged = next;
  }
  return merged;
}

/**
 * 阅读顺序：横跨两栏的项（标题、通栏图）把页面分成若干段，每段内先左栏、后右栏。
 * 图表区域整块截图；取不到绘制指令时，同一栏内相邻文字之间的大段空白也当作图表区域（空白截图会被丢弃）。
 */
function buildFlow(blocks: LayoutBlock[], regions: Box[], haveGraphics: boolean, mid: number, body: number, W: number, H: number): FlowItem[] {
  type Item = { x: number; y: number; w: number; h: number; size: number; block?: LayoutBlock };
  const items: Item[] = [
    ...blocks.filter((b) => b.role !== 'skip' && b.role !== 'inside').map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.size, block: b })),
    ...regions.map((r) => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0, size: body })),
  ].sort((a, b) => a.y - b.y || a.x - b.x);
  if (!items.length) return [];
  const pageTop = Math.min(...items.map((b) => b.y));
  const pageBottom = Math.max(...items.map((b) => b.y + b.h));
  const pageLeft = Math.min(...items.map((b) => b.x));
  const pageRight = Math.max(...items.map((b) => b.x + b.w));
  const minGap = Math.max(body * 2.6, 18);
  const spans = (b: Item) => b.x < mid - b.size && b.x + b.w > mid + b.size;
  const colOf = (b: Item): 0 | 1 | 2 => (spans(b) ? 2 : b.x + b.w / 2 < mid ? 0 : 1);
  const twoCol = items.some((b) => colOf(b) !== 2);
  const crop = (x0: number, y0: number, x1: number, y1: number): FlowItem => {
    const a = Math.max(0, x0);
    const b = Math.max(0, y0);
    return { kind: 'crop', x: a / W, y: b / H, w: (Math.min(W, x1) - a) / W, h: (Math.min(H, y1) - b) / H };
  };
  const emit = (it: Item, cx0: number, cx1: number) => {
    if (!it.block) flow.push(crop(it.x - 4, it.y - 4, it.x + it.w + 4, it.y + it.h + 4));
    else if (it.block.role === 'figure') flow.push(crop(Math.min(cx0, it.x), it.y - 2, Math.max(cx1, it.x + it.w), it.y + it.h + 2));
    else flow.push({ kind: 'block', i: it.block.i });
  };

  const flow: FlowItem[] = [];
  let section: Item[] = [];
  let sectionTop = pageTop;
  const flushSection = (sectionBottom: number) => {
    if (!section.length) {
      if (!haveGraphics && sectionBottom - sectionTop > minGap) flow.push(crop(pageLeft, sectionTop, pageRight, sectionBottom));
      return;
    }
    const cols: [number, number][] = twoCol ? [[pageLeft, mid], [mid, pageRight]] : [[pageLeft, pageRight]];
    cols.forEach(([cx0, cx1], ci) => {
      const inCol = section.filter((b) => (twoCol ? colOf(b) === ci : true));
      let cursor = sectionTop;
      for (const it of inCol) {
        if (!haveGraphics && it.y - cursor > minGap) flow.push(crop(cx0, cursor, cx1, it.y));
        emit(it, cx0, cx1);
        cursor = Math.max(cursor, it.y + it.h);
      }
      if (!haveGraphics && sectionBottom - cursor > minGap) flow.push(crop(cx0, cursor, cx1, sectionBottom));
    });
    section = [];
  };
  for (const it of items) {
    if (twoCol && colOf(it) === 2) {
      flushSection(it.y);
      emit(it, pageLeft, pageRight);
      sectionTop = it.y + it.h;
    } else section.push(it);
  }
  flushSection(pageBottom);
  // 相邻的截图区域合并（同一栏、上下相接）
  const merged: FlowItem[] = [];
  for (const f of flow) {
    const last = merged[merged.length - 1];
    if (f.kind === 'crop' && last?.kind === 'crop' && f.x < last.x + last.w && f.x + f.w > last.x && f.y - (last.y + last.h) < 0.015) {
      const x0 = Math.min(last.x, f.x);
      const x1 = Math.max(last.x + last.w, f.x + f.w);
      last.h = Math.max(last.y + last.h, f.y + f.h) - last.y;
      last.x = x0;
      last.w = x1 - x0;
    } else merged.push(f.kind === 'crop' ? { ...f } : f);
  }
  return merged;
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
      const small = Math.min(p.size, cur[0]?.size ?? p.size);
      // 两端对齐的正文词距可能很大，所以只有落在栏间空白上的间隔才切开；特别大的间隔（表格）也切开。
      // 栏间距可能小于大字号标题的字宽，所以按较小的字号判断
      if (cur.length && ((gap > small * 0.5 && isGutter(right, p.x0)) || gap > size * 4)) {
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
    l.txt = joinPieces(l.pieces);
    l.text = l.txt.s;
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
  return { pieces, x0: p.x0, x1: p.x1, top: p.top, bottom: p.bottom, base: p.base, size: p.size, text: '', txt: txt() };
}

/** 同一行内的文字片段：间距明显时补空格 */
function joinPieces(pieces: Piece[]): Txt {
  const out = txt();
  let prev: Piece | null = null;
  for (const p of pieces) {
    if (prev && !out.s.endsWith(' ') && !p.str.startsWith(' ') && p.x0 - prev.x1 > prev.size * 0.15) push(out, ' ', null);
    push(out, p.str, p.off);
    prev = p;
  }
  return squashWs(out);
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
    ...(() => {
      const t = joinLines(b.lines);
      return { text: t.s, map: t.m };
    })(),
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
function joinLines(lines: Line[]): Txt {
  const out = txt();
  for (const l of lines) {
    const t = l.txt;
    if (!out.s) {
      out.s = t.s;
      out.m = [...t.m];
    } else if (/[A-Za-z]-$/.test(out.s) && /^[a-z]/.test(t.s)) {
      out.s = out.s.slice(0, -1) + t.s;
      out.m = [...out.m.slice(0, -1), ...t.m];
    } else {
      if (!(CJK.test(out.s.slice(-1)) || CJK.test(t.s[0] ?? ''))) push(out, ' ', null);
      out.s += t.s;
      out.m.push(...t.m);
    }
  }
  return squashWs(out);
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
