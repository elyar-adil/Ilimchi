import { useEffect, useState } from 'preact/hooks';
import type { PaperStore } from '../core/store';

/** 极简 hash 路由：#/p/<id> 为阅读器，其余为论文库。 */
export function useHash(): string {
  const [h, set] = useState(location.hash);
  useEffect(() => {
    const f = () => set(location.hash);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}

export const navigate = (hash: string) => {
  location.hash = hash;
};

export const paperHash = (id: string) => `#/p/${encodeURIComponent(id)}`;

export function paperIdFromHash(h: string): string | null {
  const m = /^#\/p\/(.+)$/.exec(h);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** store 每次变化时触发重渲染。 */
export function useStoreRerender(store: PaperStore): void {
  const [, setV] = useState(0);
  useEffect(() => store.subscribe(() => setV((v) => v + 1)), [store]);
}

export function useSyncStatus(store: PaperStore) {
  const [s, setS] = useState(store.getStatus());
  useEffect(() => store.subscribe(() => setS(store.getStatus())), [store]);
  return s;
}
