import type { HighlightColor, InkColor } from './types';

/**
 * 主题 = 应用图标：每个图标对应一套配色，只由一个色相（h）与饱和度（s）派生——
 * 强调色、纸面、侧栏与桌面底色全部由此计算，浅色/深色各自取值。
 */
export type AppIconId = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12';
export interface AppTheme { id: AppIconId; name: string; h: number; s: number }
export const APP_ICONS: AppTheme[] = [
  { id: '01', name: '暖杏', h: 31, s: 0.6 },
  { id: '02', name: '夜蓝', h: 220, s: 0.45 },
  { id: '03', name: '青苔', h: 78, s: 0.3 },
  { id: '04', name: '薰衣草', h: 253, s: 0.35 },
  { id: '05', name: '晴空', h: 210, s: 0.55 },
  { id: '06', name: '暮紫', h: 257, s: 0.25 },
  { id: '07', name: '暖橘', h: 30, s: 0.7 },
  { id: '08', name: '湖青', h: 180, s: 0.35 },
  { id: '09', name: '樱粉', h: 350, s: 0.55 },
  { id: '10', name: '夜空', h: 230, s: 0.35 },
  { id: '11', name: '雾灰', h: 235, s: 0.15 },
  { id: '12', name: '琥珀', h: 35, s: 0.7 },
];

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 某个主题在浅色/深色下的配色。 */
export function themeColors(theme: AppTheme, dark: boolean) {
  const tint = Math.min(0.6, Math.max(0.15, theme.s));
  if (dark) {
    const t = tint * 0.28;
    return {
      accent: hsl(theme.h, Math.min(0.6, theme.s + 0.12), 0.72),
      paper: hsl(theme.h, t, 0.125), index: hsl(theme.h, t, 0.105), desk: hsl(theme.h, t, 0.085),
    };
  }
  return {
    accent: hsl(theme.h, Math.min(0.6, theme.s + 0.12), 0.38),
    paper: hsl(theme.h, tint, 0.975), index: hsl(theme.h, tint, 0.948), desk: hsl(theme.h, tint * 0.8, 0.905),
  };
}

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
  /** 阅读视图：原版 PDF / 重排（手机上更易读） */
  view: 'pdf' | 'reflow';
  /** 重排视图的字号（像素） */
  reflowFont: number;
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
  /** 主题（即应用图标，仅本设备） */
  appIcon: AppIconId;
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
  view: 'pdf',
  reflowFont: 18,
  theme: 'system',
  darkStyle: 'soft',
  pageTint: '#ffffff',
  penColor: 'ink',
  markerColor: 'yellow',
  sort: 'recent',
  syncInterval: 'm5',
  appIcon: '01',
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
  // 主题（图标）决定强调色与各层底色；用内联变量覆盖样式表中的默认值
  const theme = APP_ICONS.find((t) => t.id === p.appIcon) ?? APP_ICONS[0];
  const c = themeColors(theme, dark);
  root.style.setProperty('--pencil', c.accent);
  root.style.setProperty('--pencil-wash', withAlpha(c.accent, dark ? 0.12 : 0.09));
  root.style.setProperty('--pencil-line', withAlpha(c.accent, dark ? 0.45 : 0.4));
  root.style.setProperty('--paper', c.paper);
  root.style.setProperty('--index', c.index);
  root.style.setProperty('--desk', c.desk);
  // 独立窗口 / 浏览器的标题栏与界面同色
  document.querySelector<HTMLMetaElement>('#app-theme-color')?.setAttribute('content', c.paper);
  // 纸面非白时才需要与 PDF 正片叠底（整页混合模式较耗性能，默认白底时跳过）
  root.dataset.tint = p.pageTint.toLowerCase() === '#ffffff' ? 'plain' : 'tinted';
}


/** 更新浏览器标签页图标、Apple Touch Icon 与 PWA 安装清单；已安装的桌面 App 需要重新添加才能刷新图标。 */
export function applyAppIcon(): void {
  if (typeof document === 'undefined') return;
  const stored = getPrefs().appIcon;
  const selected = APP_ICONS.some((icon) => icon.id === stored) ? stored : '01';
  const base = document.baseURI;
  const set = (id: string, href: string) => {
    const link = document.querySelector<HTMLLinkElement>(id);
    if (link) link.href = new URL(href, base).href;
  };
  set('#app-favicon', `./icons/animal-${selected}-96.png`);
  set('#app-touch-icon', `./icons/animal-${selected}-180.png`);
  set('#app-manifest', `./manifest-${selected}.webmanifest`);
}
