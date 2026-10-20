import { describe, expect, it } from 'vitest';
import { mergeDocs } from '../src/core/merge';
import { addAnnotation, newPaper, parseDoc, removeAnnotation, serialize, setField, setProgress, updateAnnotation } from '../src/core/model';
import { arxivRef } from '../src/core/ids';
import type { Annotation, PaperDoc } from '../src/core/types';

const ann = (id: string, updatedAt: number, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  page: 1,
  color: 'yellow',
  quote: `q-${id}`,
  prefix: '',
  suffix: '',
  start: 0,
  rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }],
  note: '',
  fingerprint: 'fp',
  version: '',
  createdAt: updatedAt,
  updatedAt,
  ...extra,
});

function base(): PaperDoc {
  return newPaper(arxivRef('1706.03762', ''), 1000);
}

describe('mergeDocs 多设备合并', () => {
  it('不同批注的并发新增：两边都保留（并集）', () => {
    const b0 = base();
    const a = addAnnotation(b0, ann('a1', 2000));
    const b = addAnnotation(b0, ann('b1', 2100));
    const m = mergeDocs(a, b);
    expect(m.annotations.map((x) => x.id).sort()).toEqual(['a1', 'b1']);
  });

  it('同一标量字段并发修改：后写入者胜出', () => {
    const b0 = base();
    const a = setField(b0, 'title', 'Old A', 2000);
    const b = setField(b0, 'title', 'New B', 3000);
    expect(mergeDocs(a, b).title).toBe('New B');
    expect(mergeDocs(b, a).title).toBe('New B');
  });

  it('不同字段并发修改：各自保留', () => {
    const b0 = base();
    const a = setField(b0, 'title', 'T', 2000);
    const b = setField(b0, 'tags', ['ml'], 2100);
    const m = mergeDocs(a, b);
    expect(m.title).toBe('T');
    expect(m.tags).toEqual(['ml']);
  });

  it('一方删除（墓碑）另一方编辑：较新的操作胜出，删除可同步', () => {
    const b0 = addAnnotation(base(), ann('x', 2000));
    const deleted = removeAnnotation(b0, 'x', 3000);
    const edited = updateAnnotation(b0, 'x', { note: 'hi' }, 2500);
    const m = mergeDocs(deleted, edited);
    expect(m.annotations.find((a) => a.id === 'x')!.deletedAt).toBe(3000);
    expect(mergeDocs(edited, deleted)).toEqual(m);
  });

  it('阅读进度：较新者胜出', () => {
    const b0 = base();
    const a = setProgress(b0, { page: 3, pages: 10, offset: 0.1 }, 5000);
    const b = setProgress(b0, { page: 7, pages: 10, offset: 0.5 }, 4000);
    expect(mergeDocs(a, b).progress.page).toBe(3);
  });

  it('交换律：merge(a,b) == merge(b,a)', () => {
    const b0 = base();
    const a = setField(addAnnotation(b0, ann('a', 2000)), 'title', 'A', 2200);
    const b = setField(removeAnnotation(addAnnotation(b0, ann('b', 2100)), 'b', 2300), 'title', 'B', 2100);
    expect(serialize(mergeDocs(a, b))).toBe(serialize(mergeDocs(b, a)));
  });

  it('幂等：merge(a,a) == a', () => {
    const a = setField(addAnnotation(base(), ann('a', 2000)), 'title', 'A', 2200);
    expect(serialize(mergeDocs(a, a))).toBe(serialize(a));
  });

  it('结合律：三台设备任意合并顺序结果一致', () => {
    const b0 = base();
    const d1 = addAnnotation(b0, ann('p', 2000));
    const d2 = setField(addAnnotation(b0, ann('q', 2100)), 'title', 'Q', 2100);
    const d3 = setField(removeAnnotation(addAnnotation(b0, ann('r', 2050)), 'r', 2400), 'title', 'R', 2400);
    const left = mergeDocs(mergeDocs(d1, d2), d3);
    const right = mergeDocs(d1, mergeDocs(d2, d3));
    const other = mergeDocs(mergeDocs(d3, d1), d2);
    expect(serialize(left)).toBe(serialize(right));
    expect(serialize(left)).toBe(serialize(other));
  });

  it('不同论文不能合并', () => {
    const a = base();
    const b = newPaper(arxivRef('2301.00001', ''), 1000);
    expect(() => mergeDocs(a, b)).toThrow();
  });
});

describe('序列化稳定性', () => {
  it('serialize → parse → serialize 逐字节一致', () => {
    let d = setField(addAnnotation(base(), ann('z', 2000)), 'tags', ['b', 'a'], 2000);
    d = addAnnotation(d, ann('a', 1500, { rects: [{ x: 0.123456789, y: 0.2, w: 0.3, h: 0.02 }] }));
    const once = serialize(d);
    expect(serialize(parseDoc(once))).toBe(once);
  });

  it('批注按位置排序，减少无意义的 diff', () => {
    const d = addAnnotation(addAnnotation(base(), ann('late', 1000, { page: 5 })), ann('early', 1000, { page: 1 }));
    const parsed = JSON.parse(serialize(d));
    expect(parsed.annotations.map((a: Annotation) => a.id)).toEqual(['early', 'late']);
  });

  it('parseDoc 清洗远端的脏数据而不是崩溃', () => {
    const d = parseDoc(
      JSON.stringify({
        id: 'x',
        annotations: [{ id: 'a', page: -4, color: 'red', rects: [{ x: 'bad' }, { x: 0, y: 0, w: 1, h: 1 }] }, 'junk', null],
        progress: { page: 0, offset: 9 },
        tags: ['t', 3, '', 't'],
      }),
    );
    expect(d.annotations).toHaveLength(1);
    expect(d.annotations[0].page).toBe(1);
    expect(d.annotations[0].color).toBe('yellow');
    expect(d.annotations[0].rects).toHaveLength(1);
    expect(d.progress.page).toBe(1);
    expect(d.progress.offset).toBe(1);
    expect(d.tags).toEqual(['t']);
  });

  it('拒绝比当前应用更新的 schema', () => {
    expect(() => parseDoc(JSON.stringify({ id: 'x', schema: 99 }))).toThrow(/更新版本/);
  });

  it('非法 JSON 报错', () => {
    expect(() => parseDoc('{oops')).toThrow();
  });
});
