import { describe, expect, it } from 'vitest';
import { APP_ICONS, themeColors } from '../src/core/prefs';

// 不依赖 @types/node：动态引入内置模块
const nodeFs = async () => (await import('node:' + 'fs')) as { readFileSync: (path: string, enc?: string) => string };

describe('图标即主题', () => {
  it('每个主题都有图标文件与安装清单，且清单颜色与浅色纸面一致', async () => {
    const { readFileSync } = await nodeFs();
    for (const t of APP_ICONS) {
      const manifest = JSON.parse(readFileSync(`public/manifest-${t.id}.webmanifest`, 'utf8'));
      expect(manifest.theme_color).toBe(themeColors(t, false).paper);
      expect(manifest.background_color).toBe(themeColors(t, false).paper);
      for (const icon of manifest.icons) expect(() => readFileSync(`public/${icon.src.replace('./', '')}`)).not.toThrow();
      for (const size of [96, 180]) expect(() => readFileSync(`public/icons/animal-${t.id}-${size}.png`)).not.toThrow();
    }
  });

  it('强调色与纸面都是合法的 6 位十六进制色', () => {
    for (const t of APP_ICONS) for (const dark of [false, true]) {
      for (const v of Object.values(themeColors(t, dark))) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
