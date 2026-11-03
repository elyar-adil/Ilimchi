import { tr } from '../core/i18n';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { PDFDoc } from '../pdf/engine';
import { pageLayout } from '../pdf/layoutcache';
import { contextOf, locateQuote } from '../core/anchor';
import { locateInBlocks, rawRunsOf, rectsForRaw } from '../core/reflowmap';
import { mergeLineRects } from '../core/anchor';
import type { Annotation } from '../core/types';
import type { ArxivHtml } from '../core/arxivhtml';
import type { ReflowSelection } from './reflow';

/**
 * arXiv HTML 版的重排视图。
 * 高亮仍然锚定在 PDF 原文上：显示时按原文片段在 HTML 文字中查找；
 * 新建高亮时把 HTML 中选中的文字到 PDF 各页中定位，得到页码与偏移。
 */

interface Props {
  doc: ArxivHtml;
  pdf: PDFDoc;
  anns: Annotation[];
  focusId: string | null;
  fontSize: number;
  jump: { page: number; id: string | null; seq: number } | null;
  onSelect: (sel: ReflowSelection | null) => void;
  onTapHl: (id: string, x: number, top: number, bottom: number) => void;
  /** 选中的文字在 PDF 中找不到（例如含公式）时提示 */
  onAnchorFail: () => void;
  onUsePdf: () => void;
}

/** 容器内文字节点（跳过公式内部，公式文字与 PDF 差别大，不参与高亮包裹） */
function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

function inMath(n: Node): boolean {
  return !!(n.parentElement && n.parentElement.closest('math'));
}

export function HtmlReflow(p: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 每次内容或高亮变化时重新生成正文，再把高亮包裹进去
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.innerHTML = p.doc.html;
    for (const a of [...p.anns].sort((x, y) => x.createdAt - y.createdAt)) {
      // 每条高亮包裹后文字节点会被拆分，所以逐条重新建立索引
      const nodes = textNodes(body);
      const starts: number[] = [];
      let full = '';
      for (const t of nodes) {
        starts.push(full.length);
        full += t.data;
      }
      const m = locateQuote(full, { quote: a.quote, prefix: a.prefix, suffix: a.suffix, start: 0 });
      if (!m) continue;
      nodes.forEach((t, k) => {
        if (inMath(t)) return;
        const s = Math.max(m.start, starts[k]) - starts[k];
        const e = Math.min(m.end, starts[k] + t.data.length) - starts[k];
        if (e <= s || !t.parentNode) return;
        const range = document.createRange();
        range.setStart(t, s);
        range.setEnd(t, e);
        const mark = document.createElement('mark');
        mark.className = `rf-hl ${a.color} ${a.decoration ?? 'highlight'}${p.focusId === a.id ? ' focus' : ''}`;
        mark.dataset.ann = a.id;
        try {
          range.surroundContents(mark);
        } catch {
          /* 跨元素的片段跳过 */
        }
      });
      // 批注显示在所在段落之后
      const marks = body.querySelectorAll<HTMLElement>(`mark[data-ann="${a.id}"]`);
      const last = marks[marks.length - 1];
      if (last && a.note.trim()) {
        last.classList.add('has-note');
        const block = last.closest('.ltx_para, p, li, figure, .ltx_equation, td') ?? last.parentElement;
        const note = document.createElement('div');
        note.className = `rf-note ${a.color}`;
        note.textContent = a.note;
        block?.after(note);
      }
    }
    // 过宽的行间公式按比例缩小到一屏宽（最多缩到 60%），其余可横向滚动
    body.querySelectorAll<HTMLElement>('table.ltx_equation, table.ltx_equationgroup, table.ltx_eqn_table').forEach((el) => {
      const w = el.clientWidth;
      const sw = el.scrollWidth;
      if (w > 0 && sw > w + 1) el.style.fontSize = `${Math.max(60, Math.floor((w / sw) * 100))}%`;
    });
  }, [p.doc.html, p.anns, p.focusId, p.fontSize]);

  useEffect(() => {
    if (!p.jump?.id) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`mark[data-ann="${p.jump.id}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [p.jump?.seq]);

  // 选中文字 → 在 PDF 中定位
  useEffect(() => {
    let timer = 0;
    let seq = 0;
    const check = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const my = ++seq;
        const body = bodyRef.current;
        const sel = window.getSelection();
        if (!body || !sel || sel.rangeCount === 0 || sel.isCollapsed || !body.contains(sel.getRangeAt(0).startContainer)) {
          p.onSelect(null);
          return;
        }
        const range = sel.getRangeAt(0);
        const quote = sel.toString().replace(/\s+/g, ' ').trim();
        if (!quote) return p.onSelect(null);
        // HTML 中的上下文，用来在 PDF 中消歧
        const before = document.createRange();
        before.setStart(body, 0);
        before.setEnd(range.startContainer, range.startOffset);
        const after = document.createRange();
        after.setStart(range.endContainer, range.endOffset);
        after.setEnd(body, body.childNodes.length);
        const prefix = before.toString().slice(-40);
        const suffix = after.toString().slice(0, 40);
        const box = range.getBoundingClientRect();
        let best: { page: number; start: number; end: number; score: number } | null = null;
        let viaBlocks: { page: number; runs: [number, number][] } | null = null;
        for (let n = 1; n <= p.pdf.numPages; n++) {
          const layout = await pageLayout(p.pdf, n);
          if (my !== seq) return;
          const m = locateQuote(layout.raw, { quote, prefix, suffix, start: 0 });
          if (m && (!best || m.score > best.score)) best = { page: n, start: m.start, end: m.end, score: m.score };
          if (best?.score === 1) break;
          // 原始文本顺序与阅读顺序不一致时，按阅读顺序的块文字查找
          if (!viaBlocks) {
            const segs = locateInBlocks(layout, quote);
            if (segs) viaBlocks = { page: n, runs: rawRunsOf(layout, segs) };
          }
        }
        if (my !== seq) return;
        if (best && best.score < 1 && viaBlocks) best = null;
        if (!best && !viaBlocks) {
          p.onSelect(null);
          p.onAnchorFail();
          return;
        }
        if (best) {
          const layout = await pageLayout(p.pdf, best.page);
          const ctx = contextOf(layout.raw, best.start, best.end);
          p.onSelect({
            page: best.page,
            start: best.start,
            end: best.end,
            quote,
            prefix: ctx.prefix,
            suffix: ctx.suffix,
            rects: rectsForRaw(layout, best.start, best.end),
            anchorTop: box.top,
            anchorLeft: box.left + box.width / 2,
          });
          return;
        }
        const vb = viaBlocks!;
        const layout = await pageLayout(p.pdf, vb.page);
        const start = vb.runs[0][0];
        const end = vb.runs[vb.runs.length - 1][1];
        const ctx = contextOf(layout.raw, start, start);
        p.onSelect({
          page: vb.page,
          start,
          end,
          quote,
          prefix: ctx.prefix,
          suffix: layout.raw.slice(end, end + 32),
          rects: mergeLineRects(vb.runs.flatMap(([a, b]) => rectsForRaw(layout, a, b))),
          // 原始文本里找不到连续引用，原版页面无法再重新定位：直接采用这里算出的矩形
          trust: true,
          anchorTop: box.top,
          anchorLeft: box.left + box.width / 2,
        });
      }, 250);
    };
    document.addEventListener('selectionchange', check);
    return () => {
      document.removeEventListener('selectionchange', check);
      window.clearTimeout(timer);
    };
  }, [p.pdf]);

  const onClick = (e: MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const target = e.target as HTMLElement;
    const mark = target.closest?.('mark[data-ann]') as HTMLElement | null;
    if (mark) {
      const r = mark.getBoundingClientRect();
      p.onTapHl(mark.dataset.ann!, e.clientX, r.top, r.bottom);
      return;
    }
    // 文内引用、公式编号等站内链接：在本视图内跳转
    const a = target.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
    if (a) {
      e.preventDefault();
      const id = decodeURIComponent(a.getAttribute('href')!.slice(1));
      bodyRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
    }
  };

  return (
    <div class="reflow" ref={scrollRef} onClick={onClick} style={{ '--rf-size': `${p.fontSize}px` } as Record<string, string>}>
      <div class="rf-doc rf-html-doc">
        <div class="rf-source">
          <span>{tr('arXiv HTML 版')}</span>
          <button class="ghost small" onClick={p.onUsePdf}>{tr('改用 PDF 重排')}</button>
        </div>
        <div class="rf-html" ref={bodyRef} lang="en" />
      </div>
    </div>
  );
}
