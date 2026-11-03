import { tr } from '../core/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Fragment, type ComponentChildren } from 'preact';
import type { PDFDoc } from '../pdf/engine';
import { CAPTION, type InlineMath, type PageLayout, type LayoutBlock } from '../pdf/blocks';
import { pageBitmap, type PageBitmap } from '../pdf/bitmap';
import { pageLayout } from '../pdf/layoutcache';
import { contextOf, locateQuote } from '../core/anchor';
import { locateInBlocks, rangesInBlock, rawRangeOf, rectsForRaw, transByBlock } from '../core/reflowmap';
import type { Annotation, Rect } from '../core/types';
import type { TransBlock } from '../core/translate';
import type { TransMarkSpan } from './translayer';
import type { FlowItem } from '../pdf/blocks';

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
  /** 矩形可信（不必在原版页面重新定位） */
  trust?: boolean;
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
  /** 显示在正文最上方（例如切换到 arXiv HTML 版的入口） */
  topBar?: ComponentChildren;
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
        {p.topBar}
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
}) {
  const { layout, page } = props;
  // 高亮在本页原始文本中的位置
  const located: Located[] = [];
  const blockSpans: { ann: Annotation; i: number; s: number; e: number }[] = [];
  for (const a of props.anns) {
    const m = locateQuote(layout.raw, { quote: a.quote, prefix: a.prefix, suffix: a.suffix, start: a.start });
    if (m) located.push({ ann: a, start: m.start, end: m.end });
    else for (const g of locateInBlocks(layout, a.quote) ?? []) blockSpans.push({ ann: a, ...g });
  }
  const tmap = transByBlock(layout, props.trans);
  const byId = new Map(props.anns.map((a) => [a.id, a]));

  // 行内公式：页面进入视口附近时取整页位图，把每个公式区域画到对应的小画布上
  const secRef = useRef<HTMLElement>(null);
  const [bmp, setBmp] = useState<PageBitmap | null>(null);
  const hasMath = layout.blocks.some((b) => b.math?.length);
  useEffect(() => {
    const el = secRef.current;
    if (!el || !hasMath) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void pageBitmap(props.pdf, page).then((b) => !cancelled && setBmp(b), () => {});
      },
      { rootMargin: '1200px 0px' },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [props.pdf, page, hasMath]);
  useEffect(() => {
    const el = secRef.current;
    if (!el || !bmp) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    el.querySelectorAll<HTMLCanvasElement>('canvas[data-math]').forEach((c) => {
      const key = `${c.dataset.math}|${c.clientWidth}`;
      if (c.dataset.drawn === key) return;
      const [x, y, w, h] = c.dataset.math!.split(',').map(Number);
      const cw = Math.max(1, Math.round((c.clientWidth || w) * dpr));
      const ch = Math.max(1, Math.round((c.clientHeight || h) * dpr));
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(bmp.canvas, x * bmp.scale, y * bmp.scale, w * bmp.scale, h * bmp.scale, 0, 0, cw, ch);
      c.dataset.drawn = key;
    });
  });

  return (
    <section class="rf-page" data-page={page} ref={secRef}>
      <div class="rf-pageno" aria-hidden="true">{page}</div>
      {groupFlow(layout, layout.flow, tmap).map((g, k) => {
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
            for (const g of blockSpans) if (g.i === b.i) spans.push({ s: g.s, e: g.e, ann: g.ann });
          }
          for (const a of uniqueNotes(spans)) if (!notes.includes(a)) notes.push(a);
          // 段落跨栏时分成多块，这里拼回同一段；块之间的空格不属于任何块
          const sep = j > 0 && !(g.translated && /[\u3000-\u9fff]$/.test(tmap.get(g.blocks[j - 1].i)?.tb.t ?? '')) ? ' ' : '';
          return (
            <Fragment key={b.i}>
              {sep}
              <span data-b={b.i} data-tr={t ? '1' : undefined}>{renderMarked(text, spans, props.focusId, t ? [] : b.math ?? [], b.size)}</span>
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
      // 图或公式之后另起一段，保证它出现在原来的位置
      lastPara = null;
      continue;
    }
    const b = layout.blocks[f.i];
    if (!b) continue;
    const translated = tmap.has(b.i);
    const prev = lastPara?.blocks[lastPara.blocks.length - 1];
    // 版面分析给出段落归属时直接采用；否则按句子是否结束来判断
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
/**
 * 按高亮区间切分文字；重叠时后创建的高亮在外层显示。
 * 行内公式以截图显示：图片放在公式区间的开头，原文文字隐藏保留（用于选择、复制与偏移计算）。
 */
function renderMarked(text: string, spans: Span[], focusId: string | null, maths: InlineMath[] = [], size = 10): ComponentChildren {
  if (!spans.length && !maths.length) return text;
  const cuts = new Set<number>([0, text.length]);
  for (const sp of spans) {
    cuts.add(Math.max(0, Math.min(text.length, sp.s)));
    cuts.add(Math.max(0, Math.min(text.length, sp.e)));
  }
  for (const m of maths) {
    cuts.add(m.s);
    cuts.add(m.e);
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const out: ComponentChildren[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const piece = text.slice(a, b);
    const m = maths.find((x) => x.s <= a && x.e >= b);
    let node: ComponentChildren = piece;
    if (m) {
      node =
        m.s === a ? (
          <span class="rf-math" key={`m${i}`} style={{ width: `${m.w / size}em`, height: `${m.h / size}em`, verticalAlign: `${-(m.y + m.h - m.base) / size}em` }}>
            <canvas data-math={`${m.x},${m.y},${m.w},${m.h}`} />
            <span class="rf-src">{piece}</span>
          </span>
        ) : (
          <span class="rf-src-tail" key={`m${i}`}>{piece}</span>
        );
    }
    const cover = spans.filter((sp) => sp.s <= a && sp.e >= b).sort((x, y) => x.ann.createdAt - y.ann.createdAt);
    const top = cover[cover.length - 1];
    if (!top) {
      out.push(node);
      continue;
    }
    const last = top.e === b;
    out.push(
      <mark
        key={i}
        data-ann={top.ann.id}
        class={`rf-hl ${top.ann.color} ${top.ann.decoration ?? 'highlight'}${focusId === top.ann.id ? ' focus' : ''}${last && top.ann.note.trim() ? ' has-note' : ''}`}
      >
        {node}
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
    void pageBitmap(props.pdf, props.page)
      .then((bmp) => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (cancelled || !canvas || !wrap) return;
        const sw = rect.w * pageW * bmp.scale;
        const sh = rect.h * pageH * bmp.scale;
        canvas.width = Math.max(1, Math.round(sw));
        canvas.height = Math.max(1, Math.round(sh));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(bmp.canvas, rect.x * pageW * bmp.scale, rect.y * pageH * bmp.scale, sw, sh, 0, 0, canvas.width, canvas.height);
        if (isBlank(ctx, canvas.width, canvas.height)) setBlank(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, rect.x, rect.y, rect.w, rect.h]);

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
