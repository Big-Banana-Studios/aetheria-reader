# Aetheria Reader

A spoken-word reader for a library of books you already own. Point it at a
folder on your own disk and it will read any of them aloud, keep your place,
and — if you want it — answer questions about the passage you are listening
to, using a language model that runs on your own hardware.

Nothing is uploaded. No book ever leaves the device, and no book is stored in
this repository.

## What it does

- **Reads a whole folder.** Choose your books folder once; the app lists every
  PDF, text and HTML file in it and remembers the folder for next time.
- **Speaks the text.** Sentence-by-sentence playback with highlighting,
  adjustable speed and voice, paragraph and section pauses, and a contents
  list built from the book's own chapter headings.
- **Keeps your place.** Reading position is saved per book, continuously.
- **Explains as you listen.** Tap the ✦ button and a Liquid AI **LFM2** model,
  running in your browser on WebGPU, explains the passage, restates it in
  plain English, defines its Pali and Sanskrit terms, or answers a question
  you type.
- **Works offline** after the first visit. The app, pdf.js, your extracted
  books and the downloaded model all persist locally.

## Getting the text out of the books

Most of these old scans are image PDFs carrying an OCR text layer, hard-wrapped
with page numbers, running headers and hyphens broken across line ends. The
cleaner in [`js/textclean.js`](js/textclean.js) undoes all of that:

- rejoins words split across a line break
- drops page numbers and the running header repeated on every page
- reflows hard-wrapped lines back into paragraphs, using the vertical gaps
  pdf.js reports to tell a wrapped line from a real paragraph break
- collapses letter-spaced display type (`B O O K` → `BOOK`), which a speech
  synthesiser would otherwise spell out one letter at a time
- finds chapter headings line by line and falls back to page ranges when a
  scan is too noisy for that to be trustworthy

A book is extracted once and cached in IndexedDB, so opening it again is
instant. On a test machine a 51 MB, 490-page scan extracted in about
1.6 seconds.

Books with no text layer at all — pure images, never OCR'd — cannot be read
aloud. The app says so plainly and marks them in the library.

## The assistant

Three models are offered, all fetched from the Hugging Face CDN and cached by
the browser. They are never served from this site.

| Model | Download | Good for |
| --- | --- | --- |
| `LFM2-350M` | ~255 MB | Fast plain-language paraphrase |
| `LFM2-700M` | ~496 MB | Balanced — the default |
| `LFM2-1.2B` | ~760 MB | Dense doctrinal passages |

WebGPU is required for usable speed. Without it the app falls back to CPU and
says so. Chrome and Edge are the safest choices; Safari 26 and later also
support WebGPU.

The model only ever sees the passage on screen, and is told to say when a
scan is too garbled to interpret rather than invent a reading.

## Browser support

| | Folder picker | Remembers folder | Reading | Assistant |
| --- | --- | --- | --- | --- |
| Chrome / Edge desktop | yes | yes | yes | yes |
| Chrome Android | yes | yes | yes | yes |
| Firefox | folder upload | no | yes | yes |
| Safari / iOS | folder upload | no | yes | needs Safari 26+ |

Only Chromium browsers implement `showDirectoryPicker`, which is what allows
the app to reopen your folder on a later visit. Elsewhere the app falls back to
a one-off folder upload — still entirely local — and tells you it cannot
remember the choice.

## Deploying to GitHub Pages

The repository is about 2 MB. Push it and enable Pages:

```bash
git init
git add .
git commit -m "Aetheria Reader"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → `main` / `root`**.

Pages must be served over HTTPS for the service worker, the folder picker and
WebGPU to work; `github.io` already is. `.nojekyll` is present so that
directories are served as-is.

### Updating

Bump `VERSION` in [`sw.js`](sw.js) whenever you change the app, or returning
visitors will keep the old cached copy.

## Running locally

A plain static server is enough, but it must be `localhost` or HTTPS:

```bash
python -m http.server 8000
# then open http://127.0.0.1:8000
```

## Layout

```
index.html              app shell
css/styles.css
js/app.js               screens, library, settings, wiring
js/reader.js            playback state machine and rendering
js/extract.js           pdf.js text extraction
js/textclean.js         OCR cleanup and sectioning
js/store.js             IndexedDB: folder handle, book cache, progress
js/ai.js                model catalogue and prompts
js/ai-worker.js         transformers.js in a worker
vendor/pdfjs/           pdf.js 6.2.108, vendored so reading works offline
sw.js                   precached shell + runtime cache for the AI libraries
dev/selftest.html       browser self-test — see below
tools/build_library.py  optional: bulk-check a folder from the command line
```

## Development

`dev/selftest.html` exercises the real module graph in a browser — filename
parsing, cleaning, sectioning, sentence splitting, IndexedDB, and a full pdf.js
extraction if you give it one:

```
http://127.0.0.1:8000/dev/selftest.html?pdf=../some-book.pdf
```

`dev/drive.mjs` runs that page in headless Chrome and prints the result:

```bash
chrome --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/p about:blank &
node dev/drive.mjs "http://127.0.0.1:8000/dev/selftest.html?pdf=../some-book.pdf"
```

`tools/build_library.py` is a command-line counterpart to the in-browser
cleaner, mirroring the same logic. It is not used by the app, but it is a quick
way to find out which books in a folder lack a text layer before you try them:

```bash
python tools/build_library.py "../Buddism books" /tmp/out
```

## Credits

[pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0),
[transformers.js](https://huggingface.co/docs/transformers.js) (Apache-2.0),
and [Liquid AI LFM2](https://huggingface.co/LiquidAI) models.
