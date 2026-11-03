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

  it('installs Uint8Array.prototype.toHex when it is missing', () => {
    const prototype = Uint8Array.prototype as unknown as {
      toHex?: (this: Uint8Array) => string;
    };
    const original = Object.getOwnPropertyDescriptor(prototype, 'toHex');

    try {
      Reflect.deleteProperty(prototype, 'toHex');
      installStreamIter();

      const toHex = new Uint8Array([0, 15, 16, 127, 128, 255]) as Uint8Array & {
        toHex(): string;
      };
      expect(toHex.toHex()).toBe('000f107f80ff');
      const sliced = new Uint8Array([0xaa, 0xbb]).subarray(1) as Uint8Array & {
        toHex(): string;
      };
      expect(sliced.toHex()).toBe('bb');
    } finally {
      if (original) Object.defineProperty(prototype, 'toHex', original);
      else Reflect.deleteProperty(prototype, 'toHex');
    }
  });

  it('installs Iterator and join when the browser has no global Iterator', () => {
    const originalIterator = Object.getOwnPropertyDescriptor(globalThis, 'Iterator');
    const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    const originalJoin = Object.getOwnPropertyDescriptor(iteratorPrototype, 'join');

    try {
      Reflect.deleteProperty(globalThis, 'Iterator');
      if (originalJoin) Reflect.deleteProperty(iteratorPrototype, 'join');

      installStreamIter();

      const shim = (globalThis as typeof globalThis & {
        Iterator?: { prototype: object };
      }).Iterator;
      expect(shim).toBeDefined();
      expect(shim?.prototype).toBe(iteratorPrototype);

      const iterator = new Set(['one', 'two']).values() as unknown as {
        join(separator?: string): string;
      };
      expect(iterator.join('/')).toBe('one/two');
    } finally {
      if (originalJoin) Object.defineProperty(iteratorPrototype, 'join', originalJoin);
      else Reflect.deleteProperty(iteratorPrototype, 'join');

      if (originalIterator) Object.defineProperty(globalThis, 'Iterator', originalIterator);
      else Reflect.deleteProperty(globalThis, 'Iterator');
    }
  });
});
