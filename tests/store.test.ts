import { describe, expect, it } from 'vitest';
import { FakeRemote, freshIdb } from './helpers';
import { PaperStore } from '../src/core/store';
import { addAnnotation, newPaper, parseDoc, serialize, setField } from '../src/core/model';
import { arxivRef } from '../src/core/ids';
import { GitHubError } from '../src/core/github';
import type { Annotation } from '../src/core/types';

const fast = { pushDelayMs: 1, lowPriorityDelayMs: 1, maxConflictRetries: 8 };

const ann = (id: string, page = 1): Annotation => ({
  id, page, color: 'green', quote: `quote ${id}`, prefix: 'p', suffix: 's', start: 3,
  rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }], note: `note ${id}`, fingerprint: 'fp', version: '',
  createdAt: Date.now(), updatedAt: Date.now(),
});

/** 模拟一台设备：独立的 IndexedDB + 独立的 store，共享同一个远端。 */
async function device(remote: FakeRemote) {
  const store = new PaperStore({ idb: freshIdb(), remote, ...fast });
  await store.init();
  return store;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('多设备同步（本地优先 + 乐观锁）', () => {
  it('创建 → 推送 → 另一台设备拉取得到相同内容', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('1706.03762', ''), 1000));
    await a.mutate('arxiv-1706.03762', (d) => addAnnotation(d, ann('n1')));
    await a.sync();
    expect(remote.files.has('papers/arxiv-1706.03762.json')).toBe(true);

    const b = await device(remote);
    await b.sync();
    expect(serialize(b.get('arxiv-1706.03762')!)).toBe(serialize(a.get('arxiv-1706.03762')!));
  });

  it('两台设备离线各自加批注，再同步：两条都保留（不互相覆盖）', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('2301.00001', ''), 1000));
    await a.sync();
    const b = await device(remote);
    await b.sync();

    // 离线编辑（尚未推送）
    await a.mutate('arxiv-2301.00001', (d) => addAnnotation(d, ann('from-a')));
    await b.mutate('arxiv-2301.00001', (d) => addAnnotation(d, ann('from-b')));

    await a.sync();
    await b.sync(); // b 的写入会先 409 → 拉取合并 → 重试
    await a.sync();

    for (const s of [a, b]) {
      expect(s.get('arxiv-2301.00001')!.annotations.map((x) => x.id).sort()).toEqual(['from-a', 'from-b']);
    }
    const remoteDoc = parseDoc(remote.files.get('papers/arxiv-2301.00001.json')!.content);
    expect(remoteDoc.annotations).toHaveLength(2);
  });

  it('推送期间远端被别人修改（竞态）：冲突被处理，不丢数据', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('2402.00002', ''), 1000));
    await a.sync();

    const other = await device(remote);
    await other.sync();
    await other.mutate('arxiv-2402.00002', (d) => addAnnotation(d, ann('remote-only')));
    await other.sync();

    // a 在写入前一刻才被“插入”远端变化，制造 409
    await a.mutate('arxiv-2402.00002', (d) => addAnnotation(d, ann('local-only')));
    remote.beforePut = () => {
      // 远端已经变化（另一台设备刚写入）
    };
    await a.sync();
    await a.sync();

    const ids = a.get('arxiv-2402.00002')!.annotations.map((x) => x.id).sort();
    expect(ids).toEqual(['local-only', 'remote-only']);
    const remoteIds = parseDoc(remote.files.get('papers/arxiv-2402.00002.json')!.content).annotations.map((x) => x.id).sort();
    expect(remoteIds).toEqual(['local-only', 'remote-only']);
  });

  it('远端在我们推送前被修改：第一次 PUT 冲突，重试后成功合并', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('2403.00003', ''), 1000));
    await a.sync();

    const other = await device(remote);
    await other.sync();
    await other.mutate('arxiv-2403.00003', (d) => setField(d, 'title', 'Title from other device', Date.now() + 5));
    await other.sync();

    await a.mutate('arxiv-2403.00003', (d) => addAnnotation(d, ann('mine')));
    const before = remote.puts;
    // 下一次写入前，远端被另一台设备抢先修改
    remote.beforePut = () => {
      const remoteDoc = parseDoc(remote.files.get('papers/arxiv-2403.00003.json')!.content);
      remote.external('papers/arxiv-2403.00003.json', serialize(addAnnotation(remoteDoc, ann('race'))));
    };
    await a.sync();
    expect(remote.puts).toBeGreaterThan(before);
    const final = parseDoc(remote.files.get('papers/arxiv-2403.00003.json')!.content);
    expect(final.annotations.map((x) => x.id).sort()).toEqual(['mine', 'race']);
    expect(final.title).toBe('Title from other device');
  });

  it('删除批注通过墓碑同步到其他设备（不会“复活”）', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('2404.00004', ''), 1000));
    await a.mutate('arxiv-2404.00004', (d) => addAnnotation(d, ann('gone')));
    await a.sync();

    const b = await device(remote);
    await b.sync();
    expect(b.get('arxiv-2404.00004')!.annotations).toHaveLength(1);

    const { removeAnnotation } = await import('../src/core/model');
    await b.mutate('arxiv-2404.00004', (d) => removeAnnotation(d, 'gone'));
    await b.sync();
    await a.sync();
    const live = a.get('arxiv-2404.00004')!.annotations.filter((x) => x.deletedAt === undefined);
    expect(live).toHaveLength(0);
  });

  it('离线时数据仍保存在本地，恢复后自动推送', async () => {
    const remote = new FakeRemote();
    const idb = freshIdb();
    const a = new PaperStore({ idb, remote, ...fast });
    await a.init();
    await a.create(newPaper(arxivRef('2405.00005', ''), 1000));
    const failing = remote.putFile.bind(remote);
    let offline = true;
    remote.putFile = async (...args) => {
      if (offline) throw new GitHubError('无法连接 GitHub（网络错误）', 'network');
      return failing(...args);
    };
    await a.sync();
    expect(a.getStatus().state).toBe('offline');
    expect(a.getStatus().pending).toBe(1);
    expect(remote.files.size).toBe(0);

    // 重启应用：从 IndexedDB 恢复，未推送的修改仍在
    const restarted = new PaperStore({ idb, remote, ...fast });
    await restarted.init();
    expect(restarted.get('arxiv-2405.00005')).toBeDefined();
    expect(restarted.getStatus().pending).toBe(1);
    offline = false;
    await restarted.flush();
    expect(remote.files.has('papers/arxiv-2405.00005.json')).toBe(true);
    await settle();
  });

  it('远端文件无法解析：跳过并报告，不影响其他论文', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('2406.00006', ''), 1000));
    await a.sync();
    remote.external('papers/corrupt.json', '{not json');
    const b = await device(remote);
    await b.sync();
    expect(b.get('arxiv-2406.00006')).toBeDefined();
    expect(b.getStatus().state).toBe('error');
    expect(b.getStatus().error).toMatch(/无法解析/);
  });

  it('远端被手动删除文件：本地数据不丢，重新上传', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('2407.00007', ''), 1000));
    await a.mutate('arxiv-2407.00007', (d) => addAnnotation(d, ann('keep')));
    await a.sync();
    remote.files.delete('papers/arxiv-2407.00007.json');
    await a.sync();
    expect(remote.files.has('papers/arxiv-2407.00007.json')).toBe(true);
    expect(parseDoc(remote.files.get('papers/arxiv-2407.00007.json')!.content).annotations[0].id).toBe('keep');
  });

  it('scrub（彻底清除）：标题/标签/批注被清空并写入墓碑，其他设备同步后也被清空', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('2408.00008', ''), 1000));
    await a.mutate('arxiv-2408.00008', (d) => setField(addAnnotation(d, ann('secret')), 'title', 'Secret title'));
    await a.sync();
    await a.scrub('arxiv-2408.00008');
    await a.sync();
    const b = await device(remote);
    await b.sync();
    const doc = b.get('arxiv-2408.00008')!;
    expect(doc.title).toBe('');
    expect(doc.deletedAt).not.toBeNull();
    expect(doc.annotations.every((x) => x.quote === '' && x.note === '')).toBe(true);
  });

  it('mergeIn（备份导入）与已有论文合并而不是覆盖', async () => {
    const remote = new FakeRemote();
    const a = await device(remote);
    await a.create(newPaper(arxivRef('2409.00009', ''), 1000));
    await a.mutate('arxiv-2409.00009', (d) => addAnnotation(d, ann('local')));
    const incoming = addAnnotation(newPaper(arxivRef('2409.00009', ''), 1000), ann('imported'));
    await a.mergeIn(incoming);
    expect(a.get('arxiv-2409.00009')!.annotations.map((x) => x.id).sort()).toEqual(['imported', 'local']);
  });
});
