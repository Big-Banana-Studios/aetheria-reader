/* ═══════════════════════════════════════════════════════════════════
   PDF TEXT EXTRACTION
   Pulls the text layer out of a PDF with pdf.js and hands it to the
   cleaner. Every one of these scans carries an OCR text layer; books
   that don't are reported so the library can mark them unreadable.
   ═══════════════════════════════════════════════════════════════════ */

import { cleanPage, stripRunningHeaders, buildSections } from './textclean.js';

// pdf.js is served from this origin rather than a CDN so that opening a
// new book still works with no network at all.
const PDFJS_URL = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url);
const PDFJS_WORKER_URL = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url);

let pdfjsPromise = null;

/** Load pdf.js once, lazily — it is only needed when a book is opened. */
function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL.href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL.href;
      return lib;
    });
  }
  return pdfjsPromise;
}

/**
 * Rebuild the lines of a page from pdf.js text items.
 *
 * pdf.js hands back positioned fragments, not lines. `hasEOL` marks the
 * end of a visual line; the vertical distance between consecutive lines
 * then tells us where paragraphs break — a gap noticeably larger than the
 * body leading means a new paragraph, which is what lets the cleaner tell
 * a wrapped line from a real break.
 */
function itemsToText(items) {
  const lines = [];
  let buf = '', y = null;

  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    if (y === null && item.transform) y = item.transform[5];
    buf += item.str;
    if (item.hasEOL) {
      lines.push({ text: buf, y: y ?? 0 });
      buf = ''; y = null;
    }
  }
  if (buf.trim()) lines.push({ text: buf, y: y ?? 0 });
  if (!lines.length) return '';

  // Typical leading, measured as the median downward step between lines
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i - 1].y - lines[i].y;
    if (d > 0) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const leading = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  let out = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i - 1].y - lines[i].y;
    // A gap half again as tall as the body leading reads as a break
    const paragraphBreak = leading > 0 && d > leading * 1.6;
    out += (paragraphBreak ? '\n\n' : '\n') + lines[i].text;
  }
  return out;
}

/**
 * Extract and clean a whole PDF.
 *
 * @param {File|Blob|ArrayBuffer} source
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{sections:Array,pages:number,words:number}>}
 */
export async function extractPdf(source, onProgress) {
  const pdfjs = await getPdfjs();
  const data = source instanceof ArrayBuffer ? source : await source.arrayBuffer();

  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableAutoFetch: true,
  });
  const pdf = await task.promise;

  const pages = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = cleanPage(itemsToText(content.items));
      if (text.trim()) pages.push(text);
      page.cleanup();                       // release per-page memory

      if (onProgress && (n % 5 === 0 || n === pdf.numPages)) {
        onProgress(n, pdf.numPages);
        await new Promise((r) => setTimeout(r, 0));   // let the UI breathe
      }
    }
  } finally {
    // Release the pdf.js worker and its page cache; a 500-page scan holds
    // on to a lot of memory otherwise.
    try { await task.destroy(); } catch {}
  }

  if (!pages.length) {
    throw new NoTextLayerError('This PDF has no text layer — it is images only.');
  }

  const sections = buildSections(stripRunningHeaders(pages));
  const words = sections.reduce(
    (a, s) => a + s.p.reduce((b, p) => b + p.split(/\s+/).length, 0), 0);

  if (words < 200) {
    throw new NoTextLayerError('Almost no readable text could be recovered from this PDF.');
  }
  return { sections, pages: pages.length, words };
}

export class NoTextLayerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoTextLayerError';
  }
}
