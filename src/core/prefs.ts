import type { HighlightColor, InkColor } from './types';

/** 配色：只改变强调色（选中、按钮、高亮提示等），与浅色/深色模式相互独立 */
export type AccentId = 'pencil' | 'sage' | 'ochre' | 'plum' | 'graphite';

export const ACCENTS: { id: AccentId; name: string; light: string; dark: string }[] = [
  { id: 'pencil', name: '铅笔蓝', light: '#2f6f9f', dark: '#86b6da' },
  { id: 'sage', name: '墨绿', light: '#3b6e56', dark: '#8fc4a6' },
  { id: 'ochre', name: '赭石', light: '#9a5b2e', dark: '#dba878' },
  { id: 'plum', name: '梅紫', light: '#6d4c8c', dark: '#bca3dc' },
  { id: 'graphite', name: '石墨', light: '#3f444b', dark: '#c9ced6' },
];

/** 论文推送到 GitHub 的频率：间隔内的多次修改合并为一次提交 */
export type SyncInterval = 'live' | 'm1' | 'm5' | 'm15' | 'h1' | 'manual';

export const SYNC_INTERVALS: { id: SyncInterval; label: string }[] = [
  { id: 'live', label: '实时' },
  { id: 'm1', label: '每 1 分钟' },
  { id: 'm5', label: '每 5 分钟' },
  { id: 'm15', label: '每 15 分钟' },
  { id: 'h1', label: '每小时' },
  { id: 'manual', label: '仅手动' },
];

/** 各频率对应的推送延迟：push 为普通修改，low 为阅读进度等低优先级修改；null 表示不自动推送 */
export function syncDelays(v: SyncInterval): { push: number | null; low: number | null } {
  switch (v) {
    case 'live':
      return { push: 1500, low: 15000 };
    case 'm1':
      return { push: 60_000, low: 60_000 };
    case 'm15':
      return { push: 900_000, low: 900_000 };
    case 'h1':
      return { push: 3_600_000, low: 3_600_000 };
    case 'manual':
      return { push: null, low: null };
    default:
      return { push: 300_000, low: 300_000 };
  }
}

/** 论文库的排序方式 */
export type SortKey = 'recent' | 'added' | 'title';

export type Theme = 'system' | 'light' | 'dark';
/** 夜间模式的两种处理：柔和降亮（保留图片原色）/ 反色（文字更清晰，图片会变色） */
export type DarkStyle = 'soft' | 'invert' | 'ink';

/** 仅保存在本设备的偏好（不含任何凭据）。 */
export interface Prefs {
  /** 可选的 PDF 代理模板，如 https://my-proxy.example/?url={url}。默认为空，即不使用代理 */
  proxy: string;
  color: HighlightColor;
  sidebar: boolean;
  theme: Theme;
  darkStyle: DarkStyle;
  /** 浅色模式下的纸面底色（与 PDF 相乘，文字保持清晰） */
  pageTint: string;
  penColor: InkColor;
  /** 荧光笔颜色 */
  markerColor: InkColor;
  /** 论文库排序（仅本设备） */
  sort: SortKey;
  /** 提交到 GitHub 的频率（仅本设备） */
  syncInterval: SyncInterval;
  /** 配色（仅本设备） */
  accent: AccentId;
}

export const PAGE_TINTS: { name: string; hex: string }[] = [
  { name: '纸白', hex: '#ffffff' },
  { name: '米黄', hex: '#f8f1de' },
  { name: '护眼绿', hex: '#e6f0e1' },
  { name: '浅灰', hex: '#ececea' },
];

const KEY = 'paper-reader.prefs';
const DEFAULTS: Prefs = {
  proxy: '',
  color: 'yellow',
  sidebar: true,
  theme: 'system',
  darkStyle: 'soft',
  pageTint: '#ffffff',
  penColor: 'ink',
  markerColor: 'yellow',
  sort: 'recent',
  syncInterval: 'm5',
  accent: 'pencil',
};

let cache: Prefs | null = null;
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Prefs>) : {}) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setPrefs(patch: Partial<Prefs>): void {
  cache = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  for (const l of [...listeners]) l();
}

export function subscribePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- 外观：把偏好落实到 <html> 的属性与 CSS 变量上 ----------

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

let systemDark: MediaQueryList | null = null;

/** 解析后的主题写入 data-theme（light | dark），CSS 只依赖这一个属性。 */
export function applyTheme(): void {
  if (typeof document === 'undefined') return;
  const p = getPrefs();
  if (!systemDark && typeof matchMedia === 'function') {
    systemDark = matchMedia('(prefers-color-scheme: dark)');
    systemDark.addEventListener?.('change', () => applyTheme());
  }
  const dark = p.theme === 'dark' || (p.theme === 'system' && !!systemDark?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.darkStyle = p.darkStyle;
  root.style.setProperty('--page-tint', p.pageTint);
  // 强调色随浅色/深色取值，用内联变量覆盖样式表中的默认值
  const accent = ACCENTS.find((a) => a.id === p.accent) ?? ACCENTS[0];
  const hex = dark ? accent.dark : accent.light;
  root.style.setProperty('--pencil', hex);
  root.style.setProperty('--pencil-wash', withAlpha(hex, dark ? 0.12 : 0.09));
  root.style.setProperty('--pencil-line', withAlpha(hex, dark ? 0.45 : 0.4));
  // 纸面非白时才需要与 PDF 正片叠底（整页混合模式较耗性能，默认白底时跳过）
  root.dataset.tint = p.pageTint.toLowerCase() === '#ffffff' ? 'plain' : 'tinted';
}
