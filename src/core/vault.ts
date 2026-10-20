import type { Idb } from './idb';

/**
 * 令牌保险库：GitHub 令牌只存在用户浏览器里，且永不明文落盘。
 *
 * - session：不持久化，关闭标签页即失效（最安全）
 * - device：用不可导出（non-extractable）的 AES-GCM 密钥加密后存入 IndexedDB。
 *           密钥本身无法被读出，复制/备份浏览器存储文件得到的只是密文；
 *           但同一浏览器内运行的脚本仍可调用它解密（这是「免输入」的代价）。
 * - passphrase：用口令派生密钥（PBKDF2-SHA256, 60 万次迭代）加密，每次启动需输入口令。
 *
 * 令牌不会写入源码、构建产物或 Git 仓库。
 */

export type VaultMode = 'device' | 'passphrase';

export interface VaultSecret {
  token: string;
}

interface DeviceRecord {
  mode: 'device';
  key: CryptoKey;
  iv: Uint8Array;
  ct: ArrayBuffer;
}

interface PassphraseRecord {
  mode: 'passphrase';
  salt: Uint8Array;
  iterations: number;
  iv: Uint8Array;
  ct: ArrayBuffer;
}

type VaultRecord = DeviceRecord | PassphraseRecord;

const KEY = 'auth';
const AAD = new TextEncoder().encode('paper-reader:vault:v1');
export const PBKDF2_ITERATIONS = 600_000;

const subtle = () => globalThis.crypto.subtle;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(key: CryptoKey, secret: VaultSecret): Promise<{ iv: Uint8Array; ct: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: AAD as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(secret)),
  );
  return { iv, ct };
}

async function decrypt(key: CryptoKey, iv: Uint8Array, ct: ArrayBuffer): Promise<VaultSecret> {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: AAD as BufferSource }, key, ct);
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as VaultSecret;
  if (typeof parsed.token !== 'string') throw new Error('保险库内容损坏');
  return parsed;
}

export class Vault {
  constructor(
    private idb: Idb,
    private iterations = PBKDF2_ITERATIONS,
  ) {}

  async mode(): Promise<VaultMode | null> {
    const rec = await this.idb.get<VaultRecord>('vault', KEY);
    return rec ? rec.mode : null;
  }

  async save(secret: VaultSecret, mode: VaultMode, passphrase?: string): Promise<void> {
    if (mode === 'passphrase') {
      if (!passphrase || passphrase.length < 8) throw new Error('口令至少 8 个字符');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(passphrase, salt, this.iterations);
      const { iv, ct } = await encrypt(key, secret);
      const rec: PassphraseRecord = { mode, salt, iterations: this.iterations, iv, ct };
      await this.idb.put('vault', KEY, rec);
    } else {
      const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const { iv, ct } = await encrypt(key, secret);
      const rec: DeviceRecord = { mode, key, iv, ct };
      await this.idb.put('vault', KEY, rec);
    }
  }

  /** 读取令牌。口令模式必须提供口令；口令错误会抛出「口令错误」。 */
  async load(passphrase?: string): Promise<VaultSecret | null> {
    const rec = await this.idb.get<VaultRecord>('vault', KEY);
    if (!rec) return null;
    try {
      if (rec.mode === 'device') return await decrypt(rec.key, rec.iv, rec.ct);
      if (!passphrase) throw new Error('需要口令');
      const key = await deriveKey(passphrase, rec.salt, rec.iterations);
      return await decrypt(key, rec.iv, rec.ct);
    } catch (e) {
      if (e instanceof Error && e.message === '需要口令') throw e;
      throw new Error(rec.mode === 'passphrase' ? '口令错误' : '无法解密已保存的令牌，请重新登录');
    }
  }

  async clear(): Promise<void> {
    await this.idb.del('vault', KEY);
  }
}
