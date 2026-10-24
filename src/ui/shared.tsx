import { tr } from '../core/i18n';
import type { SyncStatus } from '../core/store';
import type { PaperDoc } from '../core/types';

const LABEL: Record<SyncStatus['state'], string> = {
  idle: '已同步',
  syncing: '同步中',
  offline: '离线',
  auth: '令牌失效',
  error: '同步出错',
};

export function SyncBadge({ status, onSync }: { status: SyncStatus; onSync: () => void }) {
  const cls = status.state === 'idle' && status.pending === 0 ? 'ok' : status.state === 'idle' ? 'pending' : status.state;
  const text = status.state === 'idle' && status.pending > 0 ? tr('待同步 {n}', { n: status.pending }) : tr(LABEL[status.state]);
  return (
    <button class={`sync ${cls}`} onClick={onSync} title={status.error ?? tr('立即同步')}>
      <span class="dot" />
      <span>{text}</span>
    </button>
  );
}

/** 论文来源：arXiv 编号、网站域名或本机文件 */
export function sourceLabel(p: PaperDoc): string {
  if (p.id.startsWith('arxiv-')) return `arXiv ${p.id.slice(6).replace('_', '/')}`;
  if (p.id.startsWith('file-')) return tr('本机文件');
  try {
    return new URL(p.url || p.sourceUrl).hostname.replace(/^www\./, '');
  } catch {
    return tr('链接');
  }
}
