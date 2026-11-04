/**
 * pdf.js 官方查看器（TextLayerBuilder）里的“选区兜底”机制，移植自 pdfjs-dist 4.10。
 *
 * 文字层里的 span 是绝对定位、彼此没有 DOM 上的几何关系；选区拖到空白处（图片、页边）时，
 * 浏览器（尤其 Safari）会把选区终点落在文字层末尾，画出一大块跨越整页的色块，或让选区乱跳。
 * 做法：在文字层末尾放一个 .endOfContent，选择过程中把它挪到“锚点”附近并撑满整页，
 * 让浏览器把空白区域的命中落在它身上；选择结束后再放回末尾。
 */

const layers = new Map<HTMLElement, HTMLElement>();
let abort: AbortController | null = null;

function reset(end: HTMLElement, layer: HTMLElement): void {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  layer.classList.remove('selecting');
}

function enableGlobal(): void {
  if (abort) return;
  abort = new AbortController();
  const { signal } = abort;
  let pointerDown = false;
  const resetAll = () => layers.forEach(reset);
  document.addEventListener('pointerdown', () => (pointerDown = true), { signal });
  document.addEventListener(
    'pointerup',
    () => {
      pointerDown = false;
      resetAll();
    },
    { signal },
  );
  window.addEventListener(
    'blur',
    () => {
      pointerDown = false;
      resetAll();
    },
    { signal },
  );
  document.addEventListener(
    'keyup',
    () => {
      if (!pointerDown) resetAll();
    },
    { signal },
  );

  let prevRange: Range | null = null;
  document.addEventListener(
    'selectionchange',
    () => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) {
        resetAll();
        return;
      }
      const active = new Set<HTMLElement>();
      for (let i = 0; i < sel.rangeCount; i++) {
        const r = sel.getRangeAt(i);
        for (const l of layers.keys()) if (!active.has(l) && r.intersectsNode(l)) active.add(l);
      }
      for (const [l, end] of layers) {
        if (active.has(l)) l.classList.add('selecting');
        else reset(end, l);
      }
      const range = sel.getRangeAt(0);
      const modifyStart =
        !!prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node = modifyStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode as Node;
      const parent = (anchor as Node).parentElement;
      const layer = parent?.closest<HTMLElement>('.textLayer') ?? null;
      const end = layer ? layers.get(layer) : undefined;
      if (layer && end && parent) {
        end.style.width = layer.style.width;
        end.style.height = layer.style.height;
        parent.insertBefore(end, modifyStart ? anchor : (anchor as Node).nextSibling);
      }
      prevRange = range.cloneRange();
    },
    { signal },
  );
}

/** 为一个已渲染完成的文字层挂上 endOfContent；返回注销函数。 */
export function attachEndOfContent(layer: HTMLElement): () => void {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
  const onDown = () => layer.classList.add('selecting');
  layer.addEventListener('mousedown', onDown);
  layers.set(layer, end);
  enableGlobal();
  return () => {
    layer.removeEventListener('mousedown', onDown);
    layers.delete(layer);
    if (layers.size === 0) {
      abort?.abort();
      abort = null;
    }
  };
}
