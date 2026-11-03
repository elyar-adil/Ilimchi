/**
 * pdf.js 6 uses newer Map/WeakMap upsert APIs and Iterator.prototype.join.
 * Safari versions without the global Iterator constructor fail while importing
 * pdf.js, before any document is opened. Install the small compatibility layer
 * before pdf.js is evaluated. This function is also serialized into its worker.
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
 * pdf.js 6 uses `for await (… of readableStream)` to read text content.
 * Older Safari lacks ReadableStream async iteration, so add values() and
 * Symbol.asyncIterator. The PDF.js worker receives this same self-contained
 * function through src/pdf/engine.ts.
 */
export function installStreamIter(): void {
  const scope = globalThis as typeof globalThis & {
    Iterator?: { prototype: Record<PropertyKey, unknown> };
    ReadableStream?: { prototype: Record<PropertyKey, unknown> };
  };

  // Iterator objects already share this intrinsic prototype in older engines;
  // only the global constructor and the join helper are missing.
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
