import type { Annotation, PaperDoc, Shape } from './types';

/** 标注层的快照：包含墓碑，保证恢复时能同步删除。 */
export interface Snapshot {
  annotations: Annotation[];
  shapes: Shape[];
}

export const snapshotOf = (doc: PaperDoc): Snapshot => ({ annotations: doc.annotations, shapes: doc.shapes });

/** 稳定序列化（键排序），用于判断两个版本是否相同。 */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

interface Versioned {
  id: string;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * 把一组条目恢复到快照状态。
 * - 与快照相同的条目保持不变；
 * - 与快照不同的条目写入一个更新的版本（updatedAt = now），因此在合并时会胜出；
 * - 快照之后新增的条目写入墓碑，使其他设备也同步删除。
 */
function restoreList<T extends Versioned>(cur: T[], want: T[], now: number, tombstone: (x: T, now: number) => T): T[] {
  const curById = new Map(cur.map((c) => [c.id, c]));
  const wantIds = new Set(want.map((w) => w.id));
  const out: T[] = [];
  for (const w of want) {
    const c = curById.get(w.id);
    if (c && stable(c) === stable(w)) out.push(c);
    else out.push({ ...w, updatedAt: now });
  }
  for (const c of cur) {
    if (wantIds.has(c.id)) continue;
    out.push(c.deletedAt === undefined ? tombstone(c, now) : c);
  }
  return out;
}

export function restoreSnapshot(doc: PaperDoc, snap: Snapshot, now: number): PaperDoc {
  const annotations = restoreList(doc.annotations, snap.annotations, now, (a, t) => ({
    ...a,
    deletedAt: t,
    updatedAt: t,
    quote: '',
    prefix: '',
    suffix: '',
    note: '',
    rects: [],
  }));
  const shapes = restoreList(doc.shapes, snap.shapes, now, (s, t) =>
    s.kind === 'text' ? { ...s, text: '', deletedAt: t, updatedAt: t } : { ...s, points: [], deletedAt: t, updatedAt: t },
  );
  return { ...doc, annotations, shapes, updatedAt: Math.max(doc.updatedAt, now) };
}
