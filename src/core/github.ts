import { tr } from './i18n';
/**
 * 极简 GitHub REST 客户端，只用 Contents / Git Trees API。
 * api.github.com 允许浏览器跨域直连（Access-Control-Allow-Origin: *），因此无需任何后端。
 * 并发控制依赖 Contents API 的乐观锁：更新文件必须带上最新的 blob sha，否则返回 409/422。
 */

export type GitHubErrorCode = 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limit' | 'network' | 'other';

export class GitHubError extends Error {
  constructor(
    message: string,
    public code: GitHubErrorCode,
    public status = 0,
    public retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface Remote {
  listFiles(): Promise<Map<string, string>>;
  getFile(path: string): Promise<{ content: string; sha: string } | null>;
  putFile(path: string, content: string, message: string, sha?: string): Promise<{ sha: string }>;
}

export interface RepoInfo {
  full_name: string;
  private: boolean;
  default_branch: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface GitHubOptions {
  token: string;
  owner: string;
  repo: string;
  fetch?: typeof fetch;
  apiBase?: string;
  dataDir?: string;
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHubClient implements Remote {
  private readonly token: string;
  readonly owner: string;
  readonly repo: string;
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly dir: string;
  private branch: string | null = null;

  constructor(opts: GitHubOptions) {
    this.token = opts.token;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.base = opts.apiBase ?? 'https://api.github.com';
    this.dir = opts.dataDir ?? 'papers/';
  }

  private async req(method: string, path: string, body?: unknown, retries = 2): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res: Response;
      try {
        res = await this.f(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          // GitHub 对已认证 GET 返回 max-age=60 的私有缓存，必须强制校验，否则看不到别的设备刚写入的内容
          cache: 'no-cache',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw new GitHubError(tr('无法连接 GitHub（网络错误）'), 'network');
      }
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return res;
    }
    throw new GitHubError(tr('请求失败: {err}', { err: String(lastErr) }), 'network');
  }

  private async fail(res: Response, context: string): Promise<never> {
    let detail = '';
    try {
      const j = (await res.clone().json()) as { message?: string };
      detail = j.message ?? '';
    } catch {
      /* 非 JSON 响应 */
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const msg = `${context}: ${res.status}${detail ? ` ${detail}` : ''}`;

    if (res.status === 401) throw new GitHubError(tr('GitHub 令牌无效或已过期，请重新登录'), 'auth', 401);
    if (res.status === 429 || (res.status === 403 && (remaining === '0' || retryAfter > 0 || /rate limit/i.test(detail)))) {
      const wait = retryAfter > 0 ? retryAfter * 1000 : reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 60_000;
      throw new GitHubError(tr('触发 GitHub 速率限制，稍后自动重试'), 'rate_limit', res.status, wait);
    }
    if (res.status === 403) throw new GitHubError(tr('{msg}（令牌权限不足：需要该仓库的 Contents 读写权限）', { msg }), 'forbidden', 403);
    if (res.status === 404) throw new GitHubError(tr('{msg}（仓库或文件不存在，或令牌无权访问该仓库）', { msg }), 'not_found', 404);
    if (res.status === 409 || (res.status === 422 && /sha|does not match|is at/i.test(detail))) {
      throw new GitHubError(msg, 'conflict', res.status);
    }
    throw new GitHubError(msg, 'other', res.status);
  }

  async getUser(): Promise<{ login: string; id: number }> {
    const res = await this.req('GET', '/user');
    if (!res.ok) await this.fail(res, tr('读取用户信息失败'));
    return (await res.json()) as { login: string; id: number };
  }

  async getRepo(): Promise<RepoInfo> {
    const res = await this.req('GET', `/repos/${enc(this.owner)}/${enc(this.repo)}`);
    if (!res.ok) await this.fail(res, tr('读取仓库失败'));
    const info = (await res.json()) as RepoInfo;
    this.branch = info.default_branch;
    return info;
  }

  /** 令牌可访问、且有写权限的仓库（fine-grained 令牌通常只有一个）。 */
  async listWritableRepos(): Promise<RepoInfo[]> {
    const res = await this.req('GET', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    if (!res.ok) await this.fail(res, tr('列出仓库失败'));
    const repos = (await res.json()) as RepoInfo[];
    return repos.filter((r) => r.permissions?.push);
  }

  async listFiles(): Promise<Map<string, string>> {
    if (!this.branch) await this.getRepo();
    const res = await this.req('GET', `/repos/${enc(this.owner)}/${enc(this.repo)}/git/trees/${enc(this.branch!)}?recursive=1`);
    // 空仓库（尚无任何提交）：409 / 404
    if (res.status === 409 || res.status === 404) return new Map();
    if (!res.ok) await this.fail(res, tr('列出笔记文件失败'));
    const data = (await res.json()) as { tree: { path: string; type: string; sha: string }[]; truncated?: boolean };
    if (data.truncated) return this.listDirContents();
    const out = new Map<string, string>();
    for (const e of data.tree) {
      if (e.type === 'blob' && e.path.startsWith(this.dir) && e.path.endsWith('.json')) out.set(e.path, e.sha);
    }
    return out;
  }

  /** 仓库过大导致 tree 被截断时的兜底：直接列 papers/ 目录（上限 1000 个文件）。 */
  private async listDirContents(): Promise<Map<string, string>> {
    const res = await this.req('GET', `/repos/${enc(this.owner)}/${enc(this.repo)}/contents/${this.dir.replace(/\/$/, '')}`);
    if (res.status === 404) return new Map();
    if (!res.ok) await this.fail(res, tr('列出笔记目录失败'));
    const items = (await res.json()) as { path: string; type: string; sha: string }[];
    return new Map(items.filter((i) => i.type === 'file' && i.path.endsWith('.json')).map((i) => [i.path, i.sha]));
  }

  async getFile(path: string): Promise<{ content: string; sha: string } | null> {
    const res = await this.req('GET', `/repos/${enc(this.owner)}/${enc(this.repo)}/contents/${encPath(path)}`);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, tr('读取 {path} 失败', { path }));
    const j = (await res.json()) as { sha: string; content?: string; encoding?: string; type?: string };
    if (j.type && j.type !== 'file') throw new GitHubError(tr('{path} 不是文件', { path }), 'other');
    if (j.content && j.encoding === 'base64') return { content: base64ToUtf8(j.content), sha: j.sha };
    // 超过 1MB 时 contents 接口不返回正文，改走 blobs 接口
    const blob = await this.req('GET', `/repos/${enc(this.owner)}/${enc(this.repo)}/git/blobs/${j.sha}`);
    if (!blob.ok) await this.fail(blob, tr('读取 {path} 内容失败', { path }));
    const b = (await blob.json()) as { content: string };
    return { content: base64ToUtf8(b.content), sha: j.sha };
  }

  async putFile(path: string, content: string, message: string, sha?: string): Promise<{ sha: string }> {
    const res = await this.req(
      'PUT',
      `/repos/${enc(this.owner)}/${enc(this.repo)}/contents/${encPath(path)}`,
      { message, content: utf8ToBase64(content), ...(sha ? { sha } : {}) },
    );
    if (!res.ok) await this.fail(res, tr('写入 {path} 失败', { path }));
    const j = (await res.json()) as { content: { sha: string } };
    return { sha: j.content.sha };
  }

  async deleteFile(path: string, sha: string, message: string): Promise<void> {
    const res = await this.req('DELETE', `/repos/${enc(this.owner)}/${enc(this.repo)}/contents/${encPath(path)}`, { message, sha });
    if (res.status === 404) return;
    if (!res.ok) await this.fail(res, tr('删除 {path} 失败', { path }));
  }
}

const enc = encodeURIComponent;
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
