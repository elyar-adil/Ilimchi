import { parseDoc } from './model';
import type { PaperStore } from './store';
import type { PaperDoc } from './types';

/**
 * 备份与恢复。第一层备份其实是 GitHub 仓库本身（每次保存都是一次提交，可随时回滚）；
 * 这里再提供一个本地 JSON 导出/导入，方便离线存档或迁移到别的仓库。
 */

export const BACKUP_FORMAT = 'paper-reader-backup';

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  papers: PaperDoc[];
}

export function exportBackup(store: PaperStore, now = new Date()): BackupFile {
  return { format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), papers: store.list(true) };
}

export function backupFileName(now = new Date()): string {
  return `paper-reader-backup-${now.toISOString().slice(0, 10)}.json`;
}

export async function importBackup(store: PaperStore, text: string): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是合法的 JSON');
  }
  const o = raw as Partial<BackupFile> | null;
  if (!o || o.format !== BACKUP_FORMAT || !Array.isArray(o.papers)) throw new Error('这不是本应用导出的备份文件');
  let n = 0;
  for (const p of o.papers) {
    const doc = parseDoc(JSON.stringify(p));
    await store.mergeIn(doc);
    n++;
  }
  return n;
}
