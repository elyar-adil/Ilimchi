import type { Session } from './auth';
import { createIdb, type Idb } from './idb';
import { PdfCache } from './pdfcache';
import { getPrefs, subscribePrefs, syncDelays } from './prefs';
import { PaperStore } from './store';
import { Vault } from './vault';

/** 进程内单例：IndexedDB、令牌保险库、PDF 缓存，以及登录后的同步仓库。 */

export const idb: Idb = createIdb();
export const vault = new Vault(idb);
export const pdfCache = new PdfCache(idb);

let current: { store: PaperStore; session: Session } | null = null;
let cleanup: (() => void) | null = null;

export function getSession(): { store: PaperStore; session: Session } | null {
  return current;
}

export async function startSession(session: Session): Promise<PaperStore> {
  await endSession();
  const store = new PaperStore({ idb, remote: session.client });
  await store.init();
  // 提交频率由设置决定；修改设置后立即生效
  const applyInterval = () => {
    const d = syncDelays(getPrefs().syncInterval);
    store.setSyncDelays(d.push, d.low);
  };
  applyInterval();
  const unsubPrefs = subscribePrefs(applyInterval);
  current = { store, session };
  void store.sync();

  // 回到前台 / 重新联网 / 定时：拉取其他设备的最新修改
  let last = Date.now();
  const refresh = () => {
    if (Date.now() - last < 20_000) return;
    last = Date.now();
    // 聚焦 / 联网时只拉取，不触发提交；本地修改仍按频率推送
    void store.sync({ push: false });
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') refresh();
    else void store.flush(); // 切到后台时尽快把修改推上去
  };
  const onOnline = () => {
    last = 0;
    refresh();
  };
  const onHide = () => void store.flush();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('focus', refresh);
  const interval = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 5 * 60_000);
  cleanup = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('focus', refresh);
    clearInterval(interval);
    unsubPrefs();
  };
  return store;
}

export async function endSession(): Promise<void> {
  cleanup?.();
  cleanup = null;
  current?.store.destroy();
  current = null;
}
