# Aetheria Reader

A spoken-word reader for classic Buddhist texts. It ships with 149
public-domain books, reads them aloud, keeps your place, and — if you want it —
answers questions about the passage you are listening to, using a language
model that runs on your own hardware.

It will also read your own books, straight off your disk, without uploading
anything.

## What it does

- **Ships a library.** 149 public-domain titles, 10.2 million words, printed
  between 1830 and 1935. Cleaned text only: 57 MB, published with the app.
- **Reads your own folder too.** Choose a folder of PDFs and the app lists
  every book in it, extracts the text in the browser, and remembers the folder
  for next time. Nothing is uploaded.
- **Speaks the text.** Sentence-by-sentence playback with highlighting,
  adjustable speed and voice, paragraph and section pauses, and a contents
  list built from the book's own chapter headings.
- **Keeps your place.** Reading position is saved per book, continuously.
- **Explains as you listen.** Tap the ✦ button and a Liquid AI **LFM2** model,
  running in your browser on WebGPU, explains the passage, restates it in
  plain English, defines its Pali and Sanskrit terms, or answers a question
  you type.
- **Keeps reading in a background tab** on a computer, and puts the book on
  the lock screen with working media keys. On phones it pauses when you
  leave and resumes where you left off — see below for why.
- **Works offline** after the first visit. The app and pdf.js are precached;
  any book you open is kept, and **Settings → Library offline** downloads the
  whole 57 MB collection in one go. The model persists too, once downloaded.

## The library

`library/index.json` is the catalogue; each book is a separate
`library/<id>.json` holding cleaned, sectioned text. They are fetched one at a
time as books are opened and cached by the service worker, so the reader only
ever downloads what they actually read.

The texts are generated from a folder of PDFs by
[`tools/build_library.py`](tools/build_library.py), which mirrors the
in-browser cleaner exactly:

```bash
python tools/build_library.py "../Buddism books" library
```

The source PDFs — 1.9 GB — are deliberately not in this repository. They
exceed what GitHub Pages will host, and the text is what the reader needs.
Of 153 books, 149 carry an OCR text layer; the other four are picture-only
scans and were skipped.

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
- rejoins a paragraph split across a page break, so the reader is never left
  speaking half a sentence and then starting mid-clause on the other side
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

## Background playback

**On a phone, reading stops when you leave the app, and that cannot be
fixed from a web page.** Android and iOS suspend the speech engine whenever
the page is hidden. It is not a question of audio focus: the music keeps
playing perfectly well with the screen off, which is exactly the proof that
focus was granted — the speech engine is simply switched off. Chrome's own
"listen to this page" is a native feature for the same reason.

So the app pauses on the way out, remembers the sentence, resumes it on
return, and reports *paused* on the lock screen rather than offering a
button that does nothing. A screen wake lock is held while reading, so it
keeps going until the screen is locked deliberately.

Getting real background playback would mean abandoning the browser's speech
engine and synthesising the audio in-page with a neural voice — Kokoro-82M
or Piper, both of which run in ONNX — then playing that through an audio
element, which does survive backgrounding. That is a different app, and a
download of 25–82 MB before a word is spoken.

In a **desktop** background tab it does keep reading, and three things make
that work:

- **Queued playback.** Four utterances are handed to the engine at a time,
  so it plays them back to back without waiting on JavaScript. A clamped
  background timer can no longer stall the reading between sentences.
- **Audible music.** A soft loop plays under the voice, and it is what
  actually holds audio focus. Inaudible audio does not work for this:
  browsers discount it deliberately, and on Android a silent loop earned
  no focus at all — the speech engine took focus when it began talking and
  the loop was paused underneath us. Real media is treated as media.
  The loop is synthesised at load, not downloaded: a slow chord
  progression under a low-pass filter with a little noise for texture,
  cross-faded end to start so it comes round without a seam
  (see [`js/ambience.js`](js/ambience.js)).
- **Thirty seconds long, and self-restarting.** Chrome takes audio focus
  only for media running longer than five seconds and writes anything
  shorter off as a UI sound effect. The element is also restarted whenever
  the platform pauses it, and a Web Audio tone runs alongside as a second
  anchor.

**Settings → Reading music** carries an on/off toggle and a volume. Switched
off, the app falls back to the near-silent loop, which still asks for focus
but is the arrangement browsers honour least reliably — so silence costs
some of the background reliability, and the app says so when you turn it
off.
- **Media Session.** The book, chapter and cover appear on the lock screen
  and in the browser's media controls; play, pause and next/previous
  sentence work from there and from hardware media keys.

A screen wake lock is also held while reading, where the browser offers one.

**Settings → Background playback → Check** reports what the browser actually
granted — whether reading is under way, whether the loop is playing, whether
it cleared the five-second floor, and whether the lock-screen card and media
keys were accepted. None of those failures announce themselves otherwise,
which is how a four-second loop once survived being tested at all.

## Browser support

| | Folder picker | Remembers folder | Reading | Background | Assistant |
| --- | --- | --- | --- | --- | --- |
| Chrome / Edge desktop | yes | yes | yes | yes | yes |
| Chrome Android | yes | yes | yes | no | yes |
| Firefox | folder upload | no | yes | yes | yes |
| Safari / iOS | folder upload | no | yes | no | needs Safari 26+ |

"Background" means another tab or another window on a computer. No mobile
browser will keep speech running once the page is hidden, so on a phone the
app pauses and resumes instead.

Only Chromium browsers implement `showDirectoryPicker`, which is what allows
the app to reopen your folder on a later visit. Elsewhere the app falls back to
a one-off folder upload — still entirely local — and tells you it cannot
remember the choice.

## Deploying to GitHub Pages

The repository is about 59 MB — 2 MB of app and 57 MB of book text, well
inside the 1 GB Pages allows. Push it and enable Pages:

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
js/library.js           the published catalogue and offline pre-caching
library/                149 books as cleaned text, plus index.json
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

`tools/build_library.py` generates `library/`. It mirrors the in-browser
cleaner, and also reports which books in a folder lack a text layer.

## Credits

[pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0),
[transformers.js](https://huggingface.co/docs/transformers.js) (Apache-2.0),
and [Liquid AI LFM2](https://huggingface.co/LiquidAI) models.
