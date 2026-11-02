import { chat, parseSegments, type AiConfig } from './ai';
import type { Idb } from './idb';

/**
 * 高亮在译文中的位置。
 *
 * 高亮锚定在原文上；显示译文时需要知道译文里哪一段对应被高亮的原文。
 * 先用启发式立即给出位置（原文片段在译文中原样出现，或按长度比例），
 * 配置了 AI 时再请模型精确对齐，结果缓存在本机。
 */

export interface Span {
  ts: number;
  te: number;
}

const PUNCT = /[，。、；：！？,.;:!?）)」』”’\s]/;

/** 启发式对齐：原样出现（术语、名称）时直接用；否则按位置比例，并对齐到词或标点边界。 */
export function heuristicAlign(src: string, cs: number, ce: number, tr: string): Span {
  const quote = src.slice(cs, ce).trim();
  const ratioS = src.length ? cs / src.length : 0;
  if (quote.length >= 2) {
    let best = -1;
    let bestD = Infinity;
    for (let i = tr.indexOf(quote); i >= 0; i = tr.indexOf(quote, i + 1)) {
      const d = Math.abs(i / Math.max(1, tr.length) - ratioS);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) return { ts: best, te: best + quote.length };
  }
  // 句子数一致时先按句子对应，再在句内按比例；否则按整段比例
  const ss = sentenceStarts(src, /(?<=[.!?])\s+(?=[\p{Lu}(\[])/gu);
  const ts0 = sentenceStarts(tr, /(?<=[。！？!?.])\s*(?=\S)/gu);
  const mapPos = (pos: number, end: boolean): number => {
    if (ss.length === ts0.length && ss.length > 1) {
      let k = ss.length - 1;
      while (k > 0 && (end ? ss[k] >= pos : ss[k] > pos)) k--;
      const sEnd = k + 1 < ss.length ? ss[k + 1] : src.length;
      const tEnd = k + 1 < ts0.length ? ts0[k + 1] : tr.length;
      const r = (pos - ss[k]) / Math.max(1, sEnd - ss[k]);
      return Math.round(ts0[k] + r * (tEnd - ts0[k]));
    }
    return Math.round((pos / Math.max(1, src.length)) * tr.length);
  };
  let ts = mapPos(cs, false);
  let te = Math.max(ts + 1, mapPos(ce, true));
  const ratioS2 = ts;
  const ratioE2 = te;
  // 起点退到上一个标点或空格之后，终点延到下一个标点之前（各最多几个字符）
  for (let k = 0; k < 4 && ts > 0 && !PUNCT.test(tr[ts - 1]); k++) ts--;
  if (ts > 0 && !PUNCT.test(tr[ts - 1])) ts = ratioS2;
  for (let k = 0; k < 4 && te < tr.length && !PUNCT.test(tr[te]); k++) te++;
  if (te < tr.length && !PUNCT.test(tr[te])) te = Math.max(ts + 1, ratioE2);
  // 不要切开西文单词
  while (ts > 0 && /[A-Za-z0-9]/.test(tr[ts - 1]) && /[A-Za-z0-9]/.test(tr[ts])) ts--;
  while (te < tr.length && /[A-Za-z0-9]/.test(tr[te - 1]) && /[A-Za-z0-9]/.test(tr[te])) te++;
  return { ts: Math.max(0, ts), te: Math.min(tr.length, te) };
}

function sentenceStarts(text: string, re: RegExp): number[] {
  const out = [0];
  for (const m of text.matchAll(re)) {
    const at = (m.index ?? 0) + m[0].length;
    if (at > 0 && at < text.length) out.push(at);
  }
  return out;
}

export interface AlignReq {
  key: string;
  src: string;
  cs: number;
  ce: number;
  tr: string;
}

const OPEN = '⟦';
const CLOSE = '⟧';

const SYSTEM = [
  'You align highlights between a source paragraph and its translation.',
  `In each item, the SOURCE contains one span marked with ${OPEN} and ${CLOSE}. Find the part of the TRANSLATION that expresses exactly that span.`,
  `Reply with the same [[n]] markers; after each, copy the TRANSLATION exactly, character for character, inserting ${OPEN} before and ${CLOSE} after the corresponding part. Do not change, add or remove any other character. Mark one contiguous part only; if the meaning is spread out, mark the shortest part that covers it.`,
].join('\n');

/** 用 AI 精确对齐；返回 key → 位置。模型输出与译文不一致的条目会被丢弃（调用方保留启发式结果）。 */
export async function aiAlign(cfg: AiConfig, apiKey: string, reqs: AlignReq[], signal?: AbortSignal): Promise<Map<string, Span>> {
  const out = new Map<string, Span>();
  if (!reqs.length) return out;
  const user = reqs
    .map((r, i) => `[[${i + 1}]]\nSOURCE: ${r.src.slice(0, r.cs)}${OPEN}${r.src.slice(r.cs, r.ce)}${CLOSE}${r.src.slice(r.ce)}\nTRANSLATION: ${r.tr}`)
    .join('\n\n');
  const content = await chat(cfg, apiKey, SYSTEM, user, signal, 0);
  const segs = parseSegments(content);
  reqs.forEach((r, i) => {
    const marked = segs.get(i + 1)?.replace(/^TRANSLATION:\s*/, '');
    const span = marked ? spanFromMarked(marked, r.tr) : null;
    if (span) out.set(r.key, span);
  });
  return out;
}

/** 从带标记的译文中取出位置；去掉标记后必须与原译文一致（忽略空白差异） */
export function spanFromMarked(marked: string, tr: string): Span | null {
  const a = marked.indexOf(OPEN);
  const b = marked.indexOf(CLOSE);
  if (a < 0 || b < a) return null;
  const plain = marked.slice(0, a) + marked.slice(a + 1, b) + marked.slice(b + 1);
  const norm = (s: string) => s.replace(/\s+/g, '');
  if (norm(plain) !== norm(tr)) return null;
  // 按去空白后的位置映射回原译文
  const toOrig = (n: number) => {
    let seen = 0;
    for (let i = 0; i < tr.length; i++) {
      if (/\s/.test(tr[i])) continue;
      if (seen === n) return i;
      seen++;
    }
    return tr.length;
  };
  const ts = toOrig(norm(marked.slice(0, a)).length);
  const te = toOrig(norm(marked.slice(0, b)).length - 1);
  return te > ts ? { ts, te } : null;
}

export function alignCacheKey(paperId: string, version: string, lang: string, page: number, block: number, cs: number, ce: number, tr: string): string {
  return `ai-hl:${paperId}:${version}:${lang}:${page}:${block}:${cs}-${ce}:${hash(tr)}`;
}

export async function loadAligned(idb: Idb, key: string): Promise<Span | null> {
  return (await idb.get<Span>('kv', key)) ?? null;
}

export async function saveAligned(idb: Idb, key: string, span: Span): Promise<void> {
  await idb.put('kv', key, span);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
