import { createIdb } from './idb';

export interface AiOptions {
  baseUrl: string;
  model: string;
}

const DEFAULTS: AiOptions = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};
const OPTIONS_KEY = 'paper-reader.ai-options';
const SECRET_KEY = 'paper-reader.ai-api-key';
const AAD = new TextEncoder().encode('ilimchi:ai-key:v1');
const db = createIdb();
const listeners = new Set<() => void>();

interface SecretRecord {
  key: CryptoKey;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

export function getAiOptions(): AiOptions {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    const value = raw ? JSON.parse(raw) as Partial<AiOptions> : {};
    return {
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : DEFAULTS.baseUrl,
      model: typeof value.model === 'string' ? value.model : DEFAULTS.model,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function subscribeAiConfig(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function validateOptions(options: AiOptions): AiOptions {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  const model = options.model.trim();
  if (!baseUrl || !model) throw new Error('请填写 API 地址和模型名称');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('API 地址不是有效的 URL');
  }
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('API 地址必须使用 HTTPS；本机 localhost 可以使用 HTTP');
  }
  return { baseUrl, model };
}

async function encryptKey(apiKey: string): Promise<SecretRecord> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('当前浏览器不支持安全的密钥存储，请使用 HTTPS 或 localhost 打开 Ilimchi');
  const key = await cryptoApi.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: AAD as BufferSource },
    key,
    new TextEncoder().encode(apiKey),
  );
  return { key, iv, ciphertext };
}

export async function hasAiKey(): Promise<boolean> {
  return !!(await db.get<SecretRecord>('kv', SECRET_KEY));
}

async function loadAiKey(): Promise<string | null> {
  const record = await db.get<SecretRecord>('kv', SECRET_KEY);
  if (!record) return null;
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv as BufferSource, additionalData: AAD as BufferSource },
      record.key,
      record.ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('无法解密本机保存的 AI Key，请清除并重新配置');
  }
}

/** Key is encrypted in IndexedDB; provider options contain no credentials. Empty apiKey preserves an existing key. */
export async function saveAiConfig(options: AiOptions, apiKey: string): Promise<void> {
  const clean = validateOptions(options);
  const key = apiKey.trim();
  if (key) await db.put('kv', SECRET_KEY, await encryptKey(key));
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(clean));
  } catch {
    throw new Error('无法保存 AI 设置，请检查浏览器存储权限');
  }
  notify();
}

export async function clearAiConfig(): Promise<void> {
  await db.del('kv', SECRET_KEY);
  try {
    localStorage.removeItem(OPTIONS_KEY);
  } catch {
    /* Ignore storage restrictions. */
  }
  notify();
}

export async function requestAi(
  systemPrompt: string,
  userPrompt: string,
  options: AiOptions = getAiOptions(),
  apiKeyOverride?: string,
): Promise<string> {
  const clean = validateOptions(options);
  const apiKey = apiKeyOverride?.trim() || await loadAiKey();
  if (!apiKey) throw new Error('请先在设置中配置 AI API Key');

  const base = clean.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const endpoint = base + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: clean.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1400,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('AI 请求超时，请检查网络或稍后重试');
    }
    throw new Error('无法连接 AI 服务。请检查 API 地址、网络和服务端的 CORS 设置');
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null) as {
    error?: string | { message?: string };
    choices?: { message?: { content?: unknown } }[];
  } | null;
  if (!response.ok) {
    const rawError = data?.error;
    const message = typeof rawError === 'string' ? rawError : rawError?.message;
    throw new Error(message || 'AI 服务返回 HTTP ' + response.status);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.map((part: unknown) => {
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    }).join('').trim();
    if (text) return text;
  }
  throw new Error('AI 返回了空内容；请检查模型名称和 API 兼容性');
}
