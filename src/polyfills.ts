/**
 * pdf.js 6 使用了较新的 upsert 提案（Map/WeakMap.prototype.getOrInsertComputed），
 * 部分浏览器尚未实现。这里补一个等价的垫片，必须在 pdf.js 渲染前执行。
 */
type Upsertable = { prototype: { getOrInsertComputed?: unknown } };
for (const C of [Map, WeakMap] as unknown as Upsertable[]) {
  if (typeof C.prototype.getOrInsertComputed !== 'function') {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value: function getOrInsertComputed(this: Map<unknown, unknown>, key: unknown, compute: (k: unknown) => unknown) {
        if (!this.has(key)) this.set(key, compute(key));
        return this.get(key);
      },
    });
  }
}
export {};
