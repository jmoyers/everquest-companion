# Spell-line research (all 13 spell-casting classes)

Produced 2026-08-13 by thirteen parallel research agents (one per class; Berserker/Monk/Warrior
have no spells on Legends), each grounded in the class's Legends spell list (dumped from
`src/main/data/spells.json` into `class-spells.json` here — 2,003 class-spell rows total) and
researching CLASSIC/LIVE sources for line membership and stacking semantics:
`wiki.project1999.com` (especially its `Buff_Lines` slot table; note the .net mirror is dead and
.com serves a broken cert chain), `everquest.allakhazam.com`, Lucy stacking dumps, and
eqresource. eqlwiki.com was deliberately NOT fetched — the repo already mirrors it under
`scripts/sources/cache/spells/`, and it stays the sole authority for what exists on Legends.
Coverage was verified programmatically per class AND at merge: every input spell placed exactly
once (modulo genuine DB duplicate rows, folded and flagged), zero unexplained cross-agent
stacking contradictions.

THE RESEARCH IS AMENDED WHEN THE GAME PATCHES, NOT RE-RUN (JOS-439, 2026-08-21). The game added
`Lifebite` — an instant lifetap the wiki page for which was created 2026-08-18 — and the owner
ruled it into both lifetap ladders. Two rows were added by hand rather than by a fourteenth agent:
`Lifebite` at Necromancer 8 and Shadow Knight 10, between `Lifespike` and `Lifedraw` in
`nec-lifetap` and `sk-lifetap-direct`, mirrored into `lines-merged.json`, with the matching
`class-spells.json` rows (so the coverage arithmetic still balances: necromancer input 192 → 193,
shadow-knight 90 → 91) and a note on each member saying where it came from. A patch that adds a
whole class's worth of spells would deserve the agent; one rung does not.

`log-blocked-pairs.json` is the MEASURED evidence tier: 33 distinct stacking conflicts mined
from the owner's own log ("Your X spell did not take hold. (Blocked by Y.)" — game messages
only, no player speech). Several independently confirm the P99 slot model on Legends itself
(Center vs Skin like Rock; Arch Shielding vs Talisman of Altuna; Augmentation vs Celerity).
The parser could capture these live — a per-user measured stacking tier for the overlay.

## Files

- `class-spells.json` — the ground truth handed to the agents: per class, every spell with
  Legends level + effect strings (magnitudes are Legends' own scaling).
- `lines-<class>.json` — the per-class deliverable: upgrade lines (ordered members, `inDb`
  flags), standalone spells, `missingOnLegends`, `unlinked` facts, stacking conflicts with
  source URLs, and open questions.
- `lines-merged.json` — the four files merged, plus coverage verification (598/598 spells
  placed exactly once) and cross-agent contradiction checks (none genuine).

## The load-bearing model

P99's `Buff_Lines` page expresses stacking as numbered effect SLOTS — two buffs conflict iff
they occupy the same slot. All four agents converged on this independently. Key verified facts:

- Cleric Courage/Heroism line, druid/ranger Skin line, shaman Inner Fire, and Protection of
  the Glades share ONE slot (AC slot 1 + HP primary) — mutually exclusive.
- Symbol line (HP-only, gem-reagent column), Aegis line (AC slot 4), Talisman/Shielding
  (their own HP group) all stack with the above and with each other.
- Aegolism is a COMBINATION spell occupying slot 1 AND 4 with a hard HP blocker — it evicts
  Heroism + Symbol + Aegis and mutually blocks Protection of the Glades.
- Legends' own `effects` strings carry the classic slot-blocker rows verbatim
  (`Block new spell if slot N is effect 'Max Hitpoints' and < X`) — some stacking rules are
  machine-derivable from our DB alone.
- Legends spell LEVELS track modern/live Allakhazam, not P99 classic — levels must come from
  our DB, never from classic sources.

Intended consumer: a future spell-lines OVERLAY (separate module beside
`spellCorrectionsList.ts`, applied at load in `spellDb.ts`) powering upgrade-sequence
tracking ("you scribed the replacement for X") and cross-class stacking answers.
