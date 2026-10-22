/** 数据模型。所有持久化到 GitHub 的结构都在这里定义。 */

export const SCHEMA_VERSION = 3;

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';
export const HIGHLIGHT_COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];
export type AnnotationDecoration = 'highlight' | 'underline';

/** 相对页面宽高的比例坐标（0..1），与缩放无关。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Annotation {
  id: string;
  /** 1-based 页码 */
  page: number;
  color: HighlightColor;
  /** 标记方式：旧笔记没有此字段时默认为高亮。 */
  decoration?: AnnotationDecoration;
  /** 选中的原文（用于换版本 / 换设备时重新定位） */
  quote: string;
  /** 选区前后的上下文，用于在多处相同文本中消歧 */
  prefix: string;
  suffix: string;
  /** 选区起点在该页文本层中的字符偏移 */
  start: number;
  /** 高亮矩形（页面比例坐标） */
  rects: Rect[];
  /** 用户批注（纯文本） */
  note: string;
  /** 创建/最近一次定位时 PDF 的指纹；与当前指纹一致时直接信任 rects */
  fingerprint: string;
  /** 创建时的论文版本标签，如 "v2"；空串表示未指定 */
  version: string;
  createdAt: number;
  updatedAt: number;
  /** 墓碑：删除时间。保留一段时间以便其他设备同步删除 */
  deletedAt?: number;
}

export interface Progress {
  page: number;
  pages: number;
  /** 视口顶部在当前页内的位置（0..1） */
  offset: number;
  updatedAt: number;
}

/** 参与「最后写入者胜出」合并的标量字段 */
export type FieldName = 'title' | 'authors' | 'version' | 'url' | 'sourceUrl' | 'tags' | 'deletedAt';

export type InkColor = 'ink' | 'blue' | 'red' | 'green' | 'yellow' | 'pink';
export const INK_HEX: Record<InkColor, string> = {
  ink: '#1d2129', blue: '#2f5fd0', red: '#c0392b', green: '#2e8b57', yellow: '#ffd60a', pink: '#ff2d55',
};
export const INK_KEYS = Object.keys(INK_HEX) as InkColor[];
/** 画笔与文字可用的颜色 */
export const PEN_COLORS: InkColor[] = ['ink', 'blue', 'red', 'green'];
/** 荧光笔可用的颜色 */
export const MARKER_COLORS: InkColor[] = ['yellow', 'green', 'blue', 'pink'];

/** 手绘笔迹：点坐标为页面比例（0..1） */
export interface InkShape {
  kind: 'ink';
  id: string;
  page: number;
  color: InkColor;
  points: [number, number][];
  /** 荧光笔：宽而半透明的笔迹，与纸面正片叠底 */
  marker?: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** 文字框：x/y/w 为页面宽高比例，size 为页面宽度的比例（字号随缩放变化） */
export interface TextShape {
  kind: 'text';
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  size: number;
  color: InkColor;
  text: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export type Shape = InkShape | TextShape;

export interface PaperDoc {
  schema: number;
  id: string;
  /** PDF 的规范链接；本地文件论文为空串 */
  url: string;
  /** 用户最初输入的链接（通常是 abs 页面） */
  sourceUrl: string;
  title: string;
  authors: string;
  /** 论文版本标签，如 "v2"；空串 = 最新 */
  version: string;
  tags: string[];
  progress: Progress;
  /** 最近一次打开论文的时间戳；与阅读进度更新相互独立。 */
  lastOpenedAt: number;
  /** 每个阅读会话累计的毫秒数；合并时按会话 ID 取最大值再求和。 */
  readingSessions: Record<string, number>;
  annotations: Annotation[];
  shapes: Shape[];
  createdAt: number;
  updatedAt: number;
  /** 移入回收站的时间；null = 正常 */
  deletedAt: number | null;
  /** 各标量字段最后修改时间，用于合并 */
  fieldTimes: Record<FieldName, number>;
}

export type PaperKind = 'arxiv' | 'openreview' | 'acl' | 'url' | 'file';

export interface PaperRef {
  id: string;
  kind: PaperKind;
  pdfUrl: string;
  pageUrl: string;
  version: string;
  arxivId?: string;
}

export const FIELD_NAMES: FieldName[] = ['title', 'authors', 'version', 'url', 'sourceUrl', 'tags', 'deletedAt'];
