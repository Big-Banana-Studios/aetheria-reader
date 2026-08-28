/* ═══════════════════════════════════════════════════════════════════
   TEXT CLEANING
   Turns raw page text pulled out of a PDF into sections of readable
   paragraphs. Scanned 19th-century books arrive hard-wrapped, hyphen-
   split across line ends and littered with page numbers and running
   headers, none of which should ever reach the speech synthesiser.
   ═══════════════════════════════════════════════════════════════════ */

const LIGATURES = [
  [/ﬀ/g, 'ff'], [/ﬁ/g, 'fi'], [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'], [/ﬄ/g, 'ffl'], [/­/g, ''],
];

// A word broken across a line end: "com-\npassion"
const HYPHEN_RE = /(\p{L})[-‐‑]\s*\n\s*(\p{L})/gu;

// A line holding nothing but a page number, arabic or roman
const PAGE_NUM_RE = /^\s*[[(]?\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*[\])]?\s*$/i;

const HEADING_WORDS =
  'CHAPTER|BOOK|PART|SECTION|LECTURE|APPENDIX|PREFACE|INTRODUCTION|' +
  'FOREWORD|CANTO|VOLUME|SUTTA|SUTRA|DISCOURSE|ESSAY|LETTER';
const HEADING_ONLY_RE = new RegExp(`^\\s*(${HEADING_WORDS})\\b[\\s.:-]*[IVXLCDM\\d]*[\\s.:-]*$`, 'i');
const HEADING_LEAD_RE = new RegExp(`^\\s*(${HEADING_WORDS})\\s+[IVXLCDM\\d]+\\b`, 'i');

/* ── Page furniture ─────────────────────────────────────────────── */

/** Strip page numbers from the head and foot of a single page. */
export function cleanPage(page) {
  const lines = page.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && PAGE_NUM_RE.test(lines[0].trim())) lines.shift();
  if (lines.length && PAGE_NUM_RE.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n');
}

/**
 * Remove the book title / chapter name that many scans repeat as the
 * first line of every page. Detected by frequency, so a line that only
 * looks like a header on one page is left alone.
 */
export function stripRunningHeaders(pages) {
  const counts = new Map();
  const normalise = (s) => s.replace(/\d+/g, '#').toLowerCase();

  for (const page of pages) {
    for (const line of page.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (s.length < 70) {
        const key = normalise(s);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      break;                       // only the first non-blank line counts
    }
  }

  const threshold = Math.max(4, Math.floor(pages.length / 8));
  const common = new Set();
  for (const [key, n] of counts) if (n >= threshold) common.add(key);
  if (!common.size) return pages;

  return pages.map((page) => {
    const lines = page.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      if (common.has(normalise(s))) lines.splice(i, 1);
      break;
    }
    return lines.join('\n');
  });
}

/* ── Paragraphs and headings ────────────────────────────────────── */

// Four or more single letters in a row: display type from a title page,
// set with wide letter-spacing. Prose never looks like this, and a speech
// synthesiser would otherwise spell it out one letter at a time.
const LETTERSPACED_RE = /\p{L}(?: \p{L}){3,}/gu;

/**
 * "B O O K  L I B R A R Y" → "BOOK LIBRARY". Runs before runs of spaces
 * are squashed, so the wider gaps that separate words survive as breaks.
 */
export function collapseLetterSpacing(text) {
  return text.replace(LETTERSPACED_RE, (m) => m.replace(/ /g, ''));
}

/** Reject OCR noise, index tables and stray page-number columns. */
function isProse(p) {
  if (p.length < 3) return false;
  let letters = 0;
  for (const ch of p) if (/\p{L}/u.test(ch)) letters++;
  return letters >= Math.max(3, p.length * 0.5);
}

export function isHeading(line) {
  if (line.length > 80) return false;
  if (HEADING_ONLY_RE.test(line) || HEADING_LEAD_RE.test(line)) return true;

  // A short all-caps line with no sentence-ending punctuation
  const letters = [...line].filter((c) => /\p{L}/u.test(c));
  if (letters.length >= 4 && line.length <= 60 && !/[.,;?!]$/.test(line)) {
    const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
    if (upper / letters.length > 0.9) return true;
  }
  return false;
}

/**
 * Reflow one page into a list of { kind: 'h' | 'p', text } blocks.
 *
 * Headings are spotted line by line, *before* lines are joined into
 * paragraphs. In most of these editions a heading sits on its own line
 * with no blank line beneath it, so detecting it after the reflow would
 * glue it onto the opening sentence of the chapter.
 */
export function pageBlocks(text) {
  for (const [re, sub] of LIGATURES) text = text.replace(re, sub);
  text = text.replace(HYPHEN_RE, '$1$2');       // rejoin hyphen-split words
  text = collapseLetterSpacing(text);           // before spaces are squashed
  text = text.replace(/[ \t]+/g, ' ');

  const blocks = [];
  let buf = [];

  const flush = () => {
    if (!buf.length) return;
    const p = buf.join(' ').replace(/\s{2,}/g, ' ').trim();
    buf = [];
    if (isProse(p)) blocks.push({ kind: 'p', text: p });
  };

  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) {
      flush();
    } else if (isHeading(s)) {
      flush();
      const last = blocks[blocks.length - 1];
      // Fold a run of heading lines together: "CHAPTER I" + "THE BIRTH"
      if (last && last.kind === 'h' && last.text.length + s.length < 90) {
        last.text += ' — ' + s;
      } else {
        blocks.push({ kind: 'h', text: s });
      }
    } else {
      buf.push(s);
    }
  }
  flush();
  return blocks;
}

/* ── Sectioning ─────────────────────────────────────────────────── */

/** Fallback when heading detection is unusable: fixed runs of pages. */
function pageGroups(prose, pageCount, group = 8) {
  const sections = [];
  let cur = [], start = 0;
  for (const { text, page } of prose) {
    if (Math.floor(page / group) !== Math.floor(start / group) && cur.length) {
      sections.push({ h: `Pages ${start + 1}–${page}`, p: cur });
      cur = []; start = page;
    }
    cur.push(text);
  }
  if (cur.length) sections.push({ h: `Pages ${start + 1}–${pageCount}`, p: cur });
  return sections;
}

const ENDS_SENTENCE = /[.!?…]["')\]]?\s*$/;

/**
 * Does one block of text run straight on into the next?
 *
 * Scans break a single paragraph into pieces constantly — at page ends,
 * at column ends, and wherever OCR read the leading of a line as a blank
 * line. Left alone, each piece becomes its own utterance and the reader
 * hears a pause dropped into the middle of a sentence.
 *
 * The test is deliberately strict: the first piece must not have ended a
 * sentence, *and* the second must start lower-case (or the first must end
 * on a mark that cannot close one). A genuine new paragraph opening with
 * a capital is therefore never swallowed, even when OCR lost its full
 * stop.
 */
function continuesParagraph(prev, next) {
  if (ENDS_SENTENCE.test(prev)) return false;
  return /^\p{Ll}/u.test(next) || /[,;:—–-]$/.test(prev);
}

function joinParagraph(prev, next) {
  return /[-‐‑]$/.test(prev)
    ? prev.replace(/[-‐‑]$/, '') + next     // a word split by the break
    : prev + ' ' + next;
}

/** Split cleaned pages into navigable sections. */
export function buildSections(pages) {
  const flat = [];
  pages.forEach((page, pi) => {
    for (const b of pageBlocks(page)) {
      const prev = flat[flat.length - 1];
      if (b.kind === 'p' && prev?.kind === 'p' && continuesParagraph(prev.text, b.text)) {
        prev.text = joinParagraph(prev.text, b.text);
        continue;
      }
      flat.push({ ...b, page: pi });
    }
  });
  if (!flat.length) return [];

  const prose = flat.filter((b) => b.kind === 'p');
  if (!prose.length) return [];

  const marks = [];
  flat.forEach((b, i) => { if (b.kind === 'h') marks.push(i); });
  if (!marks.length) return pageGroups(prose, pages.length);

  if (marks[0] !== 0) marks.unshift(0);
  const sections = [];
  for (let n = 0; n < marks.length; n++) {
    const start = marks[n];
    const end = n + 1 < marks.length ? marks[n + 1] : flat.length;
    const body = flat.slice(start, end);
    if (!body.length) continue;
    const head = body[0].kind === 'h' ? body[0].text : 'Beginning';
    const paras = body.filter((b) => b.kind === 'p').map((b) => b.text);
    if (paras.length) {
      sections.push({ h: head.replace(/^[\s.:—-]+|[\s.:—-]+$/g, '') || 'Untitled', p: paras });
    }
  }

  // Fold runaway-short sections into the previous one, so the contents
  // list is not a wall of two-line entries.
  const merged = [];
  for (const s of sections) {
    const words = s.p.reduce((a, p) => a + p.split(/\s+/).length, 0);
    if (merged.length && words < 80) {
      merged[merged.length - 1].p.push(...s.p);
    } else {
      merged.push(s);
    }
  }

  // Heading detection is unreliable on noisy scans. Judge it only after
  // merging: more than one section per page means it fired on OCR junk
  // rather than on real chapter headings.
  if (!merged.length || merged.length > Math.max(8, pages.length * 0.75)) {
    return pageGroups(prose, pages.length);
  }
  return merged;
}

/* ── Filename metadata ──────────────────────────────────────────── */

const YEAR_RE = /\((\d{4})\)/;
const SD_RE = /\((?:s\.d|19--|n\.d)\.?\)/i;
const BY_RE = /\s+(?:by|par|von)\s+/i;
const NOTE_RE = /\((German text|French text|unknown author)\)/i;

/** "A Buddhist Bible by D. Goddard (1932).pdf" → title / author / year. */
export function parseFilename(filename) {
  let stem = filename.replace(/\.[^.]+$/, '');

  let note = null;
  const noteMatch = stem.match(NOTE_RE);
  if (noteMatch) { note = noteMatch[1]; stem = stem.replace(NOTE_RE, ''); }

  let year = null;
  const yearMatch = stem.match(YEAR_RE);
  if (yearMatch) { year = parseInt(yearMatch[1], 10); stem = stem.replace(YEAR_RE, ''); }
  stem = stem.replace(SD_RE, '');
  stem = stem.replace(/\s{2,}/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '');

  let title = stem, author = null;
  const parts = stem.split(BY_RE);
  if (parts.length >= 2) {
    title = parts[0].replace(/^[\s.,-]+|[\s.,-]+$/g, '');
    author = parts[parts.length - 1].replace(/^[\s.,-]+|[\s.,-]+$/g, '');
    if (author.length > 90) author = null;
  }
  return { title: title || stem, author, year, note };
}
