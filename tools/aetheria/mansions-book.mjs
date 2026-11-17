// Writes texts/mansions-of-the-moon.md, the Mansions of the Moon as a book for the Aetheria shelf,
// from the canon in an aetheria-divination checkout (the same data its Mansions tab, and
// Titīrṣā's, are drawn from). Never edit the .md by hand: change the canon there and run again.
//
//   node tools/aetheria/mansions-book.mjs ../aetheria-divination
//
// One section per mansion, so the Reader's list of sections runs 1 to 27.

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const div = process.argv[2];
if (!div) {
  console.error('Usage: node tools/aetheria/mansions-book.mjs <aetheria-divination folder>');
  process.exit(2);
}
const from = (/** @type {string} */ p) => import(pathToFileURL(resolve(div, p)).href);
const { mansionsExport } = await from('scripts/export-mansions.js');
const { padas, mansionArc, pillarOf } = await from('src/engine/mansions.js');
const { arcText } = await from('src/ui/mansions-view.js');

const D = mansionsExport();
const PALACE = {
  1: 'north, Water, ☵ Kan', 2: 'south-west, Earth, ☷ Kun', 3: 'east, Wood, ☳ Zhen',
  4: 'south-east, Wood, ☴ Xun', 5: 'the center, Earth', 6: 'north-west, Metal, ☰ Qian',
  7: 'west, Metal, ☱ Dui', 8: 'north-east, Earth, ☶ Gen', 9: 'south, Fire, ☲ Li',
};
const QUARTER = ['First', 'Second', 'Third', 'Fourth'];
const cap = (/** @type {string} */ t) => t.charAt(0).toUpperCase() + t.slice(1);
const stop = (/** @type {string} */ t) => (/[.!?]$/.test(t) ? t : `${t}.`);
const list = (/** @type {(string|number)[]} */ xs) => (xs.length < 2 ? String(xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
function ord(/** @type {number} */ n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** How a counterpart was matched, as a sentence. */
function matched(/** @type {{match: string, note: string}} */ x) {
  if (x.match === 'star') return `Stars in common: ${x.note}.`;
  if (x.match === 'near') return `Matched by nearby stars: ${x.note}.`;
  return x.note ? `Matched by order round the sky. ${stop(cap(x.note))}` : 'Matched by order round the sky.';
}
const chinese = (/** @type {any} */ c) =>
  `Chinese: ${c.char} ${c.pinyin}, ${c.meaning}, the ${ord(c.order)} of the 28 xiù, in the ${c.group}. Its key star is ${c.star}. ${matched(c)}`;
const arabic = (/** @type {any} */ a) =>
  `Arabic: ${a.name}, ${a.meaning}, the ${ord(a.order)} of the 28 manāzil. Its stars: ${a.stars}. ${matched(a)}`;

const A = D.abhijit;
const u21 = mansionArc(21), s22 = mansionArc(22);
const traitSources = D.sources.traits.map(([name, , what]) => `${name} for ${what}`);

let md = `---
title: The Mansions of the Moon
author: Joseph and Alisha Lewis, with Claude
year: 2026
---
# The Mansions of the Moon

The 27 lunar mansions as the Mansions tab in Divination Freq and Titīrṣā shows them. Joe and Alisha approved this material on 17 November 2026.

Each mansion is an arc of 13°20′ of the star (sidereal) zodiac, reckoned with the Lahiri ayanamsa. Each has four quarters of 3°20′. Its tone is the tone with the same number: the first mansion goes with the first tone, 174 Hz.

For each mansion this book gives:
- its arc of the sky and its stars;
- what the Aetheria Tone Codex says of it: its deity, symbol and ruling planet;
- its tone, palace and hexagram, with Legge's Judgment;
- its four quarters, each with its navamsa sign and naming syllable;
- its counterparts in the Chinese and Arabic lists of 28;
- its matchmaking traits;
- the stories of its stars.

The matches with the Chinese and Arabic lists are ours. Where the two lists share a star, we matched by that star. Otherwise we went by their order round the sky, counting Abhijit as the 28th mansion.

The matchmaking traits come from modern almanac lists, which name no classical text: ${list(traitSources)}. Each story names the article it comes from.

# Abhijit, the 28th mansion

The old lists counted 28 mansions. Later astronomers dropped Abhijit to make 27, a count that fits the 27 tones.

Abhijit runs from ${arcText(A.startDeg, A.endDeg)} of the star zodiac. That is the last quarter of Uttara Ashadha (${arcText(u21.end - 10 / 3, u21.end)}) and the first ${Math.round((A.endDeg - s22.start) * 60)}′ of Shravana.

Stars: ${A.stars}. Deity: ${A.deity}.

${chinese(A.chinese)}

${arabic(A.arabic)}
`;

for (const m of D.mansions) {
  const { start, end } = mansionArc(m.n);
  const pillar = pillarOf(m.n);
  md += `
# ${m.n} · ${m.name}, “${m.meaning}”

${arcText(start, end, true)} of the star zodiac.

- Deity: ${stop(cap(m.deity))}
- Symbol: ${stop(cap(m.symbol))}
- Ruling planet: ${m.planet}.
- Stars: ${stop(m.stars)}

Tone: ${m.hz} Hz, ${m.script}, ${m.fn}, in the ${m.layer} layer. Palace ${m.palace}: ${PALACE[m.palace]}. Its pillar of the cube is mansions ${list(pillar)}, all ruled by ${m.planet}.

Hexagram: ${m.hexagram.number}, ${m.hexagram.name} (${m.hexagram.chinese} ${m.hexagram.pinyin}). Legge's Judgment: ${m.judgment}

${m.prose}

${padas(m.n).map((p, k) => `${QUARTER[k]} quarter: ${arcText(p.start, p.end)}. Navamsa ${p.navamsa}. Syllable ${p.syllable}.`).join('\n\n')}

${chinese(m.chinese)}

${arabic(m.arabic)}

Matchmaking traits. Gana: ${m.traits.gana}. Yoni: ${m.traits.yoni}. Nadi: ${m.traits.nadi}. Nature: ${m.traits.nature}.
${m.lore.map((l) => `\n${stop(l.title)} ${l.text} (${l.source})\n`).join('')}`;
}

md += `
# Sources

The syllables of the quarters come from Wikipedia's article Nakshatra, the Chinese list from Twenty-Eight Mansions, and the Arabic list from Lunar station. The traits come from ${list(traitSources)}. Each story names its own article.

The deity, symbol, ruling planet, tone and its words are from the Aetheria Tone Codex, on this shelf. Legge's Judgments are from James Legge's translation of the Yi King (1882).
`;

const out = join(dirname(fileURLToPath(import.meta.url)), 'texts', 'mansions-of-the-moon.md');
writeFileSync(out, md);
console.log(`Wrote ${out} (${md.split(/\s+/).length} words)`);
