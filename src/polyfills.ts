/**
 * Compatibility helpers required by pdf.js 6 on Safari.
 * This function is intentionally self-contained because it is serialized into
 * the PDF worker (see src/pdf/engine.ts) as well as run in the main thread.
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
 * pdf.js 6 calls Promise.withResolvers(), Promise.try(), and
 * Iterator.prototype.join(), and uses async iteration over ReadableStream.
 * Older Safari versions may lack these APIs. Install them before pdf.js runs.
 */
export function installStreamIter(): void {
  const scope = globalThis as typeof globalThis & {
    Iterator?: { prototype: Record<PropertyKey, unknown> };
    ReadableStream?: { prototype: Record<PropertyKey, unknown> };
  };

  // Promise.withResolvers is used by the PDF.js display and worker code.
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

  // Older Safari has iterator objects but no global Iterator constructor.
  // Their built-in iterator prototypes inherit from Object.prototype, so use
  // that shared ancestor as the compatibility prototype.
  if (!scope.Iterator) {
    const iteratorPrototype = Object.getPrototypeOf(
      Object.getPrototypeOf([][Symbol.iterator]()),
    ) as Record<PropertyKey, unknown>;
    const IteratorShim = function IteratorShim(this: object): void {
      if (new.target === IteratorShim) {
        throw new TypeError('Iterator is an abstract base class');
      }
    };
    IteratorShim.prototype = iteratorPrototype;
    Object.defineProperty(globalThis, 'Iterator', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: IteratorShim,
    });
    scope.Iterator = IteratorShim;
  }

  const iteratorPrototype = scope.Iterator.prototype;
  if (typeof iteratorPrototype.join !== 'function') {
    Object.defineProperty(iteratorPrototype, 'join', {
      configurable: true,
      writable: true,
      value: function join(this: Iterable<unknown>, separator?: string): string {
        return Array.from(this).join(separator);
      },
    });
  }

  // Safari versions without ReadableStream async iteration cannot execute
  // pdf.js page.getTextContent(), which consumes streams with for-await-of.
  // Uint8Array.prototype.toHex is used by PDF.js to calculate document
  // fingerprints. It is missing in older Safari releases.
  const uint8ArrayPrototype = Uint8Array.prototype as Uint8Array['__proto__'] & {
    toHex?: () => string;
  };
  if (typeof uint8ArrayPrototype.toHex !== 'function') {
    Object.defineProperty(uint8ArrayPrototype, 'toHex', {
      configurable: true,
      writable: true,
      value: function toHex(this: Uint8Array): string {
        if (!(this instanceof Uint8Array)) {
          throw new TypeError('Uint8Array.prototype.toHex called on incompatible receiver');
        }
        const digits = '0123456789abcdef';
        let result = '';
        for (let i = 0; i < this.length; i++) {
          const byte = this[i];
          result += digits[(byte >>> 4) & 0x0f] + digits[byte & 0x0f];
        }
        return result;
      },
    });
  }

  const RS = scope.ReadableStream;
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
