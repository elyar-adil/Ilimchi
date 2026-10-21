import { tr } from './i18n';
import { GitHubClient, GitHubError, type RepoInfo } from './github';
import type { Idb } from './idb';
import { Vault, type VaultMode } from './vault';
import { clearAiConfig } from './ai';

/**
 * 授权：纯前端、无后端。
 *
 * 为什么用 fine-grained 个人访问令牌（PAT）而不是 OAuth：
 * GitHub 的 OAuth 令牌交换端点（/login/oauth/access_token、/login/device/code）不支持浏览器跨域（无 CORS 头），
 * 并且网页授权流程需要保密的 client_secret，只能放在后端。而题目要求不依赖自建服务器 / Cloudflare 后端，
 * 所以由用户在自己的 GitHub 账号里创建一个「只限单个仓库、只有 Contents 读写」的令牌，粘贴到应用中。
 * 令牌只在你的浏览器里加密保存（见 vault.ts），只发往 api.github.com，不进入源码或仓库。
 */

export type RememberMode = 'session' | VaultMode;

export interface Config {
  login: string;
  owner: string;
  repo: string;
  remember: RememberMode;
}

const CONFIG_KEY = 'paper-reader.config';
export const DEFAULT_REPO = 'paper-notes-data';

export function loadConfig(): Config | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<Config>;
    if (typeof c.owner === 'string' && typeof c.repo === 'string' && typeof c.login === 'string') {
      return { login: c.login, owner: c.owner, repo: c.repo, remember: (c.remember as RememberMode) ?? 'session' };
    }
  } catch {
    /* 忽略损坏的配置 */
  }
  return null;
}

export function saveConfig(c: Config): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  } catch {
    /* 隐私模式下可能不可写 */
  }
}

export function clearConfig(): void {
  try {
    localStorage.removeItem(CONFIG_KEY);
  } catch {
    /* ignore */
  }
}

export class ChooseRepoError extends Error {
  constructor(public repos: RepoInfo[]) {
    super(tr('请选择用于存放笔记的仓库'));
    this.name = 'ChooseRepoError';
  }
}

export class PublicRepoError extends Error {
  constructor(public fullName: string) {
    super(tr('仓库 {fullName} 是公开的，你的全部笔记将对所有人可见。建议改用私有仓库。', { fullName }));
    this.name = 'PublicRepoError';
  }
}

export interface ConnectInput {
  token: string;
  /** "owner/repo"；留空则自动发现 */
  repo?: string;
  remember: RememberMode;
  passphrase?: string;
  allowPublic?: boolean;
}

export interface Session {
  client: GitHubClient;
  config: Config;
  warnings: string[];
}

export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const m = /^\s*(?:https?:\/\/github\.com\/)?([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+?)(?:\.git)?\/?\s*$/.exec(input);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function connect(input: ConnectInput, vault: Vault, fetchImpl?: typeof fetch): Promise<Session> {
  const token = input.token.trim();
  if (!token) throw new Error(tr('请粘贴 GitHub 令牌'));
  if (/\s/.test(token)) throw new Error(tr('令牌中不应包含空白字符'));

  const warnings: string[] = [];
  if (/^(ghp_|gho_)/.test(token)) {
    warnings.push(tr('你使用的是经典令牌，权限范围很大（可访问你所有仓库）。强烈建议改用只限单个仓库的 fine-grained 令牌。'));
  }

  // 先用占位仓库验证令牌并取得登录名
  const probe = new GitHubClient({ token, owner: '_', repo: '_', fetch: fetchImpl });
  const user = await probe.getUser();

  let owner: string;
  let repo: string;
  const explicit = input.repo ? parseRepoInput(input.repo) : null;
  if (input.repo?.trim() && !explicit) throw new Error(tr('仓库格式应为 owner/name'));
  if (explicit) {
    ({ owner, repo } = explicit);
  } else {
    const repos = await probe.listWritableRepos();
    const preferred = repos.find((r) => r.full_name.toLowerCase() === `${user.login}/${DEFAULT_REPO}`.toLowerCase());
    const pick = preferred ?? (repos.length === 1 ? repos[0] : null);
    if (!pick) {
      if (repos.length === 0) {
        throw new Error(tr('该令牌没有任何可写入的仓库。请先创建私有仓库（建议命名 {repo}），并在令牌的 Repository access 中选中它。', { repo: DEFAULT_REPO }));
      }
      throw new ChooseRepoError(repos);
    }
    [owner, repo] = pick.full_name.split('/');
  }

  const client = new GitHubClient({ token, owner, repo, fetch: fetchImpl });
  let info: RepoInfo;
  try {
    info = await client.getRepo();
  } catch (e) {
    if (e instanceof GitHubError && e.code === 'not_found') {
      throw new Error(tr('找不到仓库 {owner}/{repo}，或令牌无权访问它。请检查令牌的 Repository access。', { owner, repo }));
    }
    throw e;
  }
  if (info.permissions && !info.permissions.push) {
    throw new Error(tr('令牌对 {name} 没有写权限。请在令牌权限里给 Contents 选择 Read and write。', { name: info.full_name }));
  }
  if (!info.private && !input.allowPublic) throw new PublicRepoError(info.full_name);

  const config: Config = { login: user.login, owner, repo, remember: input.remember };
  await vault.clear();
  if (input.remember !== 'session') await vault.save({ token }, input.remember, input.passphrase);
  saveConfig(config);
  return { client, config, warnings };
}

export type RestoreResult = { kind: 'none'; config: Config | null } | { kind: 'locked'; config: Config } | { kind: 'ready'; session: Session };

export async function restore(vault: Vault, fetchImpl?: typeof fetch): Promise<RestoreResult> {
  const config = loadConfig();
  const mode = await vault.mode();
  if (!config || !mode) return { kind: 'none', config };
  if (mode === 'passphrase') return { kind: 'locked', config };
  const secret = await vault.load().catch(() => null);
  if (!secret) return { kind: 'none', config };
  return { kind: 'ready', session: makeSession(secret.token, config, fetchImpl) };
}

export async function unlock(vault: Vault, passphrase: string, fetchImpl?: typeof fetch): Promise<Session> {
  const config = loadConfig();
  if (!config) throw new Error(tr('缺少账号配置，请重新登录'));
  const secret = await vault.load(passphrase);
  if (!secret) throw new Error(tr('没有已保存的令牌，请重新登录'));
  return makeSession(secret.token, config, fetchImpl);
}

function makeSession(token: string, config: Config, fetchImpl?: typeof fetch): Session {
  return { client: new GitHubClient({ token, owner: config.owner, repo: config.repo, fetch: fetchImpl }), config, warnings: [] };
}

export async function signOut(vault: Vault, idb: Idb, clearLocalData: boolean): Promise<void> {
  await vault.clear();
  clearConfig();
  if (clearLocalData) {
    await clearAiConfig().catch(() => {});
    await Promise.all((['papers', 'sync', 'pdfs', 'pdfmeta'] as const).map((s) => idb.clear(s)));
  }
}
