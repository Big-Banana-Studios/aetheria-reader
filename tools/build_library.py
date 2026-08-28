#!/usr/bin/env python3
"""
Build the Aetheria Reader library from a folder of PDFs.

Extracts the text layer of every PDF (via pdftotext), cleans up OCR
artefacts, splits the result into sections and writes one compact JSON
file per book plus a catalog index.

    python tools/build_library.py "../Buddism books" library --name Buddhism
    python tools/build_library.py /e/BookSets library --sets

Books already extracted are kept, so adding a new set does not re-do the
old ones. Collections not named in a run are carried over untouched.

Requires `pdftotext` (Poppler / Xpdf) on PATH.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
from collections import Counter
from datetime import date

# -- Filename parsing ------------------------------------------------------

# "Title by Author (1932).pdf" / "Titre par Auteur (1862).pdf" / "Title (1908).pdf"
YEAR_RE = re.compile(r"\((\d{4})\)")
SD_RE = re.compile(r"\((?:s\.d|19--|n\.d)\.?\)", re.I)
BY_RE = re.compile(r"\s+(?:by|par|von)\s+", re.I)
NOTE_RE = re.compile(r"\((German text|French text|unknown author)\)", re.I)


def parse_name(stem):
    """Split a filename stem into title / author / year / note."""
    note = None
    m = NOTE_RE.search(stem)
    if m:
        note = m.group(1)
        stem = NOTE_RE.sub("", stem)

    year = None
    m = YEAR_RE.search(stem)
    if m:
        year = int(m.group(1))
        stem = YEAR_RE.sub("", stem)
    stem = SD_RE.sub("", stem)
    stem = re.sub(r"\s{2,}", " ", stem).strip(" .-")

    author = None
    parts = BY_RE.split(stem)
    if len(parts) >= 2:
        title = parts[0].strip(" .,-")
        author = parts[-1].strip(" .,-")
    else:
        # Some sets use "Title - Author" instead of "Title by Author". Only
        # take the tail when it actually looks like a name, or subtitles
        # ("Assyria - its princes, priests and people") lose half of
        # themselves to the author field.
        title = stem.strip(" .,-")
        head, sep, tail = stem.rpartition(" - ")
        if sep and looks_like_name(tail.strip(" .,")):
            title = head.strip(" .,-")
            author = tail.strip(" .,-")

    if author and len(author) > 90:
        author = None
    return title or stem, author, year, note


# "G. Smith", "E. A. Budge", "The British Museum" — but not a subtitle
NAME_RE = re.compile(
    r"^(?:[A-Z]\.\s*)*[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3}$", re.U)


def looks_like_name(text):
    if not text or len(text) > 45:
        return False
    words = text.split()
    if not 1 <= len(words) <= 5:
        return False
    # A trailing subtitle usually reads as a phrase, not a name
    if any(w.lower() in ("of", "the", "and", "in", "to", "from", "with", "its")
           for w in words[1:]):
        return False
    return bool(NAME_RE.match(text))


def slugify(text, fallback="book"):
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return (text or fallback)[:80].strip("-")


# -- Text cleaning ---------------------------------------------------------

PAGE_NUM_RE = re.compile(r"^\s*[\[(]?\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*[\])]?\s*$", re.I)


def clean_page(page):
    """Drop page numbers from the top and bottom of one page."""
    lines = page.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    for edge in (0, -1):
        if not lines:
            break
        if PAGE_NUM_RE.match(lines[edge].strip()):
            lines.pop(edge)
    return "\n".join(lines)


def strip_running_headers(pages):
    """Remove short lines that repeat as the first line across many pages."""
    heads = Counter()
    for p in pages:
        for line in p.split("\n"):
            s = line.strip()
            if s:
                if len(s) < 70:
                    heads[re.sub(r"\d+", "#", s.lower())] += 1
                break
    threshold = max(4, len(pages) // 8)
    common = {h for h, n in heads.items() if n >= threshold}
    if not common:
        return pages
    out = []
    for p in pages:
        lines = p.split("\n")
        for i, line in enumerate(lines):
            s = line.strip()
            if not s:
                continue
            if re.sub(r"\d+", "#", s.lower()) in common:
                lines.pop(i)
            break
        out.append("\n".join(lines))
    return out


HYPHEN_RE = re.compile(r"(\w)[-‐‑]\s*\n\s*(\w)")
LIGATURES = {
    "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl",
    "ﬃ": "ffi", "ﬄ": "ffl", "­": "",
}


def is_prose(p):
    """Reject OCR noise, index tables and stray page-number columns."""
    if len(p) < 3:
        return False
    letters = sum(ch.isalpha() for ch in p)
    return letters >= max(3, len(p) * 0.5)


# Four or more single letters in a row: display type from a title page,
# set with wide letter-spacing. Prose never looks like this, and a speech
# synthesiser would otherwise spell it out one letter at a time.
LETTERSPACED_RE = re.compile(r"\w(?: \w){3,}")


def collapse_letter_spacing(text):
    """'B O O K  L I B R A R Y' -> 'BOOK LIBRARY'."""
    return LETTERSPACED_RE.sub(lambda m: m.group(0).replace(" ", ""), text)


def page_blocks(text):
    """Reflow one page into a list of ('h', heading) / ('p', paragraph).

    Headings are recognised line by line, before lines are joined into
    paragraphs -- in most of these editions a heading sits on its own line
    with no blank line after it, so detecting it post-reflow would glue it
    onto the opening sentence of the chapter.
    """
    for k, v in LIGATURES.items():
        text = text.replace(k, v)
    text = HYPHEN_RE.sub(r"\1\2", text)          # join hyphen-split words
    text = collapse_letter_spacing(text)         # before spaces are squashed
    text = re.sub(r"[ \t]+", " ", text)

    blocks, buf = [], []

    def flush():
        if not buf:
            return
        p = re.sub(r"\s{2,}", " ", " ".join(buf)).strip()
        buf.clear()
        if is_prose(p):
            blocks.append(("p", p))

    for line in text.split("\n"):
        s = line.strip()
        if not s:
            flush()
        elif is_heading(s):
            flush()
            # Merge a run of adjacent heading lines ("CHAPTER I" + "THE BIRTH")
            if blocks and blocks[-1][0] == "h" and len(blocks[-1][1]) + len(s) < 90:
                blocks[-1] = ("h", blocks[-1][1] + " — " + s)
            else:
                blocks.append(("h", s))
        else:
            buf.append(s)
    flush()
    return blocks


# -- Heading detection -----------------------------------------------------

KEYWORDS = (
    r"CHAPTER|BOOK|PART|SECTION|LECTURE|APPENDIX|PREFACE|INTRODUCTION|"
    r"FOREWORD|CANTO|VOLUME|SUTTA|SUTRA|DISCOURSE|ESSAY|LETTER"
)
KEYWORD_RE = re.compile(
    r"^\s*(" + KEYWORDS + r")\b[\s.:\-]*[IVXLCDM\d]*[\s.:\-]*$", re.I)
KEYWORD_LEAD_RE = re.compile(
    r"^\s*(" + KEYWORDS + r")\s+[IVXLCDM\d]+\b", re.I)


def is_heading(p):
    if len(p) > 80:
        return False
    if KEYWORD_RE.match(p) or KEYWORD_LEAD_RE.match(p):
        return True
    # Short ALL-CAPS line with no terminal punctuation
    letters = [c for c in p if c.isalpha()]
    if len(letters) >= 4 and len(p) <= 60 and not p.endswith((".", ",", ";", "?", "!")):
        if sum(c.isupper() for c in letters) / len(letters) > 0.9:
            return True
    return False


def page_groups(flat, pages, group=8):
    """Fallback sectioning: fixed runs of pages."""
    sections, cur, start = [], [], 0
    for kind, text, pi in flat:
        if pi // group != start // group and cur:
            sections.append({"h": "Pages %d–%d" % (start + 1, pi), "p": cur})
            cur, start = [], pi
        cur.append(text)
    if cur:
        sections.append({"h": "Pages %d–%d" % (start + 1, len(pages)), "p": cur})
    return sections


ENDS_SENTENCE_RE = re.compile(r"""[.!?…]["')\]]?\s*$""")
TRAILING_HYPHEN_RE = re.compile(r"[-‐‑]$")


def continues_paragraph(prev, nxt):
    """Does one block of text run straight on into the next?

    Scans break a single paragraph into pieces constantly -- at page ends,
    at column ends, and wherever OCR read the leading of a line as a blank
    line. Left alone, each piece becomes its own utterance and the reader
    hears a pause dropped into the middle of a sentence.

    The test is deliberately strict: the first piece must not have ended a
    sentence, *and* the second must start lower-case (or the first must end
    on a mark that cannot close one). A genuine new paragraph opening with a
    capital is therefore never swallowed, even when OCR lost its full stop.
    """
    if ENDS_SENTENCE_RE.search(prev):
        return False
    return (nxt[:1].islower() and nxt[:1].isalpha()) or prev[-1:] in ",;:—–-"


def join_paragraph(prev, nxt):
    if TRAILING_HYPHEN_RE.search(prev):
        return TRAILING_HYPHEN_RE.sub("", prev) + nxt   # word split by the break
    return prev + " " + nxt


def build_sections(pages):
    """Split pages into sections, preferring detected headings."""
    flat = []                                     # [(kind, text, page_index)]
    for pi, page in enumerate(pages):
        for kind, text in page_blocks(page):
            if (kind == "p" and flat and flat[-1][0] == "p"
                    and continues_paragraph(flat[-1][1], text)):
                flat[-1] = ("p", join_paragraph(flat[-1][1], text), flat[-1][2])
                continue
            flat.append((kind, text, pi))
    if not flat:
        return []

    marks = [i for i, (k, _, _) in enumerate(flat) if k == "h"]
    prose = [(t, pi) for k, t, pi in flat if k == "p"]
    if not prose:
        return []

    fallback = [("p", t, pi) for t, pi in prose]
    if not marks:
        return page_groups(fallback, pages)

    sections = []
    if marks[0] != 0:
        marks = [0] + marks
    for n, start in enumerate(marks):
        end = marks[n + 1] if n + 1 < len(marks) else len(flat)
        body = flat[start:end]
        if not body:
            continue
        head = body[0][1] if body[0][0] == "h" else "Beginning"
        paras = [t for k, t, _ in body if k == "p"]
        if paras:
            sections.append({"h": head.strip(" .:-—") or "Untitled", "p": paras})

    # Fold runaway-short sections into the previous one, so navigation is not
    # a wall of two-line entries.
    merged = []
    for s in sections:
        if merged and sum(len(p.split()) for p in s["p"]) < 80:
            merged[-1]["p"].extend(s["p"])
        else:
            merged.append(s)

    # Heading detection is unreliable on noisy scans. Judge it only after
    # merging: more than one section per page means it fired on OCR junk
    # rather than on real chapter headings.
    if not merged or len(merged) > max(8, len(pages) * 0.75):
        return page_groups(fallback, pages)
    return merged


# -- Readability -----------------------------------------------------------

STOPWORDS = frozenset(
    "the of and to in is was that a it as for with by his he on at from not "
    "this which were be or had have their but they all we you her she him "
    "them".split())


def prose_score(sections):
    """
    Roughly, how much of this reads as English prose.

    These sets contain scholarly editions that are mostly transliterated
    cuneiform, and a few volumes in German or French. They extract
    perfectly well and are useless read aloud by an English voice, so the
    library says so rather than letting someone find out by pressing play.
    Measured as the share of words that are common English function words:
    ordinary prose runs well above 18%, transliteration near zero.
    """
    text = " ".join(p for s in sections for p in s["p"])
    mid = text[len(text) // 4: len(text) // 4 + 60000]
    words = re.findall(r"[A-Za-z'-]+", mid.lower())
    if len(words) < 200:
        return 0
    return round(100 * sum(w in STOPWORDS for w in words) / len(words))


# -- Main ------------------------------------------------------------------

def extract(path):
    """Return a list of page texts, or None if the PDF has no usable text."""
    try:
        out = subprocess.run(
            ["pdftotext", "-enc", "UTF-8", "-q", path, "-"],
            capture_output=True, timeout=900,
        )
    except subprocess.TimeoutExpired:
        return None
    text = out.stdout.decode("utf-8", "replace")
    if not text.strip():
        return None
    pages = [clean_page(p) for p in text.split("\f")]
    pages = [p for p in pages if p.strip()]
    return strip_running_headers(pages)


def load_index(dest):
    """Existing catalogue, so a rerun need not re-extract everything."""
    path = os.path.join(dest, "index.json")
    if not os.path.exists(path):
        return {"collections": [], "books": []}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def build_collection(src, dest, name, existing, force=False):
    """Extract one folder of PDFs into `dest`, returning its catalogue rows."""
    coll_id = slugify(name)
    pdfs = sorted(f for f in os.listdir(src) if f.lower().endswith(".pdf"))
    if not pdfs:
        print("  (no PDFs in %s)" % src)
        return coll_id, [], []

    # Books already extracted are reused unless asked otherwise: a full run
    # over a large set takes many minutes, and adding a new set should not
    # mean redoing the ones already done.
    known = {b["id"]: b for b in existing.get("books", [])}
    rows, skipped, seen = [], [], set()

    for n, fname in enumerate(pdfs, 1):
        title, author, year, note = parse_name(os.path.splitext(fname)[0])
        slug = slugify("%s-%s-%s" % (title, author or "", year or ""))
        while slug in seen:
            slug += "-2"
        seen.add(slug)

        sys.stdout.write("[%3d/%d] %-52.52s " % (n, len(pdfs), title))
        sys.stdout.flush()

        out_path = os.path.join(dest, slug + ".json")
        if not force and slug in known and os.path.exists(out_path):
            row = dict(known[slug])
            row["c"] = coll_id
            if "p" not in row:                     # scored after the fact
                with open(out_path, encoding="utf-8") as fh:
                    row["p"] = prose_score(json.load(fh)["sections"])
            rows.append(row)
            print("kept")
            continue

        pages = extract(os.path.join(src, fname))
        if not pages:
            print("SKIP (no text layer)")
            skipped.append(fname)
            continue

        sections = build_sections(pages)
        words = sum(len(p.split()) for s in sections for p in s["p"])
        if words < 500:
            print("SKIP (only %d words)" % words)
            skipped.append(fname)
            continue

        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump({
                "id": slug, "title": title, "author": author, "year": year,
                "note": note, "pages": len(pages), "words": words,
                "sections": sections,
            }, fh, ensure_ascii=False, separators=(",", ":"))

        kb = round(os.path.getsize(out_path) / 1024)
        rows.append({
            "id": slug, "t": title, "a": author, "y": year, "n": note,
            "w": words, "s": len(sections), "kb": kb, "c": coll_id,
            "p": prose_score(sections),
        })
        print("%3d sec %8d words %6d KB" % (len(sections), words, kb))

    return coll_id, rows, skipped


def main():
    ap = argparse.ArgumentParser(
        description="Build the Aetheria Reader library from folders of PDFs.")
    ap.add_argument("source", help="folder of PDFs, or a parent of such folders with --sets")
    ap.add_argument("dest", nargs="?", default="library", help="output folder (default: library)")
    ap.add_argument("--name", help="collection name (default: the folder's own name)")
    ap.add_argument("--sets", action="store_true",
                    help="treat each subfolder of SOURCE as its own collection")
    ap.add_argument("--replace", action="store_true",
                    help="start a fresh catalogue instead of merging into the existing one")
    ap.add_argument("--force", action="store_true",
                    help="re-extract books even where their text is already built")
    args = ap.parse_args()

    os.makedirs(args.dest, exist_ok=True)
    existing = {"collections": [], "books": []} if args.replace else load_index(args.dest)

    sources = []
    if args.sets:
        for entry in sorted(os.listdir(args.source)):
            path = os.path.join(args.source, entry)
            if os.path.isdir(path):
                sources.append((path, entry))
    else:
        sources.append((args.source,
                        args.name or os.path.basename(os.path.abspath(args.source))))

    # Anything not part of the collections being (re)built is carried over
    rebuilt = {slugify(name) for _, name in sources}
    carried = [b for b in existing.get("books", []) if b.get("c") not in rebuilt]
    collections = [c for c in existing.get("collections", []) if c["id"] not in rebuilt]
    books = []
    all_skipped = []

    for src, name in sources:
        print("\n== %s ==" % name)
        coll_id, rows, skipped = build_collection(src, args.dest, name, existing, args.force)
        if not rows:
            continue
        books.extend(rows)
        collections.append({
            "id": coll_id, "name": name, "count": len(rows),
            "words": sum(r["w"] for r in rows),
        })
        all_skipped.extend(skipped)

    # Books carried over from a previous run join at the end, minus any the
    # run has just rebuilt. Catalogues written before collections existed
    # have no `c` at all, so matching on id is what keeps them from being
    # counted twice.
    fresh = {b["id"] for b in books}
    for b in carried:
        if b["id"] in fresh:
            continue
        # A catalogue entry whose text file has gone would be a dead link
        if not os.path.exists(os.path.join(args.dest, b["id"] + ".json")):
            print("  dropped (text missing): %s" % b["t"])
            continue
        books.append(b)

    # Recount every collection from the books that actually survived, and
    # drop any left with nothing in it.
    counts = {}
    for b in books:
        c = b.get("c")
        if c:
            entry = counts.setdefault(c, {"count": 0, "words": 0})
            entry["count"] += 1
            entry["words"] += b.get("w", 0)
    collections = [dict(c, **counts[c["id"]]) for c in collections if c["id"] in counts]

    books.sort(key=lambda b: b["t"].lower())
    collections.sort(key=lambda c: c["name"].lower())

    with open(os.path.join(args.dest, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "generated": date.today().isoformat(),
            "count": len(books),
            "collections": collections,
            "books": books,
        }, fh, ensure_ascii=False, separators=(",", ":"))

    total_kb = sum(b["kb"] for b in books)
    print("\n%d books in %d collection(s)  |  %.1f MB  |  %s words"
          % (len(books), len(collections), total_kb / 1024.0,
             "{:,}".format(sum(b["w"] for b in books))))
    for c in collections:
        print("   %-28s %4d books" % (c["name"], c["count"]))
    if all_skipped:
        print("\nSkipped %d (no text layer):" % len(all_skipped))
        for sk in all_skipped:
            print("  -", sk)


if __name__ == "__main__":
    main()
