/* ═══════════════════════════════════════════════════════════════════
   WORD DOCUMENTS
   Converts .docx to text via mammoth, which turns the document into
   simple HTML. Headings become sections, which is rather better than
   what a scanned PDF gives us: a Word file says outright where its
   chapters begin instead of leaving it to be guessed.

   mammoth is served from this origin rather than a CDN, so opening a
   document still works with no network.
   ═══════════════════════════════════════════════════════════════════ */

const MAMMOTH_URL = new URL('../vendor/mammoth/mammoth.browser.min.js', import.meta.url);

let loading = null;

/** mammoth is a UMD bundle, so it is loaded as a classic script. */
function getMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = MAMMOTH_URL.href;
      el.onload = () => window.mammoth
        ? resolve(window.mammoth)
        : reject(new Error('Word support failed to load.'));
      el.onerror = () => reject(new Error('Word support could not be loaded.'));
      document.head.appendChild(el);
    });
  }
  return loading;
}

/**
 * Extract a .docx into sections.
 *
 * @param {File|Blob} file
 * @returns {Promise<{sections:Array,pages:number,words:number}>}
 */
export async function extractDocx(file) {
  const mammoth = await getMammoth();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });

  const dom = new DOMParser().parseFromString(html, 'text/html');
  const sections = [];
  let current = { h: 'Beginning', p: [] };

  for (const el of dom.body.children) {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    if (/^H[1-4]$/.test(el.tagName)) {
      if (current.p.length) sections.push(current);
      current = { h: text.slice(0, 90), p: [] };
    } else if (el.tagName === 'UL' || el.tagName === 'OL') {
      // Read list items as separate sentences rather than one long run-on
      for (const li of el.querySelectorAll('li')) {
        const item = li.textContent.replace(/\s+/g, ' ').trim();
        if (item) current.p.push(/[.!?…]$/.test(item) ? item : item + '.');
      }
    } else if (el.tagName === 'TABLE') {
      for (const row of el.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('td, th')]
          .map((c) => c.textContent.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        if (cells.length) current.p.push(cells.join(' — ') + '.');
      }
    } else {
      current.p.push(text);
    }
  }
  if (current.p.length) sections.push(current);

  const words = sections.reduce(
    (a, s) => a + s.p.reduce((b, p) => b + p.split(/\s+/).filter(Boolean).length, 0), 0);

  return { sections: paginate(sections), pages: 1, words };
}

const PARAS_PER_PART = 40;

/**
 * A document written without Word headings arrives as one enormous
 * section, which leaves the contents list useless and no way to jump
 * about. Break a long run into parts so there is something to navigate.
 */
function paginate(sections) {
  if (sections.length > 1) return sections;
  const only = sections[0];
  if (!only || only.p.length <= PARAS_PER_PART * 1.5) return sections;

  const parts = [];
  for (let i = 0; i < only.p.length; i += PARAS_PER_PART) {
    const slice = only.p.slice(i, i + PARAS_PER_PART);
    parts.push({ h: `Part ${parts.length + 1}`, p: slice });
  }
  return parts;
}
