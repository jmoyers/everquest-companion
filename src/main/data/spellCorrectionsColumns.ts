// THE COLUMN CORRECTIONS — the seventh and eighth drift classes, split out of
// `spellCorrectionsList.ts` at its measured 400-code-line ceiling (JOS-528), along the seam the
// architecture already cut for the sixth: a drift class that is not about a SENTENCE gets its own
// file, the way `spellCorrectionsPolarity.ts` holds the polarity family. The evidence bar, the
// idempotence triangle and the `rowsFor` write rules are `spellCorrectionsList.ts`'s and
// `spellCorrections.ts`'s; nothing about an entry is decided here.
//
// THE WRONG LEVEL (the seventh, JOS-415): `classes` is the wiki's other column, the one
// `shared/spellLevels.ts` reads into (class, level) pairs and `buildLevelUnlocks` turns into
// "new at this level" cards. Its defect shape is a duplicate pair of wiki pages that disagree,
// which is why a classes correction writes EVERY row of its name — half a correction leaves the
// phantom card exactly where it was.
//
// THE WRONG EFFECT LINE (the eighth, JOS-528): `effects` is the wiki's numbered slot list, and
// `shared/spellMetrics.ts` reads its `per tick` marker to decide whether damage arrives over
// time. A correction here replaces ONE element of the list, first row, `from` required — see the
// field-union doc in `spellCorrections.ts`.

import type { SpellCorrection } from './spellCorrections'

export const COLUMN_CORRECTIONS: readonly SpellCorrection[] = [
  // The wiki has two pages for this spell — pageid 46874, titled `Leech`, `{{Classic Era}}`,
  // `* [[Necromancer]] - Level 9`, and pageid 50162, titled `Leach`, `{{Paineel Era}}`,
  // `* [[Necromancer]] - Level 12 Recourse Effect` — and BOTH set `spellname = Leach`, so the
  // scrape files two rows under one name. Every other field the two share is identical (mana 72,
  // cast 2.40, recast 10.00, the same `Decrease Hitpoints by 8 per tick` slot, the same four
  // vendors in the same four zones), which is what makes them one spell rather than two. The
  // level-12 row is the one that is wrong.
  {
    spells: ['Leach'],
    field: 'classes',
    from: '* Necromancer - Level 12 Recourse Effect',
    to: '* Necromancer - Level 9',
    attribution: 'db',
    evidence:
      'Reported 6AT44D (v1.5.0): `For a necro, on level up to level 12. Shows Leach beting a spell. But leach was learned at lvl 9 for a necro.` Checked against EQ LEGENDS data, not classic EQ: eqlwiki`s own Necromancer spell list places the spell ONCE, at Level 9, as `Leach NEC(9)` linking the page titled `Leech`; its Level 12 rows are Bind Affinity, Convoke Shadow and Lifedraw, and no row anywhere in that list links the page titled `Leach`. The DB is its own witness twice over: our other row for this name already says `* Necromancer - Level 9` (so this correction reports satisfied on it), and the level-12 page`s own description reads `6 ticks @L9 to 9 ticks @L15` while its duration row says `7 ticks @L12` — the page contradicts itself about the floor. `Level 12 Recourse Effect` is a note the wiki hung on the classes bullet; shared/spellLevels.ts`s SEGMENT regex reads the number and ignores the trailing words, which is correct behaviour on a line that is wrong. Blast radius: buildLevelUnlocks emitted a second Leach row at NEC 12 and the panel drew a card there; with both rows at NEC 9 the renderer`s fold-by-name draws one card at 9 and none at 12. spellClasses is unchanged (both rows already said Necromancer).'
  },
  // The Leach shape exactly: two wiki pages under one `spellname`, and the one that is wrong is a
  // live-EQ copy that pre-dates the Legends re-tier.
  {
    spells: ['Swift Like The Wind'],
    field: 'classes',
    from: '* Enchanter - Level 49',
    to: '* Enchanter - Level 47',
    attribution: 'db',
    evidence:
      'Reported 01M0T4RJCRZRFTFZ6W717T2W14 (v1.9.0): `hi see the spell swift like the wind for enchanter at both 47 and 49. it`s only at 47. thanks!` The wiki holds two pages that both set `spellname = Swift Like The Wind` (checked 2026-08-28): pageid 48049, `* Enchanter - Level 47`, recast 1.50, duration `16 Min` — the Legends page — and pageid 49816, `* Enchanter - Level 49`, recast 2.25, duration `15.7 minutes @L49 to 16 minutes @L50`, which is live EQ`s level-scaled figure for its L49 enchanter haste, copied before the re-tier. eqlwiki`s own Enchanter spell index carries the spell ONCE, in its ==Level 47== section, linking the 48049 page; no index row places it at 49. Blast radius: buildLevelUnlocks drew a phantom card at ENC 49; with both rows at 47 the renderer`s fold-by-name draws one card at 47. Duration is untouched (both rows already parse to 960000 ms) and no message moves.'
  },
  // The eighth class's one entry. `shared/spellMetrics.ts` reads the slot list`s `per tick`
  // marker to decide whether damage arrives over time, so a DoT whose slot line omits the marker
  // files as direct damage: wrong tab, and a total counted once instead of once per tick.
  {
    spells: ['Vengeance of the Wild'],
    field: 'effects',
    from: 'Decrease Hit Points between 121 and 132',
    to: 'Decrease Hit Points between 121 and 132 per tick',
    attribution: 'db',
    evidence:
      'Reported 01M0V24TW8FP3WFS38AFGN1HDH (v1.9.0): `Vengeance of the Wild is not showing as a DoT and the damage listed does not match the actual DoT damage (likely because its is not being seen as a DoT?)` The page is its own witness (pageid fetched 2026-08-28): its description reads `causing between 122 and 131 damage every six seconds for 30s` and its duration row `5 ticks`, while its slot line alone omits the rate marker. The DB is the family witness: 138 detrimental rows with a duration carry `per tick` on their Decrease-Hitpoints line verbatim, and every other no-marker row with a duration (censused 2026-08-28: the root families, Fire, Ice, Flame Song of Ro, Stone Spider Stun) is genuinely front-loaded damage riding a root/resist/stun duration — Vengeance of the Wild is the sole row whose own description contradicts its slot. The numbers 121/132 are the slot`s and stay: the description`s 122/131 is the page disagreeing with itself by one, and a correction fixes the marker, not the wiki`s arithmetic. Blast radius: spellMetrics reads perTick true, so bestSpells moves the spell from the DD tab to the DoT tab and its total becomes per-tick x 5 ticks (126.5 midpoint -> 632.5) with dps over the 30 s cycle; the parser is untouched (DoT damage attribution is log-shape driven); spellEffectClass`s heal families are untouched (this is a Decrease line).'
  }
]
