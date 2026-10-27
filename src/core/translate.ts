import type { PDFDoc } from '../pdf/engine';
import { extractBlocks, type TextBlock } from '../pdf/blocks';
import { resolveTargetLang, translateItems, type AiConfig } from './ai';
import type { Idb } from './idb';

/** 译文块：位置与字号沿用原文，文字为译文。坐标同 TextBlock（scale = 1）。 */
export interface TransBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  /** 原文行距（旧缓存可能没有） */
  lh?: number;
  t: string;
}

const BATCH_CHARS = 3500;

function cacheKey(paperId: string, version: string, lang: string, page: number): string {
  return `ai-tr:${paperId}:${version}:${lang}:${page}`;
}

export async function loadPageTranslation(idb: Idb, paperId: string, version: string, lang: string, page: number): Promise<TransBlock[] | null> {
  const rec = await idb.get<{ blocks: TransBlock[] }>('kv', cacheKey(paperId, version, lang, page));
  return rec?.blocks ?? null;
}

export interface TranslateOpts {
  pdf: PDFDoc;
  idb: Idb;
  paperId: string;
  version: string;
  cfg: AiConfig;
  apiKey: string;
  signal: AbortSignal;
  onPage: (page: number, blocks: TransBlock[]) => void;
  onProgress: (done: number, total: number) => void;
}

/**
 * 逐页翻译：已缓存的页面直接跳过；每页结果写入本地缓存（不进入 GitHub 仓库）。
 * 文本只会发送到用户配置的 AI 服务。
 */
export async function translatePaper(opts: TranslateOpts): Promise<void> {
  const { pdf, idb, paperId, version, cfg, apiKey, signal } = opts;
  const total = pdf.numPages;
  const lang = resolveTargetLang(cfg);
  for (let n = 1; n <= total; n++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const cached = await loadPageTranslation(idb, paperId, version, lang, n);
    if (cached) {
      opts.onPage(n, cached);
      opts.onProgress(n, total);
      continue;
    }
    const page = await pdf.getPage(n);
    const blocks = await extractBlocks(page);
    const map = new Map<string, string>();
    for (const batch of batches(blocks, n)) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const out = await translateItems(cfg, apiKey, batch, signal);
      for (const [id, text] of out) map.set(id, text);
    }
    const result: TransBlock[] = blocks.map((b, i) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.size, lh: b.pitch, t: map.get(`${n}-${i}`) ?? '' })).filter((b) => b.t);
    await idb.put('kv', cacheKey(paperId, version, lang, n), { blocks: result });
    opts.onPage(n, result);
    opts.onProgress(n, total);
  }
}

/** 按字符数切分批次；id 为 页码-块序号，便于回填。 */
function* batches(blocks: TextBlock[], page: number): Generator<{ id: string; text: string }[]> {
  let cur: { id: string; text: string }[] = [];
  let size = 0;
  for (let i = 0; i < blocks.length; i++) {
    const item = { id: `${page}-${i}`, text: blocks[i].text };
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
