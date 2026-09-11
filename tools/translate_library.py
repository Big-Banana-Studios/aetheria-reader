#!/usr/bin/env python3
"""
Translate the non-English books in the Aetheria Reader library into
English -- once, on this machine -- and publish the result as ordinary
book files beside the originals.

    python tools/translate_library.py library --list
    python tools/translate_library.py library --lang French
    python tools/translate_library.py library --lang Latin
    python tools/translate_library.py library --only <book-id>
    python tools/translate_library.py library --trial 12 --lang Latin
    python tools/translate_library.py library --sample <book-id>
    python tools/translate_library.py library --sync

Each translated book becomes library/<id>.en.json, in exactly the shape of
the original (sections of headings and paragraphs), so the reader needs
nothing new to read it. The catalogue row gains an `e` field holding the
English file's size in KB. The models never go anywhere near the
repository: they live in the Hugging Face cache on the machine that runs
this, the way the source PDFs live on a USB drive.

Two engines, chosen by language:

  marian   Helsinki-NLP OPUS-MT, one model per language pair. Fast, good
           on clean modern prose, hopeless on OCR noise. French, German,
           Italian.
  llm      A small instruction-tuned language model, told what century
           the print is from and what OCR does to it. Slower, far more
           tolerant of long-s-as-f and broken ligatures, and the only
           option for Latin, which has no OPUS-MT pair.

Work is cached per segment under tools/.translate-cache/, so a run that is
interrupted picks up where it stopped, and a change of model starts a
fresh cache rather than mixing two translators in one book.

Needs the venv described in the README (torch with CUDA, transformers,
sentencepiece, sacremoses).
"""

import argparse
import json
import os
import random
import re
import sys
import time
from datetime import date

# -- What translates what ----------------------------------------------------

# Verified to exist on the Hub, 2026-09-10. "tc-big" builds are the newer
# transformer-big models and translate noticeably better; German has none.
MARIAN = {
    "French":  "Helsinki-NLP/opus-mt-tc-big-fr-en",
    "German":  "Helsinki-NLP/opus-mt-de-en",
    "Italian": "Helsinki-NLP/opus-mt-tc-big-it-en",
    "Spanish": "Helsinki-NLP/opus-mt-es-en",
    "Dutch":   "Helsinki-NLP/opus-mt-nl-en",
}

# Languages with no Marian pair go through the LLM. Latin is the one that
# matters here: 36 books, and every one of them an early-modern print.
LLM_LANGUAGES = {"Latin"}

DEFAULT_LLM = "LiquidAI/LFM2.5-2.6B"

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".translate-cache")

# Bumped when the way segments are prepared changes, so that entries made
# the old way are redone rather than trusted. 2: capitals lower-cased first.
CACHE_VERSION = 2


# -- Text handling -----------------------------------------------------------

# Mirrors splitSentences in js/reader.js, so a translated paragraph breaks
# into the same sentences the reader would have spoken. One difference: the
# reader drops a trailing fragment with no full stop, and here it is kept,
# because losing text is worse than an odd pause.
SENTENCE_RE = re.compile(
    "(?:[^.!?\u2026]|\\.(?=[a-z]|[A-Z]\\.|\\d))*[.!?\u2026]+[\"')\\]]?\\s*")
PAGES_HEADING_RE = re.compile("^Pages \\d+\u2013\\d+$")
TRIM_PUNCT = ".,;:!?()[]\"\u201c\u201d\u2018\u2019"


def split_sentences(text):
    text = text.strip()
    if not text:
        return []
    out, end = [], 0
    for m in SENTENCE_RE.finditer(text):
        if m.end() == m.start():
            continue
        s = m.group(0).strip()
        if len(s) > 2:
            out.append(s)
        end = m.end()
    tail = text[end:].strip()
    if len(tail) > 2:
        out.append(tail)
    return out or [text]


def chunk_words(text, max_words):
    """Break an over-long run at clause boundaries, never mid-word."""
    words = text.split()
    if len(words) <= max_words:
        return [text]
    pieces, cur = [], []
    for w in words:
        cur.append(w)
        if (len(cur) >= max_words * 0.6 and w[-1:] in ",;:") or len(cur) >= max_words:
            pieces.append(" ".join(cur))
            cur = []
    if cur:
        pieces.append(" ".join(cur))
    return pieces


def is_caps(text):
    """Set in capitals: a heading, or a title page's display type."""
    letters = [c for c in text if c.isalpha()]
    return len(letters) >= 4 and sum(c.isupper() for c in letters) / len(letters) > 0.8


def uncap(text):
    low = text.lower()
    return low[:1].upper() + low[1:]


def group_sentences(sentences, max_words):
    """Pack sentences into runs of about max_words, for the LLM."""
    groups, cur, n = [], [], 0
    for s in sentences:
        w = len(s.split())
        if cur and n + w > max_words:
            groups.append(" ".join(cur))
            cur, n = [], 0
        cur.append(s)
        n += w
    if cur:
        groups.append(" ".join(cur))
    return groups


WORD_RE = re.compile("^[^\\W\\d_]+(?:['\u2019-][^\\W\\d_]+)*$", re.U)
VOWEL_RE = re.compile("[aeiouy\u00e4\u00f6\u00fc\u00e9\u00e8\u00ea\u00e0\u00e2\u00f9\u00fb\u00f4\u00ee\u00ef\u0153\u00e6]", re.I)


def clean_score(sections):
    """
    How much of this reads as words at all, 0-100.

    OCR of Fraktur and of early-modern Latin type comes out as letter
    salad, and no translator turns letter salad into prose. Measured on a
    stretch from the middle of the book, as the language tagger does.
    """
    text = " ".join(p for s in sections for p in s["p"])
    mid = text[len(text) // 4: len(text) // 4 + 80000]
    toks = mid.split()
    if not toks:
        return 0
    good = sum(1 for t in toks
               if WORD_RE.match(t.strip(TRIM_PUNCT))
               and VOWEL_RE.search(t) and len(t) <= 22)
    return round(100 * good / len(toks))


# -- Engines -----------------------------------------------------------------

def pick_device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    print("  (no CUDA device: running on CPU, which will be very slow)")
    return "cpu"


def is_oom(err):
    import torch
    if isinstance(err, torch.cuda.OutOfMemoryError):
        return True
    return "out of memory" in str(err).lower()


def in_batches(items, batch, run):
    """
    Apply `run` to successive slices of `items`, shrinking the slice when
    the GPU runs out of memory rather than dying. Something else may be
    using the card, a run of unusually long segments may not fit, and a
    long book should not be lost to either.
    """
    import torch
    out = []
    start = 0
    size = max(1, batch)
    while start < len(items):
        chunk = items[start:start + size]
        try:
            out.extend(run(chunk))
            start += len(chunk)
        except Exception as err:
            if not is_oom(err) or size == 1:
                raise
            size = max(1, size // 2)
            torch.cuda.empty_cache()
            sys.stdout.write("\n  (out of GPU memory: batch now %d)\n" % size)
    return out


class MarianEngine:
    """One OPUS-MT model. Segments are sentences; batches are length-sorted."""

    name = "marian"

    def __init__(self, model_id, batch=48, fp32=False, beams=4):
        from transformers import MarianMTModel, MarianTokenizer
        self.model_id = model_id
        self.batch = batch
        self.beams = beams
        self.device = pick_device()
        print("  loading %s" % model_id)
        self.tok = MarianTokenizer.from_pretrained(model_id)
        self.model = MarianMTModel.from_pretrained(model_id).to(self.device).eval()
        if self.device == "cuda" and not fp32:
            self.model.half()

    def segments(self, paragraph):
        out = []
        for s in split_sentences(paragraph):
            out.extend(chunk_words(s, 120))
        return out

    def translate(self, texts, **_):
        import torch
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))

        def run(idx):
            # Display type defeats these models -- "MENSTRUE PUANT" came
            # back as "A HUGE MENSTRUE". Translate it in lower case and
            # restore the capitals after, so a heading still reads as one.
            caps = [is_caps(texts[i]) for i in idx]
            batch = [uncap(texts[i]) if c else texts[i] for i, c in zip(idx, caps)]
            enc = self.tok(batch, return_tensors="pt", padding=True,
                           truncation=True, max_length=512).to(self.device)
            with torch.inference_mode():
                gen = self.model.generate(**enc, num_beams=self.beams,
                                          max_new_tokens=512)
            outs = [t.strip() for t in self.tok.batch_decode(gen, skip_special_tokens=True)]
            return [t.upper() if c else t for t, c in zip(outs, caps)]

        result = [""] * len(texts)
        for i, text in zip(order, in_batches(order, self.batch, run)):
            result[i] = text
        return result


LLM_SYSTEM = (
    "You are a translator of old books. Translate the {language} text into "
    "clear, natural, modern English. The text is OCR from a book printed in "
    "{year}: expect the long s read as 'f', ligatures and abbreviations "
    "mangled, and old spellings. Translate what was evidently meant. "
    "Output only the English translation: no notes, no preamble, no "
    "original text, no commentary."
)


class LlmEngine:
    """A chat model with a fixed instruction. Segments are paragraphs."""

    name = "llm"

    def __init__(self, model_id, batch=8, max_words=170, **_):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.model_id = model_id
        self.batch = batch
        self.max_words = max_words
        self.device = pick_device()
        print("  loading %s" % model_id)
        self.tok = AutoTokenizer.from_pretrained(model_id)
        self.tok.padding_side = "left"
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        try:
            self.model = AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype)
        except TypeError:                                   # older transformers
            self.model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=dtype)
        self.model = self.model.to(self.device).eval()

    def segments(self, paragraph):
        if len(paragraph.split()) <= self.max_words * 1.3:
            return [paragraph]
        return group_sentences(split_sentences(paragraph), self.max_words)

    def _prompt(self, text, language, year):
        messages = [
            {"role": "system", "content": LLM_SYSTEM.format(
                language=language, year=year or "an earlier century")},
            {"role": "user", "content": text},
        ]
        prompt = self.tok.apply_chat_template(messages, tokenize=False,
                                              add_generation_prompt=True)
        # A "thinking" model's template opens a scratchpad for the answer
        # to begin in. Translation does not need one, and a paragraph of
        # deliberation per paragraph of Latin would be paid for in time
        # and then thrown away, so the block is closed before the model
        # sees it -- the same convention hybrid models document.
        if prompt.rstrip().endswith("<think>"):
            prompt = prompt.rstrip() + "\n\n</think>\n\n"
        return prompt

    def translate(self, texts, language="the source language", year=None):
        import torch
        prompts = [self._prompt(t, language, year) for t in texts]
        order = sorted(range(len(texts)), key=lambda i: len(prompts[i]))

        def run(idx):
            enc = self.tok([prompts[i] for i in idx], return_tensors="pt",
                           padding=True, add_special_tokens=False).to(self.device)
            in_len = enc["input_ids"].shape[1]
            longest = max(len(self.tok(texts[i])["input_ids"]) for i in idx)
            with torch.inference_mode():
                gen = self.model.generate(
                    **enc, do_sample=False, repetition_penalty=1.05,
                    max_new_tokens=min(1400, int(longest * 2.0) + 48),
                    pad_token_id=self.tok.pad_token_id)
            outs = self.tok.batch_decode(gen[:, in_len:], skip_special_tokens=True)
            return [tidy_llm_output(t, texts[i]) for i, t in zip(idx, outs)]

        result = [""] * len(texts)
        for i, text in zip(order, in_batches(order, self.batch, run)):
            result[i] = text
        return result


# The ways a chat model talks about a text instead of translating it.
COMMENTARY_RE = re.compile(
    r"^(?:what does|the (?:text|passage|latin|phrase|word)s? (?:appears?|seems?|is)|"
    r"this (?:text|passage|phrase|appears|seems|is a)|it (?:seems|appears|looks)|"
    r"i(?:'m| am) (?:sorry|unable|not able)|i (?:cannot|can't|could not)|"
    r"sorry|unfortunately|note:|please provide|as an ai)", re.I)


def tidy_llm_output(text, source):
    """Strip the ways a chat model dresses up an answer it was told not to."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    text = re.sub(r"^(?:here is|here's) the (?:english )?translation:?\s*", "",
                  text, flags=re.I)
    text = re.sub(r"^\*\*?(?:english )?translation:?\*\*?:?\s*", "", text, flags=re.I).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    # A model that gave up and echoed the input, ran off into a loop, or
    # discussed the passage instead of rendering it, is worse than the
    # original standing in for it.
    if not text or text == source:
        return ""
    if len(text) > 3 * len(source) + 80 or COMMENTARY_RE.match(text):
        return ""
    return text


def trivial(text):
    """Too short to translate: a stray word, a number, a printer's mark."""
    words = text.split()
    return len(words) < 3 or not VOWEL_RE.search(text)


# -- The catalogue -----------------------------------------------------------

def load_index(dest):
    with open(os.path.join(dest, "index.json"), encoding="utf-8") as fh:
        return json.load(fh)


def save_index(dest, index):
    with open(os.path.join(dest, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))


def english_path(dest, book_id):
    return os.path.join(dest, book_id + ".en.json")


def load_book(dest, book_id):
    with open(os.path.join(dest, book_id + ".json"), encoding="utf-8") as fh:
        return json.load(fh)


def candidates(index, args):
    rows = []
    for row in index["books"]:
        lang = row.get("l")
        if args.only:
            if row["id"] in args.only:
                rows.append(row)
            continue
        if not lang or lang == "English":
            continue
        if args.lang and lang not in args.lang:
            continue
        if lang not in MARIAN and lang not in LLM_LANGUAGES and args.engine != "llm":
            continue
        rows.append(row)
    return rows


def engine_for(lang, args):
    if args.engine == "llm" or (args.engine == "auto" and lang not in MARIAN):
        return "llm", args.model or DEFAULT_LLM
    return "marian", args.model or MARIAN[lang]


# -- The work ----------------------------------------------------------------

def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


class SegmentCache:
    """Append-only record of every segment translated so far for one book."""

    def __init__(self, book_id, model_id):
        os.makedirs(CACHE_DIR, exist_ok=True)
        self.path = os.path.join(CACHE_DIR, "%s.%s.jsonl" % (book_id, slug(model_id)))
        self.done = {}
        self.version = 1
        if os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                        if "v" in rec:
                            self.version = max(self.version, int(rec["v"]))
                        else:
                            self.done[rec["k"]] = rec["t"]
                    except (ValueError, KeyError, TypeError):
                        pass
        self.fh = open(self.path, "a", encoding="utf-8")

    def put(self, key, text):
        self.done[key] = text
        self.fh.write(json.dumps({"k": key, "t": text}, ensure_ascii=False) + "\n")

    def mark_current(self):
        """Record that everything in here was made the current way."""
        if self.version < CACHE_VERSION:
            self.fh.write(json.dumps({"v": CACHE_VERSION}) + "\n")
            self.version = CACHE_VERSION

    def flush(self):
        self.fh.flush()

    def close(self):
        self.fh.close()


def plan_segments(book, engine):
    """Every piece of text to translate, keyed so it can be put back."""
    units = []                                        # (key, text)
    for si, sec in enumerate(book["sections"]):
        h = sec.get("h") or ""
        if h and not PAGES_HEADING_RE.match(h) and h not in ("Beginning", "Untitled"):
            units.append(("%d:h" % si, h))
        for pi, para in enumerate(sec["p"]):
            for gi, seg in enumerate(engine.segments(para)):
                units.append(("%d:%d:%d" % (si, pi, gi), seg))
    return units


def assemble(book, cache, engine_name, model_id, language):
    sections = []
    for si, sec in enumerate(book["sections"]):
        h = sec.get("h") or ""
        head = cache.done.get("%d:h" % si) or h
        paras = []
        for pi, para in enumerate(sec["p"]):
            pieces = []
            for gi in range(10000):
                key = "%d:%d:%d" % (si, pi, gi)
                if key not in cache.done:
                    break
                pieces.append(cache.done[key])
            text = " ".join(p for p in pieces if p).strip()
            paras.append(text or para)            # untranslatable: keep the original
        sections.append({"h": head, "p": paras})
    words = sum(len(p.split()) for s in sections for p in s["p"])
    return {
        "id": book["id"], "title": book.get("title"), "author": book.get("author"),
        "year": book.get("year"), "note": book.get("note"),
        "pages": book.get("pages"), "words": words, "sections": sections,
        "translated": {"from": language, "engine": engine_name,
                       "model": model_id, "date": date.today().isoformat()},
    }


def translate_book(dest, row, engine, args):
    book = load_book(dest, row["id"])
    language = row.get("l") or "the source language"
    cache = SegmentCache(row["id"], engine.model_id)
    units = plan_segments(book, engine)
    if cache.version < 2 and engine.name == "marian":
        # Earlier runs fed capitals straight to the model; redo those lines.
        for key, text in units:
            if key in cache.done and is_caps(text):
                del cache.done[key]
    todo = [(k, t) for k, t in units if k not in cache.done]
    if engine.name == "llm":
        # A one-word paragraph is OCR debris, and a chat model asked to
        # translate "eteninii" writes an essay about it. Leave such
        # fragments as they are.
        for key, text in todo:
            if trivial(text):
                cache.put(key, text)
        cache.flush()
        todo = [(k, t) for k, t in todo if not trivial(t)]
    total_words = sum(len(t.split()) for _, t in units)
    todo_words = sum(len(t.split()) for _, t in todo)

    print("  %d segments, %s words%s" % (
        len(units), "{:,}".format(total_words),
        "" if not cache.done else " (%d already done)" % (len(units) - len(todo))))

    started = time.perf_counter()
    failed = 0
    run_words = 0
    step = engine.batch * 4
    try:
        for start in range(0, len(todo), step):
            chunk = todo[start:start + step]
            outs = engine.translate([t for _, t in chunk],
                                    language=language, year=book.get("year"))
            for (key, src), out in zip(chunk, outs):
                if not out:
                    failed += 1
                cache.put(key, out)
            cache.flush()
            run_words += sum(len(t.split()) for _, t in chunk)
            elapsed = time.perf_counter() - started
            rate = run_words / max(elapsed, 1e-6)
            left = (todo_words - run_words) / max(rate, 1e-6)
            sys.stdout.write("\r  %5.1f%%  %6.0f words/s  ~%s left    " % (
                100.0 * (total_words - todo_words + run_words) / max(total_words, 1),
                rate, fmt_time(left)))
            sys.stdout.flush()
        cache.mark_current()
    finally:
        cache.close()
    print()

    out = assemble(book, cache, engine.name, engine.model_id, language)
    path = english_path(dest, row["id"])
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    kb = round(os.path.getsize(path) / 1024)
    row["e"] = kb
    print("  wrote %s  (%s English words, %d KB%s)" % (
        os.path.basename(path), "{:,}".format(out["words"]), kb,
        "" if not failed else ", %d segments left in the original" % failed))
    return kb


def fmt_time(seconds):
    seconds = int(seconds)
    if seconds < 90:
        return "%ds" % seconds
    if seconds < 5400:
        return "%dm" % (seconds // 60)
    return "%.1fh" % (seconds / 3600)


# -- Commands ----------------------------------------------------------------

def cmd_list(dest, index, args):
    rows = candidates(index, args)
    print("%-8s %5s %6s %-5s %-7s  %s" % ("lang", "clean", "words", "done", "engine", "title"))
    total_kb = 0
    for row in rows:
        book = load_book(dest, row["id"])
        score = clean_score(book["sections"])
        eng, _ = engine_for(row.get("l"), args)
        mark = "yes" if row.get("e") else ("skip" if score < args.min_clean else "")
        total_kb += row.get("e") or 0
        print("%-8s %5d %5dk %-5s %-7s  %s" % (
            row.get("l") or "?", score, row["w"] // 1000, mark, eng, row["t"][:60]))
    print("\n%d books; %.1f MB of English already published" % (len(rows), total_kb / 1024))


def cmd_sample(dest, row, n=5):
    src = load_book(dest, row["id"])
    en_path = english_path(dest, row["id"])
    if not os.path.exists(en_path):
        print("no translation yet for %s" % row["id"])
        return
    with open(en_path, encoding="utf-8") as fh:
        en = json.load(fh)
    pairs = [(s["p"][i], e["p"][i]) for s, e in zip(src["sections"], en["sections"])
             for i in range(min(len(s["p"]), len(e["p"]))) if 15 < len(s["p"][i].split()) < 120]
    random.seed(1)
    for a, b in random.sample(pairs, min(n, len(pairs))):
        print("\n-- %s\n%s\n-- English\n%s" % (row.get("l"), a, b))
    print("\n(%s, %s)" % (en["translated"]["engine"], en["translated"]["model"]))


def cmd_sync(dest, index):
    """Make the catalogue's `e` flags match the files actually present."""
    changed = 0
    for row in index["books"]:
        path = english_path(dest, row["id"])
        had = row.get("e")
        if os.path.exists(path):
            row["e"] = round(os.path.getsize(path) / 1024)
        else:
            row.pop("e", None)
        if had != row.get("e"):
            changed += 1
    save_index(dest, index)
    n = sum(1 for r in index["books"] if r.get("e"))
    print("%d translations on disk, %d rows changed" % (n, changed))


def cmd_trial(dest, index, args):
    """Translate a few segments of one book and print the pairs, writing nothing."""
    rows = candidates(index, args)
    if not args.only:
        rows = [r for r in rows
                if clean_score(load_book(dest, r["id"])["sections"]) >= args.min_clean]
    if not rows:
        sys.exit("nothing matches")
    row = rows[0]
    eng, model = engine_for(row.get("l"), args)
    engine = make_engine(eng, model, args)
    book = load_book(dest, row["id"])
    units = [(k, t) for k, t in plan_segments(book, engine) if ":h" not in k]
    mid = len(units) // 2
    pick = units[mid: mid + args.trial]
    print("== %s (%s, %s)" % (row["t"], row.get("l"), model))
    t0 = time.perf_counter()
    outs = engine.translate([t for _, t in pick], language=row.get("l"), year=book.get("year"))
    dt = time.perf_counter() - t0
    for (_, src), out in zip(pick, outs):
        print("\n> %s\n= %s" % (src, out or "[no output]"))
    words = sum(len(t.split()) for _, t in pick)
    print("\n%d words in %.1fs = %.0f words/s" % (words, dt, words / max(dt, 1e-6)))


def make_engine(kind, model, args):
    if kind == "llm":
        return LlmEngine(model, batch=args.batch or 8)
    return MarianEngine(model, batch=args.batch or 48, fp32=args.fp32, beams=args.beams)


def main():
    ap = argparse.ArgumentParser(description="Translate the library's non-English books into English.")
    ap.add_argument("dest", nargs="?", default="library", help="the library folder (default: library)")
    ap.add_argument("--lang", action="append", help="only this language (repeatable)")
    ap.add_argument("--only", action="append", help="only this book id (repeatable)")
    ap.add_argument("--engine", choices=["auto", "marian", "llm"], default="auto",
                    help="auto picks Marian where a pair exists and the LLM otherwise")
    ap.add_argument("--model", help="override the model id for whichever engine runs")
    ap.add_argument("--min-clean", type=int, default=70,
                    help="skip books whose text scores below this for OCR cleanliness (default 70)")
    ap.add_argument("--limit", type=int, help="stop after this many books")
    ap.add_argument("--force", action="store_true", help="redo books already translated")
    ap.add_argument("--batch", type=int, help="segments per model call")
    ap.add_argument("--beams", type=int, default=4, help="Marian beam width (default 4)")
    ap.add_argument("--fp32", action="store_true", help="run Marian in full precision")
    ap.add_argument("--list", action="store_true", help="show what would be translated, and how")
    ap.add_argument("--trial", type=int, metavar="N", help="translate N segments of the first match and print them")
    ap.add_argument("--sample", metavar="ID", help="print a few paragraphs of a finished translation beside the original")
    ap.add_argument("--sync", action="store_true", help="repair the catalogue's flags from the files present")
    args = ap.parse_args()

    dest = args.dest
    index = load_index(dest)

    if args.sync:
        cmd_sync(dest, index)
        return
    if args.list:
        cmd_list(dest, index, args)
        return
    if args.sample:
        row = next((r for r in index["books"] if r["id"] == args.sample), None)
        if not row:
            sys.exit("no such book: %s" % args.sample)
        cmd_sample(dest, row)
        return
    if args.trial:
        cmd_trial(dest, index, args)
        return

    rows = candidates(index, args)
    if not rows:
        sys.exit("Nothing to translate for that selection. Try --list.")

    engines = {}
    done = 0
    total_kb = 0
    for row in rows:
        if args.limit and done >= args.limit:
            break
        if row.get("e") and not args.force and os.path.exists(english_path(dest, row["id"])):
            continue
        book = load_book(dest, row["id"])
        score = clean_score(book["sections"])
        if score < args.min_clean and not args.only:
            print("\n== %s  [%s]  skipped: OCR too poor (%d < %d)" % (
                row["t"][:60], row.get("l"), score, args.min_clean))
            continue

        kind, model = engine_for(row.get("l"), args)
        key = (kind, model)
        if key not in engines:
            engines.clear()                       # one model in memory at a time
            engines[key] = make_engine(kind, model, args)

        print("\n== %s  [%s, clean %d]" % (row["t"][:60], row.get("l"), score))
        total_kb += translate_book(dest, row, engines[key], args)
        save_index(dest, index)                   # after every book, so a stop loses nothing
        done += 1

    print("\n%d book(s) translated, %.1f MB added to the library" % (done, total_kb / 1024))


if __name__ == "__main__":
    main()
