import { tr } from '../core/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { pdfjs, type PDFDoc } from '../pdf/engine';
import type { Annotation, InkColor, InkShape, Rect, Shape, TextShape } from '../core/types';
import { contextOf, locateQuote, pointInRects } from '../core/anchor';
import { rawOffsetAtPoint, rawText, readableSlice, rectsForOffsets } from '../pdf/text';
import type { Tool } from './toolbar';
import type { TransBlock } from '../core/translate';
import { drawTranslation, type TransMarkSpan } from './translayer';
import { attachEndOfContent } from './endofcontent';

export interface DraftText {
  page: number;
  x: number;
  y: number;
}

/** 高亮的位置信息（端点调整时更新） */
export type HlPatch = Pick<Annotation, 'start' | 'quote' | 'prefix' | 'suffix' | 'rects'>;

/**
 * 墨色：逐像素处理。接近中性色（白纸、黑字、灰色文字）翻转明度，变成黑底白字；
 * 有颜色的像素（彩色图片、图表）保留色相并压暗，不做反色。
 */
function applyInk(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx - mn < 24) {
      const v = 255 - (r + g + b) / 3;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    } else {
      d[i] = r * 0.72;
      d[i + 1] = g * 0.72;
      d[i + 2] = b * 0.72;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** pdf.js 4.x 用 --scale-factor 计算文字层字号与尺寸；--total-scale-factor 保留给旧样式。 */
function applyScaleVars(el: HTMLElement | null, scale: number): void {
  if (!el) return;
  el.style.setProperty('--scale-factor', String(scale));
  el.style.setProperty('--total-scale-factor', String(scale));
}

/** 页面两侧留白（像素）：默认缩窄页面以留出空间，文字框可拖入其中 */
export const TEXT_SIDE_PX = 120;

interface Props {
  pdf: PDFDoc;
  num: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  scrollRef: { current: HTMLDivElement | null };
  anns: Annotation[];
  shapes: Shape[];
  unanchored: Set<string>;
  focusId: string | null;
  tool: Tool;
  penColor: InkColor;
  markerColor: InkColor;
  draft: DraftText | null;
  touchSelection: { page: number; start: number; end: number; rects: Rect[] } | null;
  showTouchSelectionHandles: boolean;
  onRendered: (page: number, pageEl: HTMLElement, layer: HTMLElement) => void;
  onAddInk: (page: number, points: [number, number][], marker: boolean) => void;
  onStartText: (page: number, x: number, y: number) => void;
  onCommitDraft: (text: string) => void;
  onCancelDraft: () => void;
  onUpdateText: (id: string, text: string) => void;
  onUpdateTextGeom: (id: string, g: { x: number; y: number; w: number }) => void;
  /** 两侧留白（像素），文字框可以拖到页面左右两侧 */
  sideRoom: number;
  /** 墨色模式：纯黑底白字，彩色像素保留颜色并压暗 */
  ink: boolean;
  onDeleteShape: (id: string) => void;
  selectedId: string | null;
  onSelectHl: (id: string | null) => void;
  onAdjustHl: (id: string, patch: HlPatch) => void;
  onDeleteHl: (id: string) => void;
  /** 译文块（已翻译时非空）：直接绘制到页面位图上替换原文 */
  trans: TransBlock[] | null;
  /** 译文中的高亮位置：译文块序号 → 区间 */
  transMarks: Map<number, TransMarkSpan[]> | null;
}

/**
 * 单页：canvas（PDF）→ 高亮层 → 文本层（选择） → 手绘层 → 文字框 → 交互层。
 * 进入视口才渲染。夜间模式与纸面底色通过 CSS 变量在 canvas 上处理。
 */
export function PdfPage(props: Props) {
  const { pdf, num, top, width, height, scale, scrollRef, tool } = props;
  const trans = props.trans;
  const ink = props.ink;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  /** 显示译文时高亮在译文上的矩形（页面比例坐标） */
  const [transRects, setTransRects] = useState<Map<string, Rect[]>>(new Map());
  const transMarks = props.transMarks;
  const [draftInk, setDraftInk] = useState<[number, number][] | null>(null);
  const inkRef = useRef<[number, number][] | null>(null);
  const onRenderedRef = useRef(props.onRendered);
  onRenderedRef.current = props.onRendered;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { root: scrollRef.current, rootMargin: '1200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRef]);

  // 画布：缩放 / 主题 / 译文变化时重绘。离屏渲染完成后一次性替换，旧画面始终可见（不闪烁）。
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { promise: Promise<unknown>; cancel(): void } | null = null;
    (async () => {
      const page = await pdf.getPage(num);
      if (cancelled) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      // 注意：此处不能碰 canvas.width / height，否则会立刻清空现有画面。
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width * dpr);
      off.height = Math.floor(vp.height * dpr);
      const offCtx = off.getContext('2d');
      if (!offCtx) return;
      task = page.render({ canvasContext: offCtx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise;
      if (cancelled) return;
      // CSS 尺寸由样式（100% 填满页面）决定：布局一变，旧位图立即被拉伸到新尺寸，等新位图就绪再换成清晰的。
      canvas.width = off.width;
      canvas.height = off.height;
      const cctx = canvas.getContext('2d');
      cctx?.drawImage(off, 0, 0);
      if (trans && trans.length && cctx) {
        const hits = drawTranslation(cctx, trans, scale * dpr, transMarks ?? undefined);
        const W = canvas.width;
        const H = canvas.height;
        const next = new Map<string, Rect[]>();
        for (const [id, rs] of hits) next.set(id, rs.map((r) => ({ x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H })));
        setTransRects(next);
      } else setTransRects(new Map());
      if (ink && cctx) applyInk(cctx, canvas.width, canvas.height);

      // The PDF canvas is already complete. Reveal it before waiting for the
      // selectable text layer; on older Safari the latter can stall even when
      // the actual page drawing succeeded.
      setRendered(true);
    })().catch((e: unknown) => {
      if (!cancelled && !(e instanceof Error && /cancel/i.test(e.name + e.message))) console.error(`第 ${num} 页渲染失败`, e);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, scale, pdf, num, ink, trans, transMarks]);

  // 文字层：每页只构建一次。缩放时 DOM 保持不动（选区不会丢），
  // 位置用百分比、字号用 --scale-factor，随页面尺寸实时变化；这里只负责同步该变量。
  const textLayerRef = useRef<InstanceType<typeof pdfjs.TextLayer> | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let tl: InstanceType<typeof pdfjs.TextLayer> | null = null;
    let detach: (() => void) | null = null;
    (async () => {
      const page = await pdf.getPage(num);
      if (cancelled) return;
      const layer = layerRef.current;
      if (!layer) return;
      const vp = page.getViewport({ scale: scaleRef.current });
      layer.replaceChildren();
      applyScaleVars(wrapRef.current, scaleRef.current);
      tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport: vp });
      textLayerRef.current = tl;
      await tl.render();
      if (cancelled || !wrapRef.current) return;
      detach = attachEndOfContent(layer);
      // 构建期间若缩放过，补一次更新
      if (scaleRef.current !== vp.scale) tl.update({ viewport: page.getViewport({ scale: scaleRef.current }) });
      onRenderedRef.current(num, wrapRef.current, layer);
    })().catch((e: unknown) => {
      if (!cancelled && !(e instanceof Error && /cancel/i.test(e.name + e.message))) console.error(`第 ${num} 页文字层失败`, e);
    });
    return () => {
      cancelled = true;
      tl?.cancel();
      detach?.();
      if (textLayerRef.current === tl) textLayerRef.current = null;
    };
  }, [visible, pdf, num]);

  // 缩放：与布局变化在同一次提交里同步 CSS 变量，并让 pdf.js 重算每个 span 的横向拉伸
  useLayoutEffect(() => {
    applyScaleVars(wrapRef.current, scale);
    const tl = textLayerRef.current;
    if (!tl) return;
    void pdf.getPage(num).then((page) => {
      if (textLayerRef.current === tl) tl.update({ viewport: page.getViewport({ scale: scaleRef.current }) });
    });
  }, [scale, pdf, num]);

  /** 指针坐标 → 页面比例坐标 */
  const toRatio = (e: PointerEvent | MouseEvent): [number, number] | null => {
    const el = wrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  const inking = tool === 'pen' || tool === 'marker';
  const onPenDown = (e: PointerEvent) => {
    // 触摸不落笔：手指用于平移与缩放，手掌误触也因此不会留下笔迹
    if (!inking || e.pointerType === 'touch') return;
    const pt = toRatio(e);
    if (!pt) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    inkRef.current = [pt];
    setDraftInk([pt]);
    e.preventDefault();
  };
  const onPenMove = (e: PointerEvent) => {
    if (!inkRef.current) return;
    const pt = toRatio(e);
    if (!pt) return;
    const last = inkRef.current[inkRef.current.length - 1];
    // 过滤过密的点，减小数据体积
    if (Math.abs(last[0] - pt[0]) + Math.abs(last[1] - pt[1]) < 0.002) return;
    inkRef.current = [...inkRef.current, pt];
    setDraftInk(inkRef.current);
  };
  const onPenUp = () => {
    const pts = inkRef.current;
    inkRef.current = null;
    setDraftInk(null);
    if (pts && pts.length > 1) props.onAddInk(num, pts, tool === 'marker');
  };

  const onSurfaceClick = (e: MouseEvent) => {
    if (tool !== 'text') return;
    const pt = toRatio(e);
    if (pt) props.onStartText(num, pt[0], pt[1]);
  };

  // ---- 高亮：点选后出现两端手柄与删除按钮 ----
  const [preview, setPreview] = useState<{ id: string; rects: Rect[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ id: string; side: 'start' | 'end'; start: number; end: number; moved: boolean } | null>(null);
  const selAnn = props.selectedId ? props.anns.find((a) => a.id === props.selectedId) ?? null : null;
  const selRects: Rect[] = selAnn ? (preview && preview.id === selAnn.id ? preview.rects : selAnn.rects) : [];

  const onPageClick = (e: MouseEvent) => {
    if (tool !== 'select') return;
    if ((e.target as HTMLElement).closest('.hl-ctl')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const pt = toRatio(e);
    if (!pt) return;
    const hit = props.anns.find((a) => pointInRects(rectsShown(a), pt[0], pt[1]));
    props.onSelectHl(hit ? hit.id : null);
  };

  const onHandleDown = (side: 'start' | 'end', id: string) => (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const a = props.anns.find((x) => x.id === id);
    const layer = layerRef.current;
    if (!a || !layer) return;
    // 重新定位当前文字范围（偏移以当前文本层为准）
    const m = locateQuote(rawText(layer), { quote: a.quote, prefix: a.prefix, suffix: a.suffix, start: a.start });
    if (!m) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id, side, start: m.start, end: m.end, moved: false };
    setDragging(true);
  };
  const onHandleMove = (e: PointerEvent) => {
    const d = dragRef.current;
    const layer = layerRef.current;
    const pageEl = wrapRef.current;
    if (!d || !layer || !pageEl) return;
    const off = rawOffsetAtPoint(layer, e.clientX, e.clientY);
    if (off === null) return;
    if (d.side === 'start') d.start = Math.min(off, d.end - 1);
    else d.end = Math.max(off, d.start + 1);
    d.moved = true;
    setPreview({ id: d.id, rects: rectsForOffsets(layer, pageEl, d.start, d.end) });
  };
  const onHandleUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    const layer = layerRef.current;
    const pageEl = wrapRef.current;
    if (!d || !d.moved || !layer || !pageEl) {
      setPreview(null);
      return;
    }
    const rects = rectsForOffsets(layer, pageEl, d.start, d.end);
    if (rects.length === 0) {
      setPreview(null);
      return;
    }
    const ctx = contextOf(rawText(layer), d.start, d.end);
    props.onAdjustHl(d.id, { start: d.start, quote: readableSlice(layer, d.start, d.end), prefix: ctx.prefix, suffix: ctx.suffix, rects });
    setPreview(null);
  };

  // 显示译文时：落在译文块上的那部分高亮改画在对应的译文上，其余部分保持原位
  const transBoxes: Rect[] = trans && width > 0 && height > 0
    ? trans.map((b) => ({ x: (b.x * scale) / width, y: (b.y * scale) / height, w: (b.w * scale) / width, h: (b.h * scale) / height }))
    : [];
  const inTrans = (r: Rect) => transBoxes.some((t) => r.x + r.w / 2 >= t.x && r.x + r.w / 2 <= t.x + t.w && r.y + r.h / 2 >= t.y && r.y + r.h / 2 <= t.y + t.h);
  const rectsShown = (a: Annotation): Rect[] => {
    if (!transBoxes.length) return a.rects;
    return [...a.rects.filter((r) => !inTrans(r)), ...(transRects.get(a.id) ?? [])];
  };

  const pageSize = width > 0 ? height / width : 1;
  const inks = props.shapes.filter((s): s is InkShape => s.kind === 'ink');
  const texts = props.shapes.filter((s): s is TextShape => s.kind === 'text');
  const pts = (p: [number, number][]) => p.map(([x, y]) => `${x * 1000},${y * 1000 * pageSize}`).join(' ');

  return (
    <div
      class={`pdf-page tool-${tool}`}
      data-page={num}
      ref={wrapRef}
      onClick={(e: MouseEvent) => onPageClick(e)}
      style={{ top: `${top}px`, width: `${width}px`, height: `${height}px`, '--pw': `${width}px` } as Record<string, string>}
    >
      <canvas ref={canvasRef} />
      <div class="hl-layer">
        {props.anns.flatMap((a) =>
          (preview && preview.id === a.id ? preview.rects : rectsShown(a)).map((r, i) => (
            <div
              key={`${a.id}-${i}`}
              class={`hl ${a.color} ${a.decoration ?? 'highlight'} ${props.focusId === a.id ? 'focus' : ''} ${props.unanchored.has(a.id) ? 'loose' : ''} ${props.selectedId === a.id ? 'selected' : ''}`}
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            />
          )),
        )}
      </div>
      <div class="textLayer" ref={layerRef} />
      {props.touchSelection?.page === num && props.touchSelection.rects.length > 0 && (() => {
        const rects = props.touchSelection.rects;
        const first = rects[0];
        const last = rects[rects.length - 1];
        return (
          <div class="touch-selection-layer" aria-hidden="true">
            {rects.map((r, i) => (
              <div
                key={i}
                class="touch-selection-rect"
                style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
              />
            ))}
            {props.showTouchSelectionHandles && (
              <>
                <div
                  class="touch-selection-handle start"
                  data-touch-selection-handle="start"
                  style={{ left: `${first.x * 100}%`, top: `${(first.y + first.h) * 100}%` }}
                />
                <div
                  class="touch-selection-handle end"
                  data-touch-selection-handle="end"
                  style={{ left: `${(last.x + last.w) * 100}%`, top: `${(last.y + last.h) * 100}%` }}
                />
              </>
            )}
          </div>
        );
      })()}

      <svg class="ink-layer" viewBox={`0 0 1000 ${1000 * pageSize}`} preserveAspectRatio="none" aria-hidden="true">
        {inks.flatMap((s) => {
          const erase = tool === 'eraser' ? (e: PointerEvent) => { e.stopPropagation(); props.onDeleteShape(s.id); } : undefined;
          const line = (
            <polyline key={s.id} class={`ink-stroke k-${s.color}${s.marker ? ' marker' : ''}`} points={pts(s.points)} />
          );
          // 橡皮模式下额外铺一条更宽的透明线，便于点中细笔迹
          const hit = erase && (
            <polyline
              key={`${s.id}-hit`}
              class="hit"
              points={pts(s.points)}
              fill="none"
              stroke="transparent"
              stroke-width="14"
              stroke-linecap="round"
              stroke-linejoin="round"
              onPointerDown={erase}
            />
          );
          return hit ? [line, hit] : [line];
        })}
        {draftInk && draftInk.length > 1 && (
          <polyline class={`ink-stroke k-${tool === 'marker' ? props.markerColor : props.penColor}${tool === 'marker' ? ' marker' : ''}`} points={pts(draftInk)} />
        )}
      </svg>

      <div class="shape-layer">
        {texts.map((s) => (
          <TextBox
            key={s.id}
            x={s.x}
            y={s.y}
            w={s.w}
            size={s.size}
            color={s.color}
            text={s.text}
            interactive={tool === 'select' || tool === 'text'}
            onCommit={(t) => (t ? props.onUpdateText(s.id, t) : props.onDeleteShape(s.id))}
            onGeom={(g) => props.onUpdateTextGeom(s.id, g)}
            side={props.sideRoom}
          />
        ))}
        {props.draft && props.draft.page === num && (
          <TextBox
            x={props.draft.x}
            y={props.draft.y}
            w={0.32}
            size={0.017}
            color={props.penColor}
            text=""
            interactive
            autoFocus
            onCommit={(t) => (t ? props.onCommitDraft(t) : props.onCancelDraft())}
          />
        )}
      </div>

      <div
        class={`surface ${inking ? 'pen' : ''} ${tool === 'text' ? 'text' : ''}`}
        onPointerDown={(e: PointerEvent) => onPenDown(e)}
        onPointerMove={(e: PointerEvent) => onPenMove(e)}
        onPointerUp={() => onPenUp()}
        onPointerCancel={() => onPenUp()}
        onClick={(e: MouseEvent) => onSurfaceClick(e)}
      />

      {selAnn && tool === 'select' && selRects.length > 0 && (() => {
        const first = selRects[0];
        const last = selRects[selRects.length - 1];
        const minY = Math.min(...selRects.map((r) => r.y));
        const right = Math.max(...selRects.filter((r) => Math.abs(r.y - minY) < 0.001).map((r) => r.x + r.w));
        const id = selAnn.id;
        return (
          <div class={`hl-ctl${dragging ? ' dragging' : ''}`}>
            <div
              class="hl-handle start"
              style={{ left: `${first.x * 100}%`, top: `${first.y * 100}%`, height: `${first.h * 100}%` }}
              onPointerDown={onHandleDown('start', id)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
            />
            <div
              class="hl-handle end"
              style={{ left: `${(last.x + last.w) * 100}%`, top: `${last.y * 100}%`, height: `${last.h * 100}%` }}
              onPointerDown={onHandleDown('end', id)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
            />
            <button
              type="button"
              class="hl-del"
              aria-label={tr('删除高亮')}
              title={tr('删除高亮')}
              style={{ left: `${right * 100}%`, top: `${minY * 100}%` }}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                props.onDeleteHl(id);
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2l6 6M8 2l-6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        );
      })()}
      {!rendered && <div class="page-placeholder">{tr('第 {num} 页', { num })}</div>}
    </div>
  );
}

function TextBox(p: {
  x: number;
  y: number;
  w: number;
  size: number;
  color: InkColor;
  text: string;
  interactive: boolean;
  autoFocus?: boolean;
  onCommit: (text: string) => void;
  /** 拖动或调整宽度结束时回写位置 */
  onGeom?: (g: { x: number; y: number; w: number }) => void;
  /** 两侧留白（像素） */
  side?: number;
}) {
  const [editing, setEditing] = useState(!!p.autoFocus);
  const [value, setValue] = useState(p.text);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setValue(p.text), [p.text]);
  // Preact 不会在挂载时聚焦 autoFocus，进入编辑时需要显式聚焦
  useEffect(() => {
    if (!editing) return;
    const t = taRef.current;
    t?.focus();
    // 新建的文字框居中显示，避免落在底部工具栏下面
    if (p.autoFocus) t?.scrollIntoView({ block: 'center' });
  }, [editing]);
  // 位置与宽度：拖动中只更新本地预览，松开时写回文档
  const [geo, setGeo] = useState({ x: p.x, y: p.y, w: p.w });
  const geoRef = useRef(geo);
  const setGeoBoth = (g: { x: number; y: number; w: number }) => {
    geoRef.current = g;
    setGeo(g);
  };
  const drag = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; g: { x: number; y: number; w: number }; pw: number; ph: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    if (!drag.current) setGeoBoth({ x: p.x, y: p.y, w: p.w });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.x, p.y, p.w]);

  const beginDrag = (mode: 'move' | 'resize', e: PointerEvent) => {
    if (!p.interactive || editing) return;
    const target = e.currentTarget as HTMLElement;
    const page = target.closest('.pdf-page');
    if (!page) return;
    const r = page.getBoundingClientRect();
    target.setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, g: geoRef.current, pw: r.width, ph: r.height, moved: false };
    e.preventDefault();
    e.stopPropagation();
  };
  const onDragMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dxPx = e.clientX - d.sx;
    const dyPx = e.clientY - d.sy;
    if (!d.moved && Math.abs(dxPx) + Math.abs(dyPx) < 3) return;
    d.moved = true;
    const dx = dxPx / d.pw;
    const dy = dyPx / d.ph;
    // 允许拖进页面两侧的留白，但不超过留白宽度
    const room = (p.side ?? 0) / d.pw;
    if (d.mode === 'move') setGeoBoth({ x: clamp(d.g.x + dx, -room, 1 + room - d.g.w), y: clamp(d.g.y + dy, 0, 0.98), w: d.g.w });
    else setGeoBoth({ x: d.g.x, y: d.g.y, w: clamp(d.g.w + dx, 0.06, 1 + room - d.g.x) });
  };
  const onDragEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    suppressClick.current = true;
    p.onGeom?.(geoRef.current);
  };

  const style = {
    left: `${geo.x * 100}%`,
    top: `${geo.y * 100}%`,
    width: `${geo.w * 100}%`,
    fontSize: `calc(var(--pw) * ${p.size})`,
  } as Record<string, string>;

  if (editing) {
    return (
      <textarea
        ref={taRef}
        class={`tbox editing k-${p.color}`}
        style={style}
        value={value}
        autoFocus
        rows={Math.max(1, value.split('\n').length)}
        placeholder={tr('输入文字')}
        onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
        onBlur={() => {
          setEditing(false);
          p.onCommit(value.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <div
      class={`tbox ${p.interactive ? 'live' : ''} k-${p.color}`}
      style={style}
      onPointerDown={(e: PointerEvent) => beginDrag('move', e)}
      onPointerMove={(e: PointerEvent) => onDragMove(e)}
      onPointerUp={() => onDragEnd()}
      onPointerCancel={() => onDragEnd()}
      onClick={(e) => {
        if (!p.interactive) return;
        e.stopPropagation();
        // 拖动结束后的那次点击不进入编辑
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        setEditing(true);
      }}
    >
      {p.text}
      {p.interactive && <span class="tbox-grip" onPointerDown={(e: PointerEvent) => beginDrag('resize', e)} />}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
