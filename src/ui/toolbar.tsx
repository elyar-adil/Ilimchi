import type { ComponentChildren } from 'preact';
import { Icon, type IconName } from './icons';
import { INK_HEX, type InkColor } from '../core/types';

export type Tool = 'select' | 'text' | 'pen' | 'marker' | 'eraser';

const TOOLS: { id: Tool; icon: IconName; label: string }[] = [
  { id: 'select', icon: 'select', label: '选择' },
  { id: 'text', icon: 'text', label: '文字' },
  { id: 'pen', icon: 'pen', label: '画笔' },
  { id: 'marker', icon: 'marker', label: '荧光笔' },
  { id: 'eraser', icon: 'eraser', label: '橡皮' },
];

interface TopProps {
  title: string;
  page: number;
  pages: number;
  zoomLabel: string;
  onBack: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  sidebarOpen: boolean;
  onToggleSide: () => void;
  onOpenSettings: () => void;
  sync: ComponentChildren;
}

/** 顶部一行：返回、标题、缩放、侧栏、设置。 */
export function TopBar(p: TopProps) {
  return (
    <header class="topbar">
      <button class="icon-btn" onClick={p.onBack} title="返回论文库" aria-label="返回论文库">
        <Icon name="back" />
      </button>
      <div class="topbar-title" title={p.title}>{p.title}</div>
      <div class="grow" />
      {p.pages > 0 && <span class="pager">{p.page} / {p.pages}</span>}
      <div class="segmented" role="group" aria-label="缩放">
        <button onClick={p.onZoomOut} title="缩小" aria-label="缩小"><Icon name="minus" size={14} /></button>
        <button onClick={p.onFit} title="适应宽度" class="seg-label">{p.zoomLabel}</button>
        <button onClick={p.onZoomIn} title="放大" aria-label="放大"><Icon name="plus" size={14} /></button>
      </div>
      <button class={`icon-btn ${p.sidebarOpen ? 'on' : ''}`} onClick={p.onToggleSide} title="笔记" aria-label="显示或隐藏笔记">
        <Icon name="sidebar" />
      </button>
      {p.sync}
      <button class="icon-btn" onClick={p.onOpenSettings} title="设置" aria-label="设置">
        <Icon name="gear" />
      </button>
    </header>
  );
}

interface FloatProps {
  tool: Tool;
  onTool: (t: Tool) => void;
  color: InkColor;
  palette: InkColor[];
  onColor: (c: InkColor) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

/** 底部中间的浮动工具条：只在阅读区域出现。 */
export function FloatingTools(p: FloatProps) {
  return (
    <div class="float-tools" role="toolbar" aria-label="标注工具">
      <button class="float-btn" onClick={p.onUndo} disabled={!p.canUndo} title="撤销 ⌘Z" aria-label="撤销">
        <Icon name="undo" size={17} />
      </button>
      <button class="float-btn" onClick={p.onRedo} disabled={!p.canRedo} title="重做 ⇧⌘Z" aria-label="重做">
        <Icon name="redo" size={17} />
      </button>
      <span class="float-sep" />
      {TOOLS.map((t) => (
        <button
          class={`float-btn ${p.tool === t.id ? 'on' : ''}`}
          aria-pressed={p.tool === t.id}
          title={t.label}
          aria-label={t.label}
          onClick={() => p.onTool(t.id)}
        >
          <Icon name={t.icon} size={17} />
        </button>
      ))}
      {(p.tool === 'pen' || p.tool === 'marker' || p.tool === 'text') && (
        <>
          <span class="float-sep" />
          {p.palette.map((c) => (
            <button
              class={`ink-dot ${p.color === c ? 'on' : ''}`}
              style={{ background: INK_HEX[c] }}
              aria-label={`颜色 ${c}`}
              aria-pressed={p.color === c}
              onClick={() => p.onColor(c)}
            />
          ))}
        </>
      )}
    </div>
  );
}
