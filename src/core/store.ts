import { GitHubError, type Remote } from './github';
import { idFromPath, paperPath } from './ids';
import type { Idb } from './idb';
import { mergeDocs } from './merge';
import { liveAnnotations, parseDoc, pruneTombstones, serialize, setField } from './model';
import type { PaperDoc } from './types';

/**
 * 本地优先的论文库：
 *  1. 所有修改先写入本机 IndexedDB（即使断网 / 关页面也不会丢），并标记为 dirty；
 *  2. 稍后（防抖）推送到用户自己的 GitHub 仓库，每篇论文一个 JSON 文件；
 *  3. 推送使用 Contents API 的 sha 乐观锁；遇到冲突（别的设备改过）就拉取远端、
 *     用 mergeDocs 合并后重试，保证多设备并发编辑最终收敛，不会互相覆盖。
 */

export type SyncState = 'idle' | 'syncing' | 'offline' | 'auth' | 'error';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncAt: number | null;
  error: string | null;
}

interface Meta {
  /** 最近一次已知的远端 blob sha */
  sha?: string;
  dirty: boolean;
  /** 本地修订号；用于判断推送期间是否又有新修改 */
  rev: number;
}

export interface StoreOptions {
  idb: Idb;
  remote: Remote | null;
  pushDelayMs?: number;
  lowPriorityDelayMs?: number;
  maxConflictRetries?: number;
}

export class PaperStore {
  private docs = new Map<string, PaperDoc>();
  private metas = new Map<string, Meta>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = Infinity;
  private chain: Promise<unknown> = Promise.resolve();
  private retryAttempt = 0;
  private destroyed = false;
  private version = 0;
  private status: SyncStatus = { state: 'idle', pending: 0, lastSyncAt: null, error: null };

  private readonly idb: Idb;
  private readonly remote: Remote | null;
  /** 自动推送间隔（毫秒）；null 表示不自动推送，仅手动同步 */
  private pushDelay: number | null;
  private lowDelay: number | null;
  private readonly maxRetries: number;

  constructor(opts: StoreOptions) {
    this.idb = opts.idb;
    this.remote = opts.remote;
    this.pushDelay = opts.pushDelayMs ?? 1500;
    this.lowDelay = opts.lowPriorityDelayMs ?? 15000;
    this.maxRetries = opts.maxConflictRetries ?? 6;
  }

  // ---------- 生命周期 ----------

  async init(): Promise<void> {
    const [docs, metas] = await Promise.all([this.idb.all<PaperDoc>('papers'), this.idb.all<Meta>('sync')]);
    for (const [id, d] of docs) this.docs.set(id, d);
    for (const [id, m] of metas) this.metas.set(id, m);
    this.refreshPending();
    this.emit();
    if (this.dirtyIds().length > 0) this.schedule(200);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  // ---------- 读取 ----------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 每次变化递增，供 UI 判断是否需要重新渲染 */
  getVersion(): number {
    return this.version;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  get(id: string): PaperDoc | undefined {
    return this.docs.get(id);
  }

  list(includeDeleted = false): PaperDoc[] {
    return [...this.docs.values()].filter((d) => includeDeleted || d.deletedAt === null);
  }

  // ---------- 写入 ----------

  async create(doc: PaperDoc): Promise<PaperDoc> {
    const existing = this.docs.get(doc.id);
    if (existing) {
      if (existing.deletedAt !== null) return this.mutate(doc.id, (d) => setField(d, 'deletedAt', null));
      return existing;
    }
    this.docs.set(doc.id, doc);
    this.metas.set(doc.id, { dirty: true, rev: 1 });
    await this.persist(doc.id);
    this.refreshPending();
    this.emit();
    this.autoSchedule(this.pushDelay);
    return doc;
  }

  async mutate(id: string, fn: (d: PaperDoc) => PaperDoc, opts: { lowPriority?: boolean } = {}): Promise<PaperDoc> {
    const cur = this.docs.get(id);
    if (!cur) throw new Error(`论文不存在: ${id}`);
    const next = fn(cur);
    if (next === cur) return cur;
    this.docs.set(id, next);
    const meta = this.meta(id);
    meta.dirty = true;
    meta.rev++;
    await this.persist(id);
    this.refreshPending();
    this.emit();
    this.autoSchedule(opts.lowPriority ? this.lowDelay : this.pushDelay);
    return next;
  }

  /** 导入（备份恢复 / 外部来源）：与本地同 id 文档合并，而不是覆盖。 */
  async mergeIn(doc: PaperDoc): Promise<void> {
    const cur = this.docs.get(doc.id);
    if (!cur) {
      await this.create(doc);
      return;
    }
    await this.mutate(doc.id, (d) => {
      const merged = mergeDocs(d, doc);
      return serialize(merged) === serialize(d) ? d : merged;
    });
  }

  /**
   * 彻底清除一篇论文的内容（标题、标签、全部批注）。
   * 不删除远端文件，而是写入「清空墓碑」：这样其他设备上旧的副本在合并时也会被清空，不会复活。
   * 历史内容仍保留在你的 Git 提交历史里（可自行 force-push 清除）。
   */
  async scrub(id: string): Promise<void> {
    const now = Date.now();
    await this.mutate(id, (d) => {
      let n = setField(d, 'title', '', now);
      n = setField(n, 'authors', '', now);
      n = setField(n, 'tags', [], now);
      n = setField(n, 'deletedAt', now, now);
      n = {
        ...n,
        annotations: n.annotations.map((a) =>
          a.deletedAt !== undefined ? a : { ...a, quote: '', prefix: '', suffix: '', note: '', rects: [], deletedAt: now, updatedAt: now },
        ),
        updatedAt: now,
      };
      n = {
        ...n,
        shapes: (n.shapes ?? []).map((sh) =>
          sh.deletedAt !== undefined ? sh : sh.kind === 'text' ? { ...sh, text: '', deletedAt: now, updatedAt: now } : { ...sh, points: [], deletedAt: now, updatedAt: now },
        ),
      };
      return n;
    });
  }

  // ---------- 同步 ----------

  /** 调整自动推送间隔；修改会在下一次调度时生效。 */
  setSyncDelays(push: number | null, low: number | null): void {
    this.pushDelay = push;
    this.lowDelay = low;
  }

  /** 拉取远端变化；默认同时推送本地修改。 */
  async sync(opts: { push?: boolean } = {}): Promise<void> {
    if (!this.remote || this.destroyed) return;
    await this.exclusive(async () => {
      this.setStatus({ state: 'syncing' });
      try {
        await this.pull();
        if (opts.push !== false) await this.pushAll();
        this.onSuccess();
      } catch (e) {
        this.onError(e);
      }
    });
  }

  /** 立即推送所有待同步的修改（不拉取）。 */
  async flush(): Promise<void> {
    if (!this.remote || this.destroyed) return;
    await this.exclusive(async () => {
      if (this.dirtyIds().length === 0) return;
      this.setStatus({ state: 'syncing' });
      try {
        await this.pushAll();
        this.onSuccess();
      } catch (e) {
        this.onError(e);
      }
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async pull(): Promise<void> {
    const remote = this.remote!;
    const listing = await remote.listFiles();
    const todo: { id: string; path: string; sha: string }[] = [];
    for (const [path, sha] of listing) {
      const id = idFromPath(path);
      if (!id) continue;
      const meta = this.metas.get(id);
      if (!this.docs.has(id) || !meta || meta.sha !== sha) todo.push({ id, path, sha });
    }

    // 本地已同步过、远端却不存在：不删除本地数据，重新上传（数据安全优先）
    for (const [id, meta] of this.metas) {
      if (meta.sha && !listing.has(paperPath(id)) && this.docs.has(id)) {
        meta.sha = undefined;
        meta.dirty = true;
        meta.rev++;
        await this.idb.put('sync', id, meta);
      }
    }

    let unparsable = 0;
    await pool(todo, 6, async ({ id, path }) => {
      const file = await remote.getFile(path);
      if (!file) return;
      let remoteDoc: PaperDoc;
      try {
        remoteDoc = parseDoc(file.content);
      } catch {
        unparsable++;
        return;
      }
      if (remoteDoc.id !== id) {
        unparsable++;
        return;
      }
      // 以下到 set 之间没有 await，不会与用户编辑交错
      const local = this.docs.get(id);
      const merged = local ? mergeDocs(local, remoteDoc) : remoteDoc;
      const needsPush = !!local && serialize(merged) !== serialize(remoteDoc);
      const meta = this.meta(id);
      this.docs.set(id, merged);
      meta.sha = file.sha;
      if (needsPush) {
        meta.dirty = true;
        meta.rev++;
      }
      await this.persist(id);
    });
    this.refreshPending();
    this.emit();
    if (unparsable > 0) throw new Error(`有 ${unparsable} 个笔记文件无法解析，已跳过（请检查仓库中 papers/ 下的文件）`);
  }

  private async pushAll(): Promise<void> {
    for (const id of this.dirtyIds()) await this.pushOne(id);
  }

  private async pushOne(id: string): Promise<void> {
    const remote = this.remote!;
    const path = paperPath(id);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const doc = this.docs.get(id);
      const meta = this.meta(id);
      if (!doc) return;
      const rev = meta.rev;
      const pruned = pruneTombstones(doc);
      const text = serialize(pruned);
      try {
        const res = await remote.putFile(path, text, commitMessage(pruned, !meta.sha), meta.sha);
        meta.sha = res.sha;
        if (meta.rev === rev) {
          meta.dirty = false;
          if (pruned !== doc) this.docs.set(id, pruned);
        }
        await this.persist(id);
        this.refreshPending();
        this.emit();
        return;
      } catch (e) {
        if (!(e instanceof GitHubError) || e.code !== 'conflict' || attempt === this.maxRetries) throw e;
        // 别的设备改过：拉取最新版本，合并后重试
        await sleep(50 + Math.random() * 250);
        const file = await remote.getFile(path);
        if (!file) {
          meta.sha = undefined;
          continue;
        }
        const remoteDoc = parseDoc(file.content);
        const merged = mergeDocs(this.docs.get(id) ?? doc, remoteDoc);
        this.docs.set(id, merged);
        meta.sha = file.sha;
        if (serialize(merged) === file.content) {
          // 远端已包含我们的全部修改，无需再提交
          if (meta.rev === rev) meta.dirty = false;
          await this.persist(id);
          this.refreshPending();
          this.emit();
          return;
        }
        await this.persist(id);
      }
    }
  }

  // ---------- 状态与调度 ----------

  private onSuccess(): void {
    this.retryAttempt = 0;
    this.refreshPending();
    this.setStatus({ state: 'idle', lastSyncAt: Date.now(), error: null });
    if (this.dirtyIds().length > 0) this.autoSchedule(this.pushDelay);
  }

  private autoSchedule(delay: number | null): void {
    if (delay !== null) this.schedule(delay);
  }

  private onError(e: unknown): void {
    this.refreshPending();
    if (e instanceof GitHubError) {
      if (e.code === 'auth') return this.setStatus({ state: 'auth', error: e.message });
      if (e.code === 'forbidden' || e.code === 'not_found') return this.setStatus({ state: 'error', error: e.message });
      if (e.code === 'network') {
        this.setStatus({ state: 'offline', error: e.message });
        return this.backoff();
      }
      if (e.code === 'rate_limit') {
        this.setStatus({ state: 'error', error: e.message });
        return this.schedule(Math.max(e.retryAfterMs, 5000));
      }
    }
    this.setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) });
    this.backoff();
  }

  private backoff(): void {
    const delay = Math.min(5000 * 2 ** this.retryAttempt, 300_000);
    this.retryAttempt++;
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (!this.remote || this.destroyed) return;
    const due = Date.now() + delay;
    if (this.timer && this.dueAt <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dueAt = Infinity;
      void this.flush();
    }, delay);
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  private refreshPending(): void {
    this.status = { ...this.status, pending: this.dirtyIds().length };
  }

  private dirtyIds(): string[] {
    return [...this.metas.entries()].filter(([id, m]) => m.dirty && this.docs.has(id)).map(([id]) => id);
  }

  private meta(id: string): Meta {
    let m = this.metas.get(id);
    if (!m) {
      m = { dirty: false, rev: 0 };
      this.metas.set(id, m);
    }
    return m;
  }

  private async persist(id: string): Promise<void> {
    const doc = this.docs.get(id);
    const meta = this.metas.get(id);
    if (doc) await this.idb.put('papers', id, doc);
    if (meta) await this.idb.put('sync', id, { ...meta });
  }

  private emit(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }
}

function commitMessage(doc: PaperDoc, created: boolean): string {
  const title = (doc.title || doc.id).replace(/\s+/g, ' ').slice(0, 60);
  return `${created ? 'add' : 'update'}: ${title} (${liveAnnotations(doc).length} notes)`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
