import 'fake-indexeddb/auto';
import { GitHubError, type Remote } from '../src/core/github';
import { createIdb } from '../src/core/idb';

let n = 0;
/** 每个测试使用独立的 IndexedDB，避免串数据。 */
export const freshIdb = () => createIdb(`test-db-${++n}-${Math.random().toString(36).slice(2)}`);

/** 内存版 GitHub Contents API：与真实行为一致的乐观锁（sha 不匹配即冲突）。 */
export class FakeRemote implements Remote {
  files = new Map<string, { content: string; sha: string }>();
  puts = 0;
  /** 注入：下一次写入前，先由"另一台设备"修改远端 */
  beforePut?: (path: string) => void;

  private sha(content: string) {
    let h = 0;
    for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0;
    return `${(h >>> 0).toString(16).padStart(8, '0')}${content.length.toString(16)}`;
  }

  async listFiles() {
    return new Map([...this.files].map(([p, f]) => [p, f.sha]));
  }
  async getFile(path: string) {
    const f = this.files.get(path);
    return f ? { ...f } : null;
  }
  async putFile(path: string, content: string, _msg: string, sha?: string) {
    this.beforePut?.(path);
    this.beforePut = undefined;
    const cur = this.files.get(path);
    if (cur && cur.sha !== sha) throw new GitHubError(`${path}: 409 is at ${cur.sha}`, 'conflict', 409);
    if (!cur && sha) throw new GitHubError(`${path}: 409`, 'conflict', 409);
    const next = { content, sha: this.sha(content) };
    this.files.set(path, next);
    this.puts++;
    return { sha: next.sha };
  }
  /** 模拟另一台设备直接写入远端 */
  external(path: string, content: string) {
    this.files.set(path, { content, sha: this.sha(content) });
  }
}
