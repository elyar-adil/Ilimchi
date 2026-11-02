import { LANG, tr } from './i18n';
import type { Idb } from './idb';

/**
 * AI 功能（可选，默认隐藏）。
 *
 * - 服务地址、模型、目标语言：只存在本设备的 localStorage，不含凭据。
 * - API Key：只存在本设备。默认用不可导出的 AES-GCM 密钥加密后存入 IndexedDB；
 *   也可以选择「仅本次会话」，此时只保留在内存中，关闭标签页即消失。
 * - 请求从浏览器直接发往用户配置的服务（OpenAI 兼容的 /chat/completions 接口），
 *   不经过任何我们自己的服务器。
 *
 * Key 永远不会写入源码、构建产物或 Git 仓库。
 */

export interface AiConfig {
  /** 服务地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  /** 目标语言代码，见 TARGET_LANGS；'auto' 表示跟随界面语言 */
  targetLang: string;
}

export const TARGET_LANGS: { id: string; name: string }[] = [
  { id: 'zh-CN', name: '简体中文' },
  { id: 'en', name: 'English' },
  { id: 'ja', name: '日本語' },
  { id: 'ko', name: '한국어' },
  { id: 'fr', name: 'Français' },
  { id: 'de', name: 'Deutsch' },
  { id: 'es', name: 'Español' },
];

const CONFIG_KEY = 'paper-reader.ai';
/** 用户是否在设置中展开过 AI 区域；未展开时 AI 功能完全隐藏 */
const REVEAL_KEY = 'paper-reader.ai.revealed';

const DEFAULT_CONFIG: AiConfig = { baseUrl: '', model: '', targetLang: 'auto' };

/** 实际使用的目标语言：'auto' 时跟随界面语言 */
export function resolveTargetLang(cfg: AiConfig): string {
  if (cfg.targetLang && cfg.targetLang !== 'auto') return cfg.targetLang;
  return LANG === 'zh' ? 'zh-CN' : 'en';
}

export function getAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<AiConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setAiConfig(patch: Partial<AiConfig>): AiConfig {
  const next = { ...getAiConfig(), ...patch };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  } catch {
    /* 无法持久化时仅影响本次会话 */
  }
  return next;
}

export function isAiRevealed(): boolean {
  try {
    return localStorage.getItem(REVEAL_KEY) === '1';
  } catch {
    return false;
  }
}

/** AI 配置或 Key 变化时通知阅读器重新检查可用性 */
export const AI_CHANGED_EVENT = 'paper-reader:ai-changed';
export function notifyAiChanged(): void {
  window.dispatchEvent(new Event(AI_CHANGED_EVENT));
}

export function revealAi(): void {
  try {
    localStorage.setItem(REVEAL_KEY, '1');
  } catch {
    /* ignore */
  }
}

// ---------- API Key 存储 ----------

const subtle = () => globalThis.crypto.subtle;
const AAD = new TextEncoder().encode('paper-reader:ai-key:v1');
const VAULT_KEY = 'ai';

interface AiKeyRecord {
  key: CryptoKey;
  iv: Uint8Array;
  ct: ArrayBuffer;
}

export type AiKeyMode = 'device' | 'session';

/** 仅本次会话的 Key：只在内存中 */
let sessionKey: string | null = null;

export async function saveAiKey(idb: Idb, apiKey: string, mode: AiKeyMode): Promise<void> {
  const value = apiKey.trim();
  if (!value) throw new Error(tr('请输入 API Key'));
  await clearAiKey(idb);
  if (mode === 'session') {
    sessionKey = value;
    return;
  }
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: AAD as BufferSource }, key, new TextEncoder().encode(value));
  const rec: AiKeyRecord = { key, iv, ct };
  await idb.put('vault', VAULT_KEY, rec);
}

export async function loadAiKey(idb: Idb): Promise<string | null> {
  if (sessionKey) return sessionKey;
  const rec = await idb.get<AiKeyRecord>('vault', VAULT_KEY);
  if (!rec) return null;
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource, additionalData: AAD as BufferSource }, rec.key, rec.ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function hasAiKey(idb: Idb): Promise<boolean> {
  if (sessionKey) return true;
  return !!(await idb.get<AiKeyRecord>('vault', VAULT_KEY));
}

export async function clearAiKey(idb: Idb): Promise<void> {
  sessionKey = null;
  await idb.del('vault', VAULT_KEY);
}

// ---------- 调用 ----------

function systemPrompt(lang: string, context: string): string {
  const lines = [
    `You are an expert translator of academic papers. Translate each segment into fluent, natural ${lang}, the way a domain expert would write it in a published paper in that language — not word for word.`,
    '',
    'The segments are paragraphs, headings and captions extracted from a PDF, in reading order. Extraction may leave artifacts: words broken by hyphenation or spaces, stray footnote markers, superscript digits, or fragments of inline math. Silently repair broken words; keep everything else that is not prose exactly as it appears.',
    'A segment may begin or end in the middle of a sentence, because the paragraph continues in another column or on another page. Translate exactly the part that is there, as a fragment; do not complete it, and do not repeat or anticipate text from other segments.',
    '',
    'Rules:',
    `- Translate every sentence completely. Never leave an English sentence untranslated, never copy the source text into the output.`,
    '- Your output is pasted directly onto the page in place of the original. It must contain only the translation: no notes, no alternatives, no questions, no explanations, no labels such as "译：" or "Translation:", no comments about the source or about how something should be translated. If a word is unclear or garbled, choose the most plausible reading and translate it silently.',
    '- Keep unchanged: math and symbols, variable names, numbers and units, citation markers such as [12] or (Smith et al., 2020), URLs, code, and names of people, models, datasets, benchmarks, methods and software (e.g. Transformer, nuPlan, ResNet-50).',
    '- Widely used technical terms: use the standard translation in the field. If a term has no settled translation, keep the English term; at its first occurrence you may write the translation followed by the English in parentheses.',
    '- Use the same translation for the same term in every segment.',
    '- Headings stay short headings; keep their numbering ("3.2 Method" → "3.2 方法"). Figure/table captions keep their label ("Figure 3:" → "图 3：").',
    '- An author list, affiliation, e-mail line or bibliography entry is returned unchanged.',
    '- Never merge, split, drop or reorder segments.',
    '',
    'Input: segments, each introduced by a marker such as [[3]] on its own line.',
    'Output: exactly the same markers in the same order, each followed by the translation of that segment and nothing else.',
    '',
    'Example input:',
    '[[1]]',
    'However, these planners are trained to imitate the natural-',
    '[[2]]',
    'Figure 2: Overview of the proposed adversarial generation pipeline.',
    'Example output:',
    '[[1]]',
    '然而，这些规划器是通过模仿自然',
    '[[2]]',
    '图 2：所提出的对抗生成流程概览。',
  ];
  if (context) lines.push('', 'Context from the paper (for terminology only; do not translate it or copy it into the output):', context);
  return lines.join('\n');
}

export interface TranslateItem {
  id: string;
  text: string;
}

export class AiHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** 翻译一批文本块，返回 id -> 译文。context 为论文标题与摘要，用于统一术语。 */
export async function translateItems(
  cfg: AiConfig,
  apiKey: string,
  items: TranslateItem[],
  signal?: AbortSignal,
  context = '',
): Promise<Map<string, string>> {
  const lang = resolveTargetLang(cfg);
  const langName = TARGET_LANGS.find((l) => l.id === lang)?.name ?? lang;
  // 批内用短序号作标记，减少 token，也避免模型改写 id
  const input = items.map((it, i) => `[[${i + 1}]]\n${it.text}`).join('\n\n');
  const content = await chat(cfg, apiKey, systemPrompt(langName, context), input, signal);
  const byIndex = parseSegments(content);
  const out = new Map<string, string>();
  items.forEach((it, i) => {
    const t = byIndex.get(i + 1);
    if (t) out.set(it.id, t);
  });
  return out;
}

/** 调用 OpenAI 兼容的 /chat/completions，返回回复文本 */
export async function chat(cfg: AiConfig, apiKey: string, system: string, user: string, signal?: AbortSignal, temperature = 0.2): Promise<string> {
  const base = cfg.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error(tr('服务地址必须以 http(s):// 开头'));
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new AiHttpError(tr('AI 服务返回错误 {status}', { status: res.status }) + (detail ? `: ${detail}` : ''), res.status);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? '';
}

/** 解析 "[[n]] 译文" 格式的回复；兼容推理模型输出的 <think> 段。 */
export function parseSegments(content: string): Map<number, string> {
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  const out = new Map<number, string>();
  const re = /\[\[(\d+)\]\]/g;
  const marks: { n: number; at: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) marks.push({ n: +m[1], at: m.index, end: m.index + m[0].length });
  marks.forEach((m, i) => {
    const seg = text.slice(m.end, i + 1 < marks.length ? marks[i + 1].at : undefined).trim();
    if (seg && !out.has(m.n)) out.set(m.n, seg);
  });
  return out;
}
