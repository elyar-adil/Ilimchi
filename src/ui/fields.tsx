import { tr } from '../core/i18n';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';

/** 像正文一样显示的文字，点击后原地编辑；Enter 保存，Esc 取消。 */
export function EditableText({ value, placeholder, cls = '', label, onSave }: {
  value: string;
  placeholder: string;
  cls?: string;
  label: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setV(value);
  }, [value, editing]);

  const fit = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  };

  if (editing) {
    return (
      <textarea
        class={`editable editing ${cls}`}
        value={v}
        rows={1}
        aria-label={label}
        placeholder={placeholder}
        ref={(el) => {
          fit(el);
          if (el && document.activeElement !== el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }}
        onInput={(e) => {
          setV((e.target as HTMLTextAreaElement).value);
          fit(e.target as HTMLTextAreaElement);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            cancelled.current = true;
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        onBlur={() => {
          setEditing(false);
          if (cancelled.current) {
            cancelled.current = false;
            setV(value);
            return;
          }
          const next = v.replace(/\s+/g, ' ').trim();
          if (next !== value) onSave(next);
        }}
      />
    );
  }
  return (
    <div
      class={`editable ${cls} ${value ? '' : 'is-empty'}`}
      role="button"
      tabIndex={0}
      aria-label={tr('{label}：{value}，点击编辑', { label, value: value || tr('未填写') })}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setEditing(true);
      }}
    >
      {value || placeholder}
    </div>
  );
}

/** 标签：小签排列，可删除；末尾“添加标签”原地展开输入。 */
export function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState('');
  const commit = () => {
    const parts = v.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    setV('');
    setAdding(false);
    if (parts.length) onChange([...new Set([...tags, ...parts])]);
  };
  return (
    <div class="tags">
      {tags.map((t) => (
        <span class="tag-chip" key={t}>
          <span>{t}</span>
          <button class="chip-x" title={tr('移除标签')} aria-label={tr('移除标签 {tag}', { tag: t })} onClick={() => onChange(tags.filter((x) => x !== t))}>
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          class="tag-input"
          value={v}
          autoFocus
          placeholder={tr('标签名')}
          aria-label={tr('新标签')}
          onInput={(e) => setV((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setV('');
              setAdding(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <button class="tag-add" onClick={() => setAdding(true)}>{tr('添加标签')}</button>
      )}
    </div>
  );
}
