import { subscribeLanguage, tr } from '../core/i18n';
import { useEffect, useState } from 'preact/hooks';
import { restore, signOut, unlock, type Config, type Session } from '../core/auth';
import { endSession, idb, startSession, vault } from '../core/services';
import { applyTheme, subscribePrefs } from '../core/prefs';
import type { PaperStore } from '../core/store';
import { Login, Unlock } from './login';
import { Library } from './library';
import { Reader } from './reader';
import { Settings } from './settings';
import { ConfirmHost } from './confirm';
import { paperIdFromHash, useHash, navigate } from './nav';

type Boot = { kind: 'loading' } | { kind: 'login' } | { kind: 'locked'; config: Config } | { kind: 'ready' };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [store, setStore] = useState<PaperStore | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const hash = useHash();
  const [, setLanguageVersion] = useState(0);

  useEffect(() => {
    applyTheme();
    return subscribePrefs(applyTheme);
  }, []);

  useEffect(() => subscribeLanguage(() => setLanguageVersion((v) => v + 1)), []);

  const enter = async (s: Session) => {
    const st = await startSession(s);
    setSession(s);
    setStore(st);
    setBoot({ kind: 'ready' });
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await restore(vault);
        if (r.kind === 'ready') await enter(r.session);
        else if (r.kind === 'locked') setBoot({ kind: 'locked', config: r.config });
        else setBoot({ kind: 'login' });
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
        setBoot({ kind: 'login' });
      }
    })();
    // 进入/离开登录态时清理 session 事件
    return () => void endSession();
  }, []);

  const onSignOut = async (clearLocal: boolean) => {
    await endSession();
    await signOut(vault, idb, clearLocal);
    setStore(null);
    setSession(null);
    setShowSettings(false);
    setBoot({ kind: 'login' });
    navigate('');
  };

  if (boot.kind === 'loading') return <div class="center muted">{tr('正在加载…')}</div>;
  if (boot.kind === 'login') return <Login onConnected={enter} initialError={bootError} />;
  if (boot.kind === 'locked') {
    return (
      <Unlock
        config={boot.config}
        onUnlock={async (pass) => enter(await unlock(vault, pass))}
        onForget={() => onSignOut(false)}
      />
    );
  }
  if (!store || !session) return null;

  const paperId = paperIdFromHash(hash);
  return (
    <>
      {paperId && store.get(paperId) ? (
        <Reader key={paperId} store={store} paperId={paperId} onOpenSettings={() => setShowSettings(true)} />
      ) : (
        <Library store={store} session={session} onOpenSettings={() => setShowSettings(true)} />
      )}
      <ConfirmHost />
      {showSettings && (
        <Settings
          store={store}
          session={session}
          onClose={() => setShowSettings(false)}
          onSignOut={onSignOut}
        />
      )}
    </>
  );
}
