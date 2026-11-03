import { describe, expect, it } from 'vitest';
import { installStreamIter } from '../src/polyfills';

describe('Safari PDF.js polyfills', () => {
  it('installs Map and WeakMap getOrInsertComputed when missing', () => {
    const mapOriginal = Object.getOwnPropertyDescriptor(Map.prototype, 'getOrInsertComputed');
    const weakMapOriginal = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'getOrInsertComputed');

    try {
      Reflect.deleteProperty(Map.prototype, 'getOrInsertComputed');
      Reflect.deleteProperty(WeakMap.prototype, 'getOrInsertComputed');
      installStreamIter();

      const map = new Map<string, number>() as Map<string, number> & {
        getOrInsertComputed(key: string, compute: (key: string) => number): number;
      };
      expect(map.getOrInsertComputed('a', () => 1)).toBe(1);
      expect(map.getOrInsertComputed('a', () => 2)).toBe(1);

      const key = {};
      const weakMap = new WeakMap<object, number>() as WeakMap<object, number> & {
        getOrInsertComputed(key: object, compute: (key: object) => number): number;
      };
      expect(weakMap.getOrInsertComputed(key, () => 3)).toBe(3);
      expect(weakMap.getOrInsertComputed(key, () => 4)).toBe(3);
    } finally {
      if (mapOriginal) Object.defineProperty(Map.prototype, 'getOrInsertComputed', mapOriginal);
      else Reflect.deleteProperty(Map.prototype, 'getOrInsertComputed');
      if (weakMapOriginal) Object.defineProperty(WeakMap.prototype, 'getOrInsertComputed', weakMapOriginal);
      else Reflect.deleteProperty(WeakMap.prototype, 'getOrInsertComputed');
    }
  });

  it('installs Promise.withResolvers when it is missing', async () => {
    const original = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');

    try {
      Reflect.deleteProperty(Promise, 'withResolvers');
      installStreamIter();

      const promiseWithResolvers = (Promise as unknown as {
        withResolvers?: <T>() => {
          promise: Promise<T>;
          resolve: (value: T | PromiseLike<T>) => void;
          reject: (reason?: unknown) => void;
        };
      }).withResolvers;

      expect(typeof promiseWithResolvers).toBe('function');
      const capability = promiseWithResolvers!<number>();
      capability.resolve(42);
      await expect(capability.promise).resolves.toBe(42);
    } finally {
      if (original) Object.defineProperty(Promise, 'withResolvers', original);
      else Reflect.deleteProperty(Promise, 'withResolvers');
    }
  });

  it('installs Promise.try when it is missing and forwards errors', async () => {
    const original = Object.getOwnPropertyDescriptor(Promise, 'try');

    try {
      Reflect.deleteProperty(Promise, 'try');
      installStreamIter();

      const promiseTry = (Promise as unknown as {
        try?: <T>(callback: () => T | PromiseLike<T>) => Promise<Awaited<T>>;
      }).try;

      expect(typeof promiseTry).toBe('function');
      await expect(promiseTry!(() => 42)).resolves.toBe(42);
      await expect(promiseTry!(() => { throw new Error('expected'); })).rejects.toThrow('expected');
    } finally {
      if (original) Object.defineProperty(Promise, 'try', original);
      else Reflect.deleteProperty(Promise, 'try');
    }
  });

  it('installs async iteration on ReadableStream when missing', async () => {
    const prototype = ReadableStream.prototype as ReadableStream['__proto__'] & {
      values?: (options?: { preventCancel?: boolean }) => AsyncIterator<unknown>;
    };
    const originalAsync = Object.getOwnPropertyDescriptor(prototype, Symbol.asyncIterator);
    const originalValues = Object.getOwnPropertyDescriptor(prototype, 'values');

    try {
      Reflect.deleteProperty(prototype, Symbol.asyncIterator);
      Reflect.deleteProperty(prototype, 'values');
      installStreamIter();

      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(7);
          controller.close();
        },
      });
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 7 });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      await iterator.return?.();
    } finally {
      if (originalAsync) Object.defineProperty(prototype, Symbol.asyncIterator, originalAsync);
      else Reflect.deleteProperty(prototype, Symbol.asyncIterator);
      if (originalValues) Object.defineProperty(prototype, 'values', originalValues);
      else Reflect.deleteProperty(prototype, 'values');
    }
  });
});
