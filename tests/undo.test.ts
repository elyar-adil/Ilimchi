import { describe, expect, it } from 'vitest';
import { mergeDocs } from '../src/core/merge';
import { addAnnotation, addShape, liveAnnotations, liveShapes, newPaper, removeShape, updateShape } from '../src/core/model';
import { restoreSnapshot, snapshotOf } from '../src/core/undo';
import { arxivRef } from '../src/core/ids';
import type { Annotation, InkShape, TextShape } from '../src/core/types';

const base = () => newPaper(arxivRef('1706.03762', ''), 1000);
const ann = (id: string, t: number): Annotation => ({
  id, page: 1, color: 'yellow', quote: 'q', prefix: '', suffix: '', start: 0,
  rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }], note: '', fingerprint: 'fp', version: '', createdAt: t, updatedAt: t,
});
const text = (id: string, t: number): TextShape => ({
  kind: 'text', id, page: 1, x: 0.2, y: 0.2, w: 0.3, size: 0.017, color: 'ink', text: '原文', createdAt: t, updatedAt: t,
});
const ink = (id: string, t: number): InkShape => ({ kind: 'ink', id, page: 1, color: 'blue', points: [[0.1, 0.1], [0.2, 0.2]], createdAt: t, updatedAt: t });

describe('撤销（快照恢复）', () => {
  it('撤销添加：新增的高亮与画笔被墓碑化', () => {
    const before = snapshotOf(base());
    let d = addAnnotation(base(), ann('a1', 1100));
    d = addShape(d, ink('i1', 1200));
    const undone = restoreSnapshot(d, before, 1300);
    expect(liveAnnotations(undone)).toHaveLength(0);
    expect(liveShapes(undone)).toHaveLength(0);
  });

  it('撤销删除：被删除的文字框重新出现', () => {
    const d0 = addShape(base(), text('t1', 1100));
    const snap = snapshotOf(d0);
    const d1 = removeShape(d0, 't1', 1200);
    expect(liveShapes(d1)).toHaveLength(0);
    const undone = restoreSnapshot(d1, snap, 1300);
    expect(liveShapes(undone)).toHaveLength(1);
    expect(undone.shapes.find((s) => s.id === 't1')).toMatchObject({ text: '原文' });
  });

  it('撤销编辑：文字内容回到之前的版本', () => {
    const d0 = addShape(base(), text('t1', 1100));
    const snap = snapshotOf(d0);
    const d1 = updateShape(d0, 't1', { text: '改过' }, 1200);
    const undone = restoreSnapshot(d1, snap, 1300);
    expect(undone.shapes[0]).toMatchObject({ text: '原文' });
  });

  it('撤销结果通过合并覆盖另一台设备上的旧版本（恢复胜出）', () => {
    const d0 = addShape(base(), text('t1', 1100));
    const snap = snapshotOf(d0);
    const edited = updateShape(d0, 't1', { text: '设备 A 改过' }, 1200);
    const otherDevice = updateShape(d0, 't1', { text: '设备 B 改过' }, 1150);
    const undone = restoreSnapshot(edited, snap, 1300);
    const merged = mergeDocs(otherDevice, undone);
    expect(merged.shapes[0]).toMatchObject({ text: '原文' });
  });

  it('未改变的条目保持原样，撤销是幂等的', () => {
    const d0 = addShape(base(), ink('i1', 1100));
    const snap = snapshotOf(d0);
    const once = restoreSnapshot(d0, snap, 1300);
    expect(once.shapes[0].updatedAt).toBe(1100);
    const twice = restoreSnapshot(once, snap, 1400);
    expect(twice.shapes).toEqual(once.shapes);
  });
});
