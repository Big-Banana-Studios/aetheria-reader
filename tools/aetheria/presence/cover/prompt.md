# The Presence: cover art prompts

For an image model such as Nano Banana. The art carries no lettering: the
title, names, spine and back cover are set by `make_cover.py --art`, so
they come out sharp and at KDP's exact sizes.

## Front cover (portrait, 2:3, 4K)

A luminous, contemplative fine-art painting for a book cover. Night on a vast,
quiet plain under a deep indigo sky scattered with faint stars. Across the
lower middle of the picture stands a gentle row of seven freestanding
doorways from the sacred architecture of different peoples and ages, each a
different shape, left to right: an ancient stone trilithon of two standing
stones and a capstone; a Moorish horseshoe arch; a slender Gothic pointed
arch; in the center, the tallest, a plain wooden doorway with its door swung
open; a Mughal onion-dome arch; a round Romanesque arch; a Japanese torii
gate. No walls and no buildings, only the doorways standing in the open.
Through every doorway pours the same warm golden light, as if one sun stood
just beyond them all, and it spills forward across the ground in long soft
pools that reflect faintly, like still water. Mood: hushed, reverent,
hopeful. One light, many doors. Palette: indigo, midnight blue, warm gold
and amber, with a breath of lavender in the sky near the horizon. Style:
refined digital painting with subtle painterly texture, cinematic lighting,
gentle volumetric glow, crisp dark silhouettes, minimal and elegant, never
busy. Composition: vertical 2:3, centered and symmetrical; the doorways sit
about two-thirds of the way down; keep the top third open, dark sky for a
title, and the bottom tenth calm and dark for the authors' names. No text,
letters, numbers, logos, signatures or watermarks. No people or faces. No
religious symbols or icons on the doorways (no crosses, crescents, stars,
Om signs or statues), so that no tradition is singled out. Highly detailed,
4K.

## Full wraparound (landscape, about 4:3, 4K)

The same painting, made wide for a paperback's whole cover: back, spine and
front. Landscape, about 4:3 (12.5 by 9.25). The seven doorways and their
light stand only in the right half, centered within it, about two-thirds of
the way down. The left half is the back cover: the same starry indigo sky and
dark plain, quiet and fairly even, with only a faint warm glow along the
horizon, dark enough for paragraphs of light-colored text. Keep a narrow
vertical strip just left of the center plain, for the spine. No text,
letters, logos or watermarks; no people; no religious symbols. 4K.

## Using our cover as a reference

Attach `The-Presence-ebook-cover.jpg` and add to either prompt: "Use the
attached image as a reference for composition only. Keep the seven doorways
in the same order and the same layout, but repaint everything as a rich,
detailed painting, and leave out all the lettering."

## Then

    python tools/aetheria/presence/cover/make_cover.py out --pages 117 --art the-painting.png

`painting.jpg`, here, is the painting Joe made from the front-cover prompt on
19 November 2026, with our cover as the reference. It is the book's cover:

    python tools/aetheria/presence/cover/make_cover.py out --pages 117 --art tools/aetheria/presence/cover/painting.jpg

Use the interior's final page count: the spine's width depends on it.
