import { cacheKey, UNVERSIONED_TTL_MS, type PdfCache } from './pdfcache';

/**
 * 获取 PDF 字节。论文只在你的浏览器里读取，不经过、也不存放到任何自建服务器。
 *
 * 加载顺序：
 *  1. 本机缓存（IndexedDB）
 *  2. 直连原站（需要对方站点允许跨域 CORS）
 *  3. 你自己配置的可选代理模板（默认不启用）
 *  4. 失败 → 由界面引导「打开本地 PDF 文件」，同样只在浏览器内处理
 */

export type PdfLoadErrorCode = 'blocked' | 'http' | 'not_pdf' | 'too_large' | 'bad_url';

export class PdfLoadError extends Error {
  constructor(
    message: string,
    public code: PdfLoadErrorCode,
    public status = 0,
  ) {
    super(message);
    this.name = 'PdfLoadError';
  }
}

export interface LoadResult {
  data: ArrayBuffer;
  via: 'cache' | 'direct' | 'proxy';
}

export interface LoadOptions {
  paperId: string;
  version: string;
  url: string;
  proxyTemplate?: string;
  cache?: PdfCache;
  fetchImpl?: typeof fetch;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** 跳过本地缓存（用户点「重新下载」） */
  refresh?: boolean;
}

export const MAX_PDF_BYTES = 150 * 1024 * 1024;

export function isPdf(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes.slice(0, 1024));
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

export function applyProxy(template: string, url: string): string {
  const t = template.trim();
  if (t.includes('{url}')) return t.replace('{url}', encodeURIComponent(url));
  return t + encodeURIComponent(url);
}

export function assertHttpUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PdfLoadError('链接无效', 'bad_url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PdfLoadError('只支持 http(s) 链接', 'bad_url');
}

async function download(f: typeof fetch, url: string, opts: LoadOptions): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await f(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // 浏览器不区分「CORS 被拒」和「断网」，统一当作被阻止处理
    throw new PdfLoadError('浏览器无法直接读取该链接（对方站点可能未开放跨域访问，或网络不通）', 'blocked');
  }
  if (!res.ok) throw new PdfLoadError(`下载失败：HTTP ${res.status}`, 'http', res.status);

  const total = Number(res.headers.get('content-length')) || 0;
  if (total > MAX_PDF_BYTES) throw new PdfLoadError('PDF 过大（超过 150MB）', 'too_large');

  let data: ArrayBuffer;
  if (res.body && opts.onProgress) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (loaded > MAX_PDF_BYTES) throw new PdfLoadError('PDF 过大（超过 150MB）', 'too_large');
      opts.onProgress(loaded, total);
    }
    const merged = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    data = merged.buffer;
  } else {
    data = await res.arrayBuffer();
  }
  if (!isPdf(data)) throw new PdfLoadError('该链接返回的不是 PDF（可能是网页）。请使用论文的 PDF 直链', 'not_pdf');
  return data;
}

export async function loadPdf(opts: LoadOptions): Promise<LoadResult> {
  assertHttpUrl(opts.url);
  const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const key = cacheKey(opts.paperId, opts.version);

  let stale: ArrayBuffer | null = null;
  if (opts.cache && !opts.refresh) {
    const hit = await opts.cache.get(key);
    if (hit) {
      const expired = !opts.version && !hit.meta.pinned && Date.now() - hit.meta.cachedAt > UNVERSIONED_TTL_MS;
      if (!expired) return { data: hit.data, via: 'cache' };
      stale = hit.data; // 未指定版本的链接可能已更新：优先重新下载，失败再用旧缓存
    }
  }

  let lastErr: unknown;
  const attempts: { url: string; via: 'direct' | 'proxy' }[] = [{ url: opts.url, via: 'direct' }];
  if (opts.proxyTemplate?.trim()) attempts.push({ url: applyProxy(opts.proxyTemplate, opts.url), via: 'proxy' });

  for (const a of attempts) {
    try {
      const data = await download(f, a.url, opts);
      if (opts.cache) await opts.cache.put(key, data, false).catch(() => {});
      return { data, via: a.via };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      lastErr = e;
      if (e instanceof PdfLoadError && (e.code === 'too_large' || e.code === 'not_pdf')) break;
    }
  }
  if (stale) return { data: stale, via: 'cache' };
  throw lastErr instanceof Error ? lastErr : new PdfLoadError('加载失败', 'blocked');
}

/** 用户手动选择的本地 PDF：只在浏览器内处理，并固定缓存在本机。 */
export async function importLocalPdf(file: File, cache?: PdfCache, paperId?: string, version = ''): Promise<ArrayBuffer> {
  if (file.size > MAX_PDF_BYTES) throw new PdfLoadError('PDF 过大（超过 150MB）', 'too_large');
  const data = await file.arrayBuffer();
  if (!isPdf(data)) throw new PdfLoadError('所选文件不是 PDF', 'not_pdf');
  if (cache && paperId) await cache.put(cacheKey(paperId, version), data, true).catch(() => {});
  return data;
}
