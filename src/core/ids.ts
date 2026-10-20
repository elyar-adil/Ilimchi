import type { PaperRef } from './types';

/**
 * 把用户输入（arXiv 链接 / 编号 / 其他 PDF 链接）解析成稳定的论文标识。
 * 同一篇论文无论从 abs、pdf、html 还是带版本号的链接进入，都得到同一个 id，
 * 这样笔记在不同设备、不同入口之间始终对得上。
 */

const NEW_ID = /^(\d{4}\.\d{4,5})(?:v(\d+))?$/;
const OLD_ID = /^([a-z]+(?:-[a-z]+)*(?:\.[A-Za-z]{2})?\/\d{7})(?:v(\d+))?$/;

const ARXIV_HOSTS = new Set([
  'arxiv.org',
  'www.arxiv.org',
  'export.arxiv.org',
  'browse.arxiv.org',
  'alphaxiv.org',
  'www.alphaxiv.org',
  'ar5iv.org',
  'ar5iv.labs.arxiv.org',
]);

export function parseArxivId(raw: string): { id: string; version: string } | null {
  let s = raw.trim().replace(/^arxiv:\s*/i, '').replace(/\.pdf$/i, '').replace(/\/+$/, '');
  const m = NEW_ID.exec(s) || OLD_ID.exec(s);
  if (!m) return null;
  return { id: m[1], version: m[2] ? `v${m[2]}` : '' };
}

export function arxivRef(id: string, version: string): PaperRef {
  return {
    id: `arxiv-${id.replace('/', '_')}`,
    kind: 'arxiv',
    arxivId: id,
    version,
    pdfUrl: `https://arxiv.org/pdf/${id}${version}`,
    pageUrl: `https://arxiv.org/abs/${id}${version}`,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 去掉 hash、跟踪参数，统一主机名大小写。 */
export function normalizeUrl(u: URL): string {
  const url = new URL(u.toString());
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export async function resolvePaper(input: string): Promise<PaperRef> {
  const text = input.trim();
  if (!text) throw new Error('请输入论文链接或 arXiv 编号');

  const bare = parseArxivId(text);
  if (bare) return arxivRef(bare.id, bare.version);

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('无法识别的链接，请输入 http(s) 链接或 arXiv 编号');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('只支持 http(s) 链接');
  }
  const host = url.hostname.toLowerCase();

  if (ARXIV_HOSTS.has(host)) {
    // /abs/<id>、/pdf/<id>(.pdf)、/html/<id>、/overview/<id>；旧式编号含斜杠
    const rest = url.pathname.split('/').filter(Boolean).slice(1).join('/');
    const parsed = parseArxivId(rest);
    if (parsed) return arxivRef(parsed.id, parsed.version);
    throw new Error('无法从该 arXiv 链接中识别论文编号');
  }

  if (host === 'openreview.net' || host === 'www.openreview.net') {
    const pid = url.searchParams.get('id');
    if (pid && /^[\w-]+$/.test(pid)) {
      return {
        id: `openreview-${pid}`,
        kind: 'openreview',
        version: '',
        pdfUrl: `https://openreview.net/pdf?id=${pid}`,
        pageUrl: `https://openreview.net/forum?id=${pid}`,
      };
    }
  }

  if (host === 'aclanthology.org' || host === 'www.aclanthology.org') {
    const seg = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.pdf$/i, '');
    if (/^([A-Z]\d{2}-\d{4}|\d{4}\.[\w-]+\.\d+)$/.test(seg)) {
      return {
        id: `acl-${seg.toLowerCase()}`,
        kind: 'acl',
        version: '',
        pdfUrl: `https://aclanthology.org/${seg}.pdf`,
        pageUrl: `https://aclanthology.org/${seg}/`,
      };
    }
  }

  let pdfUrl = normalizeUrl(url);
  if ((host.endsWith('biorxiv.org') || host.endsWith('medrxiv.org')) && /\/content\/10\.1101\//.test(url.pathname) && !/\.pdf$/i.test(url.pathname)) {
    const u = new URL(pdfUrl);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}.full.pdf`;
    pdfUrl = u.toString();
  }
  const hash = (await sha256Hex(pdfUrl)).slice(0, 16);
  return { id: `url-${hash}`, kind: 'url', version: '', pdfUrl, pageUrl: pdfUrl };
}

/** 切换版本：仅 arXiv 会改变 PDF 链接。 */
export function withVersion(ref: PaperRef, version: string): PaperRef {
  const v = normalizeVersion(version);
  if (ref.kind === 'arxiv' && ref.arxivId) return arxivRef(ref.arxivId, v);
  return { ...ref, version: v };
}

/** "2" / "v2" / "V2" → "v2"；"latest"/空 → "" */
export function normalizeVersion(input: string): string {
  const s = input.trim().toLowerCase();
  if (!s || s === 'latest' || s === '最新') return '';
  const m = /^v?(\d{1,3})$/.exec(s);
  if (!m) throw new Error('版本格式应为 v1、v2… 或 latest');
  return `v${Number(m[1])}`;
}

export function versionNumber(v: string): number {
  const m = /^v(\d+)$/.exec(v);
  return m ? Number(m[1]) : 0;
}

export function paperPath(id: string): string {
  return `papers/${id}.json`;
}

export function idFromPath(path: string): string | null {
  const m = /^papers\/([A-Za-z0-9._-]+)\.json$/.exec(path);
  return m ? m[1] : null;
}

/** 本地文件论文：按文件内容哈希生成 id，同一份 PDF 在任何设备上得到同一个 id。 */
export async function fileRef(bytes: ArrayBuffer): Promise<PaperRef> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { id: `file-${hex.slice(0, 20)}`, kind: 'file', version: '', pdfUrl: '', pageUrl: '' };
}
