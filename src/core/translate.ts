import type { PDFDoc } from '../pdf/engine';
import { extractBlocks, type TextBlock } from '../pdf/blocks';
import { AiHttpError, resolveTargetLang, translateItems, type AiConfig } from './ai';
import type { Idb } from './idb';
import { tr } from './i18n';

/** 译文块：位置与字号沿用原文，文字为译文。坐标同 TextBlock（scale = 1）。 */
export interface TransBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  /** 原文行距（旧缓存可能没有） */
  lh?: number;
  /** 原文对齐方式 */
  al?: 'justify' | 'center' | 'left';
  t: string;
}

/** 每个请求的字符上限：批次小一些、并发多一些，整体更快，单次失败的代价也更小 */
const BATCH_CHARS = 2500;
/** 同时进行的请求数 */
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

// v2：分块规则改变（排除 arXiv 竖排编号等），旧缓存不再使用
function cacheKey(paperId: string, version: string, lang: string, page: number): string {
  return `ai-tr2:${paperId}:${version}:${lang}:${page}`;
}

export async function loadPageTranslation(idb: Idb, paperId: string, version: string, lang: string, page: number): Promise<TransBlock[] | null> {
  const rec = await idb.get<{ blocks: TransBlock[] }>('kv', cacheKey(paperId, version, lang, page));
  return rec?.blocks ?? null;
}

/** 删除某篇论文（当前语言）的全部译文缓存，用于重新翻译 */
export async function clearPaperTranslation(idb: Idb, paperId: string, version: string, lang: string, pages: number): Promise<void> {
  for (let n = 1; n <= pages; n++) await idb.del('kv', cacheKey(paperId, version, lang, n));
}

export interface TranslateOpts {
  pdf: PDFDoc;
  idb: Idb;
  paperId: string;
  version: string;
  cfg: AiConfig;
  apiKey: string;
  signal: AbortSignal;
  /** 论文标题，作为术语上下文 */
  title?: string;
  /** 优先翻译的页（通常是正在阅读的页），之后的页依次进行，最后回到前面的页 */
  startPage?: number;
  onPage: (page: number, blocks: TransBlock[]) => void;
  onProgress: (done: number, total: number) => void;
}

export interface TranslateResult {
  /** 未能完成的页（下次「继续翻译」会重试） */
  failed: number[];
  lastError?: string;
}

/**
 * 翻译整篇论文：已缓存的页面直接跳过，因此中途退出后可以继续；
 * 每页完成后立即写入本地缓存（不进入 GitHub 仓库）。文本只会发送到用户配置的 AI 服务。
 */
export async function translatePaper(opts: TranslateOpts): Promise<TranslateResult> {
  const { pdf, idb, paperId, version, cfg, apiKey, signal } = opts;
  const total = pdf.numPages;
  const lang = resolveTargetLang(cfg);

  let done = 0;
  const pending: number[] = [];
  for (let n = 1; n <= total; n++) {
    const cached = await loadPageTranslation(idb, paperId, version, lang, n);
    if (cached) {
      opts.onPage(n, cached);
      done++;
    } else pending.push(n);
  }
  opts.onProgress(done, total);
  if (!pending.length) return { failed: [] };

  // 提取全部页面的文本块（很快）；参考文献需要跨页判断，所以按顺序处理
  const pageBlocks = new Map<number, TextBlock[]>();
  const skip = new Map<number, boolean[]>();
  let inRefs = false;
  for (let n = 1; n <= total; n++) {
    throwIfAborted(signal);
    const blocks = await extractBlocks(await pdf.getPage(n));
    pageBlocks.set(n, blocks);
    skip.set(
      n,
      blocks.map((b) => {
        const r = classifyReference(b.text, inRefs);
        inRefs = r.inRefs;
        return r.skip;
      }),
    );
  }
  const context = paperContext(opts.title ?? '', pageBlocks.get(1) ?? []);

  const start = Math.min(Math.max(1, opts.startPage ?? 1), total);
  const order = [...pending.filter((n) => n >= start), ...pending.filter((n) => n < start)];
  const run = limiter(CONCURRENCY);
  // 内部信号：用户停止，或遇到配置错误时取消其余请求
  const ctrl = new AbortController();
  const sig = ctrl.signal;
  const stop = () => ctrl.abort();
  signal.addEventListener('abort', stop);
  const failed: number[] = [];
  let lastError: string | undefined;
  let fatal: unknown = null;

  const translatePage = async (n: number) => {
    const blocks = pageBlocks.get(n) ?? [];
    const flags = skip.get(n) ?? [];
    const items = blocks.map((b, i) => ({ id: String(i), text: b.text })).filter((_, i) => !flags[i]);
    try {
      const results = await Promise.all([...batches(items)].map((batch) => run(() => translateBatch(cfg, apiKey, batch, sig, context))));
      const map = new Map<string, string>();
      for (const r of results) for (const [id, t] of r) map.set(id, t);
      const out: TransBlock[] = [];
      blocks.forEach((b, i) => {
        const t = map.get(String(i));
        // 模型原样返回（作者、单位、文献条目等）时保留原文，不做覆盖
        if (t && normalize(t) !== normalize(b.text)) out.push({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.size, lh: b.pitch, al: b.align, t });
      });
      await idb.put('kv', cacheKey(paperId, version, lang, n), { blocks: out });
      opts.onPage(n, out);
      opts.onProgress(++done, total);
    } catch (e) {
      if (isAbort(e)) throw e;
      if (e instanceof AiHttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
        // 认证、模型名等配置错误：其余页面也不会成功，直接停止
        fatal ??= e;
        ctrl.abort();
        throw e;
      }
      failed.push(n);
      lastError = e instanceof Error ? e.message : String(e);
    }
  };

  try {
    await Promise.allSettled(order.map((n) => translatePage(n)));
  } finally {
    signal.removeEventListener('abort', stop);
  }
  if (fatal) throw fatal;
  throwIfAborted(signal);
  return { failed: failed.sort((a, b) => a - b), lastError };
}

/** 一个批次：网络错误、429、5xx 时退避重试；漏掉的段落再单独补一次。 */
async function translateBatch(
  cfg: AiConfig,
  apiKey: string,
  batch: { id: string; text: string }[],
  signal: AbortSignal,
  context: string,
): Promise<Map<string, string>> {
  const out = await withRetry(() => translateItems(cfg, apiKey, batch, signal, context), signal);
  const missing = batch.filter((it) => !out.has(it.id));
  if (missing.length && missing.length < batch.length) {
    try {
      const again = await withRetry(() => translateItems(cfg, apiKey, missing, signal, context), signal);
      for (const [id, t] of again) out.set(id, t);
    } catch (e) {
      if (isAbort(e)) throw e;
    }
  } else if (missing.length === batch.length) {
    throw new Error(tr('AI 回复格式不正确'));
  }
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (e) {
      if (isAbort(e)) throw e;
      const retryable = !(e instanceof AiHttpError) || e.status === 408 || e.status === 429 || e.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw e;
      await sleep(1500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5), signal);
    }
  }
}

/** 并发上限；按提交顺序排队，所以先提交的页面先完成 */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next(); // 名额直接交给下一个
      else active--;
    }
  };
}

/** 标题 + 摘要，帮助模型统一术语 */
function paperContext(title: string, firstPage: TextBlock[]): string {
  const parts: string[] = [];
  if (title.trim()) parts.push(`Title: ${title.trim()}`);
  const i = firstPage.findIndex((b) => /^abstract\b/i.test(b.text));
  const abs = i >= 0 ? firstPage.slice(i, i + 3).map((b) => b.text).join(' ') : firstPage.slice(0, 4).map((b) => b.text).join(' ');
  if (abs) parts.push(abs.slice(0, 1500));
  return parts.join('\n');
}

const REF_HEADING = /^(\d+\.?\s*)?(references|bibliography|参考文献)$/i;
const YEAR = /\b(19|20)\d{2}[a-z]?\b/;

/** 参考文献条目不翻译：既浪费时间，也容易把作者名和刊名译坏。 */
export function classifyReference(text: string, inRefs: boolean): { skip: boolean; inRefs: boolean } {
  const t = text.trim();
  if (REF_HEADING.test(t)) return { skip: true, inRefs: true };
  const numbered = /^\[\d+\]/.test(t);
  if (numbered && YEAR.test(t)) return { skip: true, inRefs };
  if (inRefs) {
    if (numbered || YEAR.test(t)) return { skip: true, inRefs: true };
    // 没有年份的短块多半是下一个标题（如附录），参考文献结束
    return { skip: false, inRefs: false };
  }
  return { skip: false, inRefs: false };
}

/** 按字符数切分批次 */
function* batches(items: { id: string; text: string }[]): Generator<{ id: string; text: string }[]> {
  let cur: { id: string; text: string }[] = [];
  let size = 0;
  for (const item of items) {
    if (size + item.text.length > BATCH_CHARS && cur.length) {
      yield cur;
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += item.text.length;
  }
  if (cur.length) yield cur;
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
