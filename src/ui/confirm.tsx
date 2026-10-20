import { useEffect, useState } from 'preact/hooks';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  /** 破坏性操作：确认按钮为红色，且默认焦点在「取消」上 */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** 以应用内对话框替代浏览器原生 confirm，返回用户是否确认。 */
export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  // 若已有未决对话框，先按取消处理，避免悬挂的 Promise
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { ...opts, resolve };
    notify();
  });
}

function settle(ok: boolean) {
  const c = current;
  current = null;
  notify();
  c?.resolve(ok);
}

/** 挂载一次即可（在 App 中渲染）。 */
export function ConfirmHost() {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false);
      if (e.key === 'Enter' && current && !current.danger) settle(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const c = current;
  if (!c) return null;
  return (
    <div class="confirm-bg" onClick={() => settle(false)} role="presentation">
      <div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{c.title}</h2>
        {c.message && <p class="muted">{c.message}</p>}
        <div class="confirm-actions">
          <button class="ghost" autoFocus={c.danger} onClick={() => settle(false)}>取消</button>
          <button class={c.danger ? 'destructive' : ''} autoFocus={!c.danger} onClick={() => settle(true)}>
            {c.confirmLabel ?? (c.danger ? '删除' : '确定')}
          </button>
        </div>
      </div>
    </div>
  );
}
