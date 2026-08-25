// One-off LOOT fixture extractor (Task #47) — sibling of extract-fixtures.mjs (which is
// buffs-oriented and drops loot lines). Slices line ranges from the real log keeping only
// the lines the loot family cares about (loot + zone), so fixtures stay small and
// reviewable but replay through the real parser + LootModule is faithful.
//
//   node tests/extract-loot-fixtures.mjs "<path-to-eqlog>"
//
// Line numbers below were located in eqlog_Primitive_freeport.txt on 2026-08-02;
// re-locate if the log is truncated/rotated.
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { scrubKeep } from './fixture-scrub.mjs'

// Fixtures resolve RELATIVE to this file — the repo moved once and these extractors kept
// writing into the old absolute path. Never hardcode a repo path here again.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

const KEEP = [
  /\] --You have looted /,
  /\] You looted /,
  // The DESTROY (JOS-401) — the negative member of the loot family, and the only line in it that
  // subtracts. It belongs in these windows for the same reason the sold form does: the held-count
  // rule is a fold over the whole family, and a window that shows only the additions can only
  // prove half of it.
  /\] You successfully destroyed /,
  /\] You have entered /
]
// Routed through the SHARED scrub (tests/fixture-scrub.mjs) — one definition of
// "third-party chat" for every extractor in the tree.
function keep(line) {
  if (!line.startsWith('[')) return false
  if (!scrubKeep(line)) return false
  return KEEP.some((re) => re.test(line))
}

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    if (keep(lines[i])) seg.push(lines[i])
  }
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// W19 DRAGON HOARD: the Jul 30 22:36–23:06 Plane of Fear gear session — a run of
// "… and stored it in your Dragon Hoard" loots (Blighted Gloves ×2, Vermiculated
// Bracelet +1, Umbral Platemail Gauntlets +1 with the "an" article, …).
slice(598500, 609900, 'w19-hoard.log')
// W19b TRADESKILL DEPOT: the Aug 1 00:28:20 "Griffenne Blood … stored it in your
// tradeskill depot" line (one of only two in the whole log).
slice(793350, 793410, 'w19b-depot.log')
// W20 COMBINE/UPGRADE: the Jul 19 08:48–09:39 lowbie session — "You looted <item> …
// to create a <item> +N" upgrade lines (Thaumaturgist's Robe → +2 twice incl. a
// same-second double combine, Antiqued Silver Band → "an" article on the created item).
slice(2560, 15115, 'w20-combine.log')
// W21 STACKED COUNTS: the Jul 20 19:01–20:34 session — dashed "--You have looted 2 Bone
// Chips …--" kept stacks AND "You looted 2 Phosphorous Powder … and sold it …" sold
// stacks (the old regexes swallowed the digits into the item name).
slice(151440, 169545, 'w21-stacked.log')
// W33 DESTROY (JOS-401): the Aug 4 21:35–21:37 Nagafen loot-then-clean-out — three Prayers of
// Life off one corpse and ONE destroyed (held 2), a `Blight, Hammer of the Scourge +1` looted and
// then destroyed on the same counting key, and two destroys of things this window never saw
// arrive (`Backpack`, `Diamond Dust`) — the floor-at-0 case, on real bytes.
slice(1315000, 1315060, 'w33-destroy.log')
// W34 DESTROY STACKS (JOS-401): the Aug 12 00:36–00:38 Karana skeleton pull — a `2 Bone Chips`
// stack, two singles and one auto-sold (never held) followed by two destroys, so the stack size
// rule and the subtraction meet on one counting key inside one zone.
slice(1608330, 1608460, 'w34-destroy-stacks.log')
// W47 THE AUTO-SELL / AUTO-MERGE PATCH ERA (JOS-453): the Aug 23 15:06–15:27 Plane of Hate
// session the owner reported. Every window above was cut from JULY / early-August spans where a
// looted item rarely carried a ` +N`; the 2026-08-18 patch made `+N` drops routine, and this
// window is the loot family AS IT PRINTS NOW, on one evening's real bytes:
//   · auto-SELL of a `+N` drop — `Ethereal Mist Gauntlets +4 … and sold it for free.` and
//     `Shadow Rage Sleeves +4 … for free.` The item came off a corpse and was GONE the same
//     instant: the case that decides what the gear-ownership census may claim (see
//     shared/lootDisposition.ts `isKept`).
//   · auto-MERGE with NO TIER BUMP — `Ethereal Mist Greaves +4 … to create an Ethereal Mist
//     Greaves +4`. The census below found 106 of these; every earlier fixture's combine lines
//     climb, so no committed window pinned the equal case before this one.
//   · auto-MERGE from a TIERLESS looted copy — `Lustrous Russet Vambraces … to create a Lustrous
//     Russet Vambraces +6` (twice, and `Shadow Rage Wristguard`/`Shrieking Ahlspiess` beside it):
//     the created name is the ONLY tier statement on the line, which is what itemTiers folds.
//   · the ordinary climb (`Indicolite Bracer +4 → +6`, `Valorium Vambraces +1 → +5`), a STACKED
//     auto-sell (`2 Crystallized Sulfur`), dashed keeps (Ruby, Diamond, a Mote) and a mid-window
//     zone change into `The Plane of Hate 4 (Refined)` so the zone tag is exercised too.
slice(2465019, 2469700, 'w47-autosell-patch.log')
