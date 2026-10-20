import { versionNumber } from './ids';

/**
 * 可选：从 arXiv API 取标题、作者与最新版本号。
 * 浏览器能否直连取决于 arXiv 的 CORS 策略；失败时静默返回 null，
 * 阅读器会改为从 PDF 第一页推断标题，因此这里不是关键路径。
 */

export interface ArxivMeta {
  title: string;
  authors: string;
  latestVersion: string;
}

export function parseArxivAtom(xml: string): ArxivMeta | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const entry = doc.querySelector('entry');
  if (!entry) return null;
  const title = entry.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (!title || /^error$/i.test(title)) return null;
  const authors = [...entry.querySelectorAll('author > name')].map((n) => n.textContent?.trim() ?? '').filter(Boolean).join(', ');
  const idText = entry.querySelector('id')?.textContent ?? '';
  const m = /v(\d+)\s*$/.exec(idText.trim());
  return { title, authors, latestVersion: m ? `v${m[1]}` : '' };
}

export async function fetchArxivMeta(arxivId: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<ArxivMeta | null> {
  try {
    const res = await fetchImpl(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) return null;
    return parseArxivAtom(await res.text());
  } catch {
    return null;
  }
}

export function isNewerVersion(latest: string, current: string): boolean {
  return versionNumber(latest) > 0 && current !== '' && versionNumber(latest) > versionNumber(current);
}
