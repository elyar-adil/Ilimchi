import { tr } from '../core/i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { arxivRef, normalizeVersion, parseArxivId, withVersion } from '../core/ids';
import { fetchArxivMeta, isNewerVersion } from '../core/arxivmeta';
import {
  addAnnotation, addShape, liveAnnotations, liveShapes, newId, removeAnnotation, removeShape,
  setField, setProgress, updateAnnotation, updateShape, displayTitle,
} from '../core/model';
import { contextOf, locateQuote } from '../core/anchor';
import { loadPdf, importLocalPdf, PdfLoadError } from '../core/pdfsource';
import { cacheKey } from '../core/pdfcache';
import { pdfCache } from '../core/services';
import { getPrefs, setPrefs, subscribePrefs } from '../core/prefs';
import { guessMeta, type TextItem } from '../core/titleguess';
import type { PaperStore } from '../core/store';
import type { Annotation, HighlightColor, InkColor, InkShape, PaperDoc, Rect, Shape, TextShape } from '../core/types';
import { HIGHLIGHT_COLORS, MARKER_COLORS, PEN_COLORS } from '../core/types';
import { openPdf, type PDFDoc } from '../pdf/engine';
import { rawOffsetAtPoint, rawText, readableSlice, rectsForOffsets, selectionToPending, type PendingSelection } from '../pdf/text';
import { navigate, useStoreRerender } from './nav';
import { restoreSnapshot, snapshotOf, type Snapshot } from '../core/undo';
import { sourceLabel } from './shared';
import { EditableText, TagEditor } from './fields';
import { TEXT_SIDE_PX, type HlPatch } from './pdfpage';
import { PdfPage, type DraftText } from './pdfpage';
import { TopBar, FloatingTools, type Tool } from './toolbar';
import { Icon } from './icons';
import { askConfirm } from './confirm';
import 'pdfjs-dist/web/pdf_viewer.css';

const GAP = 16;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

interface Loaded {
  pdf: PDFDoc;
  fp: string;
  sizes: { w: number; h: number }[];
  via: string;
}

type LoadState =
  | { kind: 'loading'; done?: number; total?: number }
  | { kind: 'ready'; loaded: Loaded }
  | { kind: 'error'; message: string; code?: string };

interface TouchTextSelection {
  page: number;
  layer: HTMLElement;
  pageEl: HTMLElement;
  start: number;
  end: number;
  rects: Rect[];
}

interface TouchPointerCandidate {
  pointerId: number;
  startX: number;
  startY: number;
  layer: HTMLElement;
  pageEl: HTMLElement;
  page: number;
  mode: 'pending' | 'selecting' | 'adjusting' | 'panning';
  start: number;
  end: number;
  edge?: 'start' | 'end';
  timer?: number;
  handleEl?: HTMLElement;
}

/** Long-press selects a word without invoking the browser's native text selection UI. */
function wordRangeAt(text: string, offset: number): { start: number; end: number } {
  if (!text.length) return { start: 0, end: 0 };
  const at = Math.max(0, Math.min(text.length - 1, offset));
  const char = text[at];
  // CJK scripts are not space-delimited; select a single character as a predictable starting point.
  if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(char)) {
    return { start: at, end: at + 1 };
  }
  const word = /[\p{L}\p{N}_]/u;
  if (!word.test(char)) return { start: at, end: at + 1 };
  let start = at;
  let end = at + 1;
  while (start > 0 && word.test(text[start - 1])) start--;
  while (end < text.length && word.test(text[end])) end++;
  return { start, end };
}

function makeTouchSelection(layer: HTMLElement, pageEl: HTMLElement, page: number, a: number, b: number): TouchTextSelection | null {
  const length = rawText(layer).length;
  const start = Math.max(0, Math.min(length, Math.min(a, b)));
  const end = Math.max(0, Math.min(length, Math.max(a, b)));
  if (end <= start) return null;
  const rects = rectsForOffsets(layer, pageEl, start, end);
  return rects.length ? { page, layer, pageEl, start, end, rects } : null;
}

/** Convert the app-owned touch range to the same data shape used by desktop selection. */
function touchSelectionToPending(selection: TouchTextSelection, viewer: HTMLElement): PendingSelection | null {
  const raw = rawText(selection.layer);
  const quote = readableSlice(selection.layer, selection.start, selection.end);
  if (!quote) return null;
  const context = contextOf(raw, selection.start, selection.end);
  const rects = selection.rects;
  const pageBox = selection.pageEl.getBoundingClientRect();
  const viewerBox = viewer.getBoundingClientRect();
  const top = Math.min(...rects.map((r) => r.y)) * pageBox.height + pageBox.top;
  const last = rects[rects.length - 1];
  const left = (last.x + last.w / 2) * pageBox.width + pageBox.left;
  return {
    page: selection.page,
    pageEl: selection.pageEl,
    layer: selection.layer,
    start: selection.start,
    end: selection.end,
    quote,
    prefix: context.prefix,
    suffix: context.suffix,
    rects,
    anchorTop: Math.max(0, top - viewerBox.top + viewer.scrollTop),
    anchorLeft: left - viewerBox.left + viewer.scrollLeft,
  };
}

export function Reader({ store, paperId, onOpenSettings }: { store: PaperStore; paperId: string; onOpenSettings: () => void }) {
  useStoreRerender(store);
  const doc = store.get(paperId) as PaperDoc;
  const docRef = useRef(doc);
  docRef.current = doc;
  const prefs = usePrefs();

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  /** 相对“适宽”的缩放倍数；1 = 适宽 */
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const zoomAnchor = useRef<{ ratio: number; y: number } | null>(null);
  const [width, setWidth] = useState(800);
  const [showSide, setShowSide] = useState(() => getPrefs().sidebar);
  const [focusId, setFocusId] = useState<string | null>(null);
  /** 当前点选、可调整端点的高亮 */
  const [hlSel, setHlSel] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [touchSelection, setTouchSelection] = useState<TouchTextSelection | null>(null);
  const touchSelectionRef = useRef<TouchTextSelection | null>(null);
  touchSelectionRef.current = touchSelection;
  const writeTouchSelection = (next: TouchTextSelection | null) => {
    touchSelectionRef.current = next;
    setTouchSelection(next);
  };
  const [unanchored, setUnanchored] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const [draft, setDraft] = useState<DraftText | null>(null);
  // 撤销 / 重做：只记录用户对标注的修改，快照包含墓碑
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const syncHistory = () => setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });

  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relocating = useRef(new Set<string>());

  // 打开时单独记录时间，不依赖翻页进度；刚打开但尚未滚动的论文也排在最前。
  useEffect(() => {
    const openedAt = Date.now();
    void store.mutate(paperId, (d) => ({ ...d, lastOpenedAt: Math.max(d.lastOpenedAt ?? 0, openedAt) }), { lowPriority: true }).catch(() => undefined);
  }, [store, paperId]);

  // 只累计 PDF 已就绪且标签页可见的时间。每次打开产生独立 session ID，合并时不会互相覆盖。
  useEffect(() => {
    if (load.kind !== 'ready') return;
    const sessionId = newId();
    let activeSince: number | null = document.visibilityState === 'visible' ? performance.now() : null;
    let pendingMs = 0;
    const flush = () => {
      if (activeSince !== null) {
        pendingMs += Math.max(0, performance.now() - activeSince);
        activeSince = performance.now();
      }
      const elapsed = Math.floor(pendingMs);
      if (elapsed < 1) return;
      pendingMs -= elapsed;
      void store.mutate(paperId, (d) => {
        const sessions = d.readingSessions ?? {};
        return { ...d, readingSessions: { ...sessions, [sessionId]: (sessions[sessionId] ?? 0) + elapsed } };
      }, { lowPriority: true }).catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flush();
        activeSince = null;
      } else if (activeSince === null) {
        activeSince = performance.now();
      }
    };
    const timer = window.setInterval(() => { if (activeSince !== null) flush(); }, 15_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (activeSince !== null) flush();
    };
  }, [store, paperId, load.kind]);

  // 工具切换时清理未完成的操作
  useEffect(() => {
    setDraft(null);
    setPending(null);
    writeTouchSelection(null);
  }, [tool]);

  /** 记录修改前的快照后再写入；新的修改会清空重做栈。 */
  const edit = (mut: (d: PaperDoc) => PaperDoc) => {
    const cur = store.get(paperId);
    if (cur) {
      undoStack.current = [...undoStack.current.slice(-49), snapshotOf(cur)];
      redoStack.current = [];
      syncHistory();
    }
    return store.mutate(paperId, mut);
  };
  const undo = () => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    const cur = store.get(paperId);
    if (cur) redoStack.current.push(snapshotOf(cur));
    syncHistory();
    void store.mutate(paperId, (d) => restoreSnapshot(d, snap, Date.now()));
  };
  const redo = () => {
    const snap = redoStack.current.pop();
    if (!snap) return;
    const cur = store.get(paperId);
    if (cur) undoStack.current.push(snapshotOf(cur));
    syncHistory();
    void store.mutate(paperId, (d) => restoreSnapshot(d, snap, Date.now()));
  };
  const undoRef2 = useRef({ undo, redo });
  undoRef2.current = { undo, redo };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTool('select');
        setHlSel(null);
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.metaKey || e.ctrlKey) && !typing && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) undoRef2.current.redo();
        else undoRef2.current.undo();
      } else if ((e.metaKey || e.ctrlKey) && !typing && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        undoRef2.current.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- 加载 PDF ----------
  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    restoredRef.current = false;
    (async () => {
      setLoad({ kind: 'loading' });
      try {
        const d = docRef.current;
        let bytes: ArrayBuffer;
        let via = 'cache';
        if (d.url) {
          const r = await loadPdf({
            paperId: d.id,
            version: d.version,
            url: d.url,
            proxyTemplate: getPrefs().proxy,
            cache: pdfCache,
            signal: ctrl.signal,
            onProgress: (done, total) => alive && setLoad({ kind: 'loading', done, total }),
            refresh: reloadKey > 0,
          });
          bytes = r.data;
          via = r.via;
        } else {
          const hit = await pdfCache.get(cacheKey(d.id, ''));
          if (!hit) throw new PdfLoadError(tr('这篇论文的 PDF 不在本设备上，请重新选择对应的文件'), 'blocked');
          bytes = hit.data;
        }
        const pdf = await openPdf(bytes);
        const fp = pdf.fingerprints?.[0] ?? `${bytes.byteLength}:${pdf.numPages}`;
        const sizes: { w: number; h: number }[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const p = await pdf.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          sizes.push({ w: vp.width, h: vp.height });
        }
        if (!alive) return;
        setLoad({ kind: 'ready', loaded: { pdf, fp, sizes, via } });
        void enrich(pdf, d.id, d.version, d.url);
      } catch (e) {
        if (!alive || (e instanceof DOMException && e.name === 'AbortError')) return;
        setLoad({ kind: 'error', message: e instanceof Error ? e.message : String(e), code: e instanceof PdfLoadError ? e.code : undefined });
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, doc.url, doc.version, reloadKey]);

  /** 首次打开时补全标题与作者；发现 arXiv 新版本则提示。 */
  async function enrich(pdf: PDFDoc, id: string, version: string, url: string) {
    try {
      // 先从 PDF 第一页推断标题与作者（不依赖网络）
      const first = await pdf.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const tc = await first.getTextContent();
      const items = tc.items.filter((it) => 'str' in it).map((it) => it as unknown as TextItem);
      const guess = guessMeta(items, vp.height);
      if (pdf.numPages !== docRef.current.progress.pages) {
        await store.mutate(id, (d) => ({ ...d, progress: { ...d.progress, pages: pdf.numPages } }), { lowPriority: true });
      }
      const ax = parseArxivId(url.replace(/^https?:\/\/arxiv\.org\/pdf\//, ''))?.id ?? (id.startsWith('arxiv-') ? id.slice(6).replace('_', '/') : null);
      // arXiv 元数据优先（若可取得），否则用 PDF 推断结果；只填空字段，不覆盖用户已有内容
      const meta = ax ? await fetchArxivMeta(ax) : null;
      await store.mutate(id, (d) => {
        let n = d;
        if (!n.title.trim()) {
          const t = meta?.title || guess.title;
          if (t) n = setField(n, 'title', t);
        }
        if (!n.authors.trim()) {
          const a = meta?.authors || guess.authors;
          if (a) n = setField(n, 'authors', a);
        }
        return n;
      });
      if (meta && isNewerVersion(meta.latestVersion, version)) setNewVersion(meta.latestVersion);
    } catch {
      /* 元数据补全是尽力而为 */
    }
  }

  // ---------- 布局 ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [load.kind]);

  // 墨色模式是否实际生效（考虑“自动”时的系统深色设置）
  const inkOn = prefs.darkStyle === 'ink' && (prefs.theme === 'dark' || (prefs.theme === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  // 宽屏时页面两侧留白，文字框可以拖进去；窄屏（手机）不留白
  const sideRoom = width >= 640 ? TEXT_SIDE_PX : 0;
  const baseScale = load.kind === 'ready' ? fitScale(load.loaded.sizes, width, sideRoom) : 1;
  const scale = baseScale * zoom;
  const layout = useMemo(() => {
    if (load.kind !== 'ready') return { tops: [] as number[], heights: [] as number[], widths: [] as number[], total: 0 };
    let y = GAP;
    const tops: number[] = [];
    const heights: number[] = [];
    const widths: number[] = [];
    for (const s of load.loaded.sizes) {
      tops.push(y);
      heights.push(s.h * scale);
      widths.push(s.w * scale);
      y += s.h * scale + GAP;
    }
    return { tops, heights, widths, total: y };
  }, [load, scale]);

  const layoutTotal = layout.total;
  const layoutTotalRef = useRef(0);
  layoutTotalRef.current = layoutTotal;
  const pagesRef = useRef<HTMLDivElement>(null);

  /**
   * 缩放分两步：手势进行中只改变 .pages 的 CSS 变换（不重排、不重新栅格化），
   * 手势结束（或滚轮停止）后按最终倍数重新排版，并保持锚点位置不动。
   */
  const gesture = useRef<{ z0: number; k: number; ox: number; oy: number; anchorY: number } | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTransform = () => {
    const p = pagesRef.current;
    if (!p) return;
    p.style.transform = '';
    p.style.transformOrigin = '';
    p.style.willChange = '';
  };

  /** 以视口坐标 (ax, ay) 为中心，把缩放目标设为 target（仅变换）。 */
  const zoomLive = (target: number, ax: number, ay: number) => {
    const el = scrollRef.current;
    const p = pagesRef.current;
    if (!el || !p) return;
    if (!gesture.current) {
      gesture.current = { z0: zoomRef.current, k: 1, ox: el.scrollLeft + ax, oy: el.scrollTop + ay, anchorY: ay };
    }
    const g = gesture.current;
    g.k = clampZoom(target) / g.z0;
    p.style.willChange = 'transform';
    p.style.transformOrigin = `${g.ox}px ${g.oy}px`;
    p.style.transform = `scale(${g.k})`;
    scheduleCommit(160);
  };

  const scheduleCommit = (delay: number) => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commitZoom, delay);
  };

  /** 结束缩放手势：按最终倍数排版，并把锚点放回原位。 */
  const commitZoom = () => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const z = clampZoom(g.z0 * g.k);
    if (z === zoomRef.current) {
      clearTransform();
      return;
    }
    zoomAnchor.current = { ratio: g.oy / Math.max(1, layoutTotalRef.current), y: g.anchorY };
    setZoom(z);
  };

  const zoomCenter = (next: number) => {
    const el = scrollRef.current;
    if (!el) return;
    zoomLive(next, el.clientWidth / 2, el.clientHeight / 2);
    commitZoom();
  };

  // 布局变化后：恢复锚点滚动位置，并移除临时变换（同一帧完成，不会闪烁）
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = scrollRef.current;
    if (a && el) {
      zoomAnchor.current = null;
      el.scrollTop = Math.max(0, a.ratio * layoutTotal - a.y);
    }
    clearTransform();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  /**
   * 触控与触控板手势（只作用于阅读区，不影响鼠标）：
   * - 手指拖动：平移，松手后带惯性滑动
   * - 双指捏合：缩放（以双指中点为中心）
   * - 笔处于使用中（1.5 秒内）或大面积接触（手掌）：忽略触摸，防止误触
   * - 触控板捏合 / Ctrl+滚轮：缩放阅读区，而不是整个浏览器界面
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const touches = new Map<number, { x: number; y: number }>();
    const candidates = new Map<number, TouchPointerCandidate>();
    let lastPenAt = 0;
    let pinch: { dist: number; zoom: number } | null = null;
    let samples: { t: number; x: number; y: number }[] = [];
    let inertiaId = 0;
    const PALM_PX = 40;
    const PEN_GRACE_MS = 1500;

    const stopInertia = () => {
      if (inertiaId) cancelAnimationFrame(inertiaId);
      inertiaId = 0;
    };

    /** 松手时根据最近的采样估算速度（px/ms），然后按指数衰减继续滚动。 */
    const startInertia = () => {
      const now = performance.now();
      const recent = samples.filter((s) => now - s.t <= 100);
      samples = [];
      if (recent.length < 2 || now - recent[recent.length - 1].t > 60) return;
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = b.t - a.t;
      if (dt <= 0) return;
      const clamp = (v: number) => Math.max(-3, Math.min(3, v));
      let vx = clamp((b.x - a.x) / dt);
      let vy = clamp((b.y - a.y) / dt);
      if (Math.hypot(vx, vy) < 0.05) return;
      let last = now;
      const step = (t: number) => {
        const frame = Math.min(50, t - last);
        last = t;
        const beforeY = el.scrollTop;
        const beforeX = el.scrollLeft;
        el.scrollTop -= vy * frame;
        el.scrollLeft -= vx * frame;
        const decay = Math.exp(-frame / 280);
        vx *= decay;
        vy *= decay;
        const moved = Math.abs(el.scrollTop - beforeY) + Math.abs(el.scrollLeft - beforeX);
        if (Math.hypot(vx, vy) < 0.02 || moved < 0.01) {
          inertiaId = 0;
          return;
        }
        inertiaId = requestAnimationFrame(step);
      };
      inertiaId = requestAnimationFrame(step);
    };

    const centroid = () => {
      const pts = [...touches.values()];
      return {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      };
    };
    const dist = () => {
      const [a, b] = [...touches.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    };

    const selectionOffsetAt = (c: TouchPointerCandidate, x: number, y: number): number | null => {
      const direct = rawOffsetAtPoint(c.layer, x, y);
      if (direct !== null) return direct;
      const box = c.pageEl.getBoundingClientRect();
      const px = Math.max(box.left + 2, Math.min(box.right - 2, x));
      const py = Math.max(box.top + 2, Math.min(box.bottom - 2, y));
      return rawOffsetAtPoint(c.layer, px, py);
    };

    const beginPanFromCandidate = (c: TouchPointerCandidate) => {
      if (c.timer !== undefined) window.clearTimeout(c.timer);
      c.timer = undefined;
      if (c.handleEl) c.handleEl.style.pointerEvents = '';
      c.mode = 'panning';
      touches.set(c.pointerId, { x: c.startX, y: c.startY });
      samples = [{ t: performance.now(), x: c.startX, y: c.startY }];
    };

    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const root = el.closest('.reader') as HTMLElement | null;
      const isPen = e.pointerType === 'pen';
      const isTouch = e.pointerType === 'touch';

      if (isPen) {
        lastPenAt = performance.now();
        stopInertia();
      } else if (isTouch) {
        if (performance.now() - lastPenAt < PEN_GRACE_MS) return;
        if (e.width > PALM_PX || e.height > PALM_PX) return;
        stopInertia();
      } else {
        if (e.pointerType === 'mouse') {
          if (root) root.dataset.touchSelect = 'false';
          if (target?.closest('.textLayer')) {
            setPending(null);
            writeTouchSelection(null);
          }
        }
        return;
      }

      const handle = target?.closest('[data-touch-selection-handle]') as HTMLElement | null;
      const existing = touchSelectionRef.current;
      if (handle && existing && toolRef.current === 'select' && touches.size === 0 && candidates.size === 0) {
        if (root) root.dataset.touchSelect = 'true';
        const edge = handle.dataset.touchSelectionHandle === 'start' ? 'start' : 'end';
        const candidate: TouchPointerCandidate = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          layer: existing.layer,
          pageEl: existing.pageEl,
          page: existing.page,
          mode: 'adjusting',
          start: existing.start,
          end: existing.end,
          edge,
          handleEl: handle,
        };
        // Let caretPositionFromPoint see the text underneath the handle while the finger or stylus drags.
        handle.style.pointerEvents = 'none';
        candidates.set(e.pointerId, candidate);
        try { el.setPointerCapture(e.pointerId); } catch { /* implicit pointer capture is sufficient */ }
        e.preventDefault();
        return;
      }

      const layer = target?.closest('.textLayer') as HTMLElement | null;
      if (layer && toolRef.current === 'select' && touches.size === 0 && candidates.size === 0) {
        const pageEl = layer.closest('[data-page]') as HTMLElement | null;
        if (pageEl) {
          if (root) root.dataset.touchSelect = 'true';
          setPending(null);
          writeTouchSelection(null);
          const candidate: TouchPointerCandidate = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            layer,
            pageEl,
            page: Number(pageEl.dataset.page),
            mode: isPen ? 'selecting' : 'pending',
            start: 0,
            end: 0,
          };
          if (isPen) {
            const offset = selectionOffsetAt(candidate, e.clientX, e.clientY);
            if (offset === null) {
              if (root) root.dataset.touchSelect = 'false';
              return;
            }
            const word = wordRangeAt(rawText(layer), offset);
            candidate.start = word.start;
            candidate.end = word.end;
            candidates.set(e.pointerId, candidate);
            const next = makeTouchSelection(layer, pageEl, candidate.page, candidate.start, candidate.end);
            if (next) writeTouchSelection(next);
            else {
              candidates.delete(e.pointerId);
              if (root) root.dataset.touchSelect = 'false';
              return;
            }
          } else {
            candidates.set(e.pointerId, candidate);
            candidate.timer = window.setTimeout(() => {
              if (candidate.mode !== 'pending') return;
              const offset = selectionOffsetAt(candidate, candidate.startX, candidate.startY);
              if (offset === null) {
                beginPanFromCandidate(candidate);
                return;
              }
              const word = wordRangeAt(rawText(candidate.layer), offset);
              candidate.start = word.start;
              candidate.end = word.end;
              candidate.mode = 'selecting';
              const next = makeTouchSelection(candidate.layer, candidate.pageEl, candidate.page, candidate.start, candidate.end);
              if (next) writeTouchSelection(next);
              else beginPanFromCandidate(candidate);
            }, 430);
          }
          try { el.setPointerCapture(e.pointerId); } catch { /* implicit pointer capture is sufficient */ }
          e.preventDefault();
          return;
        }
      }

      if (isPen) {
        if (root) root.dataset.touchSelect = 'false';
        return;
      }

      // A second finger should take over for pan/pinch rather than creating a second text selection.
      if (candidates.size > 0) {
        for (const candidate of candidates.values()) beginPanFromCandidate(candidate);
        writeTouchSelection(null);
        setPending(null);
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 1) samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      if (touches.size === 2) {
        samples = [];
        const base = gesture.current ? gesture.current.z0 * gesture.current.k : zoomRef.current;
        pinch = { dist: dist(), zoom: base };
      }
    };
    const onMove = (e: PointerEvent) => {
      const candidate = candidates.get(e.pointerId);
      if (candidate && candidate.mode === 'pending') {
        if (Math.hypot(e.clientX - candidate.startX, e.clientY - candidate.startY) < 9) return;
        beginPanFromCandidate(candidate);
      }
      if (candidate && (candidate.mode === 'selecting' || candidate.mode === 'adjusting')) {
        const offset = selectionOffsetAt(candidate, e.clientX, e.clientY);
        if (offset !== null) {
          if (candidate.mode === 'selecting') {
            candidate.end = offset;
          } else if (candidate.edge === 'start') {
            candidate.start = Math.min(offset, candidate.end - 1);
          } else {
            candidate.end = Math.max(offset, candidate.start + 1);
          }
          const next = makeTouchSelection(candidate.layer, candidate.pageEl, candidate.page, candidate.start, candidate.end);
          if (next) writeTouchSelection(next);
        }
        e.preventDefault();
        return;
      }

      const prev = touches.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      touches.set(e.pointerId, cur);
      if (touches.size === 1) {
        el.scrollTop -= cur.y - prev.y;
        el.scrollLeft -= cur.x - prev.x;
        samples.push({ t: performance.now(), x: cur.x, y: cur.y });
        if (samples.length > 12) samples.shift();
        return;
      }
      if (touches.size === 2 && pinch) {
        const c = centroid();
        const box = el.getBoundingClientRect();
        zoomLive(pinch.zoom * (dist() / pinch.dist), c.x - box.left, c.y - box.top);
      }
    };
    const onUp = (e: PointerEvent) => {
      const candidate = candidates.get(e.pointerId);
      if (candidate) {
        if (candidate.timer !== undefined) window.clearTimeout(candidate.timer);
        if (candidate.handleEl) candidate.handleEl.style.pointerEvents = '';
        if (candidate.mode === 'pending') {
          candidates.delete(e.pointerId);
          return;
        }
        if (candidate.mode === 'selecting' || candidate.mode === 'adjusting') {
          candidates.delete(e.pointerId);
          const selection = touchSelectionRef.current;
          const next = selection ? touchSelectionToPending(selection, el) : null;
          setPending(next);
          if (!next) writeTouchSelection(null);
          return;
        }
        candidates.delete(e.pointerId);
      }
      const wasPinch = touches.size >= 2;
      touches.delete(e.pointerId);
      if (wasPinch && touches.size < 2) {
        pinch = null;
        commitZoom();
        samples = [];
      }
      if (touches.size === 0 && !wasPinch) startInertia();
    };

    const onContextMenu = (e: Event) => {
      const root = el.closest('.reader') as HTMLElement | null;
      if (root?.dataset.touchSelect === 'true') e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const base = gesture.current ? gesture.current.z0 * gesture.current.k : zoomRef.current;
      zoomLive(base * Math.exp(-e.deltaY * 0.0025), e.clientX - box.left, e.clientY - box.top);
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContextMenu);
    return () => {
      for (const candidate of candidates.values()) {
        if (candidate.timer !== undefined) window.clearTimeout(candidate.timer);
        if (candidate.handleEl) candidate.handleEl.style.pointerEvents = '';
      }
      const root = el.closest('.reader') as HTMLElement | null;
      if (root) root.dataset.touchSelect = 'false';
      stopInertia();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind]);

  // ---------- 恢复阅读位置 ----------
  useEffect(() => {
    if (load.kind !== 'ready' || restoredRef.current || !scrollRef.current) return;
    restoredRef.current = true;
    const p = docRef.current.progress;
    if (p.page > 1 || p.offset > 0) {
      const idx = Math.min(p.page, layout.tops.length) - 1;
      const top = (layout.tops[idx] ?? 0) + p.offset * (layout.heights[idx] ?? 0);
      scrollRef.current.scrollTop = Math.max(0, top - 8);
    }
  }, [load.kind, layout]);

  // ---------- 翻页进度（防抖写入） ----------
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || load.kind !== 'ready') return;
    const y = el.scrollTop + el.clientHeight * 0.25;
    let idx = 0;
    while (idx + 1 < layout.tops.length && layout.tops[idx + 1] <= y) idx++;
    const offset = Math.min(1, Math.max(0, (y - layout.tops[idx]) / (layout.heights[idx] || 1)));
    setCurrentPage(idx + 1);
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => {
      void store.mutate(paperId, (d) => setProgress(d, { page: idx + 1, pages: layout.tops.length, offset: round3(offset) }), { lowPriority: true });
    }, 1500);
  };
  useEffect(
    () => () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
    },
    [],
  );

  // ---------- 选择 → 高亮 / 批注 ----------
  const onMouseUp = () => {
    if (tool !== 'select') return;
    setTimeout(() => {
      const p = selectionToPending(window.getSelection()!);
      const el = scrollRef.current;
      if (!p || !el) return;
      // 选区坐标来自视口；浮动条位于可滚动的内容里，需换算到内容坐标
      const box = el.getBoundingClientRect();
      setPending({
        ...p,
        anchorTop: Math.max(0, p.anchorTop - box.top + el.scrollTop),
        anchorLeft: p.anchorLeft - box.left + el.scrollLeft,
      });
    }, 0);
  };

  const copySelectedText = async () => {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.quote);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = pending.quote;
      fallback.setAttribute('readonly', '');
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      fallback.style.pointerEvents = 'none';
      document.body.appendChild(fallback);
      fallback.select();
      const copied = document.execCommand('copy');
      fallback.remove();
      if (!copied) {
        alert(tr('复制失败，请检查浏览器剪贴板权限'));
        return;
      }
    }
    setPending(null);
    writeTouchSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const createHighlight = async (color: HighlightColor, withNote: boolean) => {
    if (!pending || load.kind !== 'ready') return;
    const ann: Annotation = {
      id: newId(),
      page: pending.page,
      color,
      quote: pending.quote,
      prefix: pending.prefix,
      suffix: pending.suffix,
      start: pending.start,
      rects: pending.rects,
      note: '',
      fingerprint: load.loaded.fp,
      version: docRef.current.version,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setPending(null);
    writeTouchSelection(null);
    window.getSelection()?.removeAllRanges();
    await edit((d) => addAnnotation(d, ann));
    setFocusId(ann.id);
    // 只有“批注”需要编辑内容，才打开右侧栏；普通高亮不打扰阅读
    if (withNote) {
      setNoteDraft(ann.id);
      setShowSide(true);
    }
  };

  /** 拖动高亮端点结束：更新范围、原文与上下文（可撤销） */
  const adjustHl = (id: string, patch: HlPatch) => {
    void edit((d) => updateAnnotation(d, id, patch));
  };
  /** 删除高亮前确认，删除后同步到其他设备 */
  const deleteHl = async (id: string) => {
    const ok = await askConfirm({ title: tr('删除这条高亮？'), message: tr('高亮及其批注会从所有设备中移除。'), danger: true });
    if (!ok) return;
    setHlSel(null);
    void edit((d) => removeAnnotation(d, id));
  };

  const onRendered = (page: number, pageEl: HTMLElement, layer: HTMLElement) => {
    if (load.kind !== 'ready') return;
    const fp = load.loaded.fp;
    const raw = rawText(layer);
    for (const a of liveAnnotations(docRef.current)) {
      if (a.page !== page || a.fingerprint === fp || relocating.current.has(a.id)) continue;
      relocating.current.add(a.id);
      const m = locateQuote(raw, { quote: a.quote, prefix: a.prefix, suffix: a.suffix, start: a.start });
      if (m && m.score >= 0.85) {
        const rects = rectsForOffsets(layer, pageEl, m.start, m.end);
        void store.mutate(paperId, (d) => updateAnnotation(d, a.id, { rects, start: m.start, fingerprint: fp }));
        setUnanchored((s) => without(s, a.id));
      } else {
        setUnanchored((s) => new Set(s).add(a.id));
      }
    }
  };

  const jumpTo = (page: number, yRatio: number, id: string | null) => {
    const el = scrollRef.current;
    if (!el || load.kind !== 'ready') return;
    const idx = page - 1;
    const top = (layout.tops[idx] ?? 0) + yRatio * (layout.heights[idx] ?? 0) - 120;
    el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    setFocusId(id);
  };

  // ---------- 手绘与文字 ----------
  const addInk = (page: number, points: [number, number][], marker: boolean) => {
    const now = Date.now();
    const p = getPrefs();
    const s: InkShape = {
      kind: 'ink',
      id: newId(),
      page,
      color: marker ? p.markerColor : p.penColor,
      points,
      ...(marker ? { marker: true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    void edit((d) => addShape(d, s));
  };

  const commitDraft = (text: string) => {
    const dr = draft;
    setDraft(null);
    if (!dr) return;
    const now = Date.now();
    const s: TextShape = {
      kind: 'text', id: newId(), page: dr.page, x: dr.x, y: dr.y, w: 0.32, size: 0.017,
      color: getPrefs().penColor, text, createdAt: now, updatedAt: now,
    };
    void edit((d) => addShape(d, s));
  };

  const updateText = (id: string, text: string) => void edit((d) => updateShape(d, id, { text }));
  const deleteShape = (id: string) => void edit((d) => removeShape(d, id));
  const updateTextGeom = (id: string, g: { x: number; y: number; w: number }) => void edit((d) => updateShape(d, id, g));

  // ---------- 元数据 ----------
  const setMeta = (patch: Partial<Pick<PaperDoc, 'title' | 'authors' | 'tags'>>) =>
    store.mutate(paperId, (d) => {
      let n = d;
      for (const [k, v] of Object.entries(patch)) n = setField(n, k as 'title' | 'authors' | 'tags', v as never);
      return n;
    });

  const changeVersion = async (raw: string) => {
    let v: string;
    try {
      v = normalizeVersion(raw);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      return;
    }
    const d = docRef.current;
    if (v === d.version) return;
    const ax = d.id.startsWith('arxiv-') ? d.id.slice(6).replace('_', '/') : null;
    await store.mutate(paperId, (x) => {
      let n = setField(x, 'version', v);
      if (ax) n = setField(n, 'url', withVersion(arxivRef(ax, v), v).pdfUrl);
      return n;
    });
  };

  const onAttachLocal = async (file: File) => {
    try {
      await importLocalPdf(file, pdfCache, paperId, docRef.current.version);
      setReloadKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const anns = liveAnnotations(doc).sort((a, b) => a.page - b.page || a.start - b.start);
  const shapes = liveShapes(doc).sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
  const loaded = load.kind === 'ready' ? load.loaded : null;
  const pageCount = loaded?.pdf.numPages ?? doc.progress.pages;

  return (
    <div class="reader" data-tool={tool}>
      <TopBar
        title={displayTitle(doc)}
        page={currentPage}
        pages={pageCount}
        zoomLabel={zoom === 1 ? tr('适宽') : `${Math.round(zoom * 100)}%`}
        onBack={() => navigate('')}
        onZoomIn={() => zoomCenter(zoomRef.current * 1.25)}
        onZoomOut={() => zoomCenter(zoomRef.current / 1.25)}
        onFit={() => zoomCenter(1)}
        sidebarOpen={showSide}
        onToggleSide={() => {
          setShowSide((s) => !s);
          setPrefs({ sidebar: !showSide });
        }}
        onOpenSettings={onOpenSettings}
      />

      {newVersion && (
        <div class="banner">
          <span>{tr('arXiv 有新版本 {v}', { v: newVersion })}</span>
          <div class="grow" />
          <button class="ghost small" onClick={() => setNewVersion(null)}>{tr('忽略')}</button>
          <button class="small" onClick={() => { void changeVersion(newVersion); setNewVersion(null); }}>{tr('切换')}</button>
        </div>
      )}

      <div class="body">
        <div class="stage">
        <div
          class="viewer"
          ref={scrollRef}
          onScroll={onScroll}
          onMouseUp={onMouseUp}
          onTouchEnd={onMouseUp}
        >
          {load.kind === 'loading' && (
            <div class="status">
              <p>{tr('正在打开')}</p>
              <span class="muted small">
                {load.total ? `${Math.round(((load.done ?? 0) / load.total) * 100)}%` : tr('直接从原站读取，不经过任何第三方服务器')}
              </span>
            </div>
          )}

          {load.kind === 'error' && (
            <div class="status">
              <p class="error">{load.message}</p>
              <div class="row center">
                <button class="ghost" onClick={() => setReloadKey((k) => k + 1)}>{tr('重试')}</button>
                <label class="file-btn">
                  {tr('选择本地 PDF')}
                  <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    if (f) void onAttachLocal(f);
                  }} />
                </label>
                {doc.sourceUrl && <a class="ghost btn" href={doc.sourceUrl} target="_blank" rel="noreferrer noopener">{tr('原文')}</a>}
              </div>
            </div>
          )}

          {loaded && (
            <div class="pages" ref={pagesRef} style={{ height: `${layout.total}px` }}>
              {loaded.sizes.map((_, i) => (
                <PdfPage
                  key={i}
                  pdf={loaded.pdf}
                  num={i + 1}
                  top={layout.tops[i]}
                  width={layout.widths[i]}
                  height={layout.heights[i]}
                  scale={scale}
                  scrollRef={scrollRef}
                  sideRoom={sideRoom}
                  ink={inkOn}
                  anns={anns.filter((a) => a.page === i + 1)}
                  shapes={shapes.filter((s) => s.page === i + 1)}
                  unanchored={unanchored}
                  focusId={focusId}
                  tool={tool}
                  penColor={prefs.penColor}
                  markerColor={prefs.markerColor}
                  draft={draft}
                  touchSelection={touchSelection?.page === i + 1 ? touchSelection : null}
                  showTouchSelectionHandles={!!pending && touchSelection?.page === i + 1}
                  onRendered={onRendered}
                  onAddInk={addInk}
                  onStartText={(page, x, y) => setDraft({ page, x, y })}
                  onCommitDraft={commitDraft}
                  onCancelDraft={() => setDraft(null)}
                  onUpdateText={updateText}
                  onUpdateTextGeom={updateTextGeom}
                  onDeleteShape={deleteShape}
                  selectedId={hlSel}
                  onSelectHl={setHlSel}
                  onAdjustHl={adjustHl}
                  onDeleteHl={deleteHl}
                />
              ))}
            </div>
          )}

          {pending && tool === 'select' && (
            <div class="selection-bar" style={{ top: `${pending.anchorTop - 52}px`, left: `${pending.anchorLeft}px` }} onMouseDown={(e) => e.preventDefault()}>
              {HIGHLIGHT_COLORS.map((c) => (
                <button class={`swatch ${c}`} title={colorName(c)} aria-label={tr('{color}高亮', { color: colorName(c) })} onClick={() => createHighlight(c, false)} />
              ))}
              <span class="sel-sep" />
              <button class="ghost small on-dark" onClick={copySelectedText}>{tr('复制')}</button>
              <span class="sel-sep" />
              <button class="ghost small on-dark" onClick={() => createHighlight(prefs.color, true)}>{tr('批注')}</button>
            </div>
          )}
        </div>
        <FloatingTools
          tool={tool}
          onTool={setTool}
          color={tool === 'marker' ? prefs.markerColor : prefs.penColor}
          palette={tool === 'marker' ? MARKER_COLORS : PEN_COLORS}
          canUndo={history.undo > 0}
          canRedo={history.redo > 0}
          onUndo={undo}
          onRedo={redo}
          onColor={(c: InkColor) => setPrefs(tool === 'marker' ? { markerColor: c } : { penColor: c })}
        />
        </div>

        {showSide && (
          <aside class="side">
            <section class="cite">
              <EditableText cls="cite-title" label={tr('标题')} value={doc.title} placeholder={tr('未识别到标题')} onSave={(v) => setMeta({ title: v })} />
              <EditableText cls="cite-authors" label={tr('作者')} value={doc.authors} placeholder={tr('添加作者')} onSave={(v) => setMeta({ authors: v })} />
              <div class="cite-line">
                <span class="cite-source">{sourceLabel(doc)}</span>
                <EditableText cls="cite-version" label={tr('版本')} value={doc.version} placeholder={tr('最新版')} onSave={(v) => void changeVersion(v)} />
              </div>
              <TagEditor tags={doc.tags} onChange={(tags) => void setMeta({ tags })} />
              {doc.url === '' && <p class="cite-note">{tr('本机文件：笔记会同步，PDF 需在每台设备上单独打开。')}</p>}
            </section>

            <section class="notes-section">
              <div class="section-head">
                <span>{tr('笔记')}</span>
                <span class="count">{anns.length + shapes.length}</span>
              </div>
              {anns.length + shapes.length === 0 && (
                <p class="empty-note">{tr('选中文字即可高亮或写批注；也可以用文字、画笔工具直接在页面上书写。')}</p>
              )}
              <ul class="notes">
                {marginItems(anns, shapes).map((it) =>
                  it.kind === 'ann' ? (
                    <NoteItem
                      key={it.a.id}
                      ann={it.a}
                      focused={focusId === it.a.id}
                      unanchored={unanchored.has(it.a.id)}
                      autoEdit={noteDraft === it.a.id}
                      onJump={() => jumpTo(it.a.page, rectsTop(it.a.rects), it.a.id)}
                      onSave={(patch) => edit((d) => updateAnnotation(d, it.a.id, patch))}
                      onDelete={() => edit((d) => removeAnnotation(d, it.a.id))}
                      onEdited={() => setNoteDraft(null)}
                    />
                  ) : (
                    <ShapeItem
                      key={it.s.id}
                      shape={it.s}
                      onJump={() => jumpTo(it.s.page, it.s.kind === 'text' ? it.s.y : shapeTop(it.s), it.s.id)}
                      onDelete={() => deleteShape(it.s.id)}
                    />
                  ),
                )}
              </ul>
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}

/** 笔记按页面顺序排列：同一页内按纵向位置。 */
function marginItems(anns: Annotation[], shapes: Shape[]) {
  type Item = { kind: 'ann'; a: Annotation; page: number; top: number } | { kind: 'shape'; s: Shape; page: number; top: number };
  const items: Item[] = [
    ...anns.map((a) => ({ kind: 'ann' as const, a, page: a.page, top: rectsTop(a.rects) })),
    ...shapes.map((s) => ({ kind: 'shape' as const, s, page: s.page, top: s.kind === 'text' ? s.y : shapeTop(s) })),
  ];
  return items.sort((x, y) => x.page - y.page || x.top - y.top);
}

function NoteItem(props: {
  ann: Annotation;
  focused: boolean;
  unanchored: boolean;
  autoEdit: boolean;
  onJump: () => void;
  onSave: (patch: Partial<Omit<Annotation, 'id'>>) => void;
  onDelete: () => void;
  onEdited: () => void;
}) {
  const { ann: a } = props;
  const [note, setNote] = useState(a.note);
  const [editing, setEditing] = useState(props.autoEdit);
  useEffect(() => setNote(a.note), [a.note]);
  useEffect(() => {
    if (props.autoEdit) setEditing(true);
  }, [props.autoEdit]);
  return (
    <li class={`note c-${a.color} ${props.focused ? 'focused' : ''}`} id={`ann-${a.id}`}>
      <button class="note-page" onClick={props.onJump} title={tr('跳到第 {page} 页', { page: a.page })} aria-label={tr('跳到第 {page} 页', { page: a.page })}>
        {a.page}
      </button>
      <div class="note-main">
        <blockquote onClick={props.onJump}>{a.quote.length > 240 ? `${a.quote.slice(0, 240)}…` : a.quote}</blockquote>
        {editing ? (
          <textarea
            value={note}
            autoFocus
            rows={2}
            placeholder={tr('写下批注')}
            aria-label={tr('批注')}
            onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
            onBlur={() => {
              if (note !== a.note) props.onSave({ note });
              setEditing(false);
              props.onEdited();
            }}
          />
        ) : a.note ? (
          <div class="note-body" onClick={() => setEditing(true)}>{a.note}</div>
        ) : null}
        {props.unanchored && <p class="warn" title={tr('PDF 版本可能不同，原文位置未能精确匹配')}>{tr('位置待确认')}</p>}
      </div>
      <div class="note-actions">
        {!a.note && !editing && (
          <button class="icon-btn tiny" title={tr('写批注')} aria-label={tr('写批注')} onClick={() => setEditing(true)}>
            <Icon name="edit" size={12} />
          </button>
        )}
        <button
          class="icon-btn tiny"
          title={tr('删除')}
          aria-label={tr('删除批注')}
          onClick={async () => (await askConfirm({ title: tr('删除这条批注？'), message: tr('批注及其高亮会从所有设备中移除。'), danger: true })) && props.onDelete()}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </li>
  );
}

function ShapeItem({ shape, onJump, onDelete }: { shape: Shape; onJump: () => void; onDelete: () => void }) {
  const kind = shape.kind === 'text' ? tr('文字') : shape.marker ? tr('荧光笔') : tr('画笔');
  const text = shape.kind === 'text' ? shape.text : '';
  return (
    <li class="note shape">
      <button class="note-page" onClick={onJump} title={tr('跳到第 {page} 页', { page: shape.page })} aria-label={tr('跳到第 {page} 页', { page: shape.page })}>
        {shape.page}
      </button>
      <div class="note-main">
        <p class="shape-kind">{kind}</p>
        {text && <div class="shape-label">{text.length > 120 ? `${text.slice(0, 120)}…` : text}</div>}
      </div>
      <button
        class="icon-btn tiny note-actions"
        title={tr('删除')}
        aria-label={tr('删除')}
        onClick={async () => (await askConfirm({ title: tr('删除这项{kind}标注？', { kind }), message: tr('删除后会从所有设备中移除。'), danger: true })) && onDelete()}
      >
        <Icon name="close" size={12} />
      </button>
    </li>
  );
}

function shapeTop(s: Shape): number {
  if (s.kind !== 'ink' || s.points.length === 0) return 0;
  return Math.min(...s.points.map((p) => p[1]));
}

// ---------- 工具 ----------

function usePrefs() {
  const [p, setP] = useState(getPrefs());
  useEffect(() => subscribePrefs(() => setP(getPrefs())), []);
  return p;
}

function fitScale(sizes: { w: number }[], width: number, side: number): number {
  const w = sizes[0]?.w || 612;
  return Math.max(0.5, Math.min(3, (width - 48 - 2 * side) / w));
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

function rectsTop(rects: { y: number }[]) {
  return rects.length ? Math.min(...rects.map((r) => r.y)) : 0;
}

function without(s: Set<string>, id: string) {
  const n = new Set(s);
  n.delete(id);
  return n;
}

function colorName(c: HighlightColor) {
  return { yellow: tr('黄色'), green: tr('绿色'), blue: tr('蓝色'), pink: tr('粉色'), purple: tr('紫色') }[c];
}

