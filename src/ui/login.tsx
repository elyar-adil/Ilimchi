import { tr } from '../core/i18n';
import { useState } from 'preact/hooks';
import { ChooseRepoError, connect, type Config, type RememberMode, type Session } from '../core/auth';
import type { RepoInfo } from '../core/github';
import { vault } from '../core/services';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

export function Login({ onConnected, initialError }: { onConnected: (s: Session) => Promise<void>; initialError?: string | null }) {
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');
  const [remember, setRemember] = useState<RememberMode>('device');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [choices, setChoices] = useState<RepoInfo[] | null>(null);

  const submit = async (e: Event, chosenRepo?: string) => {
    e.preventDefault();
    setError(null);
    if (remember === 'passphrase' && pass.length < 8) return setError(tr('口令至少 8 个字符'));
    setBusy(true);
    try {
      const session = await connect({ token, repo: chosenRepo ?? repo, remember, passphrase: pass }, vault);
      setToken('');
      setPass('');
      setChoices(null);
      if (session.warnings.length) console.warn(session.warnings.join('\n'));
      await onConnected(session);
    } catch (err) {
      if (err instanceof ChooseRepoError) {
        setChoices(err.repos);
        setError(tr('该令牌可访问多个仓库，请选择一个用于存放笔记：'));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="login">
      <h1>Ilimchi</h1>
      <p class="muted">
        {tr('PDF 直接从 arXiv 等站点在你的浏览器里读取；笔记和批注保存在你自己的 GitHub 私有仓库中。没有任何自建服务器。')}
      </p>

      <details class="setup" open>
        <summary>{tr('第一次使用：三步设置')}</summary>
        <ol>
          <li>{tr('在 GitHub 新建一个私有仓库，建议名 paper-notes-data（可以是空仓库）。')}</li>
          <li>
            <a href={TOKEN_URL} target="_blank" rel="noreferrer noopener">
              {tr('创建 fine-grained 令牌')}
            </a>
            {tr('：Repository access 选「Only select repositories」并只选上一步的仓库；Permissions 里把 Contents 设为 Read and write，其余保持默认。')}
          </li>
          <li>{tr('把生成的令牌（github_pat_…）粘贴到下面。')}</li>
        </ol>
      </details>

      <form onSubmit={(e) => submit(e)} class="stack">
        <label>
          {tr('GitHub 令牌')}
          <input
            type="password"
            autoComplete="off"
            spellcheck={false}
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            placeholder="github_pat_…"
            required
          />
        </label>
        <label>
          {tr('仓库（可选，留空则自动选择）')}
          <input
            value={repo}
            onInput={(e) => setRepo((e.target as HTMLInputElement).value)}
            placeholder={tr('你的用户名/paper-notes-data')}
            autoComplete="off"
            spellcheck={false}
          />
        </label>

        <fieldset class="remember">
          <legend>{tr('令牌保存方式')}</legend>
          <label class="radio">
            <input type="radio" name="rem" checked={remember === 'session'} onChange={() => setRemember('session')} />
            {tr('仅本次会话（关闭标签页即忘记，最安全）')}
          </label>
          <label class="radio">
            <input type="radio" name="rem" checked={remember === 'device'} onChange={() => setRemember('device')} />
            {tr('记住在本设备（加密存放于浏览器，无需每次输入）')}
          </label>
          <label class="radio">
            <input type="radio" name="rem" checked={remember === 'passphrase'} onChange={() => setRemember('passphrase')} />
            {tr('记住，但每次用口令解锁（最推荐用于共享电脑）')}
          </label>
          {remember === 'passphrase' && (
            <input
              type="password"
              placeholder={tr('设置口令（至少 8 位）')}
              value={pass}
              autoComplete="new-password"
              onInput={(e) => setPass((e.target as HTMLInputElement).value)}
            />
          )}
        </fieldset>

        {error && <p class="error">{error}</p>}
        {choices && (
          <div class="choices">
            {choices.map((r) => (
              <button type="button" class="ghost" disabled={busy} onClick={(e) => submit(e as unknown as Event, r.full_name)}>
                {r.full_name}
              </button>
            ))}
          </div>
        )}
        <button type="submit" disabled={busy || !token}>
          {busy ? tr('正在验证…') : tr('连接 GitHub')}
        </button>
      </form>
      <p class="muted small">
        {tr('令牌只发送到 api.github.com，并仅在你的浏览器内加密保存；不会写入代码或仓库。')}
      </p>
    </main>
  );
}

export function Unlock({ config, onUnlock, onForget }: { config: Config; onUnlock: (p: string) => Promise<void>; onForget: () => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main class="login">
      <h1>{tr('解锁')}</h1>
      <p class="muted">{config.login} · {config.owner}/{config.repo}</p>
      <form
        class="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onUnlock(pass);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input type="password" placeholder={tr('口令')} value={pass} autoFocus onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={busy || !pass}>{tr('解锁')}</button>
      </form>
      <button class="ghost" onClick={onForget}>{tr('忘记令牌，重新登录')}</button>
    </main>
  );
}
