import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, base64ToUtf8, utf8ToBase64 } from '../src/core/github';
import { connect } from '../src/core/auth';
import { Vault } from '../src/core/vault';
import { freshIdb } from './helpers';

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('GitHub 客户端', () => {
  it('UTF-8 与 base64 往返（含中文与 emoji）', () => {
    const s = '论文笔记 📄 Attention ✓';
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s);
  });

  it('所有请求带 Bearer 令牌，且不把令牌放进 URL', async () => {
    const { f, calls } = fakeFetch(() => json({ login: 'me', id: 1 }));
    const c = new GitHubClient({ token: 'github_pat_SECRET', owner: 'o', repo: 'r', fetch: f });
    await c.getUser();
    expect(calls[0].url).not.toContain('SECRET');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer github_pat_SECRET');
    expect(calls[0].init.credentials).toBe('omit');
  });

  it('PUT 携带 sha（乐观锁）并把内容转为 base64', async () => {
    const { f, calls } = fakeFetch(() => json({ content: { sha: 'newsha' } }));
    const c = new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: f });
    const r = await c.putFile('papers/a.json', '{"x":"论文"}', 'msg', 'oldsha');
    expect(r.sha).toBe('newsha');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.sha).toBe('oldsha');
    expect(base64ToUtf8(body.content)).toBe('{"x":"论文"}');
  });

  it('409/422 sha 不匹配 → conflict', async () => {
    const { f } = fakeFetch(() => json({ message: 'is at abc but expected def' }, 409));
    const c = new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: f });
    await expect(c.putFile('papers/a.json', 'x', 'm', 'def')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('401 → auth，403 → forbidden，404 → not_found', async () => {
    const mk = (status: number) => fakeFetch(() => json({ message: 'nope' }, status)).f;
    await expect(new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: mk(401) }).getUser()).rejects.toMatchObject({ code: 'auth' });
    await expect(new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: mk(403) }).getUser()).rejects.toMatchObject({ code: 'forbidden' });
    await expect(new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: mk(404) }).getRepo()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('429 / 限流头 → rate_limit 并给出等待时间', async () => {
    const { f } = fakeFetch(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'retry-after': '30' }));
    const c = new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: f });
    try {
      await c.getUser();
      throw new Error('should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubError);
      expect((e as GitHubError).code).toBe('rate_limit');
      expect((e as GitHubError).retryAfterMs).toBe(30_000);
    }
  });

  it('网络错误会重试，最终报告 network', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const c = new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: f });
    await expect(c.getUser()).rejects.toMatchObject({ code: 'network' });
    expect(n).toBe(3);
  });

  it('读取文件返回 sha 与内容，不存在返回 null', async () => {
    const { f } = fakeFetch((url) =>
      url.includes('missing') ? json({ message: 'Not Found' }, 404) : json({ type: 'file', sha: 'S1', encoding: 'base64', content: utf8ToBase64('hello') }),
    );
    const c = new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: f });
    expect(await c.getFile('papers/a.json')).toEqual({ content: 'hello', sha: 'S1' });
    expect(await c.getFile('papers/missing.json')).toBeNull();
  });

  it('列出文件只返回 papers/*.json', async () => {
    const { f } = fakeFetch(() =>
      json({
        truncated: false,
        tree: [
          { path: 'papers/a.json', type: 'blob', sha: '1' },
          { path: 'papers/b.txt', type: 'blob', sha: '2' },
          { path: 'README.md', type: 'blob', sha: '3' },
          { path: 'papers', type: 'tree', sha: '4' },
        ],
      }),
    );
    const c = new GitHubClient({ token: 't', owner: 'o', repo: 'r', fetch: f });
    (c as unknown as { branch: string }).branch = 'main';
    const files = await c.listFiles();
    expect([...files.keys()]).toEqual(['papers/a.json']);
  });
});

describe('授权与保险库', () => {
  it('connect：拒绝公开仓库，并且不把令牌写入 localStorage', async () => {
    const storage = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    } as Storage;

    const { f } = fakeFetch((url) => {
      if (url.endsWith('/user')) return json({ login: 'me', id: 1 });
      if (url.includes('/repos/me/notes')) return json({ full_name: 'me/notes', private: false, default_branch: 'main', permissions: { push: true } });
      return json({ message: 'nf' }, 404);
    });
    const vault = new Vault(freshIdb(), 1000);
    await expect(connect({ token: 'github_pat_X', repo: 'me/notes', remember: 'device' }, vault, f)).rejects.toThrow(/公开/);
    expect(JSON.stringify([...storage.entries()])).not.toContain('github_pat_X');
  });

  it('口令保险库：错误口令无法解密，正确口令可以', async () => {
    const v = new Vault(freshIdb(), 1000);
    await v.save({ token: 'github_pat_ABC' }, 'passphrase', 'correct horse');
    expect(await v.load('correct horse')).toEqual({ token: 'github_pat_ABC' });
    await expect(v.load('wrong password')).rejects.toThrow(/口令错误/);
    await expect(v.load()).rejects.toThrow(/需要口令/);
  });

  it('设备保险库：存储的是不可导出的密钥 + 密文，不含明文令牌', async () => {
    const idb = freshIdb();
    const v = new Vault(idb, 1000);
    await v.save({ token: 'github_pat_PLAIN' }, 'device');
    const stored = await idb.get<{ key: CryptoKey; ct: ArrayBuffer }>('vault', 'auth');
    expect(stored!.key.extractable).toBe(false);
    expect(new TextDecoder().decode(stored!.ct)).not.toContain('github_pat_PLAIN');
    expect(await v.load()).toEqual({ token: 'github_pat_PLAIN' });
  });

  it('口令不足 8 位被拒绝', async () => {
    const v = new Vault(freshIdb(), 1000);
    await expect(v.save({ token: 'x' }, 'passphrase', 'short')).rejects.toThrow(/8/);
  });
});
