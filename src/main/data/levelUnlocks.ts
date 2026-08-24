// LEVEL UNLOCKS, assembled — main's half of "what's new at this level"
// (docs/plans/levelup-whats-new.md, wave O2).
//
// NOTHING IS SCRAPED OR FETCHED HERE. Both halves are already committed and already bundled into
// the MAIN process (electron-vite inlines a JSON import — a path-relative read would miss in
// out/main/, the standing gotcha):
//   * spells.json  → the wiki's `classes` bullet list, parsed to (class, level) pairs by
//     shared/spellLevels.ts, plus the four card fields a hover needs.
//   * classes.json → `skillUnlocks` / `discUnlocks` / `disputed`, committed by wave O1.
// The renderer cannot import either (it must not reach into src/main), so this module folds them
// into the one shared wire shape and the panel pulls it once per session.
//
// THE DISPUTE RIDES ON THE ROW. classes.json states its disagreements as prose in `disputed[]`;
// a renderer that had to re-match those strings against rows would be re-deriving knowledge at
// the far end of an IPC. Instead every disputed discipline row carries the wiki's own sentence
// VERBATIM, so the panel's honesty chip is a field read, not an inference (law 1). Twelve rows
// today — BER 2, MNK 10 — the non-Rogue disciplines the central Disciplines page strikes through,
// less the one row a player has since CONFIRMED in game (`CONFIRMED_UNLOCKS`, below).
//
// CACHED FOREVER: both inputs are compile-time constants, so the fold runs once per process.

import classesJson from './classes.json'
import spellsJson from './spells.json'
// The corrections overlay, applied here for the same reason `spellDb.ts` applies it (JOS-161):
// every row of this dataset is DISPLAYED by name, and a card announcing a spell by a name the
// game never prints is a card a player cannot act on.
import { applySpellCorrections } from './spellCorrections'
// The removals layer, for the reason THIS module is the one that named it (JOS-337). Every row
// here becomes a CARD telling the player what they just unlocked and can go buy — so a spell EQ
// Legends does not have is not an inert row, it is the app sending the owner to a vendor for
// nothing. Invigor reached three of his levels (PAL 22, SHM 24, RNG 30) that way. Applied BEFORE
// the corrections overlay, the load order `spellDb.ts` states.
import { applySpellRemovals } from './spellRemovals'
// The ERA JOIN (JOS-393), applied here for the reason this module applies the other two: every row
// here becomes a CARD telling the player what this level just gave them, and `Sloths Healing` —
// `{{Kunark Era}}`, `Shaman - Level 50+` — is not a spell a level-50 shaman can go and buy on a
// server that has not opened Kunark. The verdict rides the row (`UnlockSpell.outOfEra`) rather than
// removing it: the row is real and the SEARCH still answers for it (shared/levelUnlocks.ts folds it
// out of the level lists only).
import { applySpellEra } from './spellEra'
// THE SEARCH SURFACE (JOS-392), built by the function the alerts catalog is built with. Two
// datasets searched by one matcher (`shared/spellSearch.ts`) must be folded by one surface builder,
// or the box goes quietly deaf on one of them — the same argument `searchTextFor`'s own header
// makes about the query side.
import { searchTextFor } from './spellDb'
import { parseSpellClasses } from '../../shared/spellLevels'
import { isClassAbbr, type ClassAbbr } from '../../shared/classCombo'
import type { LevelUnlockData, UnlockSkill, UnlockSpell } from '../../shared/levelUnlocks'
import {
  anyClientCurve,
  parseHpLine,
  resolveSpellMana,
  spellMetricsAt,
  type ClientHpFacts
} from '../../shared/spellMetrics'
// The CLIENT'S hitpoint slots (JOS-396), threaded in from the IPC handler rather than imported:
// `spellTable.ts` is an Electron module and this one is node-tested. See clientSpellHp.ts.
import { clientHpFor } from './clientSpellHp'
// The RAIN roster (JOS-449) and the area arithmetic that reads it. Both are separable overlays over
// the scrape, like `spellEffectClass.ts`: delete either and the catalog is unchanged.
import { rainWaves } from './rainSpells'
import { aeHits, aeMaxTargets } from '../../shared/aoeSpells'
import { replacedBy } from './spellLineLookup'
import type { SpellResistTable } from '../../shared/resistTypes'
import type { SpellDbFile } from '../../shared/types'

/**
 * The level `parseHpLine` is asked at when the question is "is this a hitpoint line at all".
 *
 * Any level answers the same: the head test reads words and the magnitude shapes (breakpoints,
 * between/and, bare range, constant) all yield SOMETHING wherever they match, so only the value
 * moves with the level. Named rather than written as a bare `1` so the next reader does not have to
 * re-derive that this is not an evaluation.
 */
const LEVEL_ANY = 1

interface RawUnlock {
  name: string
  level: number
  kind: string
}

/** classes.json's `kind` strings, narrowed to the closed union. An unknown kind is dropped. */
function unlockKind(kind: string): UnlockSkill['kind'] | null {
  return kind === 'skill' || kind === 'disc' || kind === 'innate' ? kind : null
}

/**
 * The `disputed[]` sentence covering a class's discipline table, or undefined.
 *
 * Matched on the prefix the generator writes (`discUnlocks 'MNK':`) rather than by fuzzy search:
 * the scrape owns that format, and a looser match would attach an unrelated dispute to a row.
 */
function discDispute(disputed: readonly string[], cls: ClassAbbr): string | undefined {
  const prefix = `discUnlocks '${cls}':`
  return disputed.find((d) => d.startsWith(prefix))
}

/**
 * ONE ROW A PLAYER HAS SEEN IN EQ LEGENDS, overriding the wiki's dispute of it (JOS-351).
 *
 * `disciplineDisputes` (scripts/sources/classUnlocks.ts) writes ONE sentence per non-Rogue class,
 * because the central Disciplines page strikes those tables through WHOLESALE — it says nothing
 * about individual rows. So the dispute a row wears is a claim about its whole TABLE, and a class
 * whose table holds exactly one row (RNG) cannot distinguish "the wiki disputes this discipline"
 * from "the wiki disputes RNG disciplines in general". The chip nonetheless reads, to the player
 * looking at his own unlock, as doubt about the ability he is holding.
 *
 * THE EVIDENCE BAR IS `spellRemovalsList.ts`'s RULE 1, POINTING THE OTHER WAY. Absence and
 * presence are both unmeasurable from a log here — a discipline is trained, not cast, and the
 * client prints no line when one becomes available — so the only instrument is a person with the
 * game open, and the entry states WHO, WHEN and WHAT THEY SAW. A hypothesis about which
 * disciplines EQ Legends runs is NOT admissible: this clears one row and claims nothing about the
 * twelve BER/MNK rows beside it, which keep their chips until somebody looks at them too.
 *
 * AND THE SCRAPE STAYS PRISTINE. classes.json is rewritten wholesale by `npm run scrape:classes`,
 * so deleting the RNG sentence out of `disputed[]` by hand would come back on the next run and
 * would ALSO be a lie about what the wiki says — the wiki does still strike the table through.
 * The confirmation is an overlay applied at fold time, the arrangement `spellRemovals.ts` already
 * made for the spell scrape.
 *
 * `level` IS PART OF THE MATCH, NOT DECORATION: the confirmation is "this ability, at this level",
 * so a re-scrape that moves the row states something nobody has checked and the dispute comes
 * back rather than being silently cleared at a level no one confirmed.
 */
interface ConfirmedUnlock {
  cls: ClassAbbr
  name: string
  level: number
  /** ISO date the player looked in EQ Legends and had it. */
  verified: string
  /** Who looked and what they saw, in one line. */
  evidence: string
}

const CONFIRMED_UNLOCKS: readonly ConfirmedUnlock[] = [
  {
    cls: 'RNG',
    name: 'Disrupting Shot',
    level: 20,
    verified: '2026-08-14',
    evidence:
      'Report 01KZZ6S5JB4B9RYNZS4CAT4QPY: a reporter got Disrupting Shot on his Ranger at 20 in EQ Legends and said so; the owner independently confirmed the same day (JOS-351). RNG is the class whose struck-through table holds exactly ONE row, so this clears the whole RNG dispute and nothing else.'
  }
]

/** Has somebody confirmed this exact row, at this exact level, in the shipped game? */
function isConfirmed(cls: ClassAbbr, name: string, level: number): boolean {
  return CONFIRMED_UNLOCKS.some((c) => c.cls === cls && c.name === name && c.level === level)
}

/**
 * Fold one class's skill + discipline rows, attaching the discipline dispute to each disc row —
 * except the rows a player has confirmed in game, which carry no chip.
 */
function skillsFor(
  cls: ClassAbbr,
  skillRows: readonly RawUnlock[],
  discRows: readonly RawUnlock[],
  disputed: readonly string[]
): UnlockSkill[] {
  const out: UnlockSkill[] = []
  for (const r of skillRows) {
    const kind = unlockKind(r.kind)
    if (kind) out.push({ name: r.name, level: r.level, kind })
  }
  const dispute = discDispute(disputed, cls)
  for (const r of discRows) {
    const kind = unlockKind(r.kind)
    if (!kind) continue
    const row: UnlockSkill = { name: r.name, level: r.level, kind }
    if (dispute && !isConfirmed(cls, r.name, r.level)) row.dispute = dispute
    out.push(row)
  }
  return out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
}

/**
 * WHAT THE SPELL REPLACES, per class that gains it (JOS-391).
 *
 * Asked once per (spell, class) at fold time rather than per render: the lookup is a map read, but
 * this runs over 2,001 (spell, class) pairs and the answer is a compile-time constant — there is
 * nothing for it to become later. A class with no line for the spell contributes no entry, so the
 * field is absent rather than a list of nulls.
 */
function replacesFor(name: string, at: readonly { cls: ClassAbbr }[]): UnlockSpell['replaces'] {
  const out: { name: string; cls: ClassAbbr }[] = []
  for (const cls of new Set(at.map((p) => p.cls))) {
    const place = replacedBy(name, cls)
    if (place.replaces !== null) out.push({ name: place.replaces, cls })
  }
  return out.length > 0 ? out.sort((a, b) => a.cls.localeCompare(b.cls)) : undefined
}

/**
 * WHAT THE SPELL IS WORTH, and the inputs to say it again somewhere else.
 *
 * The SNAPSHOT is read at the lowest level any class gains it — the level the unlock row is about
 * (see `unlockSpells`). The INPUTS (JOS-445) are what lets the best-spells readout re-read the same
 * spell at the level the player is actually standing at, and they are filtered to the hitpoint
 * lines: `parseHpLine`'s verdict does not depend on the level it is handed, so `LEVEL_ANY` reads
 * the same set at every level and only the VALUE it would compute is level-dependent.
 *
 * The client slots ride along ONLY where they are what answered — `spellMetricsAt` consults them
 * nowhere else, so carrying them beside a wiki-sourced figure would be a field no reader can reach.
 *
 * AND THE RE-USE TIMER RIDES ALONG RESOLVED (JOS-444 ∩ JOS-445, the integration seam): the client
 * row is two fallbacks in one argument (JOS-396's hitpoint slots, JOS-444's recast) and
 * `spellMetricsAt` resolves page-over-client internally — but a wiki-lined spell does NOT carry
 * `clientHp` on the wire, so a re-reader at another level would silently lose a client-answered
 * recast. `recastMs` is therefore resolved HERE, once, with `withRecast`'s exact precedence (a
 * page's stated 0 is an answer and blocks the fallback), and `spellMetricsForLevel` divides by the
 * same denominator main did.
 *
 * AND A RAIN'S SNAPSHOT COUNTS ITS WAVES (JOS-449). The wiki's effect line states ONE wave, so the
 * unlock card used to introduce `Frost Storm` at 512 damage while the best-spells table beside it
 * now reads 1,536 — one panel contradicting its neighbour about the same spell. The snapshot is
 * therefore taken at the SINGLE-TARGET hit count (`aeHits(waves, 1, cap)`, which is 3 for a rain
 * and 1 for everything else), and both the count and the client's cap ride the row so the far end
 * can ask the other question without re-deriving either.
 */
function writeFigures(
  spell: UnlockSpell,
  s: SpellDbFile['spells'][number],
  at: readonly { level: number }[],
  client: SpellResistTable | null
): void {
  const clientHp = clientHpFor(client, s.name)
  const waves = rainWaves(s.name)
  const cap = aeMaxTargets(clientHp?.aeMaxTargets)
  const input = { ...s, hits: aeHits(waves, 1, cap) }
  const metrics = spellMetricsAt(input, Math.min(...at.map((p) => p.level)), clientHp)
  if (metrics) spell.metrics = metrics
  writeInputs(spell, s, clientHp)
  // Only when they SAY something: a 1 and the default would be two fields on ~1,900 rows restating
  // what their absence already states (`UnlockSpell.waves` / `aeMaxTargets`).
  if (waves > 1) spell.waves = waves
  if (clientHp?.aeMaxTargets !== undefined) spell.aeMaxTargets = clientHp.aeMaxTargets
}

/**
 * The re-evaluation inputs (JOS-445) and the two resolved fields, split out of `writeFigures` so
 * that function stays under the complexity ceiling as the sources it reconciles multiply.
 *
 * A WIKI-LINED ROW CARRIES THE CLIENT ROW TOO WHEN THE CLIENT'S CURVE ANSWERS FOR ONE OF ITS LINES
 * (JOS-451). Same seam `writeFigures`'s header describes for `recastMs`, resolved the other way: a
 * magnitude cannot be pre-resolved because a re-reader asks for it at ANOTHER LEVEL, so the facts
 * have to travel. Two rows in the committed catalog qualify, so this is not a payload question.
 */
function writeInputs(
  spell: UnlockSpell,
  s: SpellDbFile['spells'][number],
  clientHp: ClientHpFacts | undefined
): void {
  const hpLines = (s.effects ?? []).filter((line) => parseHpLine(line, LEVEL_ANY) !== null)
  if (hpLines.length > 0) spell.hpLines = hpLines
  if (clientHp && (hpLines.length === 0 || anyClientCurve(hpLines, clientHp))) {
    spell.clientHp = clientHp
  }
  const mana = resolveSpellMana(s.mana, clientHp?.mana)
  if (mana !== undefined) spell.mana = mana
  const recastMs = s.recastMs ?? clientHp?.recastMs
  if (recastMs !== undefined) spell.recastMs = recastMs
}

/**
 * Every spell the DB places for at least one class at a stated level, with its card fields, its
 * figures and what it replaces.
 *
 * THE METRICS ARE READ AT THE LOWEST LEVEL ANY CLASS GAINS IT, and that is the level the row is
 * about: "New at this level" draws a spell at the level it becomes yours, so a ramp evaluated
 * anywhere else would describe a spell you cannot cast yet. One dataset serves every loadout, so
 * it cannot be per-class — and it does not need to be, because a spell's own gain level is the
 * only level at which the panel ever introduces it. (The browsing case reads the SAME row: a
 * cleric stepping to 30 sees the spells that unlock at 30, evaluated at 30.)
 *
 * AND SINCE JOS-445 THE INPUTS RIDE ALONG (`hpLines` / `clientHp`), because a SECOND reader asks a
 * question this level cannot answer: the best-spells readout ranks every spell the loadout already
 * owns AT THE LEVEL BEING VIEWED, and a spell gained at 18 and read at 35 is a different number.
 * The snapshot above stays exactly as it was — it is the level the unlock row is about — and the
 * far end recomputes only when it wants another one.
 */
function unlockSpells(client: SpellResistTable | null): UnlockSpell[] {
  const file = spellsJson as SpellDbFile
  const out: UnlockSpell[] = []
  for (const s of applySpellCorrections(applySpellEra(applySpellRemovals(file.spells).spells).spells).spells) {
    const at = parseSpellClasses(s.classes)
    if (at.length === 0) continue
    const spell: UnlockSpell = { name: s.name, at }
    // `true` or absent, never `false` — the field's own law (`SpellEntry.outOfEra`), carried across
    // the wire unchanged so the renderer has nothing to decide.
    if (s.outOfEra === true) spell.outOfEra = true
    if (typeof s.castTimeMs === 'number') spell.castTimeMs = s.castTimeMs
    // `mana` is written by `writeFigures`, which is the only place holding the client row it may
    // have to fall back to (JOS-451) — one resolution, so the row's column and its `dmg/mana` can
    // never disagree.
    if (s.targetType) spell.targetType = s.targetType
    if (s.spellType) spell.spellType = s.spellType
    if (typeof s.durationMs === 'number') spell.durationMs = s.durationMs
    // The RANK NAMES are deliberately not part of this surface: the catalog folds a line's ranks
    // onto one row and has them to hand, while this dataset is one row per DB page and would have
    // to rebuild the rank index to say the same thing. The name and the three sentences the game
    // prints are what a player searching for a spell types.
    spell.searchText = searchTextFor(s, undefined)
    if (s.illusion) spell.illusion = true
    writeFigures(spell, s, at, client)
    const replaces = replacesFor(s.name, at)
    if (replaces) spell.replaces = replaces
    out.push(spell)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

let cached: LevelUnlockData | null = null
/** Was `cached` built with the client table in hand? See `buildLevelUnlocks`. */
let cachedWithClient = false

/**
 * The whole dataset, built once — and REBUILT ONCE MORE if the client's spell table shows up after
 * the first build (JOS-396).
 *
 * The inputs used to be compile-time constants, so "cached forever" was the whole story. The client
 * table is not: it is parsed on a worker (`src/main/resist/spellTable.ts`), takes a moment on a cold
 * launch, and a player who opens the Leveling tab in that moment would otherwise be handed a dataset
 * with Odium's damage permanently missing — for the rest of the run, because the cache would never
 * be asked again. One boolean fixes it: a dataset folded WITHOUT the table is provisional and is
 * rebuilt the first time a read arrives with one. The rebuild costs the same ~2,000-row fold the
 * first one did and happens at most once per run, because the table never becomes null again.
 */
export function buildLevelUnlocks(client: SpellResistTable | null = null): LevelUnlockData {
  if (cached && (cachedWithClient || !client)) return cached
  const skillTable = classesJson.skillUnlocks as Record<string, RawUnlock[]>
  const discTable = classesJson.discUnlocks as Record<string, RawUnlock[]>
  const disputed: string[] = classesJson.disputed
  const skills: LevelUnlockData['skills'] = {}
  for (const code of new Set([...Object.keys(skillTable), ...Object.keys(discTable)])) {
    if (!isClassAbbr(code)) continue
    skills[code] = skillsFor(code, skillTable[code] ?? [], discTable[code] ?? [], disputed)
  }
  cached = { spells: unlockSpells(client), skills, scrapedAt: classesJson.scrapedAt }
  cachedWithClient = client !== null
  return cached
}

/** Test seam: forget the folded dataset so the next call re-reads its inputs. */
export function resetLevelUnlocksCache(): void {
  cached = null
  cachedWithClient = false
}

/**
 * Does this request want the unlock dataset rather than the alerts wizard's catalog?
 *
 * ONE CHANNEL, TWO ANSWERS — deliberately, and temporarily. `spells:catalog` is the existing
 * "what does the spell DB say" door and this rides it with a flag because shared/ipc.ts was
 * owned by a concurrent wave when this landed; a dedicated `spells:unlocks` channel is the right
 * shape and costs three lines the day that file is free. The flag is validated here rather than
 * trusted: renderer input at an IPC handler, the standing rule.
 */
export function isUnlocksRequest(req: unknown): boolean {
  return typeof req === 'object' && req !== null && (req as { unlocks?: unknown }).unlocks === true
}
