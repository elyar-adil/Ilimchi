import { compareAnnotations, compareShapes } from './model';
import { FIELD_NAMES, type Annotation, type FieldName, type PaperDoc, type Progress, type Shape } from './types';

/**
 * 合并两份同一论文的文档（多设备并发修改后的收敛）。
 * 满足交换律、结合律、幂等，所以不论同步顺序如何，所有设备最终得到同一结果：
 *  - 标量字段：按 fieldTimes 最后写入者胜出（时间相同则按内容确定性裁决）
 *  - 阅读进度：updatedAt 较新者胜出
 *  - 批注：按 id 取并集；同 id 取 updatedAt 较新者；删除用墓碑表示，所以删除也会同步
 */
export function mergeDocs(a: PaperDoc, b: PaperDoc): PaperDoc {
  if (a.id !== b.id) throw new Error(`不能合并不同论文: ${a.id} vs ${b.id}`);

  const fieldTimes = {} as Record<FieldName, number>;
  const out: Record<string, unknown> = {};
  for (const f of FIELD_NAMES) {
    const [t, v] = pick(a.fieldTimes[f], a[f], b.fieldTimes[f], b[f]);
    fieldTimes[f] = t;
    out[f] = v;
  }

  const progress: Progress = pickProgress(a.progress, b.progress);

  const byId = new Map<string, Annotation>();
  for (const ann of [...a.annotations, ...b.annotations]) {
    const cur = byId.get(ann.id);
    byId.set(ann.id, cur ? newer(cur, ann) : ann);
  }
  const annotations = [...byId.values()].sort(compareAnnotations);

  const shapeById = new Map<string, Shape>();
  for (const sh of [...(a.shapes ?? []), ...(b.shapes ?? [])]) {
    const cur = shapeById.get(sh.id);
    shapeById.set(sh.id, cur ? newer(cur, sh) : sh);
  }
  const shapes = [...shapeById.values()].sort(compareShapes);

  return {
    schema: Math.max(a.schema, b.schema),
    id: a.id,
    url: out.url as string,
    sourceUrl: out.sourceUrl as string,
    title: out.title as string,
    authors: out.authors as string,
    version: out.version as string,
    tags: out.tags as string[],
    deletedAt: out.deletedAt as number | null,
    fieldTimes,
    progress,
    annotations,
    shapes,
    createdAt: Math.min(a.createdAt || b.createdAt, b.createdAt || a.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

function key(v: unknown): string {
  return JSON.stringify(v);
}

function pick<T>(ta: number, va: T, tb: number, vb: T): [number, T] {
  if (ta > tb) return [ta, va];
  if (tb > ta) return [tb, vb];
  return [ta, key(va) >= key(vb) ? va : vb];
}

function pickProgress(a: Progress, b: Progress): Progress {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return key(a) >= key(b) ? a : b;
}

function newer<T extends { updatedAt: number; deletedAt?: number }>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  // 时间相同：墓碑优先，其次按内容确定性裁决
  if ((a.deletedAt !== undefined) !== (b.deletedAt !== undefined)) return a.deletedAt !== undefined ? a : b;
  return key(a) >= key(b) ? a : b;
}
