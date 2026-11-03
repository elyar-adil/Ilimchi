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


/**
 * pdf.js 6 用 `for await (… of readableStream)` 读取文本内容（page.getTextContent），
 * Safari（包括 iOS）尚未实现 ReadableStream 的异步迭代，会报
 * "undefined is not a function"。这里按规范补上 values() 与 Symbol.asyncIterator。
 * 同样的代码也会注入 PDF 解析线程（见 pdf/engine.ts）。
 */
export function installStreamIter(): void {
  const RS = (globalThis as unknown as { ReadableStream?: { prototype: Record<PropertyKey, unknown> } }).ReadableStream;
  if (!RS || typeof RS.prototype[Symbol.asyncIterator] === 'function') return;
  const values = function (this: ReadableStream, options?: { preventCancel?: boolean }) {
    const reader = this.getReader();
    const preventCancel = !!(options && options.preventCancel);
    return {
      next() {
        return reader.read();
      },
      async return(value?: unknown) {
        if (!preventCancel) {
          try {
            await reader.cancel(value);
          } catch {
            /* ignore */
          }
        }
        reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  Object.defineProperty(RS.prototype, 'values', { configurable: true, writable: true, value: values });
  Object.defineProperty(RS.prototype, Symbol.asyncIterator, { configurable: true, writable: true, value: values });
}
installStreamIter();
