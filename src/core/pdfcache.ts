import type { Idb } from './idb';

/**
 * 设备本地 PDF 缓存（仅存在于当前浏览器的 IndexedDB，不上传任何服务器、不进 GitHub）。
 * 作用：重复打开更快、可离线阅读；以及「手动打开的本地 PDF」在本机下次自动恢复。
 * LRU 淘汰，限制总大小。
 */

export interface PdfMeta {
  key: string;
  size: number;
  cachedAt: number;
  lastUsed: number;
  /** 手动打开的本地文件：不设过期，也不会因 TTL 被忽略 */
  pinned: boolean;
}

export const MAX_CACHE_BYTES = 200 * 1024 * 1024;
export const UNVERSIONED_TTL_MS = 7 * 24 * 3600 * 1000;

export class PdfCache {
  constructor(
    private idb: Idb,
    private maxBytes = MAX_CACHE_BYTES,
  ) {}

  async get(key: string): Promise<{ data: ArrayBuffer; meta: PdfMeta } | null> {
    const [data, meta] = await Promise.all([this.idb.get<ArrayBuffer>('pdfs', key), this.idb.get<PdfMeta>('pdfmeta', key)]);
    if (!data || !meta) return null;
    void this.idb.put('pdfmeta', key, { ...meta, lastUsed: Date.now() });
    return { data, meta };
  }

  async put(key: string, data: ArrayBuffer, pinned: boolean): Promise<void> {
    if (data.byteLength > this.maxBytes) return;
    const now = Date.now();
    await this.idb.put('pdfs', key, data);
    await this.idb.put('pdfmeta', key, { key, size: data.byteLength, cachedAt: now, lastUsed: now, pinned } satisfies PdfMeta);
    await this.evict();
  }

  async list(): Promise<PdfMeta[]> {
    return (await this.idb.all<PdfMeta>('pdfmeta')).map(([, m]) => m);
  }

  async totalSize(): Promise<number> {
    return (await this.list()).reduce((s, m) => s + m.size, 0);
  }

  async clear(): Promise<void> {
    await Promise.all([this.idb.clear('pdfs'), this.idb.clear('pdfmeta')]);
  }

  private async evict(): Promise<void> {
    const metas = await this.list();
    let total = metas.reduce((s, m) => s + m.size, 0);
    if (total <= this.maxBytes) return;
    // 先淘汰未固定的、最久未用的；本地文件最后才动
    const order = [...metas].sort((a, b) => Number(a.pinned) - Number(b.pinned) || a.lastUsed - b.lastUsed);
    for (const m of order) {
      if (total <= this.maxBytes) break;
      await Promise.all([this.idb.del('pdfs', m.key), this.idb.del('pdfmeta', m.key)]);
      total -= m.size;
    }
  }
}

export function cacheKey(paperId: string, version: string): string {
  return `${paperId}@${version || 'latest'}`;
}
