#!/usr/bin/env python3
"""
The Presence: What All Religions Agree On, by Joseph and Alisha Lewis.

The book is written in a shared doc. Export the doc as Markdown, save it here
as manuscript.md, and run this script. It writes:

- the Reader's copy, ../texts/the-presence.md (then run tools/build_aetheria.py);
- with --print OUT, the KDP paperback interior (6 x 9 in PDF) and the Kindle
  eBook (EPUB) into OUT. Those need pandoc and xelatex, and the TeX Gyre
  Pagella font that comes with TeX Live.

    python tools/aetheria/presence/build.py
    python tools/aetheria/presence/build.py --print out

Never edit the outputs by hand: change the doc, export it again and rerun.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TITLE = "The Presence"
SUBTITLE = "What All Religions Agree On"
AUTHORS = "Joseph and Alisha Lewis"
YEAR = 2026
FONT_DIR = "/usr/share/texmf/fonts/opentype/public/tex-gyre/"

NUMBERS = ["One", "Two", "Three", "Four", "Five", "Six"]


# -- The manuscript -----------------------------------------------------------

def split_manuscript(md):
    """Return the body (A Note Before We Start to the Afterword) and the
    Translations and Sources section, leaving out the doc's own title, byline
    and Contents (each edition makes its own)."""
    start = md.index("## A Note Before We Start")
    end = md.index("## Translations and Sources")
    return md[start:end].strip() + "\n", md[end:].strip() + "\n"


LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def parse_sources(section):
    """The sources section as (intro paragraphs, rows, closing paragraphs).
    Each row is (chapter, passage, translation, [(text, url) or (text, None)])."""
    lines = section.splitlines()[1:]
    intro, rows, outro, seen_table = [], [], [], False
    para = []

    def flush(into):
        if para:
            into.append(" ".join(para))
            para.clear()

    for ln in lines:
        s = ln.strip()
        if s.startswith("|"):
            flush(intro)
            seen_table = True
            cells = [c.strip() for c in s.strip("|").split("|")]
            if cells[0] in ("Chapter", "---") or set(cells[0]) <= set("-: "):
                continue
            where = [(m.group(1), m.group(2)) for m in LINK.finditer(cells[3])]
            if not where and cells[3]:
                where = [(cells[3], None)]
            rows.append((cells[0], cells[1], cells[2], where))
        elif not s:
            flush(outro if seen_table else intro)
        else:
            para.append(s)
    flush(outro if seen_table else intro)
    return intro, rows, outro


def by_chapter(rows):
    out = []
    for row in rows:
        if not out or out[-1][0] != row[0]:
            out.append((row[0], []))
        out[-1][1].append(row)
    return out


def stop(text):
    text = text.strip()
    return text if re.search(r"[.!?][\"”’]?$", text) else text + "."


def sources_markdown(section, mode):
    """The sources as a list grouped by chapter. mode is "ebook" (live links),
    "print" (web addresses printed out) or "reader" (no web addresses: the
    Reader reads aloud)."""
    intro, rows, outro = parse_sources(section)
    intro = [p.replace("The table below lists", "Below we list").replace("the table says so", "the list says so") for p in intro]
    if mode == "reader":
        intro = intro[:1] + ["The web addresses are in the printed book and the ebook."]
    out = ["## Translations and Sources", ""]
    out += [p + "\n" for p in intro]
    for chapter, items in by_chapter(rows):
        out.append("### Chapter %s\n" % chapter)
        for _, passage, translation, where in items:
            line = "- **%s** %s" % (stop(passage), stop(translation))
            if mode == "ebook":
                links = ", ".join("[%s](%s)" % (t, u) if u else t for t, u in where)
                line += " " + stop(links) if links else ""
            elif mode == "print":
                shown = printed_where(where)
                line += " " + shown if shown else ""
            out.append(line)
        out.append("")
    out += [p + "\n" for p in outro]
    return "\n".join(out)


def printed_where(where):
    """Web addresses as a printed page shows them: without https://, and one
    line for the long Bible Gateway and Quran API addresses."""
    parts, said = [], set()
    for text, url in where:
        if not url:
            parts.append(text + ".")
            continue
        host = re.sub(r"^https?://(www\.)?", "", url)
        if "biblegateway.com" in host:
            key = "biblegateway.com"
            if key not in said:
                parts.append("Online at biblegateway.com (King James Version).")
            said.add(key)
        elif host.startswith("api.alquran.cloud"):
            key = "alquran.cloud"
            if key not in said:
                parts.append("Online at alquran.cloud (Pickthall's translation).")
            said.add(key)
        else:
            label = "" if len(where) == 1 else text + ": "
            parts.append("%s\\nolinkurl{%s}" % (label, host.rstrip("/")))
    return "; ".join(p for p in parts)


# -- The Reader's copy ----------------------------------------------------------

def reader_text(body, sources):
    """Markdown for the Reader, which splits a book into sections at its
    headings and reads them aloud. Chapters are the sections; the smaller
    headings inside them become short paragraphs of their own, and quotations
    lose their quote marks."""
    out = []
    for ln in (body + "\n" + sources_markdown(sources, "reader")).splitlines():
        m = re.match(r"^(#{1,4})\s+(.*)$", ln)
        if m and len(m.group(1)) >= 3:
            out.append(stop(m.group(2)))
        elif m:
            out.append("# " + m.group(2))
        elif ln.startswith(">"):
            out.append(ln.lstrip("> ").rstrip())
        else:
            out.append(ln)
    text = "\n".join(out)
    text = re.sub(r"\\([\[\]*_`#])", r"\1", text)
    head = "---\ntitle: %s: %s\nauthor: %s\nyear: %d\n---\n" % (
        TITLE, SUBTITLE, AUTHORS, YEAR)
    return head + text.strip() + "\n"


# -- The paperback ---------------------------------------------------------------

def tex_text(text):
    """A heading's words for LaTeX: curly quotes, nothing else to escape."""
    text = re.sub(r'"(?=\w)', "“", text).replace('"', "”")
    return text.replace("'", "’")


def print_markdown(body, sources):
    """The body with parts, chapters and front-matter headings as LaTeX
    commands from the template, so a chapter opens with its number above its
    name and the tradition's words beneath."""
    out, main = [], False
    for ln in body.splitlines():
        m = re.match(r"^# Part (\w+): (.+)$", ln)
        if m:
            if not main:  # page 1 is the first part's page
                out.append("```{=latex}\n\\mainmatter\n```")
                main = True
            out.append("```{=latex}\n\\bookpart{Part %s}{%s}\n```" % (m.group(1), tex_text(m.group(2))))
            continue
        m = re.match(r"^## Chapter (\d+): (.+)$", ln)
        if m:
            name, _, sub = m.group(2).partition(', "')
            sub = '"' + sub if sub else ""
            run = name if len(name) < 34 else name.split(",")[0]
            out.append("```{=latex}\n\\bookchapter{%s}{%s}{%s}{%s}\n```" % (
                m.group(1), tex_text(name), tex_text(sub), tex_text(run)))
            continue
        m = re.match(r"^## (.+)$", ln)
        if m:
            if m.group(1) == "Afterword":
                out.append("```{=latex}\n\\backmatter\n```")
            out.append("```{=latex}\n\\bookfront{%s}\n```" % tex_text(m.group(1)))
            continue
        out.append(ln)
    src = sources_markdown(sources, "print")
    src = src.replace("## Translations and Sources",
                      "```{=latex}\n\\bookfront{Translations and Sources}\n\\begin{sources}\n```", 1)
    return "\n".join(out) + "\n\n" + src + "\n```{=latex}\n\\end{sources}\n```\n"


def build_print(body, sources, outdir):
    os.makedirs(outdir, exist_ok=True)
    work = os.path.join(outdir, "work")
    os.makedirs(work, exist_ok=True)
    md = os.path.join(work, "paperback.md")
    with open(md, "w", encoding="utf-8") as fh:
        fh.write(print_markdown(body, sources))
    tex = os.path.join(work, "paperback.tex")
    subprocess.run(["pandoc", md, "-f", "markdown+smart-auto_identifiers", "-t", "latex", "--wrap=preserve",
                    "--top-level-division=chapter", "--template", os.path.join(HERE, "paperback.tex"),
                    "-V", "fontdir=" + FONT_DIR, "-o", tex], check=True)
    for _ in range(3):  # the contents page needs the page numbers of a run before
        r = subprocess.run(["xelatex", "-interaction=nonstopmode", "-halt-on-error", "paperback.tex"],
                           cwd=work, capture_output=True, text=True)
        if r.returncode:
            sys.stdout.write(r.stdout[-3000:])
            raise SystemExit("xelatex failed")
    pdf = os.path.join(outdir, "The-Presence-paperback-6x9.pdf")
    shutil.copy(os.path.join(work, "paperback.pdf"), pdf)
    warn = [ln for ln in r.stdout.splitlines() if "Overfull" in ln]
    return pdf, warn


# -- The eBook -------------------------------------------------------------------

COPYRIGHT = """## Copyright

*%(title)s: %(subtitle)s*

Copyright © %(year)d Joseph Lewis and Alisha Lewis. All rights reserved.

Published by Big Banana Studios.

The quotations from scriptures and other older writings come from translations in the public domain in the United States. Translations and Sources, at the back of the book, lists every one.

Written with the help of two AI collaborators, Formant and Selah (Claude, by Anthropic). How We Wrote This tells who did what.

This book is offered for reflection. Nothing in it is medical or psychological advice.

First edition, %(year)d.
"""


def build_ebook(body, sources, outdir):
    md = os.path.join(outdir, "work", "ebook.md")
    meta = dict(title=TITLE, subtitle=SUBTITLE, year=YEAR)
    with open(md, "w", encoding="utf-8") as fh:
        fh.write(COPYRIGHT % meta + "\n" + body + "\n" + sources_markdown(sources, "ebook"))
    epub = os.path.join(outdir, "The-Presence.epub")
    subprocess.run(["pandoc", md, "-f", "markdown+smart", "-t", "epub3", "-o", epub,
                    "--toc", "--toc-depth=2", "--split-level=2",
                    "--css", os.path.join(HERE, "ebook.css"),
                    "--metadata", "title=" + TITLE, "--metadata", "subtitle=" + SUBTITLE,
                    "--metadata", "author=Joseph Lewis", "--metadata", "author=Alisha Lewis",
                    "--metadata", "publisher=Big Banana Studios", "--metadata", "lang=en-US",
                    "--metadata", "date=%d" % YEAR,
                    "--metadata", "rights=© %d Joseph Lewis and Alisha Lewis. All rights reserved." % YEAR],
                   check=True)
    return epub


def main():
    ap = argparse.ArgumentParser(description="Build The Presence from the doc's Markdown export.")
    ap.add_argument("manuscript", nargs="?", default=os.path.join(HERE, "manuscript.md"))
    ap.add_argument("--print", dest="outdir", help="also build the paperback PDF and the EPUB here")
    args = ap.parse_args()

    with open(args.manuscript, encoding="utf-8") as fh:
        body, sources = split_manuscript(fh.read())

    reader = os.path.join(HERE, "..", "texts", "the-presence.md")
    with open(reader, "w", encoding="utf-8") as fh:
        fh.write(reader_text(body, sources))
    print("Reader copy:", os.path.normpath(reader))

    if args.outdir:
        pdf, warn = build_print(body, sources, args.outdir)
        print("Paperback:", pdf, "(%d overfull lines)" % len(warn))
        print("eBook:", build_ebook(body, sources, args.outdir))


if __name__ == "__main__":
    main()
