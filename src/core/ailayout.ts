import { chat, type AiConfig, type ContentPart } from './ai';
import type { FlowItem, PageLayout } from '../pdf/blocks';
import type { Idb } from './idb';

/**
 * 用能看图的模型识别版面（重排视图使用）。
 *
 * 模型只做判断，不改写文字：输入页面截图和带编号的文字块，输出阅读顺序、段落归属、
 * 图 / 表 / 公式的完整范围，以及要丢弃的页眉页脚。文字仍取自 PDF 原文，
 * 所以高亮、笔记与译文的锚点不受影响。
 *
 * 第二步自检：把裁剪框画在页面图上交给模型复查，修正被截断或混入正文的框。
 */

/** 页面坐标统一为 0..1000 的整数，方便模型读写 */
const S = 1000;

interface Plan {
  items?: { type?: string; ids?: unknown; box?: unknown }[];
}

interface Check {
  ok?: boolean;
  boxes?: { n?: number; box?: unknown }[];
  remove?: unknown;
}

const VISUAL = new Set(['figure', 'table', 'equation', 'algorithm']);
const TEXTUAL = new Set(['text', 'heading', 'caption', 'list']);

const PLAN_PROMPT = `You are a document layout analyst. You get a rendered page of an academic paper and the list of text blocks extracted from its PDF (id, box, text). Boxes use page coordinates scaled to 0-${S} (x right, y down).

Decide how the page should be shown in a single-column reflowed reader on a phone:
- Body text, headings and captions are reflowed as text, using the block ids.
- Figures, tables, display equations and algorithm boxes are shown as images cropped from the page, so give each one box that covers the complete visual: all sub-panels, axis labels, legends, in-figure text and arrows, but not its caption and not any body paragraph.
- Running headers/footers, page numbers, margin stamps and line numbers are dropped.

Return JSON only, no commentary:
{"items":[ ... ]} in reading order, where each item is one of
{"type":"heading","ids":[...]}
{"type":"text","ids":[...]}   ← one paragraph; list several ids when a paragraph is split across columns or around a figure
{"type":"caption","ids":[...]}
{"type":"figure"|"table"|"equation"|"algorithm","box":[x0,y0,x1,y1],"ids":[ids of text blocks that lie inside this visual]}
{"type":"drop","ids":[...]}
Every block id must appear in exactly one item. Reading order for two-column pages: full-width items in vertical position, otherwise the left column top to bottom, then the right column.`;

const CHECK_PROMPT = `The page image now shows the crop boxes you proposed, drawn in red and numbered. Check every box:
- it must contain the complete figure/table/equation (nothing cut off: sub-panels, labels, legends, axis text);
- it must not contain body paragraphs or the caption;
- there must be no figure/table/equation left without a box.
Return JSON only: {"ok":true} if all are right, otherwise {"boxes":[{"n":<number>,"box":[x0,y0,x1,y1]}, ...], "remove":[<numbers of boxes that are not visuals>], "add":[{"type":"figure","box":[x0,y0,x1,y1]}]} with coordinates on the same 0-${S} scale.`;

export interface AiLayoutOpts {
  cfg: AiConfig;
  apiKey: string;
  layout: PageLayout;
  /** 页面截图（data URL） */
  image: string;
  /** 在页面截图上画出编号的裁剪框，返回新的 data URL */
  annotate: (boxes: { x: number; y: number; w: number; h: number }[]) => Promise<string>;
  signal?: AbortSignal;
}

export async function aiLayoutPage(o: AiLayoutOpts): Promise<FlowItem[]> {
  const { layout } = o;
  const model = o.cfg.visionModel?.trim() || o.cfg.model;
  const blocks = layout.blocks.map((b) => ({
    id: b.i,
    box: [b.x, b.y, b.x + b.w, b.y + b.h].map((v, k) => Math.round((v / (k % 2 ? layout.height : layout.width)) * S)),
    text: b.text.length > 120 ? `${b.text.slice(0, 120)}…` : b.text,
  }));
  const user: ContentPart[] = [
    { type: 'image_url', image_url: { url: o.image, detail: 'high' } },
    { type: 'text', text: `Text blocks:\n${blocks.map((b) => JSON.stringify(b)).join('\n')}` },
  ];
  const planText = await chat(o.cfg, o.apiKey, PLAN_PROMPT, user, o.signal, 0, model);
  const plan = parseJson<Plan>(planText);
  if (!plan?.items?.length) throw new Error('AI layout: empty plan');
  let flow = planToFlow(plan, layout);

  // 自检一轮：把裁剪框画到页面图上让模型复查
  const crops = flow.filter((f): f is Extract<FlowItem, { kind: 'crop' }> => f.kind === 'crop');
  if (crops.length) {
    try {
      const marked = await o.annotate(crops);
      const checkText = await chat(
        o.cfg,
        o.apiKey,
        PLAN_PROMPT,
        [
          ...user,
          { type: 'text', text: `Your answer was:\n${planText}` },
          { type: 'image_url', image_url: { url: marked, detail: 'high' } },
          { type: 'text', text: CHECK_PROMPT },
        ],
        o.signal,
        0,
        model,
      );
      const check = parseJson<Check>(checkText);
      if (check && !check.ok) flow = applyCheck(flow, crops, check, layout);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      /* 复查失败时使用第一轮结果 */
    }
  }
  return flow;
}

/** 模型的计划 → 重排项；校验编号，漏掉的文字块按原顺序补回，不让任何原文丢失 */
export function planToFlow(plan: Plan, layout: PageLayout): FlowItem[] {
  const n = layout.blocks.length;
  const used = new Set<number>();
  const flow: FlowItem[] = [];
  /** 每个文字块落在哪一项里（文字项或包含它的截图） */
  const owner = new Map<number, FlowItem>();
  const takeIds = (raw: unknown): number[] =>
    (Array.isArray(raw) ? raw : [])
      .map((v) => Number(v))
      .filter((i) => Number.isInteger(i) && i >= 0 && i < n && !used.has(i));
  for (const it of plan.items ?? []) {
    const type = String(it.type ?? '').toLowerCase();
    const ids = takeIds(it.ids);
    if (type === 'drop') {
      ids.forEach((i) => used.add(i));
      continue;
    }
    if (VISUAL.has(type)) {
      const box = toBox(it.box, layout);
      // 框至少要盖住它包含的文字块
      let r = box;
      for (const i of ids) {
        const b = layout.blocks[i];
        const bb = { x: b.x / layout.width, y: b.y / layout.height, w: b.w / layout.width, h: b.h / layout.height };
        r = r ? union(r, bb) : bb;
        used.add(i);
      }
      if (r && r.w > 0.01 && r.h > 0.005) {
        const crop: FlowItem = { kind: 'crop', ...pad(r, 0.004) };
        flow.push(crop);
        ids.forEach((i) => owner.set(i, crop));
      }
      continue;
    }
    if (TEXTUAL.has(type) || ids.length) {
      const role = type === 'heading' ? 'heading' : type === 'caption' ? 'caption' : 'text';
      ids.forEach((i, k) => {
        used.add(i);
        const item: FlowItem = { kind: 'block', i, role, cont: k > 0 };
        flow.push(item);
        owner.set(i, item);
      });
    }
  }
  // 漏掉的块：放到原阅读顺序中前一个块之后
  const order = layout.flow.filter((f): f is Extract<FlowItem, { kind: 'block' }> => f.kind === 'block').map((f) => f.i);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (used.has(i) || layout.blocks[i].role === 'skip' || layout.blocks[i].role === 'inside') continue;
    let at = -1;
    for (let j = k - 1; j >= 0 && at < 0; j--) {
      const o = owner.get(order[j]);
      if (o) at = flow.indexOf(o);
    }
    const item: FlowItem = { kind: 'block', i, role: 'text' };
    flow.splice(at + 1, 0, item);
    owner.set(i, item);
    used.add(i);
  }
  return flow;
}

function applyCheck(flow: FlowItem[], crops: Extract<FlowItem, { kind: 'crop' }>[], check: Check, layout: PageLayout): FlowItem[] {
  const remove = new Set((Array.isArray(check.remove) ? check.remove : []).map((v) => Number(v) - 1));
  for (const b of check.boxes ?? []) {
    const k = Number(b.n) - 1;
    const r = toBox(b.box, layout);
    if (crops[k] && r && r.w > 0.01 && r.h > 0.005) Object.assign(crops[k], pad(r, 0.004));
  }
  return flow.filter((f) => !(f.kind === 'crop' && remove.has(crops.indexOf(f))));
}

function toBox(raw: unknown, _layout: PageLayout): { x: number; y: number; w: number; h: number } | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const v = raw.map((x) => Math.max(0, Math.min(S, Number(x)))) as number[];
  if (v.some((x) => !Number.isFinite(x))) return null;
  const [x0, y0, x1, y1] = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  return { x: x0 / S, y: y0 / S, w: (x1 - x0) / S, h: (y1 - y0) / S };
}

function union(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

function pad(r: { x: number; y: number; w: number; h: number }, p: number) {
  const x = Math.max(0, r.x - p);
  const y = Math.max(0, r.y - p);
  return { x, y, w: Math.min(1, r.x + r.w + p) - x, h: Math.min(1, r.y + r.h + p) - y };
}

function parseJson<T>(text: string): T | null {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}

// ---------- 缓存（本机） ----------

export function layoutCacheKey(paperId: string, version: string, page: number, model: string): string {
  return `ai-layout:v1:${paperId}:${version}:${page}:${model}`;
}

export async function loadAiLayout(idb: Idb, key: string): Promise<FlowItem[] | null> {
  return (await idb.get<FlowItem[]>('kv', key)) ?? null;
}

export async function saveAiLayout(idb: Idb, key: string, flow: FlowItem[]): Promise<void> {
  await idb.put('kv', key, flow);
}
