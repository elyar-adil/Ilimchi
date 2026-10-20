// 论文标题与引文使用的印刷衬线体（仅拉丁字符；中文回退到系统宋体）。
// 以 FontFace 注册，构建时内联为 data URI，单文件版本无需联网加载字体。
import serif400 from '@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2?url';
import serif600 from '@fontsource/source-serif-4/files/source-serif-4-latin-600-normal.woff2?url';

const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

export function loadFonts(): void {
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  for (const [src, weight] of [[serif400, '400'], [serif600, '600']] as const) {
    const face = new FontFace('Source Serif 4', `url(${src}) format('woff2')`, { weight, style: 'normal', display: 'swap', unicodeRange: LATIN });
    face.load().then((f) => document.fonts.add(f)).catch(() => { /* 回退到系统衬线 */ });
  }
}
