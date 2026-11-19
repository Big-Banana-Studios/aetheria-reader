#!/usr/bin/env python3
"""
Build the Aetheria shelf: Joe and Alisha Lewis's own books, papers and notes.

Unlike the public-domain sets, this shelf mixes two kinds of source, both
listed in tools/aetheria/manifest.json:

- the printed books, extracted from their PDFs exactly as build_library.py
  extracts any other book (the PDFs stay out of the repository, as theirs do);
- the codex, the Lexicon, the Lo Shu chapter, papers and working notes, kept
  here as Markdown under tools/aetheria/texts/ and split into sections at
  their headings.

An item with a "note" opens with it, as its own first section. The ids all
start with "aetheria-", which is how the service worker knows these texts
may be revised (it refreshes them in the background, where every other book
is cached for good).

    python tools/build_aetheria.py --pdfs "D:/Aetheria books" library
    python tools/build_aetheria.py library      # texts only; keeps the built books

The rest of the catalogue is carried over untouched.
"""

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_library import (  # noqa: E402  (same cleaner as every other book)
    build_sections, clean_page, collapse_letter_spacing, continues_paragraph, detect_language,
    join_paragraph, load_index, page_blocks, prose_score, strip_running_headers)

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aetheria")


# -- Markdown to sections ---------------------------------------------------

def inline(text):
    """Strip Markdown emphasis, code ticks and links, leaving the words."""
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def front_matter(src):
    meta = {}
    if src.startswith("---\n"):
        head, _, src = src[4:].partition("\n---\n")
        for line in head.splitlines():
            key, _, value = line.partition(":")
            value = value.strip()
            if key.strip() == "year":
                value = int(value) if value.isdigit() else None
            meta[key.strip()] = value
    return meta, src


def table_rows(lines):
    """
    A table becomes one paragraph per row, each cell named by its column, so
    a voice reads "Mercury. Actual (AU): 0.387. Predicted (AU): 0.390." A grid
    whose top row is data (the Lo Shu square) reads row by row instead.
    """
    rows = [[inline(c) for c in ln.strip().strip("|").split("|")] for ln in lines
            if not re.match(r"^\s*\|?\s*:?-{3,}", ln)]
    if not rows:
        return []
    head, body = rows[0], rows[1:]
    if all(re.fullmatch(r"[\d.]+", c) for c in head if c):
        return [", ".join(c for c in r if c) + "." for r in rows]
    out = []
    for r in body:
        first, rest = r[0], r[1:]
        parts = [first] if first else []
        for h, c in zip(head[1:], rest):
            if not c:
                continue
            parts.append("%s: %s" % (h, c) if h else c)
        text = ". ".join(p.rstrip(".") for p in parts if p)
        if text:
            out.append(text + ".")
    return out


def markdown_sections(src):
    sections, heads, paras, buf = [], [], [], []
    lines = src.splitlines()
    i = 0

    def flush_para():
        if buf:
            text = inline(" ".join(buf))
            if text:
                paras.append(text)
            buf.clear()

    def flush_section():
        flush_para()
        if paras:
            sections.append({"h": " · ".join(heads) if heads else "Beginning", "p": list(paras)})
            heads.clear()
            paras.clear()

    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        m = re.match(r"^(#{1,4})\s+(.*)$", s)
        if m:
            flush_section()
            heads.append(inline(m.group(2)))
        elif s.startswith("```"):
            flush_para()
            block = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                if lines[i].strip():
                    block.append(lines[i].strip())
                i += 1
            if block:
                paras.append(" ".join(block))
        elif s.startswith("|"):
            flush_para()
            block = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                block.append(lines[i])
                i += 1
            paras.extend(table_rows(block))
            continue
        elif re.match(r"^(-{3,}|•(\s+•)+)$", s) or not s:
            flush_para()
        elif re.match(r"^([-*]|\d+\.)\s+", s):
            flush_para()
            item = re.sub(r"^([-*]|\d+\.)\s+(\[[ x]\]\s+)?", "", s)
            buf.append(item)
            flush_para()
        else:
            buf.append(s)
        i += 1
    flush_section()
    return sections


# -- Printed books, split at their own chapters ------------------------------

def title_key(text):
    """'P A R T  O N E — The Electric' and 'Part One: The Electric' compare equal."""
    return re.sub(r"[^a-z0-9]", "", collapse_letter_spacing(text).lower())


def line_keys(page):
    """Every line of a page, and every run of two or three lines, as keys:
    a chapter title is often set over two lines ('CHAPTER 12' / 'For Healing')."""
    keys = [k for k in (title_key(l) for l in page.split("\n")) if k]
    found = set(keys)
    found.update(a + b for a, b in zip(keys, keys[1:]))
    found.update(a + b + c for a, b, c in zip(keys, keys[1:], keys[2:]))
    return found


def chapter_candidates(entry):
    """The keys a chapter's opening line may take: its title, its title less
    a 'Chapter 3:' or '3.' prefix, or an explicit match given in the manifest."""
    title, match = (entry, None) if isinstance(entry, str) else (entry[0], entry[1])
    if match:
        return title, {title_key(match)}
    keys = {title_key(title)}
    m = re.match(r"^(?:chapter\s+\d+\s*[:.]?\s*|\d+\.\s*)(.+)$", title, re.I)
    if m:
        keys.add(title_key(m.group(1)))
    return title, keys


def pdf_pages(path):
    """The book's pages, cleaned as build_library cleans them, blank ones kept
    so that page counts stay true to the printed book."""
    text = subprocess.run(["pdftotext", "-enc", "UTF-8", "-q", path, "-"],
                          capture_output=True, timeout=900).stdout.decode("utf-8", "replace")
    return strip_running_headers([clean_page(p) for p in text.split("\f")])


def blocks_of(pages):
    """Paragraphs of a run of pages, joined across page breaks; headings kept
    as text in place, so nothing a chapter says is dropped."""
    flat = []
    for page in pages:
        for kind, text in page_blocks(page):
            if flat and kind == "p" and continues_paragraph(flat[-1], text):
                flat[-1] = join_paragraph(flat[-1], text)
            else:
                flat.append(text)
    # Rules drawn with box characters ('━━━━', '════') are layout, not words
    flat = [re.sub(r"\s{2,}", " ", RULE_RE.sub(" ", p)).strip() for p in flat]
    return [p for p in flat if p]


RULE_RE = re.compile(r"[━═─│┃╌╍]{2,}")
LEAD_MARK_RE = re.compile(r"^(?:[•·*]\s*){2,}")
CHAPTER_WORD_RE = re.compile(r"^(?:chapter|c ?ha ?pt ?er)\s+[\w-]+\s+", re.I)


def tidy_opening(paras, title):
    """
    Strip what is left of a chapter's own heading from its first paragraphs:
    'C ha pt er' from letter-spaced display type, 'PART ONE: … — CHAPTER 1',
    'Chapter One', a title's tail that wrapped onto its own line ('Room?'),
    and the title run straight into the first sentence ('The Day I Died I
    checked…'). A real first sentence is kept: only a prefix that the title
    itself ends with is removed.
    """
    tkey = title_key(title)
    for _ in range(4):
        if not paras:
            break
        p = LEAD_MARK_RE.sub("", paras[0]).strip()
        k = title_key(p)
        if not k or k.isdigit() or k == tkey or (
                len(k) <= 48 and re.fullmatch(r"(?:part[a-z]+)?chapter(?:\d+|[a-z]{0,10})", k)):
            paras.pop(0)
            continue
        m = CHAPTER_WORD_RE.match(p)
        if m:
            p = p[m.end():]
        words = p.split()
        for n in range(min(len(words) - 1, 14), 0, -1):
            pk = title_key(" ".join(words[:n]))
            if len(pk) >= 4 and tkey.endswith(pk):
                p = " ".join(words[n:])
                break
        p = LEAD_MARK_RE.sub("", p).strip()
        if p == paras[0]:
            break
        paras[0] = p
    return paras


def chapter_sections(pages, chapters):
    """
    One section per chapter of the book's own contents, found by its title
    at the head of a page. Contents pages (where three or more titles sit
    together) are skipped, so a title is only ever found where it opens.
    """
    cands = [chapter_candidates(c) for c in chapters]
    every = set().union(*(k for _, k in cands))
    toc = [i for i, p in enumerate(pages[:15]) if len(line_keys(p) & every) >= 3]
    at = toc[-1] + 1 if toc else 0
    starts = []
    for title, keys in cands:
        for i in range(at, len(pages)):
            if line_keys(pages[i]) & keys:
                starts.append((i, title, keys))
                at = i
                break
        else:
            print("\n    chapter not found: %s" % title, end="")
    sections = []
    if starts and starts[0][0] > 0:
        front = blocks_of(pages[:starts[0][0]])
        if front:
            sections.append({"h": "Title and contents", "p": front})
    pending, carried = [], []
    for n, (i, title, keys) in enumerate(starts):
        end = starts[n + 1][0] if n + 1 < len(starts) else len(pages)
        nxt = starts[n + 1][2] if n + 1 < len(starts) else set()
        paras = blocks_of(pages[i:end] if end > i else [])
        # Drop the title's own lines from the top, and the next chapter's
        # title where both open on the same page.
        drop = keys | nxt | {title_key(w) for w in re.split(r"[:—]", title)}
        while paras and (title_key(paras[0]) in drop or any(title_key(paras[0]) and title_key(paras[0]) in k for k in keys)):
            paras.pop(0)
        paras = tidy_opening(paras, title)
        # A part's title page ('Part Two: Daily Cycles', 'The 24-Hour Dance')
        # opens the chapter after it rather than standing alone.
        if end == i or sum(len(q.split()) for q in paras) < 25:
            pending.append(title)
            carried.extend(paras)
            continue
        sections.append({"h": " · ".join(pending + [title]), "p": carried + paras})
        pending, carried = [], []
    return sections


# -- Building ---------------------------------------------------------------

def with_note(sections, note, heading):
    if not note:
        return sections
    return [{"h": heading, "p": [note]}] + sections


def write_book(dest, item, sections, pages=None):
    words = sum(len(p.split()) for s in sections for p in s["p"])
    path = os.path.join(dest, item["id"] + ".json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({
            "id": item["id"], "title": item["title"], "author": item.get("author"),
            "year": item.get("year"), "note": None, "pages": pages or len(sections),
            "words": words, "sections": sections,
        }, fh, ensure_ascii=False, separators=(",", ":"))
    return {
        "id": item["id"], "t": item["title"], "a": item.get("author"), "y": item.get("year"),
        "n": None, "w": words, "s": len(sections), "kb": round(os.path.getsize(path) / 1024),
        "c": None, "p": prose_score(sections), "l": detect_language(sections)[0],
    }


def main():
    ap = argparse.ArgumentParser(description="Build the Aetheria shelf of the Reader's library.")
    ap.add_argument("dest", nargs="?", default="library", help="library folder (default: library)")
    ap.add_argument("--pdfs", help="folder holding the printed books' PDFs")
    args = ap.parse_args()

    with open(os.path.join(HERE, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    coll_name = manifest["collection"]
    coll_id = coll_name.lower()
    heading = manifest["note_heading"]
    pdfs = sorted(os.listdir(args.pdfs)) if args.pdfs else []

    rows = []
    for item in manifest["items"]:
        sys.stdout.write("  %-46.46s " % item["id"])
        if "text" in item:
            with open(os.path.join(HERE, "texts", item["text"]), encoding="utf-8") as fh:
                meta, body = front_matter(fh.read())
            item = dict(item, title=meta.get("title"), author=meta.get("author"), year=meta.get("year"))
            sections = with_note(markdown_sections(body), item.get("note"), heading)
            row = write_book(args.dest, item, sections)
        else:
            match = [f for f in pdfs if fnmatch.fnmatch(f, item["pdf"])]
            built = os.path.join(args.dest, item["id"] + ".json")
            if match:
                pages = pdf_pages(os.path.join(args.pdfs, match[0]))
                body = (chapter_sections(pages, item["chapters"]) if item.get("chapters")
                        else build_sections([p for p in pages if p.strip()]))
                sections = with_note(body, item.get("note"), heading)
                row = write_book(args.dest, item, sections, pages=len(pages))
            elif os.path.exists(built):
                # No PDF this run: keep the text already built, but take the
                # title, author and note from the manifest, so they can be
                # revised without the source.
                with open(built, encoding="utf-8") as fh:
                    prev = json.load(fh)
                old = prev["sections"]
                if old and old[0]["h"] == heading:
                    old = old[1:]
                row = write_book(args.dest, item, with_note(old, item.get("note"), heading),
                                 pages=prev.get("pages"))
            else:
                print("MISSING (no PDF matching %s)" % item["pdf"])
                continue
        row["c"] = coll_id
        if os.path.exists(os.path.join(args.dest, "covers", item["id"] + ".jpg")):
            row["cv"] = 1  # cover art at library/covers/<id>.jpg
        rows.append(row)
        print("%3d sec %7d words %5d KB" % (row["s"], row["w"], row["kb"]))

    index = load_index(args.dest)
    books = [b for b in index.get("books", []) if b.get("c") != coll_id] + rows
    books.sort(key=lambda b: b["t"].lower())
    collections = [c for c in index.get("collections", []) if c["id"] != coll_id]
    collections.append({"id": coll_id, "name": coll_name, "count": len(rows),
                        "words": sum(r["w"] for r in rows)})
    collections.sort(key=lambda c: c["name"].lower())
    with open(os.path.join(args.dest, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"generated": date.today().isoformat(), "count": len(books),
                   "collections": collections, "books": books},
                  fh, ensure_ascii=False, separators=(",", ":"))
    print("\n%s: %d items, %s words. Library: %d books in %d collections."
          % (coll_name, len(rows), "{:,}".format(sum(r["w"] for r in rows)),
             len(books), len(collections)))


if __name__ == "__main__":
    main()
