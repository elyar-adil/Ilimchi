import type { PDFPage } from '../pdf/engine';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

/**
 * 校正文字层每个 span 的位置，使选区、双击选词与画面上的字形对齐。
 *
 * pdf.js 的文字层用通用后备字体（serif / sans-serif）排版，再按整段文字的总宽度做一次 scaleX。
 * 这只保证一段文字的首尾位置正确，段内每个字符的位置仍由“后备字体的字宽”决定，
 * 与 PDF 实际使用的字体不同；论文常见的两端对齐（TeX 把词间距拉伸到各行不同）又会让偏差随行内位置累积，
 * 所以越靠行中 / 行尾，选区与字形错开越多（半个字符以上）。
 *
 * 这里做三件事：
 * 1) span 改用 PDF 内嵌字体（pdf.js 已把它注册为 FontFace，名字就是 item.fontName），字宽与画面一致；
 * 2) 剩余的差（字距调整、两端对齐的词间距拉伸）全部摊到空格上（word-spacing），而不是整体拉伸字形，
 *    这样每个单词的起止位置都落在正确处；没有空格的 span 才退回 scaleX；
 * 3) 内嵌字体的上升 / 下降高度与后备字体不同，会让基线上下漂移，按字体补偿回来。
 *
 * 位置全部用相对单位（em、--scale-factor），缩放时不需要重算。
 */

const FONT_WAIT_MS = 2000;

const contentCache = new WeakMap<PDFPage, Promise<TextContent>>();

/**
 * 取得页面文字内容，并等待其用到的内嵌字体加载完（否则量到的是后备字体的宽度）。
 * 每页只解析一次，文字层与 fitSpans 共用同一份结果。
 */
export function pageTextContent(page: PDFPage): Promise<TextContent> {
  let p = contentCache.get(page);
  if (!p) {
    p = page.getTextContent().then(async (c) => {
      const names = new Set<string>();
      for (const i of c.items) if ('str' in i && i.str) names.add(i.fontName);
      const loads = [...names].map(
        (n) =>
          new Promise<void>((res) => {
            try {
              page.commonObjs.get(n, () => res());
            } catch {
              res();
            }
          }),
      );
      await Promise.race([Promise.all(loads), new Promise<void>((res) => setTimeout(res, FONT_WAIT_MS))]);
      return c;
    });
    contentCache.set(page, p);
  }
  return p;
}

const SCALE_X = /^scaleX\([^)]*\)\s*/;

/** 内嵌字体相对后备字体的基线偏移（单位 em，向下为正）。 */
function baselineShifts(pairs: Map<string, { name: string; fallback: string }>): Map<string, number> {
  const probes: { key: string; emb: HTMLElement; fb: HTMLElement }[] = [];
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;contain:layout style';
  const mk = (family: string): HTMLElement => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:0;top:0;font-size:100px;line-height:1;white-space:pre;font-family:${family}`;
    d.innerHTML = 'x<i style="display:inline-block;width:0;height:0"></i>';
    host.append(d);
    return d;
  };
  for (const [key, v] of pairs) probes.push({ key, emb: mk(`"${v.name}", ${v.fallback}`), fb: mk(v.fallback) });
  document.body.append(host);
  const base = (d: HTMLElement): number => (d.lastElementChild as HTMLElement).getBoundingClientRect().bottom - d.getBoundingClientRect().top;
  const out = new Map<string, number>();
  for (const p of probes) out.set(p.key, (base(p.emb) - base(p.fb)) / 100);
  host.remove();
  return out;
}

interface Job {
  div: HTMLElement;
  target: number;
  rest: string;
  spaces: number;
  size: number;
}

/**
 * @returns 是否成功校正；失败（条目与 span 数量对不上）时调用方应沿用 pdf.js 自己的布局。
 */
export async function fitSpans(page: PDFPage, cssScale: number, divs: HTMLElement[], pageEl: HTMLElement): Promise<boolean> {
  const content = await pageTextContent(page);
  const items = content.items.filter((i): i is TextItem => 'str' in i);
  if (items.length !== divs.length) return false;

  // 1) 换上内嵌字体，去掉 scaleX 与词间距，让 span 以自然宽度排版（其余变换如旋转保留）
  const jobs: Job[] = [];
  const fonts = new Map<string, { name: string; fallback: string }>();
  const shiftOf: (string | null)[] = [];
  for (let i = 0; i < divs.length; i++) {
    const div = divs[i];
    const it = items[i];
    shiftOf.push(null);
    if (!div.isConnected || !it.str || content.styles[it.fontName]?.vertical) continue;
    const tr = div.style.transform;
    if (!div.dataset.fit && !SCALE_X.test(tr)) continue;
    const rest = tr.replace(SCALE_X, '');
    const fallback = div.dataset.fit ?? div.style.fontFamily;
    div.dataset.fit = fallback;
    div.style.fontFamily = `"${it.fontName}", ${fallback}`;
    div.style.fontKerning = 'none';
    div.style.fontVariantLigatures = 'none';
    div.style.wordSpacing = '';
    div.style.transform = rest;
    const key = `${it.fontName}\n${fallback}`;
    fonts.set(key, { name: it.fontName, fallback });
    shiftOf[i] = rest ? null : key; // 旋转的 span 不做竖向补偿
    jobs.push({ div, target: it.width * cssScale, rest, spaces: (it.str.match(/ /g) ?? []).length, size: parseFloat(/([\d.]+)px\)?$/.exec(div.style.fontSize)?.[1] ?? '0') * cssScale });
  }
  if (jobs.length === 0) return true;

  // 2) 统一读取（只触发一次布局）。页面可能处于缩放手势的 CSS 变换中，用 offsetWidth 校准比例。
  const box = pageEl.getBoundingClientRect();
  const k = pageEl.offsetWidth > 0 ? box.width / pageEl.offsetWidth : 1;
  const widths = jobs.map((j) => j.div.getBoundingClientRect().width / (k || 1));
  const shifts = baselineShifts(fonts);

  // 3) 统一写回
  const fixed = new Set<HTMLElement>();
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const w = widths[i];
    if (!(w > 0)) continue;
    // 摊到每个空格上的宽度（px，当前缩放下）；差得太离谱说明不是词间距的问题，退回整体拉伸
    const ws = j.spaces > 0 ? (j.target - w) / j.spaces : NaN;
    if (Number.isFinite(ws) && Math.abs(ws) <= 0.6 * j.size) {
      j.div.style.wordSpacing = `calc(var(--scale-factor) * ${(ws / cssScale).toFixed(4)}px)`;
    } else {
      j.div.style.transform = `scaleX(${j.target / w}) ${j.rest}`.trim();
    }
    fixed.add(j.div);
  }
  for (let i = 0; i < divs.length; i++) {
    const key = shiftOf[i];
    const d = key ? shifts.get(key) : 0;
    if (key && fixed.has(divs[i])) divs[i].style.marginTop = d ? `${(-d).toFixed(4)}em` : '';
  }
  return true;
}
