import { tr } from './i18n';
import { INK_KEYS } from './types';
import type { InkShape, Shape, TextShape } from './types';
import {
  FIELD_NAMES,
  HIGHLIGHT_COLORS,
  SCHEMA_VERSION,
  type Annotation,
  type FieldName,
  type HighlightColor,
  type PaperDoc,
  type PaperRef,
  type Progress,
  type Rect,
} from './types';

export const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

export function newPaper(ref: PaperRef, now = Date.now()): PaperDoc {
  const times = Object.fromEntries(FIELD_NAMES.map((f) => [f, now])) as Record<FieldName, number>;
  return {
    schema: SCHEMA_VERSION,
    id: ref.id,
    url: ref.pdfUrl,
    sourceUrl: ref.pageUrl,
    title: '',
    authors: '',
    version: ref.version,
    tags: [],
    progress: { page: 1, pages: 0, offset: 0, updatedAt: 0 },
    lastOpenedAt: 0,
    readingSessions: {},
    annotations: [],
    shapes: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    fieldTimes: times,
  };
}

type FieldValue<K extends FieldName> = PaperDoc[K];

export function setField<K extends FieldName>(doc: PaperDoc, key: K, value: FieldValue<K>, now = Date.now()): PaperDoc {
  return {
    ...doc,
    [key]: value,
    updatedAt: Math.max(doc.updatedAt, now),
    fieldTimes: { ...doc.fieldTimes, [key]: now },
  };
}

export function setProgress(doc: PaperDoc, p: Omit<Progress, 'updatedAt'>, now = Date.now()): PaperDoc {
  return { ...doc, progress: { ...p, updatedAt: now }, updatedAt: Math.max(doc.updatedAt, now) };
}

export function addAnnotation(doc: PaperDoc, ann: Annotation): PaperDoc {
  return {
    ...doc,
    annotations: [...doc.annotations.filter((a) => a.id !== ann.id), ann],
    updatedAt: Math.max(doc.updatedAt, ann.updatedAt),
  };
}

export function updateAnnotation(doc: PaperDoc, id: string, patch: Partial<Omit<Annotation, 'id'>>, now = Date.now()): PaperDoc {
  return {
    ...doc,
    annotations: doc.annotations.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: now } : a)),
    updatedAt: Math.max(doc.updatedAt, now),
  };
}

/** 删除批注：留下墓碑（清空正文），让其他设备同步删除。 */
export function removeAnnotation(doc: PaperDoc, id: string, now = Date.now()): PaperDoc {
  return {
    ...doc,
    annotations: doc.annotations.map((a) =>
      a.id === id ? { ...a, quote: '', prefix: '', suffix: '', note: '', rects: [], deletedAt: now, updatedAt: now } : a,
    ),
    updatedAt: Math.max(doc.updatedAt, now),
  };
}

export function liveAnnotations(doc: PaperDoc): Annotation[] {
  return doc.annotations.filter((a) => a.deletedAt === undefined);
}

export function pruneTombstones(doc: PaperDoc, now = Date.now()): PaperDoc {
  const kept = doc.annotations.filter((a) => a.deletedAt === undefined || now - a.deletedAt < TOMBSTONE_TTL_MS);
  return kept.length === doc.annotations.length ? doc : { ...doc, annotations: kept };
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
}

export function compareAnnotations(a: Annotation, b: Annotation): number {
  return a.page - b.page || a.start - b.start || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 稳定序列化：字段顺序固定、批注有序，保证 git diff 干净、合并结果可逐字节比较。 */
export function serialize(doc: PaperDoc): string {
  const ordered = {
    schema: doc.schema,
    id: doc.id,
    url: doc.url,
    sourceUrl: doc.sourceUrl,
    title: doc.title,
    authors: doc.authors,
    version: doc.version,
    tags: doc.tags,
    progress: doc.progress,
    lastOpenedAt: doc.lastOpenedAt ?? 0,
    readingSessions: Object.fromEntries(Object.entries(doc.readingSessions ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    deletedAt: doc.deletedAt,
    fieldTimes: Object.fromEntries(FIELD_NAMES.map((f) => [f, doc.fieldTimes[f]])),
    annotations: [...doc.annotations].sort(compareAnnotations).map(orderAnnotation),
    shapes: [...(doc.shapes ?? [])].sort(compareShapes).map(orderShape),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function orderAnnotation(a: Annotation): Annotation {
  const out: Annotation = {
    id: a.id,
    page: a.page,
    color: a.color,
    quote: a.quote,
    prefix: a.prefix,
    suffix: a.suffix,
    start: a.start,
    rects: a.rects.map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) })),
    note: a.note,
    fingerprint: a.fingerprint,
    version: a.version,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
  if (a.deletedAt !== undefined) out.deletedAt = a.deletedAt;
  return out;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ---------- 解析与清洗（远端文件可能被手工编辑，必须防御） ----------

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function sanitizeRect(r: unknown): Rect | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const x = num(o.x, NaN);
  const y = num(o.y, NaN);
  const w = num(o.w, NaN);
  const h = num(o.h, NaN);
  if ([x, y, w, h].some(Number.isNaN)) return null;
  return { x, y, w, h };
}

function sanitizeAnnotation(raw: unknown): Annotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  const color = HIGHLIGHT_COLORS.includes(o.color as HighlightColor) ? (o.color as HighlightColor) : 'yellow';
  const rects = Array.isArray(o.rects) ? (o.rects.map(sanitizeRect).filter(Boolean) as Rect[]) : [];
  const ann: Annotation = {
    id,
    page: Math.max(1, Math.floor(num(o.page, 1))),
    color,
    quote: str(o.quote),
    prefix: str(o.prefix),
    suffix: str(o.suffix),
    start: Math.max(0, Math.floor(num(o.start, 0))),
    rects,
    note: str(o.note),
    fingerprint: str(o.fingerprint),
    version: str(o.version),
    createdAt: num(o.createdAt),
    updatedAt: num(o.updatedAt),
  };
  if (typeof o.deletedAt === 'number') ann.deletedAt = o.deletedAt;
  return ann;
}

export function parseDoc(text: string): PaperDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(tr('笔记文件不是合法的 JSON'));
  }
  if (!raw || typeof raw !== 'object') throw new Error(tr('笔记文件格式错误'));
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (!id) throw new Error(tr('笔记文件缺少 id'));
  const schema = num(o.schema, 1);
  if (schema > SCHEMA_VERSION) throw new Error(tr('笔记文件来自更新版本的应用（schema {schema}），请先更新应用', { schema }));

  const ft = (o.fieldTimes && typeof o.fieldTimes === 'object' ? o.fieldTimes : {}) as Record<string, unknown>;
  const fieldTimes = Object.fromEntries(FIELD_NAMES.map((f) => [f, num(ft[f])])) as Record<FieldName, number>;
  const p = (o.progress && typeof o.progress === 'object' ? o.progress : {}) as Record<string, unknown>;
  const annotations = Array.isArray(o.annotations)
    ? (o.annotations.map(sanitizeAnnotation).filter(Boolean) as Annotation[])
    : [];
  const shapes = Array.isArray(o.shapes) ? (o.shapes.map(sanitizeShape).filter(Boolean) as Shape[]) : [];
  const rawSessions = o.readingSessions && typeof o.readingSessions === 'object' ? (o.readingSessions as Record<string, unknown>) : {};
  const readingSessions = Object.fromEntries(
    Object.entries(rawSessions)
      .filter(([id, value]) => id.length > 0 && typeof value === 'number' && Number.isFinite(value) && value >= 0)
      .map(([id, value]) => [id, Math.floor(value as number)]),
  );
  const tags = Array.isArray(o.tags) ? [...new Set(o.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== ''))] : [];

  return {
    schema: SCHEMA_VERSION,
    id,
    url: str(o.url),
    sourceUrl: str(o.sourceUrl),
    title: str(o.title),
    authors: str(o.authors),
    version: str(o.version),
    tags,
    progress: {
      page: Math.max(1, Math.floor(num(p.page, 1))),
      pages: Math.max(0, Math.floor(num(p.pages, 0))),
      offset: Math.min(1, Math.max(0, num(p.offset, 0))),
      updatedAt: num(p.updatedAt),
    },
    lastOpenedAt: num(o.lastOpenedAt),
    readingSessions,
    annotations,
    shapes,
    createdAt: num(o.createdAt),
    updatedAt: num(o.updatedAt),
    deletedAt: typeof o.deletedAt === 'number' ? o.deletedAt : null,
    fieldTimes,
  };
}

export function displayTitle(doc: PaperDoc): string {
  return doc.title.trim() || doc.id.replace(/^(arxiv|openreview|acl|url|file)-/, '$1:');
}

// ---------- 文字框与手绘 ----------

export function liveShapes(doc: PaperDoc): Shape[] {
  return (doc.shapes ?? []).filter((s) => s.deletedAt === undefined);
}

export function addShape(doc: PaperDoc, shape: Shape): PaperDoc {
  return {
    ...doc,
    shapes: [...(doc.shapes ?? []).filter((s) => s.id !== shape.id), shape],
    updatedAt: Math.max(doc.updatedAt, shape.updatedAt),
  };
}

export function updateShape(doc: PaperDoc, id: string, patch: Partial<TextShape> | Partial<InkShape>, now = Date.now()): PaperDoc {
  return {
    ...doc,
    shapes: (doc.shapes ?? []).map((s) => (s.id === id ? ({ ...s, ...patch, updatedAt: now } as Shape) : s)),
    updatedAt: Math.max(doc.updatedAt, now),
  };
}

/** 删除图形：保留墓碑，让其他设备同步删除。 */
export function removeShape(doc: PaperDoc, id: string, now = Date.now()): PaperDoc {
  return {
    ...doc,
    shapes: (doc.shapes ?? []).map((s) => {
      if (s.id !== id) return s;
      return s.kind === 'text' ? { ...s, text: '', deletedAt: now, updatedAt: now } : { ...s, points: [], deletedAt: now, updatedAt: now };
    }),
    updatedAt: Math.max(doc.updatedAt, now),
  };
}

export function compareShapes(a: Shape, b: Shape): number {
  return a.page - b.page || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function orderShape(s: Shape): Shape {
  const base = { id: s.id, kind: s.kind, page: s.page, color: s.color } as const;
  const times = { createdAt: s.createdAt, updatedAt: s.updatedAt, ...(s.deletedAt !== undefined ? { deletedAt: s.deletedAt } : {}) };
  if (s.kind === 'ink') {
    return {
      ...base,
      kind: 'ink',
      points: s.points.map(([x, y]) => [round(x), round(y)] as [number, number]),
      ...(s.marker ? { marker: true } : {}),
      ...times,
    };
  }
  return { ...base, kind: 'text', x: round(s.x), y: round(s.y), w: round(s.w), size: round(s.size), text: s.text, ...times };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function sanitizeShape(raw: unknown): Shape | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  const color = INK_KEYS.includes(o.color as InkShape['color']) ? (o.color as InkShape['color']) : 'ink';
  const common = {
    id,
    page: Math.max(1, Math.floor(num(o.page, 1))),
    color,
    createdAt: num(o.createdAt),
    updatedAt: num(o.updatedAt),
    ...(typeof o.deletedAt === 'number' ? { deletedAt: o.deletedAt } : {}),
  };
  if (o.kind === 'ink') {
    const points: [number, number][] = Array.isArray(o.points)
      ? o.points
          .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)))
          .map(([x, y]) => [clamp01(x), clamp01(y)] as [number, number])
      : [];
    return { kind: 'ink', ...common, points, ...(o.marker === true ? { marker: true } : {}) };
  }
  if (o.kind === 'text') {
    return {
      kind: 'text',
      ...common,
      x: clamp01(num(o.x)),
      y: clamp01(num(o.y)),
      w: Math.min(1, Math.max(0.02, num(o.w, 0.3))),
      size: Math.min(0.06, Math.max(0.008, num(o.size, 0.017))),
      text: str(o.text),
    };
  }
  return null;
}
