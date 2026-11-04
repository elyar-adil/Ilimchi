import { rawOffsetOf, rawText, rectsForOffsets } from '../pdf/text';
import { installPointerSelection } from './selectdrag';

/**
 * WebKit（Safari）自己绘制选区的方式与 pdf.js 的文字层不相容：
 * 文字层里每个 span 都是绝对定位的“选区根”，WebKit 会在它们之间补画“选区空隙”，
 * 结果是跨整页的色块、超出行尾的毛边、以及按字体上升/下降高度画出的过高选区。
 * 这些都是绘制层面的行为，没有 CSS 开关能关掉。
 *
 * 所以在 WebKit 上：原生选区背景设为透明（见 styles.css 中 .webkit-sel），
 * 由这里按 Range 的真实行矩形自己画。Blink / Gecko 不启用，走浏览器原生绘制，没有任何额外开销。
 */
export function needsSelectionPaint(): boolean {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/(Chrome|Chromium|CriOS|Edg|EdgiOS|FxiOS|OPR|Android)/.test(ua);
}

let installed = false;
const painted = new Set<HTMLElement>();

function clear(): void {
  for (const host of painted) host.replaceChildren();
  painted.clear();
}

function paint(): void {
  clear();
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  for (const layer of Array.from(document.querySelectorAll<HTMLElement>('.textLayer'))) {
    if (!range.intersectsNode(layer)) continue;
    const pageEl = layer.parentElement;
    const host = pageEl?.querySelector<HTMLElement>(':scope > .sel-layer');
    if (!pageEl || !host) continue;
    const start = layer.contains(range.startContainer) ? rawOffsetOf(layer, range.startContainer, range.startOffset) : 0;
    const end = layer.contains(range.endContainer) ? rawOffsetOf(layer, range.endContainer, range.endOffset) : rawText(layer).length;
    if (end <= start) continue;
    const frag = document.createDocumentFragment();
    for (const r of rectsForOffsets(layer, pageEl, start, end)) {
      const d = document.createElement('div');
      d.className = 'sel-rect';
      d.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`;
      frag.append(d);
    }
    host.replaceChildren(frag);
    painted.add(host);
  }
}

/** 幂等；仅在 WebKit 上生效。 */
export function installSelectionPaint(): void {
  if (installed || !needsSelectionPaint()) return;
  installed = true;
  document.documentElement.classList.add('webkit-sel');
  installPointerSelection();
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  };
  document.addEventListener('selectionchange', schedule);
  // 缩放 / 重排后页面尺寸变化，矩形需重算
  window.addEventListener('resize', schedule);
}
