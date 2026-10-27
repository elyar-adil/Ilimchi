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

const SYSTEM_PROMPT = (lang: string) =>
  [
    'You are a professional academic translator.',
    `Translate the "text" of each item into ${lang}. The source is usually English.`,
    'Keep technical terms, acronyms, model and dataset names, numbers, equations, citation markers such as [12] or (Smith et al., 2020), and URLs unchanged.',
    'Translate faithfully and concisely. Do not add commentary, notes or explanations.',
    'Input: {"items":[{"id":"...","text":"..."}]}.',
    'Reply with JSON only, in the same shape, with the same ids and the translated text.',
  ].join('\n');

export interface TranslateItem {
  id: string;
  text: string;
}

/** 翻译一批文本块，返回 id -> 译文。 */
export async function translateItems(
  cfg: AiConfig,
  apiKey: string,
  items: TranslateItem[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const base = cfg.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error(tr('服务地址必须以 http(s):// 开头'));
  const lang = resolveTargetLang(cfg);
  const langName = TARGET_LANGS.find((l) => l.id === lang)?.name ?? lang;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT(langName) },
        { role: 'user', content: JSON.stringify({ items }) },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(tr('AI 服务返回错误 {status}', { status: res.status }) + (detail ? `: ${detail}` : ''));
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content ?? '';
  return parseItems(content);
}

function parseItems(content: string): Map<string, string> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(tr('AI 返回的内容不是 JSON'));
  let parsed: { items?: { id?: unknown; text?: unknown }[] };
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new Error(tr('AI 返回的内容不是 JSON'));
  }
  const out = new Map<string, string>();
  for (const it of parsed.items ?? []) {
    if (typeof it.id === 'string' && typeof it.text === 'string') out.set(it.id, it.text);
  }
  return out;
}
