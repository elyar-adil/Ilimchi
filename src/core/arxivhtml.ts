import { applyProxy } from './pdfsource';
import type { Idb } from './idb';

/**
 * arXiv 官方 HTML 版（由 LaTeXML 从论文源码生成）：结构、图片与公式（MathML）都来自源码，
 * 重排效果远好于从 PDF 推断。并非每篇论文都有；浏览器能否直接读取取决于 arXiv 的跨域策略，
 * 读不到时可以经由设置里的代理读取。取到的内容先净化（去掉脚本、样式与交互元素）再缓存在本机。
 */

export interface ArxivHtml {
  /** 净化后的正文 HTML */
  html: string;
  /** 图片等相对地址的基准 */
  base: string;
}

const CACHE_TTL = 30 * 24 * 3600 * 1000;

export function arxivIdOf(paperId: string): string | null {
  if (!paperId.startsWith('arxiv-')) return null;
  return paperId.slice(6).replace('_', '/');
}

export async function loadArxivHtml(idb: Idb, arxivId: string, version: string, proxy: string, signal?: AbortSignal): Promise<ArxivHtml | null> {
  const key = `arxiv-html:${arxivId}:${version}`;
  const cached = await idb.get<ArxivHtml & { at: number }>('kv', key);
  if (cached && (version || Date.now() - cached.at < CACHE_TTL)) return cached;
  const url = `https://arxiv.org/html/${arxivId}${version}`;
  const attempts = [url];
  if (proxy.trim()) attempts.push(applyProxy(proxy, url));
  let reached = false;
  for (const u of attempts) {
    try {
      const res = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
      reached = true;
      if (!res.ok) continue;
      const text = await res.text();
      const base = (u === url && res.url ? res.url : url).replace(/\/?$/, '/');
      const html = sanitize(text, base);
      if (!html) return null; // 页面取到了，但该论文没有 HTML 版
      const out = { html, base };
      await idb.put('kv', key, { ...out, at: Date.now() });
      return out;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
    }
  }
  // 一次都没连上：多半是浏览器的跨域限制
  if (!reached) throw new ArxivHtmlBlocked();
  return null;
}

export class ArxivHtmlBlocked extends Error {
  constructor() {
    super('arXiv HTML blocked');
  }
}

const DROP = [
  'script', 'style', 'link', 'meta', 'noscript', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea',
  'nav', 'header', 'footer', 'svg[class*="icon"]', 'annotation', 'annotation-xml',
  '.ltx_page_header', '.ltx_page_footer', '.ltx_page_logo', '.ltx_dates', '.package-alerts', '.ar5iv-footer', '#header', '.ltx_role_navigation',
  '.ltx_ERROR',
].join(',');

/** 只保留论文正文；去掉脚本、样式、事件属性与危险链接，图片地址改为绝对地址 */
export function sanitize(raw: string, base: string): string | null {
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const root = doc.querySelector('article.ltx_document') ?? doc.querySelector('.ltx_page_content') ?? doc.querySelector('.ltx_document');
  if (!root) return null;
  root.querySelectorAll(DROP).forEach((el) => el.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'style' || n === 'srcset') el.removeAttribute(a.name);
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      try {
        el.setAttribute('src', new URL(src, base).href);
      } catch {
        el.remove();
        return;
      }
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
    }
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (/^\s*javascript:/i.test(href)) el.removeAttribute('href');
      else if (href && !href.startsWith('#')) {
        try {
          el.setAttribute('href', new URL(href, base).href);
        } catch {
          el.removeAttribute('href');
        }
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noreferrer noopener');
      }
    }
  });
  const text = root.textContent ?? '';
  if (text.replace(/\s+/g, '').length < 500) return null;
  return root.innerHTML;
}
