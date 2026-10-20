/**
 * 从第一页文本项里推断标题与作者。
 * - 标题：页面上部字号最大的连续几行。
 * - 作者：标题正下方、摘要之前的 1–2 行（字号小于标题，不含单位信息）。
 * 都是尽力而为的启发式；arXiv 元数据可用时会优先采用。
 */

export interface TextItem {
  str: string;
  /** PDF 变换矩阵 [a,b,c,d,e,f] */
  transform: number[];
  height: number;
}

export interface GuessedMeta {
  title: string;
  authors: string;
}

interface Cand {
  str: string;
  size: number;
  x: number;
  y: number;
}

interface Line {
  y: number;
  size: number;
  parts: Cand[];
}

function candidates(items: TextItem[], pageHeight: number): Cand[] {
  return items
    .filter((it) => it.str.trim() !== '')
    .filter((it) => Math.abs(it.transform[1]) < 0.1 && Math.abs(it.transform[2]) < 0.1) // 排除侧边的 arXiv 竖排水印
    .map((it) => ({
      str: it.str,
      size: Math.abs(it.transform[3]) || it.height,
      x: it.transform[4],
      y: it.transform[5],
    }))
    .filter((it) => it.y > pageHeight * 0.4); // 标题在页面上半部分
}

/** 按 y 从上到下分行（同一行内按 x 排序） */
function groupLines(items: Cand[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < it.size * 0.4);
    if (line) line.parts.push(it);
    else lines.push({ y: it.y, size: it.size, parts: [it] });
  }
  return lines;
}

function lineText(parts: Cand[]): string {
  return [...parts]
    .sort((a, b) => a.x - b.x)
    .map((p) => p.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABSTRACT = /^(abstract|摘要)\b/i;
// 单位、邮箱等信息出现即说明作者区已结束
const AFFILIATION = /@|university|institute|department|laborator|school of|college|大学|研究院|研究所|学院|实验室/i;

/** 作者行清理：去掉脚注符号与上标数字，统一逗号间距。 */
function cleanAuthors(t: string): string {
  return t
    .replace(/[∗*†‡§¶✉]/g, '')
    .replace(/(?<=[A-Za-zÀ-ɏ一-鿿])\d+(?=[,\s]|$)/g, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/[,\s]+$/, '')
    .trim();
}

/**
 * 作者行：同一行里相隔较远的文字块通常是不同作者（PDF 常不写逗号），之间补上 ", "。
 * 间距按字号估算，普通单词间距不会被误判。
 */
function authorLineText(parts: Cand[]): string {
  const sorted = [...parts].sort((a, b) => a.x - b.x);
  let out = '';
  let prev: Cand | null = null;
  for (const p of sorted) {
    if (prev) {
      const estEnd = prev.x + prev.str.trim().length * prev.size * 0.5;
      out += p.x - estEnd > prev.size * 0.8 ? ', ' : ' ';
    }
    out += p.str.trim();
    prev = p;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function guessAuthors(cand: Cand[], titleBottom: number, titleSize: number, pageHeight: number): string {
  // 标题下方的文字，字号必须小于标题
  const below = cand.filter((c) => c.y < titleBottom - 1 && c.y > titleBottom - pageHeight * 0.3 && c.size < titleSize * 0.9);
  const names: string[] = [];
  for (const line of groupLines(below)) {
    const t = authorLineText(line.parts);
    if (ABSTRACT.test(t) || AFFILIATION.test(t) || t.length > 160) break;
    names.push(t.replace(/[,\s]+$/, ''));
    if (names.length >= 2) break;
  }
  const authors = cleanAuthors(names.join(', '));
  return authors.length >= 2 && authors.length <= 240 ? authors : '';
}

export function guessMeta(items: TextItem[], pageHeight: number): GuessedMeta {
  const cand = candidates(items, pageHeight);
  if (cand.length === 0) return { title: '', authors: '' };

  const max = Math.max(...cand.map((c) => c.size));
  if (max <= 0) return { title: '', authors: '' };
  const big = cand.filter((c) => c.size >= max * 0.9);
  const lines = groupLines(big);
  if (lines.length === 0) return { title: '', authors: '' };

  // 只取与首行连续（行距合理）的最多 3 行
  const picked = [lines[0]];
  for (let i = 1; i < lines.length && picked.length < 3; i++) {
    const gap = picked[picked.length - 1].y - lines[i].y;
    if (gap <= lines[i].size * 2.2) picked.push(lines[i]);
    else break;
  }

  const title = picked
    .map((l) => lineText(l.parts))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const titleOk = title.length >= 8 && title.length <= 250 ? title : '';
  const last = picked[picked.length - 1];
  const authors = titleOk ? guessAuthors(cand, last.y, max, pageHeight) : '';
  return { title: titleOk, authors };
}

export function guessTitle(items: TextItem[], pageHeight: number): string {
  return guessMeta(items, pageHeight).title;
}
