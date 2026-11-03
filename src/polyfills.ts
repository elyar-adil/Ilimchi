/**
 * Runtime compatibility needed by PDF.js on older Safari releases.
 * Keep this function self-contained: src/pdf/engine.ts serializes it into
 * the PDF worker so the main thread and worker receive the same polyfills.
 */
export function installStreamIter(): void {
  // PDF.js uses Map/WeakMap.prototype.getOrInsertComputed.
  const collections = [Map, WeakMap] as unknown as Array<{
    prototype: {
      getOrInsertComputed?: (key: unknown, compute: (key: unknown) => unknown) => unknown;
    };
  }>;
  for (const Collection of collections) {
    if (typeof Collection.prototype.getOrInsertComputed !== 'function') {
      Object.defineProperty(Collection.prototype, 'getOrInsertComputed', {
        configurable: true,
        writable: true,
        value: function getOrInsertComputed(this: Map<unknown, unknown>, key: unknown, compute: (key: unknown) => unknown) {
          if (!this.has(key)) this.set(key, compute(key));
          return this.get(key);
        },
      });
    }
  }

  // These Promise helpers are used by PDF.js internals and are absent in
  // Safari 17.2 and earlier.
  const PromiseWithResolvers = Promise as PromiseConstructor & {
    withResolvers?: <T>() => {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  };
  if (typeof PromiseWithResolvers.withResolvers !== 'function') {
    Object.defineProperty(PromiseWithResolvers, 'withResolvers', {
      configurable: true,
      writable: true,
      value: function withResolvers<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      },
    });
  }

  const PromiseWithTry = Promise as PromiseConstructor & {
    try?: <T>(callback: (...args: unknown[]) => T | PromiseLike<T>, ...args: unknown[]) => Promise<Awaited<T>>;
  };
  if (typeof PromiseWithTry.try !== 'function') {
    Object.defineProperty(PromiseWithTry, 'try', {
      configurable: true,
      writable: true,
      value: function promiseTry<T>(callback: (...args: unknown[]) => T | PromiseLike<T>, ...args: unknown[]) {
        return new Promise<Awaited<T>>((resolve, reject) => {
          try {
            resolve(callback(...args) as Awaited<T> | PromiseLike<Awaited<T>>);
          } catch (error) {
            reject(error);
          }
        });
      },
    });
  }

  // Safari's ReadableStream async iterator is used by PDF.js text extraction.
  const RS = (globalThis as typeof globalThis & {
    ReadableStream?: { prototype: Record<PropertyKey, unknown> };
  }).ReadableStream;
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
