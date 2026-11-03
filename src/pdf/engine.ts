import * as pdfjs from 'pdfjs-dist';
// 以文本形式内联 worker，使产物可以是单个 HTML 文件（不依赖额外的 .mjs 资源）
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { installStreamIter } from '../polyfills';

let workerUrl: string | null = null;
function ensureWorker(): void {
  if (workerUrl) return;
  // 解析线程中同样补上 ReadableStream 的异步迭代（Safari 缺失）
  workerUrl = URL.createObjectURL(new Blob([`(${installStreamIter.toString()})();\n`, workerSource], { type: 'text/javascript' }));
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}
ensureWorker();

export { pdfjs };
export type PDFDoc = pdfjs.PDFDocumentProxy;
export type PDFPage = pdfjs.PDFPageProxy;

/** 每次都传入副本：pdf.js 会转移（detach）传入的 ArrayBuffer，而缓存里需要保留原件。 */
export async function openPdf(data: ArrayBuffer): Promise<PDFDoc> {
  ensureWorker();
  // fontExtraProperties：取得字体名（如 CMMI10），用于识别正文中的数学公式
  return pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), fontExtraProperties: true }).promise;
}
