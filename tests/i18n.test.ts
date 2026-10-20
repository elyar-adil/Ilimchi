import { describe, expect, it, vi } from 'vitest';

function setSystemLanguages(langs: string[]) {
  Object.defineProperty(globalThis.navigator, 'languages', { value: langs, configurable: true });
  Object.defineProperty(globalThis.navigator, 'language', { value: langs[0], configurable: true });
}

describe('界面语言', () => {
  it('系统为英文时使用英文，并替换占位符', async () => {
    setSystemLanguages(['en-US', 'en']);
    vi.resetModules();
    const m = await import('../src/core/i18n');
    expect(m.LANG).toBe('en');
    expect(m.tr('取消')).toBe('Cancel');
    expect(m.tr('已选 {n} 篇', { n: 3 })).toBe('3 selected');
  });

  it('系统为中文时保持中文', async () => {
    setSystemLanguages(['zh-CN', 'zh']);
    vi.resetModules();
    const m = await import('../src/core/i18n');
    expect(m.LANG).toBe('zh');
    expect(m.tr('取消')).toBe('取消');
    expect(m.tr('已选 {n} 篇', { n: 3 })).toBe('已选 3 篇');
  });

  it('缺少译文时回退到中文，未提供的占位符保持原样', async () => {
    setSystemLanguages(['en-US']);
    vi.resetModules();
    const m = await import('../src/core/i18n');
    expect(m.tr('这是一个不存在的键')).toBe('这是一个不存在的键');
    expect(m.tr('代理模板应包含 {url}')).toBe('The proxy template must contain {url}');
  });
});
