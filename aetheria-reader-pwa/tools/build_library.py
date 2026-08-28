#!/usr/bin/env python3
"""
Build the Aetheria Reader library from a folder of PDFs.

Extracts the text layer of every PDF (via pdftotext), cleans up OCR
artefacts, splits the result into sections and writes one compact JSON
file per book plus a catalog index.

    python tools/build_library.py "../Buddism books" library

Requires `pdftotext` (Poppler / Xpdf) on PATH.
"""

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
        title = stem.strip(" .,-")

    if author and len(author) > 90:
        author = None
    return title or stem, author, year, note


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


def build_sections(pages):
    """Split pages into sections, preferring detected headings."""
    flat = []                                     # [(kind, text, page_index)]
    for pi, page in enumerate(pages):
        for kind, text in page_blocks(page):
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


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "../Buddism books"
    dest = sys.argv[2] if len(sys.argv) > 2 else "library"
    os.makedirs(dest, exist_ok=True)

    pdfs = sorted(f for f in os.listdir(src) if f.lower().endswith(".pdf"))
    catalog, skipped, seen = [], [], set()

    for n, fname in enumerate(pdfs, 1):
        stem = os.path.splitext(fname)[0]
        title, author, year, note = parse_name(stem)
        slug = slugify("%s-%s-%s" % (title, author or "", year or ""))
        while slug in seen:
            slug += "-2"
        seen.add(slug)

        sys.stdout.write("[%3d/%d] %-56.56s " % (n, len(pdfs), title))
        sys.stdout.flush()

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

        book = {
            "id": slug, "title": title, "author": author, "year": year,
            "note": note, "pages": len(pages), "words": words,
            "sections": sections,
        }
        out_path = os.path.join(dest, slug + ".json")
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(book, fh, ensure_ascii=False, separators=(",", ":"))

        kb = round(os.path.getsize(out_path) / 1024)
        catalog.append({
            "id": slug, "t": title, "a": author, "y": year,
            "n": note, "w": words, "s": len(sections), "kb": kb,
        })
        print("%3d sec %8d words %6d KB" % (len(sections), words, kb))

    catalog.sort(key=lambda b: b["t"].lower())
    with open(os.path.join(dest, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "generated": date.today().isoformat(),
            "count": len(catalog),
            "books": catalog,
        }, fh, ensure_ascii=False, separators=(",", ":"))

    total_kb = sum(b["kb"] for b in catalog)
    print("\n%d books  |  %.1f MB  |  %s words"
          % (len(catalog), total_kb / 1024.0, "{:,}".format(sum(b["w"] for b in catalog))))
    if skipped:
        print("\nSkipped %d:" % len(skipped))
        for s in skipped:
            print("  -", s)


if __name__ == "__main__":
    main()
