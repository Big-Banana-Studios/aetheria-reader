# Aetheria Reader

A spoken-word reader for classic Buddhist texts. It ships with 149
public-domain books, reads them aloud, keeps your place, and — if you want it —
answers questions about the passage you are listening to, using a language
model that runs on your own hardware.

It will also read your own books, straight off your disk, without uploading
anything.

## What it does

- **Ships a library.** 414 public-domain titles across two collections —
  Buddhism (149) and Mesopotamia (265) — 30.8 million words, printed between
  1801 and 1935. Cleaned text only: 172 MB, published with the app.
- **Reads your own books too.** PDFs, Word documents, text and HTML, added
  singly with **+ File** or a whole folder at once with **+ Folder**. The text is extracted in the
  browser and kept, so **My books** shows your shelf on every visit — even
  on a phone, where no browser will remember a folder. Nothing is uploaded.
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

`library/index.json` is the catalogue, listing collections and books; each
book is a separate `library/<id>.json` holding cleaned, sectioned text. They are fetched one at a
time as books are opened and cached by the service worker, so the reader only
ever downloads what they actually read.

The texts are generated from a folder of PDFs by
[`tools/build_library.py`](tools/build_library.py), which mirrors the
in-browser cleaner exactly:

```bash
# add or rebuild one collection
python tools/build_library.py "../Buddism books" library --name Buddhism
python tools/build_library.py "G:/" library --name Mesopotamia

# or treat every subfolder of a drive as its own collection
python tools/build_library.py /e/BookSets library --sets
```

Runs merge: collections not named are carried over untouched, and books
already extracted are kept rather than redone, so adding a set takes as long
as that set alone. Catalogue entries whose text file has gone are dropped,
and collections left empty disappear. `--force` re-extracts, `--replace`
starts a fresh catalogue.

The source PDFs are deliberately not in this repository — they run to
several gigabytes, far more than GitHub Pages will host, and the text is
what the reader needs. Sixteen of 430 scans carry no OCR text layer at all
and are skipped.

Each book is also scored for how much of it reads as English prose. These
sets include scholarly editions of transliterated cuneiform, and volumes in
German and French; they extract perfectly well and are useless read aloud by
an English voice, so the library marks them **not English prose** rather than
letting someone find out by pressing play. Nineteen of 414 are flagged.

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

There are two voices, and the choice decides this.

**A browser voice** is instant and free, and stops the moment the page is
hidden. Android and iOS suspend the speech engine outright; it is not a
question of audio focus, since the music keeps playing perfectly well with
the screen off. Chrome's own "listen to this page" is a native feature for
the same reason. With a browser voice the app pauses on the way out,
remembers the sentence, and resumes it on return.

**The on-device voice** — Kokoro-82M, in [`js/voices.js`](js/voices.js) and
[`js/tts-worker.js`](js/tts-worker.js) — synthesises the audio itself. The
result is ordinary audio, and ordinary audio plays on with the screen off
like anything else. Sentences are generated a few ahead in a worker and
handed to the Web Audio clock with an explicit start time, so once a
sentence is scheduled it will sound whether or not JavaScript is being
throttled. Output goes through a MediaStream on an audio element, which is
unambiguously media as far as the platform is concerned.

Two costs, and they are real. It downloads 82–310 MB once, depending on the
build. And the first sentence takes a while — the model warms up on its
first inference — so the status line says *preparing audio…* until sound
starts. Later sentences are generated well ahead of being needed.

In a **desktop** background tab either voice keeps reading, and three things
make that work:

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
| Chrome Android | yes | yes | yes | on-device voice | yes |
| Firefox | folder upload | no | yes | yes | yes |
| Safari / iOS | folder upload | no | yes | on-device voice | needs Safari 26+ |

On a phone, background reading needs the on-device voice; a browser voice
pauses and resumes instead. **Settings → On-device voice** carries the
download, the voice list and the build choice.

### Voices

Kokoro ships four British female voices, of which `bf_emma` is much the
best (the model card grades it B−, against C for Isabella and D for Alice
and Lily), four British male, and the American voices, where `af_heart` (A)
and `af_bella` (A−) are the strongest in the set. Note that a voice cannot
be carried across engines: the ones your browser offers and the ones Kokoro
offers are separate, unrelated sets.

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
js/docx.js              Word documents, via mammoth
library/                149 books as cleaned text, plus index.json
vendor/pdfjs/           pdf.js 6.2.108, vendored so reading works offline
vendor/mammoth/         mammoth 1.11, likewise
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
[mammoth.js](https://github.com/mwilliamson/mammoth.js) (BSD-2-Clause),
[transformers.js](https://huggingface.co/docs/transformers.js) (Apache-2.0),
and [Liquid AI LFM2](https://huggingface.co/LiquidAI) models.
