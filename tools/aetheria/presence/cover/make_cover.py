#!/usr/bin/env python3
"""
The cover of The Presence: one light through many doorways.

Builds, into OUT:
- The-Presence-cover-KDP.pdf: the paperback's full wraparound cover for KDP
  (back, spine and front, 6 x 9 in trim, 0.125 in bleed all round, spine
  width from the page count on white paper);
- The-Presence-cover-preview.png: the same, small, to look at;
- The-Presence-ebook-cover.jpg: the Kindle cover, 1600 x 2560.

    python tools/aetheria/presence/cover/make_cover.py OUT --pages 117
    python tools/aetheria/presence/cover/make_cover.py OUT --pages 117 --art art.png

With --art, a picture (for example one made from prompt.md) replaces the
drawn doorways and sky; the type, spine and layout stay the same. The art
should be a wraparound picture of the cover's proportions, or a front-only
picture, which then fills the front and is darkened and mirrored behind the
back. Needs Python's playwright and Pillow.
"""

import argparse
import base64
import os
import random

from PIL import Image, ImageFilter, ImageEnhance
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = "/usr/share/texmf/fonts/opentype/public/tex-gyre/"
PT = 72  # points per inch: every measure below is in points
BLEED = 0.125 * PT
TRIM_W, TRIM_H = 6 * PT, 9 * PT
SPINE_PER_PAGE = 0.002252 * PT  # KDP, white paper

GOLD, GOLD_HI, INK, MIST = "#f2b45a", "#ffe9bf", "#ecebf6", "#cfcbe8"


# -- The picture -------------------------------------------------------------------

def door_path(kind, cx, y0, w, h):
    """The opening of one doorway, standing on y0, centred on cx."""
    x0, x1 = cx - w / 2, cx + w / 2
    top = y0 - h
    if kind in ("lintel", "door", "torii"):
        return f"M{x0},{y0} L{x0},{top} L{x1},{top} L{x1},{y0} Z"
    if kind == "round":
        ys = top + w / 2
        return f"M{x0},{y0} L{x0},{ys} A{w/2},{w/2} 0 0 1 {x1},{ys} L{x1},{y0} Z"
    if kind == "pointed":
        ys = top + 0.866 * w
        return f"M{x0},{y0} L{x0},{ys} A{w},{w} 0 0 1 {cx},{top} A{w},{w} 0 0 1 {x1},{ys} L{x1},{y0} Z"
    if kind == "horseshoe":
        r = 0.6 * w
        yc = top + r
        yj = yc + 0.33 * w
        return f"M{x0},{y0} L{x0},{yj} A{r},{r} 0 1 1 {x1},{yj} L{x1},{y0} Z"
    if kind == "onion":
        ys = top + 0.95 * w
        return (f"M{x0},{y0} L{x0},{ys} C{x0 - 0.25 * w},{ys - 0.35 * w} {cx - 0.15 * w},{ys - 0.55 * w} {cx},{top} "
                f"C{cx + 0.15 * w},{ys - 0.55 * w} {x1 + 0.25 * w},{ys - 0.35 * w} {x1},{ys} L{x1},{y0} Z")
    raise ValueError(kind)


def door_frame(kind, cx, y0, w, h):
    """Dark stone or wood drawn in front of the light: lintels, a torii, an open door."""
    x0, x1 = cx - w / 2, cx + w / 2
    top = y0 - h
    stone = "#120f2b"
    if kind == "lintel":  # an ancient trilithon: two standing stones and a capstone
        return (f'<rect x="{x0 - 0.32 * w}" y="{top}" width="{0.34 * w}" height="{h}" fill="{stone}"/>'
                f'<rect x="{x1 - 0.02 * w}" y="{top}" width="{0.34 * w}" height="{h}" fill="{stone}"/>'
                f'<rect x="{x0 - 0.42 * w}" y="{top - 0.2 * w}" width="{1.84 * w}" height="{0.24 * w}" rx="1.5" fill="{stone}"/>')
    if kind == "torii":
        p = 0.1 * w
        return (f'<rect x="{x0 + 0.08 * w}" y="{top + 0.1 * h}" width="{p}" height="{0.9 * h}" fill="{stone}"/>'
                f'<rect x="{x1 - 0.08 * w - p}" y="{top + 0.1 * h}" width="{p}" height="{0.9 * h}" fill="{stone}"/>'
                f'<rect x="{x0 - 0.04 * w}" y="{top + 0.27 * h}" width="{1.08 * w}" height="{0.06 * h}" fill="{stone}"/>'
                f'<path d="M{x0 - 0.2 * w},{top - 0.02 * h} Q{cx},{top + 0.1 * h} {x1 + 0.2 * w},{top - 0.02 * h} '
                f'L{x1 + 0.16 * w},{top + 0.1 * h} Q{cx},{top + 0.17 * h} {x0 - 0.16 * w},{top + 0.1 * h} Z" fill="{stone}"/>')
    if kind == "door":  # a plain door, standing open
        return (f'<path d="M{x0},{y0} L{x0},{top} L{x0 + 0.3 * w},{top + 0.05 * h} '
                f'L{x0 + 0.3 * w},{y0 - 0.02 * h} Z" fill="{stone}"/>')
    return ""


DOORS = [  # left to right: kind, width, height (points, on the 6 x 9 front)
    ("lintel", 36, 66), ("horseshoe", 31, 82), ("pointed", 30, 97), ("door", 36, 112),
    ("onion", 30, 97), ("round", 31, 82), ("torii", 46, 70),
]


def art_svg(width, height, front_x, front_w, top, trim_h, quiet=None):
    """The night, the plain, and the seven doorways on the front panel."""
    rnd = random.Random(7)
    y0 = top + 0.705 * trim_h
    cx = front_x + front_w / 2
    gaps = 18
    total = sum(w for _, w, _ in DOORS) + gaps * (len(DOORS) - 1)
    x = cx - total / 2
    doors = []
    for kind, w, h in DOORS:
        doors.append((kind, x + w / 2, w, h))
        x += w + gaps

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
           "<defs>",
           '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">'
           '<stop offset="0" stop-color="#07081a"/><stop offset="0.5" stop-color="#151538"/>'
           '<stop offset="0.7" stop-color="#2a2358"/><stop offset="0.74" stop-color="#1a1638"/>'
           '<stop offset="1" stop-color="#0a0919"/></linearGradient>',
           f'<radialGradient id="halo" cx="{cx}" cy="{y0 - 40}" r="{0.62 * front_w}" gradientUnits="userSpaceOnUse">'
           '<stop offset="0" stop-color="#f2b45a" stop-opacity="0.55"/>'
           '<stop offset="0.45" stop-color="#c9864a" stop-opacity="0.16"/>'
           '<stop offset="1" stop-color="#2a2358" stop-opacity="0"/></radialGradient>',
           f'<radialGradient id="core" cx="{cx}" cy="{y0 - 48}" r="{0.36 * front_w}" gradientUnits="userSpaceOnUse">'
           '<stop offset="0" stop-color="#ffd58c" stop-opacity="0.5"/>'
           '<stop offset="0.5" stop-color="#f2b45a" stop-opacity="0.16"/>'
           '<stop offset="1" stop-color="#f2b45a" stop-opacity="0"/></radialGradient>',
           '<filter id="blur3" x="-30%" y="-10%" width="160%" height="120%"><feGaussianBlur stdDeviation="3.5"/></filter>',
           '<linearGradient id="light" x1="0" y1="0" x2="0" y2="1">'
           f'<stop offset="0" stop-color="{GOLD}"/><stop offset="0.6" stop-color="#ffd58c"/>'
           f'<stop offset="1" stop-color="{GOLD_HI}"/></linearGradient>',
           '<linearGradient id="spill" x1="0" y1="0" x2="0" y2="1">'
           '<stop offset="0" stop-color="#ffd58c" stop-opacity="0.42"/>'
           '<stop offset="1" stop-color="#ffd58c" stop-opacity="0"/></linearGradient>',
           f'<linearGradient id="fade" x1="0" y1="{y0}" x2="0" y2="{y0 + 95}" gradientUnits="userSpaceOnUse">'
           '<stop offset="0" stop-color="#fff" stop-opacity="0.5"/>'
           '<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>',
           f'<mask id="reflect"><rect x="0" y="{y0}" width="{width}" height="{height}" fill="url(#fade)"/></mask>',
           '<filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="9"/></filter>',
           '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>',
           "</defs>",
           f'<rect width="{width}" height="{height}" fill="url(#sky)"/>']

    # Stars, thinning toward the horizon and kept off the light.
    for _ in range(int(width * 0.55)):
        sx = rnd.uniform(0, width)
        sy = rnd.uniform(0, top + 0.62 * trim_h)
        if abs(sx - cx) < 0.35 * front_w and sy > top + 0.45 * trim_h:
            continue
        if quiet and quiet[0] < sx < quiet[2] and quiet[1] < sy < quiet[3]:
            if rnd.random() < 0.85:  # keep the sky behind the back cover's words quiet
                continue
        r = rnd.choice([0.35, 0.45, 0.55, 0.7, 0.9, 1.15])
        op = rnd.uniform(0.25, 0.9) * (1 - sy / (top + 0.75 * trim_h)) ** 0.6
        out.append(f'<circle cx="{sx:.1f}" cy="{sy:.1f}" r="{r}" fill="#fff" opacity="{op:.2f}"/>')

    # The plain: a faint horizon line and the ground.
    out.append(f'<rect x="0" y="{y0}" width="{width}" height="{height - y0}" fill="#0b0a1c" opacity="0.55"/>')
    out.append(f'<rect x="0" y="{y0 - 0.4}" width="{width}" height="0.8" fill="#6b5aa8" opacity="0.35"/>')
    out.append(f'<rect width="{width}" height="{height}" fill="url(#halo)"/>')
    out.append(f'<rect width="{width}" height="{height}" fill="url(#core)"/>')

    # Light spilling forward from every doorway.
    for kind, dx, w, h in doors:
        spread = 0.9 * w
        out.append(f'<path d="M{dx - w / 2},{y0} L{dx + w / 2},{y0} L{dx + w / 2 + spread},{height} '
                   f'L{dx - w / 2 - spread},{height} Z" fill="url(#spill)" opacity="0.62" filter="url(#blur3)"/>')

    def doorway(kind, dx, w, h):
        d = door_path(kind, dx, y0, w, h)
        return (f'<path d="{d}" fill="{GOLD}" opacity="0.95" filter="url(#glow)"/>'
                f'<path d="{d}" fill="url(#light)"/>'
                + door_frame(kind, dx, y0, w, h))

    # Reflections in the ground, as in still water.
    out.append(f'<g mask="url(#reflect)" filter="url(#soft)">'
               f'<g transform="translate(0,{2 * y0}) scale(1,-1)">'
               + "".join(doorway(*dd) for dd in doors) + "</g></g>")
    out += [doorway(*dd) for dd in doors]
    out.append("</svg>")
    return "\n".join(out)


# -- The words ---------------------------------------------------------------------

BLURB = [
    "Every religion on earth argues about God. Which name. Which book. Which prophet.",
    "But underneath the arguments, they agree on something. The sacred is here. Not only in heaven, not only someday. Here.",
    "Air Force EOD veteran Joseph Lewis and his wife, Alisha, walk through the world’s traditions, oldest first: "
    "the Dakota’s Great Mystery, the Upanishads, the Psalms, the Buddha, the Tao Te Ching, the Gospels, the Quran, "
    "Rumi, Guru Nanak, Bahá’u’lláh and more. Each speaks in its own words, from translations anyone can check, "
    "and each gets to say where it parts ways with the others.",
    "What they share turns out to be a method: take away what covers the presence, and notice what’s left.",
    "Honest about the differences, practical about the practices, and curious about why two AIs left talking to each "
    "other drifted toward the same stillness, <i>The Presence</i> is for anyone who has ever wondered whether, at the "
    "core, they agree.",
]

EPIGRAPH = ("“Light is good in whatsoever lamp it is burning! A rose is beautiful in whatsoever garden it may "
            "bloom! A star has the same radiance if it shines from the East or from the West.”")


def font_face():
    faces = []
    for style, f in (("normal", "regular"), ("italic", "italic")):
        faces.append(f'@font-face {{ font-family: Pagella; font-style: {style}; font-weight: 400; '
                     f'src: url("file://{FONTS}texgyrepagella-{f}.otf"); }}')
    faces.append(f'@font-face {{ font-family: Pagella; font-weight: 700; '
                 f'src: url("file://{FONTS}texgyrepagella-bold.otf"); }}')
    return "\n".join(faces)


def front_words(left, top, w, h):
    """Title, subtitle and names, placed on a front panel of trim size w x h."""
    return f"""
<div class="title" style="left:{left}pt; top:{top + 0.13 * h}pt; width:{w}pt">The Presence</div>
<div class="sub" style="left:{left}pt; top:{top + 0.13 * h + 62}pt; width:{w}pt">What All Religions Agree On</div>
<div class="names" style="left:{left}pt; top:{top + 0.885 * h}pt; width:{w}pt">Joseph and Alisha Lewis</div>"""


STYLE = """
%(faces)s
html, body { margin: 0; padding: 0; background: #07081a; }
.page { position: relative; overflow: hidden; }
.page > img { position: absolute; left: 0; top: 0; }
.page div { position: absolute; font-family: Pagella; }
.title { text-align: center; font-size: 46pt; letter-spacing: 0.1em; text-transform: uppercase;
  color: %(gold)s; }
.sub { text-align: center; font-style: italic; font-size: 16.5pt; color: %(mist)s; letter-spacing: 0.02em; }
.names { text-align: center; font-size: 12.5pt; letter-spacing: 0.24em; text-transform: uppercase; color: %(ink)s; }
.epigraph { font-style: italic; font-size: 11.5pt; line-height: 1.45; color: %(mist)s; text-align: center; }
.cite { font-size: 9.5pt; letter-spacing: 0.06em; color: %(gold)s; text-align: center; }
.blurb { font-size: 10.6pt; line-height: 1.47; color: %(ink)s; text-align: left; hyphens: auto; }
.blurb p { margin: 0 0 7pt 0; }
.blurb p:first-child { font-size: 12pt; color: %(gold)s; }
.imprint { font-size: 9pt; letter-spacing: 0.22em; text-transform: uppercase; color: %(gold)s; }
.spine { display: flex; align-items: center; justify-content: center; writing-mode: vertical-rl;
  font-size: 7.6pt; letter-spacing: 0.16em; text-transform: uppercase; color: %(ink)s; white-space: nowrap; }
.spine b { color: %(gold)s; font-weight: 400; margin-bottom: 14pt; }
"""


def styles():
    return STYLE % dict(faces=font_face(), gold=GOLD, mist=MIST, ink=INK)


def data_url(path):
    with open(path, "rb") as fh:
        return "data:image/png;base64," + base64.b64encode(fh.read()).decode()


# -- Building ----------------------------------------------------------------------

def render_svg(page, svg, w, h, scale, path):
    page.set_viewport_size({"width": int(round(w)), "height": int(round(h))})
    page.set_content(f'<html><body style="margin:0">{svg}</body></html>')
    page.screenshot(path=path, clip={"x": 0, "y": 0, "width": w, "height": h})


def prepared_art(art, full_w, full_h, front_x, scale, out_png):
    """Fit a supplied picture to the wraparound: a wide one fills it all; a tall,
    front-only one fills the front, and a dark, blurred mirror of it fills the back."""
    im = Image.open(art).convert("RGB")
    W, H = int(full_w * scale), int(full_h * scale)
    if im.width / im.height > 1.0:
        canvas = im.resize((W, H), Image.LANCZOS)
    else:
        fx = int(front_x * scale)
        fw = W - fx
        front = im.resize((fw, H), Image.LANCZOS)
        back = front.transpose(Image.FLIP_LEFT_RIGHT).resize((fx, H), Image.LANCZOS)
        back = ImageEnhance.Brightness(back.filter(ImageFilter.GaussianBlur(18))).enhance(0.45)
        canvas = Image.new("RGB", (W, H))
        canvas.paste(back, (0, 0))
        canvas.paste(front, (fx, 0))
    canvas.save(out_png)


def main():
    ap = argparse.ArgumentParser(description="Build the cover of The Presence.")
    ap.add_argument("out")
    ap.add_argument("--pages", type=int, required=True, help="the interior's page count")
    ap.add_argument("--art", help="a picture to use instead of the drawn one")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    work = os.path.join(args.out, "cover-work")
    os.makedirs(work, exist_ok=True)

    spine = args.pages * SPINE_PER_PAGE
    full_w = 2 * BLEED + 2 * TRIM_W + spine
    full_h = 2 * BLEED + TRIM_H
    back_x, spine_x = BLEED, BLEED + TRIM_W
    front_x = spine_x + spine
    scale = 300 / PT  # pixels per point, for 300 dpi
    print("Spine %.3f in; cover %.4f x %.4f in" % (spine / PT, full_w / PT, full_h / PT))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=scale)

        art_png = os.path.join(work, "art.png")
        if args.art:
            prepared_art(args.art, full_w, full_h, front_x, scale, art_png)
        else:
            m = 0.5 * PT
            quiet = (back_x + m - 10, BLEED + 0.5 * PT, spine_x - m + 10, BLEED + 6.9 * PT)
            render_svg(page, art_svg(full_w, full_h, front_x, TRIM_W + BLEED, BLEED, TRIM_H, quiet),
                       full_w, full_h, scale, art_png)

        m = 0.5 * PT  # text sits half an inch inside the trim
        blurb = "".join(f"<p>{t}</p>" for t in BLURB)
        html = f"""<!doctype html><html><head><meta charset="utf-8"><style>{styles()}
@page {{ size: {full_w / PT}in {full_h / PT}in; margin: 0; }}</style></head><body>
<div class="page" style="width:{full_w}pt; height:{full_h}pt">
<img src="{data_url(art_png)}" style="width:{full_w}pt; height:{full_h}pt">
{front_words(front_x, BLEED, TRIM_W, TRIM_H)}
<div class="epigraph" style="left:{back_x + m}pt; top:{BLEED + 0.62 * PT}pt; width:{TRIM_W - 2 * m}pt">{EPIGRAPH}</div>
<div class="cite" style="left:{back_x + m}pt; top:{BLEED + 1.55 * PT}pt; width:{TRIM_W - 2 * m}pt">‘ABDU’L-BAHÁ, PARIS, 1911</div>
<div class="blurb" style="left:{back_x + m}pt; top:{BLEED + 2.2 * PT}pt; width:{TRIM_W - 2 * m}pt">{blurb}</div>
<div class="imprint" style="left:{back_x + m}pt; top:{BLEED + TRIM_H - 0.75 * PT}pt">Big Banana Studios</div>
<div class="spine" style="left:{spine_x}pt; top:{BLEED}pt; width:{spine}pt; height:{TRIM_H}pt"><b>The Presence</b>Joseph and Alisha Lewis</div>
</div></body></html>"""
        cover_html = os.path.join(work, "cover.html")
        with open(cover_html, "w", encoding="utf-8") as fh:
            fh.write(html)
        page.goto("file://" + cover_html)
        page.wait_for_timeout(300)
        pdf = os.path.join(args.out, "The-Presence-cover-KDP.pdf")
        page.pdf(path=pdf, width=f"{full_w / PT}in", height=f"{full_h / PT}in",
                 print_background=True, margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})

        prev = browser.new_page(device_scale_factor=1)
        prev.set_viewport_size({"width": int(full_w * 4 / 3) + 1, "height": int(full_h * 4 / 3) + 1})
        prev.goto("file://" + cover_html)
        prev.wait_for_timeout(300)
        prev.screenshot(path=os.path.join(args.out, "The-Presence-cover-preview.png"),
                        clip={"x": 0, "y": 0, "width": full_w * 4 / 3, "height": full_h * 4 / 3})

        # The Kindle cover: the front alone, 1600 x 2560.
        ew, eh = TRIM_W, TRIM_W * 1.6
        ebook_art = os.path.join(work, "ebook-art.png")
        if args.art:
            im = Image.open(args.art).convert("RGB")
            if im.width / im.height > 1.0:  # a wraparound picture: take its front
                im = im.crop((int(im.width * front_x / full_w), 0, im.width, im.height))
            src_ratio, dst_ratio = im.width / im.height, ew / eh
            if src_ratio > dst_ratio:
                nw = int(im.height * dst_ratio)
                im = im.crop(((im.width - nw) // 2, 0, (im.width - nw) // 2 + nw, im.height))
            im.resize((1600, 2560), Image.LANCZOS).save(ebook_art)
        else:
            render_svg(page, art_svg(ew, eh, 0, ew, (eh - TRIM_H) / 2, TRIM_H), ew, eh, 1600 / ew, ebook_art)
        ebook_html = os.path.join(work, "ebook.html")
        with open(ebook_html, "w", encoding="utf-8") as fh:
            fh.write(f"""<!doctype html><html><head><meta charset="utf-8"><style>{styles()}</style></head><body>
<div class="page" style="width:{ew}pt; height:{eh}pt"><img src="{data_url(ebook_art)}" style="width:{ew}pt; height:{eh}pt">
{front_words(0, (eh - TRIM_H) / 2, ew, TRIM_H)}</div></body></html>""")
        eb = browser.new_page(device_scale_factor=1600 / (ew * 4 / 3))
        eb.set_viewport_size({"width": int(round(ew * 4 / 3)), "height": int(round(eh * 4 / 3))})
        eb.goto("file://" + ebook_html)
        eb.wait_for_timeout(300)
        png = os.path.join(work, "ebook.png")
        eb.screenshot(path=png, clip={"x": 0, "y": 0, "width": ew * 4 / 3, "height": eh * 4 / 3})
        Image.open(png).convert("RGB").resize((1600, 2560), Image.LANCZOS).save(
            os.path.join(args.out, "The-Presence-ebook-cover.jpg"), quality=92)
        browser.close()
    print("Wrote", pdf)


if __name__ == "__main__":
    main()
