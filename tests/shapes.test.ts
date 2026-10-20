import { describe, expect, it } from 'vitest';
import { mergeDocs } from '../src/core/merge';
import { addShape, liveShapes, newPaper, parseDoc, removeShape, serialize, updateShape } from '../src/core/model';
import { arxivRef } from '../src/core/ids';
import type { InkShape, PaperDoc, TextShape } from '../src/core/types';

const ink = (id: string, t: number, extra: Partial<InkShape> = {}): InkShape => ({
  kind: 'ink', id, page: 1, color: 'blue', points: [[0.1, 0.1], [0.2, 0.25]], createdAt: t, updatedAt: t, ...extra,
});
const text = (id: string, t: number, extra: Partial<TextShape> = {}): TextShape => ({
  kind: 'text', id, page: 2, x: 0.2, y: 0.3, w: 0.3, size: 0.017, color: 'ink', text: '注意这里', createdAt: t, updatedAt: t, ...extra,
});
const base = (): PaperDoc => newPaper(arxivRef('1706.03762', ''), 1000);

describe('图形（手绘 / 文字框）数据模型', () => {
  it('序列化再解析是恒等的，并保留两类图形', () => {
    let d = addShape(base(), ink('i1', 1100));
    d = addShape(d, text('t1', 1200));
    const back = parseDoc(serialize(d));
    expect(back.shapes).toHaveLength(2);
    expect(back.shapes.find((s) => s.id === 't1')).toMatchObject({ kind: 'text', text: '注意这里', page: 2 });
    expect(serialize(back)).toBe(serialize(d));
  });

  it('删除留墓碑，liveShapes 不再包含它', () => {
    const d = removeShape(addShape(base(), ink('i1', 1100)), 'i1', 1300);
    expect(liveShapes(d)).toHaveLength(0);
    const tomb = d.shapes[0];
    expect(tomb.deletedAt).toBe(1300);
    expect(tomb.kind === 'ink' && tomb.points).toEqual([]);
  });

  it('修改文字框更新时间戳', () => {
    const d = updateShape(addShape(base(), text('t1', 1100)), 't1', { text: '改过' }, 1500);
    expect(d.shapes[0]).toMatchObject({ text: '改过', updatedAt: 1500 });
  });

  it('合并：不同图形取并集，同一图形取较新者', () => {
    const shared = addShape(base(), text('t1', 1100));
    const a = addShape(shared, ink('i-a', 1200));
    const b = updateShape(addShape(shared, ink('i-b', 1250)), 't1', { text: '设备 B 的改动' }, 1400);
    const m1 = mergeDocs(a, b);
    const m2 = mergeDocs(b, a);
    expect(serialize(m1)).toBe(serialize(m2));
    expect(m1.shapes.map((s) => s.id).sort()).toEqual(['i-a', 'i-b', 't1']);
    expect(m1.shapes.find((s) => s.id === 't1')).toMatchObject({ text: '设备 B 的改动' });
  });

  it('合并：删除的墓碑会传播到另一台设备', () => {
    const shared = addShape(base(), ink('i1', 1100));
    const deletedHere = removeShape(shared, 'i1', 1400);
    const untouched = shared;
    const m = mergeDocs(untouched, deletedHere);
    expect(liveShapes(m)).toHaveLength(0);
    expect(serialize(mergeDocs(deletedHere, untouched))).toBe(serialize(m));
  });

  it('解析时拒绝非法图形：坏坐标被裁剪，缺少 id 的丢弃，未知种类丢弃', () => {
    const raw = {
      ...JSON.parse(serialize(base())),
      shapes: [
        { kind: 'text', id: 'ok', page: 1, x: 5, y: -3, w: 9, size: 9, color: 'ink', text: 'x', createdAt: 1, updatedAt: 1 },
        { kind: 'text', page: 1, x: 0.1, y: 0.1, w: 0.1, size: 0.02, color: 'ink', text: 'no id', createdAt: 1, updatedAt: 1 },
        { kind: 'video', id: 'bad', page: 1, createdAt: 1, updatedAt: 1 },
        { kind: 'ink', id: 'pts', page: 1, color: 'hot-pink', points: 'nope', createdAt: 1, updatedAt: 1 },
      ],
    };
    const d = parseDoc(JSON.stringify(raw));
    const ids = d.shapes.map((s) => s.id);
    expect(ids).not.toContain(undefined);
    expect(ids).not.toContain('bad');
    const ok = d.shapes.find((s) => s.id === 'ok') as TextShape | undefined;
    expect(ok).toBeDefined();
    expect(ok!.x).toBeGreaterThanOrEqual(0);
    expect(ok!.x).toBeLessThanOrEqual(1);
    expect(ok!.y).toBeGreaterThanOrEqual(0);
    expect(ok!.w).toBeLessThanOrEqual(1);
    expect(ok!.size).toBeLessThanOrEqual(0.06);
    const pts = d.shapes.find((s) => s.id === 'pts') as InkShape | undefined;
    if (pts) {
      expect(pts.color).toBe('ink');
      expect(pts.points).toEqual([]);
    }
  });
});

describe('荧光笔', () => {
  it('marker 标记与黄 / 粉颜色可以往返保存', () => {
    let d = addShape(base(), { ...ink('m1', 1100), marker: true, color: 'yellow' });
    d = addShape(d, { ...ink('p1', 1200), color: 'pink' });
    const back = parseDoc(serialize(d));
    const m = back.shapes.find((s) => s.id === 'm1') as InkShape;
    const p = back.shapes.find((s) => s.id === 'p1') as InkShape;
    expect(m).toMatchObject({ marker: true, color: 'yellow' });
    expect(p.marker).toBeUndefined();
    expect(p.color).toBe('pink');
    expect(serialize(back)).toBe(serialize(d));
  });

  it('非荧光笔不写入 marker 字段；非法 marker 值被忽略', () => {
    const txt = serialize(addShape(base(), ink('n1', 1100)));
    expect(txt).not.toContain('"marker"');
    const raw = JSON.parse(serialize(base()));
    raw.shapes = [{ kind: 'ink', id: 'x', page: 1, color: 'yellow', marker: 'yes', points: [[0.1, 0.1]], createdAt: 1, updatedAt: 1 }];
    const s = parseDoc(JSON.stringify(raw)).shapes[0] as InkShape;
    expect(s.marker).toBeUndefined();
    expect(s.color).toBe('yellow');
  });
});
