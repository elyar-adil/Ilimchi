import { tr } from '../core/i18n';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Session } from '../core/auth';
import { resolvePaper, fileRef } from '../core/ids';
import { importLocalPdf } from '../core/pdfsource';
import { pdfCache } from '../core/services';
import { newPaper, liveAnnotations, displayTitle, setField } from '../core/model';
import { getPrefs, setPrefs, type SortKey } from '../core/prefs';
import type { PaperStore } from '../core/store';
import type { PaperDoc } from '../core/types';
import { navigate, paperHash, useStoreRerender, useSyncStatus } from './nav';
import { SyncBadge } from './shared';
import { Icon, type IconName } from './icons';
import { askConfirm } from './confirm';

type View = { kind: 'all' } | { kind: 'untagged' } | { kind: 'trash' } | { kind: 'tag'; tag: string };

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'recent', label: tr('最近阅读') },
  { id: 'added', label: tr('添加时间') },
  { id: 'title', label: tr('标题') },
];

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

export function Library({ store, session, onOpenSettings }: { store: PaperStore; session: Session; onOpenSettings: () => void }) {
  useStoreRerender(store);
  const status = useSyncStatus(store);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>(getPrefs().sort);
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editingTags, setEditingTags] = useState(false);
  const [tagBar, setTagBar] = useState<'add' | 'remove' | null>(null);
  const [tagInput, setTagInput] = useState('');

  const all = store.list(false);
  const trashed = store.list(true).filter((p) => p.deletedAt !== null);
  const tags = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of all) for (const t of p.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'));
  }, [store.getVersion()]);
  const untaggedCount = all.filter((p) => p.tags.length === 0).length;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = view.kind === 'trash' ? trashed : all;
    const list = base
      .filter((p) => (view.kind === 'tag' ? p.tags.includes(view.tag) : view.kind === 'untagged' ? p.tags.length === 0 : true))
      .filter((p) => !needle || `${p.title} ${p.authors} ${p.tags.join(' ')} ${p.id}`.toLowerCase().includes(needle));
    const key = (p: PaperDoc) => {
      if (sort === 'added') return -p.createdAt;
      if (sort === 'title') return 0;
      return -(p.progress.updatedAt || p.updatedAt);
    };
    return list.sort((a, b) => (sort === 'title' ? displayTitle(a).localeCompare(displayTitle(b), 'zh-Hans-CN') : key(a) - key(b)));
  }, [view, q, sort, store.getVersion()]);

  // 切换视图时清空选择
  useEffect(() => {
    setPicked(new Set());
    setSelecting(false);
    setTagBar(null);
  }, [view]);

  // 添加面板：Esc 关闭
  useEffect(() => {
    if (!addOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAddOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addOpen]);

  const heading = view.kind === 'trash' ? tr('回收站') : view.kind === 'untagged' ? tr('未分类') : view.kind === 'tag' ? view.tag : tr('全部论文');

  const changeSort = (s: SortKey) => {
    setSort(s);
    setPrefs({ sort: s });
  };

  const add = async (raw: string) => {
    setAddError(null);
    setAdding(true);
    try {
      const ref = await resolvePaper(raw);
      const existing = store.get(ref.id);
      if (existing && existing.deletedAt === null) {
        setAddOpen(false);
        return navigate(paperHash(ref.id));
      }
      await store.create(newPaper(ref));
      setAddOpen(false);
      navigate(paperHash(ref.id));
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const openLocal = async (file: File) => {
    setAddError(null);
    try {
      const bytes = await file.arrayBuffer();
      const ref = await fileRef(bytes);
      if (!store.get(ref.id)) await store.create({ ...newPaper(ref), title: file.name.replace(/\.pdf$/i, '') });
      await importLocalPdf(file, pdfCache, ref.id, '');
      setAddOpen(false);
      navigate(paperHash(ref.id));
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const trashPapers = async (ids: string[]) => {
    const ok = await askConfirm({
      title: ids.length === 1 ? tr('移入回收站？') : tr('移入回收站 {n} 篇论文？', { n: ids.length }),
      message: tr('可以在回收站中恢复，30 天内不会被永久清除。'),
      confirmLabel: tr('移入回收站'),
      danger: true,
    });
    if (!ok) return;
    const now = Date.now();
    await Promise.all(ids.map((id) => store.mutate(id, (d) => ({ ...d, deletedAt: now, fieldTimes: { ...d.fieldTimes, deletedAt: now } }))));
    setPicked(new Set());
    setSelecting(false);
  };

  const restorePapers = async (ids: string[]) => {
    const now = Date.now();
    await Promise.all(ids.map((id) => store.mutate(id, (d) => ({ ...d, deletedAt: null, fieldTimes: { ...d.fieldTimes, deletedAt: now } }))));
    setPicked(new Set());
    setSelecting(false);
  };

  const purge = async (ids: string[]) => {
    const ok = await askConfirm({
      title: ids.length === 1 ? tr('永久清除这篇论文？') : tr('永久清除 {n} 篇论文？', { n: ids.length }),
      message: tr('会清除标题、标签和全部笔记，且无法撤销。远端的历史提交仍可在 GitHub 中查看。'),
      confirmLabel: tr('永久清除'),
      danger: true,
    });
    if (!ok) return;
    await Promise.all(ids.map((id) => store.scrub(id)));
    setPicked(new Set());
    setSelecting(false);
  };

  /** 批量增减标签，写入每篇论文的标签字段（最后写入者胜出）。 */
  const changeTags = async (ids: string[], apply: (cur: string[]) => string[]) => {
    await Promise.all(
      ids.map((id) =>
        store.mutate(id, (d) => {
          const next = [...new Set(apply(d.tags).map((t) => t.trim()).filter(Boolean))];
          return setField(d, 'tags', next);
        }),
      ),
    );
  };

  const submitTagBar = async () => {
    const name = tagInput.trim();
    if (!name || !tagBar) return;
    const ids = [...picked];
    if (tagBar === 'add') await changeTags(ids, (cur) => [...cur, name]);
    else await changeTags(ids, (cur) => cur.filter((t) => t !== name));
    setTagInput('');
    setTagBar(null);
  };

  const renameTag = async (from: string, to: string) => {
    const name = to.trim();
    if (!name || name === from) return;
    await changeTags(
      all.filter((p) => p.tags.includes(from)).map((p) => p.id),
      (cur) => cur.map((t) => (t === from ? name : t)),
    );
    if (view.kind === 'tag' && view.tag === from) setView({ kind: 'tag', tag: name });
  };

  const deleteTag = async (tag: string, n: number) => {
    const ok = await askConfirm({
      title: tr('删除标签「{tag}」？', { tag }),
      message: tr('会从 {n} 篇论文上移除这个标签。论文本身和笔记不会被删除。', { n }),
      confirmLabel: tr('删除标签'),
      danger: true,
    });
    if (!ok) return;
    await changeTags(
      all.filter((p) => p.tags.includes(tag)).map((p) => p.id),
      (cur) => cur.filter((t) => t !== tag),
    );
    if (view.kind === 'tag' && view.tag === tag) setView({ kind: 'all' });
  };

  const inTrash = view.kind === 'trash';
  const ids = [...picked];

  return (
    <div class="library">
      <aside class="lib-index">
        <nav class="nav">
          <NavItem icon="library" label={tr('全部论文')} count={all.length} active={sameView(view, { kind: 'all' })} onClick={() => setView({ kind: 'all' })} />
          <NavItem icon="folder" label={tr('未分类')} count={untaggedCount} active={sameView(view, { kind: 'untagged' })} onClick={() => setView({ kind: 'untagged' })} />
          <NavItem icon="trash" label={tr('回收站')} count={trashed.length} active={sameView(view, { kind: 'trash' })} onClick={() => setView({ kind: 'trash' })} />
        </nav>

        {tags.length > 0 && (
          <>
            <div class="nav-title nav-title-row">
              <span>{tr('标签')}</span>
              <button class="icon-btn tiny" onClick={() => setEditingTags((v) => !v)} title={editingTags ? tr('完成') : tr('编辑标签')} aria-label={editingTags ? tr('完成') : tr('编辑标签')}>
                <Icon name={editingTags ? 'check' : 'edit'} size={12} />
              </button>
            </div>
            <nav class="nav">
              {tags.map(([t, n]) =>
                editingTags ? (
                  <TagEditRow key={t} name={t} count={n} onRename={(to) => renameTag(t, to)} onDelete={() => deleteTag(t, n)} />
                ) : (
                  <NavItem key={t} label={t} count={n} active={sameView(view, { kind: 'tag', tag: t })} onClick={() => setView({ kind: 'tag', tag: t })} />
                ),
              )}
            </nav>
          </>
        )}

        <div class="sidebar-foot">
          <SyncBadge status={status} onSync={() => void store.sync()} />
          <span class="muted small account" title={`${session.config.owner}/${session.config.repo}`}>{session.config.login}</span>
        </div>
      </aside>

      <main class="main">
        <header class="main-head">
          <h1>{heading}</h1>
          <div class="grow" />
          <label class="search">
            <Icon name="search" size={14} />
            <input type="search" placeholder={tr('搜索')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label={tr('搜索论文')} />
          </label>
          <select class="sort" value={sort} onChange={(e) => changeSort((e.target as HTMLSelectElement).value as SortKey)} aria-label={tr('排序')}>
            {SORTS.map((s) => <option value={s.id}>{s.label}</option>)}
          </select>
          <button class={`icon-btn ${selecting ? 'on' : ''}`} onClick={() => { setSelecting((v) => !v); setPicked(new Set()); setTagBar(null); }} title={tr('整理')} aria-label={tr('整理')} aria-pressed={selecting}>
            <Icon name="list" />
          </button>
          {!inTrash && (
            <div class="add-anchor">
              <button class="icon-btn add-btn" onClick={() => setAddOpen((v) => !v)} title={tr('添加论文')} aria-label={tr('添加论文')} aria-expanded={addOpen}>
                <Icon name="plus" />
              </button>
              {addOpen && (
                <AddPopover
                  busy={adding}
                  error={addError}
                  onSubmit={add}
                  onLocal={openLocal}
                  onClose={() => setAddOpen(false)}
                />
              )}
            </div>
          )}
          <button class="icon-btn" onClick={onOpenSettings} title={tr('设置')} aria-label={tr('设置')}>
            <Icon name="gear" />
          </button>
        </header>

        {shown.length === 0 ? (
          <div class="empty">
            {inTrash ? (
              <p>{tr('回收站是空的')}</p>
            ) : q ? (
              <p>{tr('没有匹配的论文')}</p>
            ) : view.kind === 'untagged' ? (
              <p>{tr('所有论文都已分类')}</p>
            ) : (
              <>
                <p>{tr('还没有论文')}</p>
                <p class="muted small">{tr('点击右上角的 + 粘贴链接，或打开本机 PDF。笔记会保存到你的 GitHub 仓库。')}</p>
              </>
            )}
          </div>
        ) : (
          <ul class="list">
            {shown.map((p) => (
              <PaperRow
                key={p.id}
                paper={p}
                trash={inTrash}
                selecting={selecting}
                picked={picked.has(p.id)}
                onPick={() => toggle(p.id)}
                onTrash={() => void trashPapers([p.id])}
                onRestore={() => void restorePapers([p.id])}
                onPurge={() => void purge([p.id])}
              />
            ))}
          </ul>
        )}
      </main>

      {selecting && (
        <div class="bulk-bar" role="toolbar" aria-label={tr('批量整理')}>
          <span class="bulk-count">{ids.length === 0 ? tr('选择论文') : tr('已选 {n} 篇', { n: ids.length })}</span>
          {tagBar ? (
            <form class="bulk-tag" onSubmit={(e) => { e.preventDefault(); void submitTagBar(); }}>
              <input
                value={tagInput}
                onInput={(e) => setTagInput((e.target as HTMLInputElement).value)}
                placeholder={tagBar === 'add' ? tr('新标签名') : tr('要移除的标签')}
                list={tagBar === 'remove' ? 'bulk-tags' : undefined}
                autoFocus
                aria-label={tagBar === 'add' ? tr('添加标签') : tr('移除标签')}
              />
              {tagBar === 'remove' && (
                <datalist id="bulk-tags">{tags.map(([t]) => <option value={t} />)}</datalist>
              )}
              <button type="submit" disabled={!tagInput.trim()}>{tagBar === 'add' ? tr('添加') : tr('移除')}</button>
              <button type="button" class="ghost" onClick={() => { setTagBar(null); setTagInput(''); }}>{tr('取消')}</button>
            </form>
          ) : inTrash ? (
            <>
              <button class="ghost" disabled={ids.length === 0} onClick={() => void restorePapers(ids)}>{tr('恢复')}</button>
              <button class="danger-text" disabled={ids.length === 0} onClick={() => void purge(ids)}>{tr('永久清除')}</button>
            </>
          ) : (
            <>
              <button class="ghost" disabled={ids.length === 0} onClick={() => setTagBar('add')}>{tr('添加标签')}</button>
              <button class="ghost" disabled={ids.length === 0} onClick={() => setTagBar('remove')}>{tr('移除标签')}</button>
              <button class="danger-text" disabled={ids.length === 0} onClick={() => void trashPapers(ids)}>{tr('移入回收站')}</button>
            </>
          )}
          <span class="grow" />
          <button class="ghost" onClick={() => { setSelecting(false); setPicked(new Set()); setTagBar(null); }}>{tr('完成')}</button>
        </div>
      )}
    </div>
  );
}

function AddPopover({ busy, error, onSubmit, onLocal, onClose }: {
  busy: boolean;
  error: string | null;
  onSubmit: (v: string) => void;
  onLocal: (f: File) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div class="add-pop" ref={ref} role="dialog" aria-label={tr('添加论文')}>
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value); }}>
        <input
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          placeholder={tr('粘贴链接，或输入 arXiv 编号')}
          spellcheck={false}
          autoComplete="off"
          autoFocus
          aria-label={tr('论文链接或 arXiv 编号')}
        />
        <button type="submit" disabled={busy || !value.trim()}>{busy ? tr('添加中') : tr('添加')}</button>
      </form>
      <label class="add-local">
        <Icon name="library" size={14} />
        <span>{tr('打开本机 PDF')}</span>
        <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) onLocal(f);
          (e.target as HTMLInputElement).value = '';
        }} />
      </label>
      {error && <p class="error small add-error">{error}</p>}
    </div>
  );
}

function TagEditRow({ name, count, onRename, onDelete }: { name: string; count: number; onRename: (to: string) => void; onDelete: () => void }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <div class="tag-edit">
      <input
        value={v}
        onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onBlur={() => v.trim() !== name && onRename(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setV(name);
        }}
        aria-label={tr('重命名标签 {name}', { name })}
      />
      <span class="nav-count">{count}</span>
      <button class="icon-btn tiny" onClick={onDelete} title={tr('删除标签')} aria-label={tr('删除标签 {name}', { name })}>
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

function NavItem({ icon, label, count, active, onClick }: { icon?: IconName; label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button class={`nav-item ${active ? 'on' : ''} ${icon ? '' : 'plain'}`} onClick={onClick} aria-current={active ? 'true' : undefined}>
      {icon && <Icon name={icon} size={16} />}
      <span class="nav-label">{label}</span>
      {count !== undefined && <span class="nav-count">{count}</span>}
    </button>
  );
}

function PaperRow({ paper: p, trash, selecting, picked, onPick, onTrash, onRestore, onPurge }: {
  paper: PaperDoc;
  trash: boolean;
  selecting: boolean;
  picked: boolean;
  onPick: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const notes = liveAnnotations(p).length;
  const pct = p.progress.pages ? Math.min(100, Math.round((p.progress.page / p.progress.pages) * 100)) : 0;
  const body = (
    <>
      <div class="row-title">{displayTitle(p)}</div>
      {p.authors && <div class="row-authors">{p.authors.length > 120 ? `${p.authors.slice(0, 120)}…` : p.authors}</div>}
      <div class="row-meta">
        {p.version && <span>{p.version}</span>}
        <span>{tr('{n} 条笔记', { n: notes })}</span>
        {p.progress.pages > 0 && <span class="read-pages">{tr('{page} / {pages} 页', { page: p.progress.page, pages: p.progress.pages })}</span>}
        {p.tags.map((t) => <span class="tag">{t}</span>)}
      </div>
    </>
  );
  if (selecting) {
    return (
      <li class={`paper-row selectable ${picked ? 'picked' : ''}`} onClick={onPick}>
        <span class="gutter">
          <span class={`check ${picked ? 'on' : ''}`} aria-hidden="true">{picked && <Icon name="check" size={12} />}</span>
        </span>
        <div class="row-main">{body}</div>
      </li>
    );
  }
  return (
    <li class="paper-row">
      <span class="gutter" title={pct ? tr('已读 {pct}%', { pct }) : tr('未读')}>
        <Ring pct={pct} />
      </span>
      {trash ? <div class="row-main">{body}</div> : <a class="row-main" href={paperHash(p.id)}>{body}</a>}
      <div class="row-actions">
        {trash ? (
          <>
            <button class="ghost small" onClick={onRestore}>{tr('恢复')}</button>
            <button class="ghost small danger" onClick={onPurge}>{tr('永久清除')}</button>
          </>
        ) : (
          <button class="icon-btn tiny" onClick={onTrash} title={tr('移入回收站')} aria-label={tr('移入回收站')}><Icon name="trash" size={13} /></button>
        )}
      </div>
    </li>
  );
}

/** 阅读进度：扇形填充，空心为未读，实心为读完。 */
function Ring({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct)) / 100;
  const r = 5;
  const a = p * 2 * Math.PI;
  const x = 8 + r * Math.sin(a);
  const y = 8 - r * Math.cos(a);
  const large = p > 0.5 ? 1 : 0;
  return (
    <svg class="pie" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle class="pie-rim" cx="8" cy="8" r="7" />
      {p >= 1 ? (
        <circle class="pie-fill" cx="8" cy="8" r={r} />
      ) : p > 0 ? (
        <path class="pie-fill" d={`M8 8 L8 ${8 - r} A${r} ${r} 0 ${large} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`} />
      ) : null}
    </svg>
  );
}
