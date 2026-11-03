import type { PDFDoc } from './engine';

/**
 * 重排视图用的整页位图：图表截图与行内公式都从这里裁取，每页只渲染一次。
 * 只保留最近用到的几页，避免手机上占用过多内存。
 */
export interface PageBitmap {
  canvas: HTMLCanvasElement;
  /** 位图像素 / PDF 点 */
  scale: number;
}

const KEEP = 3;
/** 单页位图的像素上限（iOS 对画布尺寸与总内存都有限制） */
const MAX_PIXELS = 7_000_000;
const cache = new WeakMap<PDFDoc, Map<number, Promise<PageBitmap>>>();

export function pageBitmap(pdf: PDFDoc, n: number): Promise<PageBitmap> {
  let m = cache.get(pdf);
  if (!m) {
    m = new Map();
    cache.set(pdf, m);
  }
  const hit = m.get(n);
  if (hit) {
    // 最近使用的放到最后
    m.delete(n);
    m.set(n, hit);
    return hit;
  }
  const p = render(pdf, n);
  m.set(n, p);
  p.catch(() => m!.delete(n));
  while (m.size > KEEP) {
    const oldest = m.keys().next().value as number;
    // 只从缓存移除；仍在使用它的组件画完后由垃圾回收释放
    m.delete(oldest);
  }
  return p;
}

async function render(pdf: PDFDoc, n: number): Promise<PageBitmap> {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3.5, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, scale };
}
