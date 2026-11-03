import { tr } from '../core/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Fragment, type ComponentChildren } from 'preact';
import type { PDFDoc } from '../pdf/engine';
import { CAPTION, type PageLayout, type LayoutBlock } from '../pdf/blocks';
import { pageLayout } from '../pdf/layoutcache';
import { contextOf, locateQuote } from '../core/anchor';
import { rangesInBlock, rawRangeOf, rectsForRaw, transByBlock } from '../core/reflowmap';
import type { Annotation, Rect } from '../core/types';
import type { TransBlock } from '../core/translate';
import type { TransMarkSpan } from './translayer';
import type { FlowItem } from '../pdf/blocks';
import type { AiConfig } from '../core/ai';
import { aiLayoutPage, layoutCacheKey, loadAiLayout, saveAiLayout } from '../core/ailayout';
import { AiHttpError } from '../core/ai';
import { idb } from '../core/services';

/**
 * 重排视图：把 PDF 每页的文字按阅读顺序排成可自由换行的段落，适合手机阅读。
 * 图、表、公式等无法重排的区域按原样截图显示。
 * 高亮与笔记仍然锚定在 PDF 原文上，所以两种视图之间完全互通；显示译文时，高亮落在对应的译文上。
 */

export interface ReflowSelection {
  page: number;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  rects: Rect[];
  anchorTop: number;
  anchorLeft: number;
}

interface Props {
  pdf: PDFDoc;
  pages: number;
  anns: Annotation[];
  /** 已翻译的页（页码 → 译文块） */
  trans: Record<number, TransBlock[]>;
  showTrans: boolean;
  /** 译文中的高亮：页码 → 版面块序号 → 区间 */
  marks: Record<number, Map<number, TransMarkSpan[]>>;
  focusId: string | null;
  fontSize: number;
  /** 译文语言（用于断字与字体选择） */
  lang: string;
  /** 初次打开时滚动到的页 */
  startPage: number;
  /** 外部要求跳转（页码 + 可选的高亮 id）；seq 变化时执行 */
  jump: { page: number; id: string | null; seq: number } | null;
  onPage: (page: number, offset: number) => void;
  onSelect: (sel: ReflowSelection | null) => void;
  onTapHl: (id: string, x: number, top: number, bottom: number) => void;
  /** 用 AI 识别版面（未配置时为 null） */
  ai: { cfg: AiConfig; apiKey: string; paperId: string; version: string } | null;
  onAiError: (msg: string) => void;
}

interface Located {
  ann: Annotation;
  start: number;
  end: number;
}

export function Reflow(p: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [layouts, setLayouts] = useState<(PageLayout | null)[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const restored = useRef(false);
  // AI 版面：页码 → 重排项；正在识别的页
  const [aiFlows, setAiFlows] = useState<Record<number, FlowItem[]>>({});
  const [aiBusy, setAiBusy] = useState<Set<number>>(new Set());
  const aiQueue = useRef<{ want: Set<number>; running: number; done: Set<number>; stopped: boolean }>({ want: new Set(), running: 0, done: new Set(), stopped: false });

  // 依次分析每一页（只提取文字，速度很快）
  useEffect(() => {
    let cancelled = false;
    setLayouts([]);
    setLoaded(0);
    restored.current = false;
    void (async () => {
      const out: (PageLayout | null)[] = [];
      const errs: string[] = [];
      for (let n = 1; n <= p.pages; n++) {
        let layout: PageLayout | null = null;
        // 偶发失败（例如移动端内存紧张时 PDF 解析线程繁忙）重试一次
        for (let attempt = 0; attempt < 2 && !layout; attempt++) {
          try {
            layout = await pageLayout(p.pdf, n);
          } catch (e) {
            errs[n - 1] = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            console.error(`第 ${n} 页重排失败`, e);
            if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
          }
        }
        out.push(layout);
        if (cancelled) return;
        if (n % 4 === 0 || n === p.pages) setLoaded(n);
      }
      if (!cancelled) {
        setErrors(errs);
        setLayouts(out);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [p.pdf, p.pages, retry]);

  // ---------- AI 版面识别 ----------
  const ai = p.ai;
  const aiModel = ai ? ai.cfg.visionModel?.trim() || ai.cfg.model : '';
  const aiKeyOf = (n: number) => (ai ? layoutCacheKey(ai.paperId, ai.version, n, aiModel) : '');
  // 先读本机缓存
  useEffect(() => {
    aiQueue.current = { want: new Set(), running: 0, done: new Set(), stopped: false };
    setAiFlows({});
    if (!ai || !layouts.length) return;
    let cancelled = false;
    void (async () => {
      const found: Record<number, FlowItem[]> = {};
      for (let n = 1; n <= layouts.length; n++) {
        const f = await loadAiLayout(idb, aiKeyOf(n));
        if (f) {
          found[n] = f;
          aiQueue.current.done.add(n);
        }
      }
      if (!cancelled) setAiFlows(found);
      pump();
    })();
    return () => {
      cancelled = true;
      aiQueue.current.stopped = true;
    };
  }, [layouts, ai?.paperId, ai?.version, aiModel]);

  const pump = () => {
    const q = aiQueue.current;
    if (!ai || q.stopped) return;
    while (q.running < 2) {
      const n = [...q.want].sort((a, b) => a - b).find((x) => !q.done.has(x));
      if (n === undefined) return;
      q.want.delete(n);
      q.done.add(n);
      q.running++;
      setAiBusy((s) => new Set(s).add(n));
      void runAi(n).finally(() => {
        q.running--;
        setAiBusy((s) => {
          const next = new Set(s);
          next.delete(n);
          return next;
        });
        pump();
      });
    }
  };

  const runAi = async (n: number) => {
    const layout = layouts[n - 1];
    if (!ai || !layout || !layout.blocks.length) return;
    try {
      const page = await p.pdf.getPage(n);
      const image = await renderPageImage(page, 1100);
      const flow = await aiLayoutPage({ cfg: ai.cfg, apiKey: ai.apiKey, layout, image, annotate: (boxes) => annotateImage(image, boxes) });
      if (aiQueue.current.stopped) return;
      await saveAiLayout(idb, aiKeyOf(n), flow);
      setAiFlows((m) => ({ ...m, [n]: flow }));
    } catch (e) {
      console.error(`第 ${n} 页 AI 版面识别失败`, e);
      // 模型不支持图片、Key 无效等配置问题：本次不再继续请求
      if (e instanceof AiHttpError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        aiQueue.current.stopped = true;
        p.onAiError(e.message);
      }
    }
  };

  // 页面接近视口时排队识别
  useEffect(() => {
    const root = scrollRef.current;
    if (!ai || !root || !layouts.length) return;
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) if (e.isIntersecting) aiQueue.current.want.add(Number((e.target as HTMLElement).dataset.page));
        pump();
      },
      { root, rootMargin: '1500px 0px' },
    );
    root.querySelectorAll('section[data-page]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [layouts, ai?.paperId, aiModel]);

  // 打开时回到阅读位置
  useLayoutEffect(() => {
    if (!layouts.length || restored.current) return;
    restored.current = true;
    scrollToPage(p.startPage, null);
  }, [layouts]);

  useEffect(() => {
    if (p.jump && layouts.length) scrollToPage(p.jump.page, p.jump.id);
  }, [p.jump?.seq, layouts.length]);

  const scrollToPage = (page: number, id: string | null) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = (id && el.querySelector<HTMLElement>(`mark[data-ann="${id}"]`)) || el.querySelector<HTMLElement>(`section[data-page="${page}"]`);
    if (!target) return;
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - (id ? 120 : 0);
    el.scrollTop = Math.max(0, top);
  };

  // ---------- 阅读位置 ----------
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const y = el.getBoundingClientRect().top + el.clientHeight * 0.25;
    const sections = el.querySelectorAll<HTMLElement>('section[data-page]');
    for (const s of Array.from(sections)) {
      const r = s.getBoundingClientRect();
      if (r.bottom > y) {
        p.onPage(Number(s.dataset.page), Math.min(1, Math.max(0, (y - r.top) / (r.height || 1))));
        break;
      }
    }
  };

  // ---------- 选择文字 ----------
  useEffect(() => {
    let timer = 0;
    const check = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => p.onSelect(readSelection(scrollRef.current, layouts)), 120);
    };
    document.addEventListener('selectionchange', check);
    return () => {
      document.removeEventListener('selectionchange', check);
      window.clearTimeout(timer);
    };
  }, [layouts]);

  const onClick = (e: MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const mark = (e.target as HTMLElement).closest?.('mark[data-ann]') as HTMLElement | null;
    if (mark) {
      const r = mark.getBoundingClientRect();
      p.onTapHl(mark.dataset.ann!, e.clientX, r.top, r.bottom);
    }
  };

  if (!layouts.length) {
    return (
      <div class="reflow" ref={scrollRef}>
        <div class="status">
          <p>{tr('正在重排')}</p>
          <span class="muted small">{p.pages ? `${Math.round((loaded / p.pages) * 100)}%` : ''}</span>
        </div>
      </div>
    );
  }

  return (
    <div class="reflow" ref={scrollRef} onScroll={onScroll} onClick={onClick} style={{ '--rf-size': `${p.fontSize}px` } as Record<string, string>}>
      <div class="rf-doc">
        {layouts.map((layout, idx) => {
          const page = idx + 1;
          if (!layout)
            return (
              <section key={page} data-page={page} class="rf-page">
                <p class="rf-missing">
                  {tr('第 {n} 页无法重排', { n: page })}
                  {errors[idx] ? `（${errors[idx]}）` : ''}{' '}
                  <button class="ghost small" onClick={() => setRetry((r) => r + 1)}>{tr('重试')}</button>
                </p>
              </section>
            );
          return (
            <RfPage
              key={page}
              pdf={p.pdf}
              page={page}
              layout={layout}
              anns={p.anns.filter((a) => a.page === page)}
              trans={p.showTrans ? p.trans[page] ?? null : null}
              marks={p.showTrans ? p.marks[page] ?? null : null}
              focusId={p.focusId}
              lang={p.lang}
              flow={aiFlows[page] ?? null}
              aiBusy={aiBusy.has(page)}
            />
          );
        })}
      </div>
    </div>
  );
}

function RfPage(props: {
  pdf: PDFDoc;
  page: number;
  layout: PageLayout;
  anns: Annotation[];
  trans: TransBlock[] | null;
  marks: Map<number, TransMarkSpan[]> | null;
  focusId: string | null;
  lang: string;
  /** AI 识别的版面；没有时用本地规则分析的结果 */
  flow: FlowItem[] | null;
  aiBusy: boolean;
}) {
  const { layout, page } = props;
  // 高亮在本页原始文本中的位置
  const located: Located[] = [];
  for (const a of props.anns) {
    const m = locateQuote(layout.raw, { quote: a.quote, prefix: a.prefix, suffix: a.suffix, start: a.start });
    if (m) located.push({ ann: a, start: m.start, end: m.end });
  }
  const tmap = transByBlock(layout, props.trans);
  const byId = new Map(props.anns.map((a) => [a.id, a]));

  return (
    <section class="rf-page" data-page={page}>
      <div class="rf-pageno" aria-hidden="true">{props.aiBusy ? `${tr('AI 排版中')} · ` : ''}{page}</div>
      {groupFlow(layout, props.flow ?? layout.flow, tmap).map((g, k) => {
        if (g.kind === 'crop') return <Crop key={`c${k}`} pdf={props.pdf} page={page} rect={g.rect} pageW={layout.width} pageH={layout.height} />;
        const notes: Annotation[] = [];
        const parts = g.blocks.map((b, j) => {
          const t = tmap.get(b.i);
          let spans: Span[];
          let text: string;
          if (t) {
            text = t.tb.t;
            spans = (props.marks?.get(b.i) ?? []).map((m) => ({ s: m.ts, e: m.te, ann: byId.get(m.id) })).filter((x): x is Span => !!x.ann);
          } else {
            text = b.text;
            spans = [];
            for (const l of located) for (const [s, e] of rangesInBlock(b, l.start, l.end)) spans.push({ s, e, ann: l.ann });
          }
          for (const a of uniqueNotes(spans)) if (!notes.includes(a)) notes.push(a);
          // 段落跨栏时分成多块，这里拼回同一段；块之间的空格不属于任何块
          const sep = j > 0 && !(g.translated && /[\u3000-\u9fff]$/.test(tmap.get(g.blocks[j - 1].i)?.tb.t ?? '')) ? ' ' : '';
          return (
            <Fragment key={b.i}>
              {sep}
              <span data-b={b.i} data-tr={t ? '1' : undefined}>{renderMarked(text, spans, props.focusId)}</span>
            </Fragment>
          );
        });
        const first = g.blocks[0];
        const role = g.role ?? (first.role === 'heading' ? 'heading' : CAPTION.test(first.text.trim()) ? 'caption' : 'text');
        const Tag = role === 'heading' ? 'h3' : 'p';
        return (
          <div key={`b${first.i}`} class="rf-block">
            <Tag class={`rf-${role === 'caption' ? 'text rf-caption' : role}${g.translated ? ' rf-tr' : ''}${first.align === 'center' ? ' rf-center' : ''}`} lang={g.translated ? props.lang : 'en'}>
              {parts}
            </Tag>
            {notes.map((a) => (
              <div key={`n${a.id}`} class={`rf-note ${a.color}`}>{a.note}</div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

type Group =
  | { kind: 'crop'; rect: { x: number; y: number; w: number; h: number } }
  | { kind: 'para'; blocks: LayoutBlock[]; translated: boolean; role?: 'text' | 'heading' | 'caption' };

const SENTENCE_END = /[.!?:;。！？：；)\]）」”"']\s*$/;

/** 阅读顺序中的项分组：同一段落被分栏或图表拆开的几块拼回一段 */
function groupFlow(layout: PageLayout, flow: FlowItem[], tmap: Map<number, unknown>): Group[] {
  const out: Group[] = [];
  let lastPara: (Group & { kind: 'para' }) | null = null;
  for (const f of flow) {
    if (f.kind === 'crop') {
      out.push({ kind: 'crop', rect: f });
      continue;
    }
    const b = layout.blocks[f.i];
    if (!b) continue;
    const translated = tmap.has(b.i);
    const prev = lastPara?.blocks[lastPara.blocks.length - 1];
    // AI 给出了段落归属时直接采用；否则按句子是否结束来判断
    const continues =
      f.cont !== undefined
        ? f.cont && !!lastPara && lastPara.translated === translated
        : !!prev && prev.role === 'text' && b.role === 'text' && lastPara!.translated === translated &&
          !SENTENCE_END.test(prev.text) && /^[a-z(\[,]/.test(b.text.trim());
    if (continues) lastPara!.blocks.push(b);
    else {
      lastPara = { kind: 'para', blocks: [b], translated, role: f.role };
      out.push(lastPara);
    }
  }
  return out;
}

interface Span {
  s: number;
  e: number;
  ann: Annotation;
}

function uniqueNotes(spans: Span[]): Annotation[] {
  const seen = new Set<string>();
  const out: Annotation[] = [];
  for (const sp of spans) {
    if (sp.ann.note.trim() && !seen.has(sp.ann.id)) {
      seen.add(sp.ann.id);
      out.push(sp.ann);
    }
  }
  return out;
}

/** 按高亮区间切分文字；重叠时后创建的高亮在外层显示 */
function renderMarked(text: string, spans: Span[], focusId: string | null): ComponentChildren {
  if (!spans.length) return text;
  const cuts = new Set<number>([0, text.length]);
  for (const sp of spans) {
    cuts.add(Math.max(0, Math.min(text.length, sp.s)));
    cuts.add(Math.max(0, Math.min(text.length, sp.e)));
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const out: ComponentChildren[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const piece = text.slice(a, b);
    const cover = spans.filter((sp) => sp.s <= a && sp.e >= b).sort((x, y) => x.ann.createdAt - y.ann.createdAt);
    const top = cover[cover.length - 1];
    if (!top) {
      out.push(piece);
      continue;
    }
    const last = top.e === b;
    out.push(
      <mark
        key={i}
        data-ann={top.ann.id}
        class={`rf-hl ${top.ann.color} ${top.ann.decoration ?? 'highlight'}${focusId === top.ann.id ? ' focus' : ''}${last && top.ann.note.trim() ? ' has-note' : ''}`}
      >
        {piece}
      </mark>,
    );
  }
  return out;
}

/** 当前浏览器选区 → 原文锚点（只接受原文段落；译文段落无法对应到原文位置） */
function readSelection(root: HTMLElement | null, layouts: (PageLayout | null)[]): ReflowSelection | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const startEl = blockOf(range.startContainer);
  if (!startEl || startEl.dataset.tr) return null;
  const pageEl = startEl.closest('section[data-page]') as HTMLElement | null;
  const page = Number(pageEl?.dataset.page);
  const layout = layouts[page - 1];
  if (!layout) return null;
  const a = layout.blocks[Number(startEl.dataset.b)];
  const cs = offsetIn(startEl, range.startContainer, range.startOffset);
  let endEl = blockOf(range.endContainer);
  if (!endEl || endEl.dataset.tr || endEl.closest('section[data-page]') !== pageEl) endEl = null;
  let start: number;
  let end: number;
  if (!endEl || endEl === startEl) {
    const ce = endEl ? offsetIn(startEl, range.endContainer, range.endOffset) : a.text.length;
    const r = rawRangeOf(a, cs, ce);
    if (!r) return null;
    ({ start, end } = r);
  } else {
    const b: LayoutBlock = layout.blocks[Number(endEl.dataset.b)];
    const ra = rawRangeOf(a, cs, a.text.length);
    const rb = rawRangeOf(b, 0, offsetIn(endEl, range.endContainer, range.endOffset));
    if (!ra) return null;
    start = ra.start;
    end = rb && rb.end > ra.start ? rb.end : ra.end;
  }
  if (end <= start) return null;
  const quote = sel.toString().replace(/\s+/g, ' ').trim();
  if (!quote) return null;
  const ctx = contextOf(layout.raw, start, end);
  const box = range.getBoundingClientRect();
  return {
    page,
    start,
    end,
    quote,
    prefix: ctx.prefix,
    suffix: ctx.suffix,
    rects: rectsForRaw(layout, start, end),
    anchorTop: box.top,
    anchorLeft: box.left + box.width / 2,
  };
}

function blockOf(n: Node): HTMLElement | null {
  const el = n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : n.parentElement;
  return (el?.closest('[data-b]') as HTMLElement | null) ?? null;
}

/** 块元素内 (node, offset) → 字符位置 */
function offsetIn(blockEl: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(blockEl, 0);
  try {
    r.setEnd(node, offset);
  } catch {
    return 0;
  }
  return r.toString().length;
}

/** 图、表、公式：按原样截取页面区域。进入视口才渲染；空白区域自动隐藏。 */
function Crop(props: { pdf: PDFDoc; page: number; rect: { x: number; y: number; w: number; h: number }; pageW: number; pageH: number }) {
  const { rect, pageW, pageH } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [blank, setBlank] = useState(false);
  const cssW = rect.w * pageW;
  const cssH = rect.h * pageH;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { promise: Promise<unknown>; cancel(): void } | null = null;
    void (async () => {
      const page = await props.pdf.getPage(props.page);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (cancelled || !canvas || !wrap) return;
      const shown = Math.min(wrap.clientWidth || cssW, cssW * 1.6);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const s = (shown * dpr) / cssW;
      canvas.width = Math.max(1, Math.round(cssW * s));
      canvas.height = Math.max(1, Math.round(cssH * s));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      const vp = page.getViewport({ scale: s });
      task = page.render({ canvasContext: ctx, canvas, viewport: vp, transform: [1, 0, 0, 1, -rect.x * pageW * s, -rect.y * pageH * s] });
      await task.promise;
      if (cancelled) return;
      if (isBlank(ctx, canvas.width, canvas.height)) setBlank(true);
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible]);

  if (blank) return null;
  return (
    <div class="rf-crop" ref={wrapRef} style={{ maxWidth: `${cssW * 1.6}px` }}>
      <canvas ref={canvasRef} style={{ aspectRatio: `${cssW} / ${cssH}` }} />
    </div>
  );
}

/** 几乎没有非白色像素：是排版留白，不是图表 */
function isBlank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const d = ctx.getImageData(0, 0, w, h).data;
    let ink = 0;
    const step = 4 * 3;
    for (let i = 0; i < d.length; i += step) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) ink++;
    return ink < (d.length / step) * 0.004;
  } catch {
    return false;
  }
}

/** 把页面渲染成 JPEG（给模型看） */
async function renderPageImage(page: Awaited<ReturnType<PDFDoc['getPage']>>, width: number): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.8);
  canvas.width = canvas.height = 0;
  return url;
}

/** 在页面图上画出编号的裁剪框（交给模型复查） */
async function annotateImage(src: string, boxes: { x: number; y: number; w: number; h: number }[]): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const W = canvas.width;
  const H = canvas.height;
  ctx.lineWidth = Math.max(2, W / 400);
  ctx.font = `bold ${Math.round(W / 40)}px sans-serif`;
  boxes.forEach((b, k) => {
    ctx.strokeStyle = 'rgba(230, 30, 30, 0.95)';
    ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
    const label = String(k + 1);
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(230, 30, 30, 0.95)';
    ctx.fillRect(b.x * W, b.y * H, tw, W / 32);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, b.x * W + 5, b.y * H + W / 40);
  });
  const url = canvas.toDataURL('image/jpeg', 0.8);
  canvas.width = canvas.height = 0;
  return url;
}
