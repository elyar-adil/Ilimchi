export type IconName =
  | 'back' | 'select' | 'text' | 'pen' | 'marker' | 'eraser' | 'sidebar' | 'gear' | 'plus' | 'minus'
  | 'search' | 'library' | 'trash' | 'tag' | 'sun' | 'moon' | 'auto' | 'sync' | 'close'
  | 'check' | 'folder' | 'untag' | 'sort' | 'list' | 'edit' | 'undo' | 'redo';

/** 统一的 1.6 线宽线性图标，24 网格。 */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

const PATHS: Record<IconName, preact.JSX.Element> = {
  back: <path d="M15 5l-7 7 7 7" />,
  select: <path d="M6 4l4.6 15.2 2.2-5.9 5.9-2.2z" />,
  text: <path d="M6 6.5V5h12v1.5M12 5v14M9.5 19h5" />,
  pen: <path d="M15.2 5.6l3.2 3.2L9.4 17.8 5 19l1.2-4.4z M13.6 7.2l3.2 3.2" />,
  marker: <path d="M14.5 4.8l4.7 4.7-7.6 7.6-4.7-4.7zM6.9 12.4l4.7 4.7-3.2 2.2H4.5v-2.2z" />,
  eraser: <path d="M4.5 18.5h8.5M7.8 15.2l7.4-7.4a1.6 1.6 0 0 1 2.3 0l1.7 1.7a1.6 1.6 0 0 1 0 2.3l-6.2 6.2H8.9z" />,
  sidebar: <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM9.5 4v16" />,
  gear: <path d="M18.96 10.15L21.32 10.78L21.32 13.22L18.96 13.85A7.2 7.2 0 0 1 18.23 15.61L18.23 15.61L19.45 17.73L17.73 19.45L15.61 18.23A7.2 7.2 0 0 1 13.85 18.96L13.85 18.96L13.22 21.32L10.78 21.32L10.15 18.96A7.2 7.2 0 0 1 8.39 18.23L8.39 18.23L6.27 19.45L4.55 17.73L5.77 15.61A7.2 7.2 0 0 1 5.04 13.85L5.04 13.85L2.68 13.22L2.68 10.78L5.04 10.15A7.2 7.2 0 0 1 5.77 8.39L5.77 8.39L4.55 6.27L6.27 4.55L8.39 5.77A7.2 7.2 0 0 1 10.15 5.04L10.15 5.04L10.78 2.68L13.22 2.68L13.85 5.04A7.2 7.2 0 0 1 15.61 5.77L15.61 5.77L17.73 4.55L19.45 6.27L18.23 8.39A7.2 7.2 0 0 1 18.96 10.15ZM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: <path d="M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2" />,
  library: <path d="M5 4.5h9.5a2.5 2.5 0 0 1 2.5 2.5v12.5H7.5A2.5 2.5 0 0 1 5 17zM5 17a2.5 2.5 0 0 1 2.5-2.5H17" />,
  trash: <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2l.9-12.2" />,
  tag: <path d="M3.5 12.2V4.5h7.7l9.3 9.3-7.7 7.7zM7.8 8.3h.01" />,
  sun: <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6zM12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />,
  moon: <path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" />,
  auto: <path d="M12 4a8 8 0 1 0 0 16zM12 4a8 8 0 0 1 0 16" />,
  sync: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v3.8h-3.8" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  undo: <path d="M9 14L4.5 9.5 9 5M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-2.5" />,
  redo: <path d="M15 14l4.5-4.5L15 5M19.5 9.5H10a5.5 5.5 0 0 0 0 11h2.5" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  folder: <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  untag: <path d="M3.5 12.2V4.5h7.7l9.3 9.3-7.7 7.7zM14 9l5 5M19 9l-5 5" />,
  sort: <path d="M7 4.5v15M4 7.5l3-3 3 3M17 19.5v-15M14 16.5l3 3 3-3" />,
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  edit: <path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5z" />,
};
