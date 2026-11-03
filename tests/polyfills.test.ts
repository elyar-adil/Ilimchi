import { describe, expect, it } from 'vitest';

describe('Safari PDF.js polyfills', () => {
  it('installs Iterator and join when the browser has no global Iterator', async () => {
    const originalIterator = Object.getOwnPropertyDescriptor(globalThis, 'Iterator');
    const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    const originalJoin = Object.getOwnPropertyDescriptor(iteratorPrototype, 'join');

    try {
      Reflect.deleteProperty(globalThis, 'Iterator');
      if (originalJoin) Reflect.deleteProperty(iteratorPrototype, 'join');

      const { installStreamIter } = await import('../src/polyfills');
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
