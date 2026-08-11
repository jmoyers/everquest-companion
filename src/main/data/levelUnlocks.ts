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
// VERBATIM, so the panel's honesty chip is a field read, not an inference (law 1). Thirteen rows
// today — BER 2, MNK 10, RNG 1 — exactly the non-Rogue disciplines the central Disciplines page
// strikes through.
//
// CACHED FOREVER: both inputs are compile-time constants, so the fold runs once per process.

import classesJson from './classes.json'
import spellsJson from './spells.json'
// The corrections overlay, applied here for the same reason `spellDb.ts` applies it (JOS-161):
// every row of this dataset is DISPLAYED by name, and a card announcing a spell by a name the
// game never prints is a card a player cannot act on.
import { applySpellCorrections } from './spellCorrections'
import { parseSpellClasses } from '../../shared/spellLevels'
import { isClassAbbr, type ClassAbbr } from '../../shared/classCombo'
import type { LevelUnlockData, UnlockSkill, UnlockSpell } from '../../shared/levelUnlocks'
import type { SpellDbFile } from '../../shared/types'

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

/** Fold one class's skill + discipline rows, attaching the discipline dispute to each disc row. */
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
    if (dispute) row.dispute = dispute
    out.push(row)
  }
  return out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
}

/** Every spell the DB places for at least one class at a stated level, with its card fields. */
function unlockSpells(): UnlockSpell[] {
  const file = spellsJson as SpellDbFile
  const out: UnlockSpell[] = []
  for (const s of applySpellCorrections(file.spells).spells) {
    const at = parseSpellClasses(s.classes)
    if (at.length === 0) continue
    const spell: UnlockSpell = { name: s.name, at }
    if (typeof s.castTimeMs === 'number') spell.castTimeMs = s.castTimeMs
    if (typeof s.mana === 'number') spell.mana = s.mana
    if (s.targetType) spell.targetType = s.targetType
    if (s.spellType) spell.spellType = s.spellType
    if (typeof s.durationMs === 'number') spell.durationMs = s.durationMs
    out.push(spell)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

let cached: LevelUnlockData | null = null

/** The whole dataset, built once. */
export function buildLevelUnlocks(): LevelUnlockData {
  if (cached) return cached
  const skillTable = classesJson.skillUnlocks as Record<string, RawUnlock[]>
  const discTable = classesJson.discUnlocks as Record<string, RawUnlock[]>
  const disputed: string[] = classesJson.disputed
  const skills: LevelUnlockData['skills'] = {}
  for (const code of new Set([...Object.keys(skillTable), ...Object.keys(discTable)])) {
    if (!isClassAbbr(code)) continue
    skills[code] = skillsFor(code, skillTable[code] ?? [], discTable[code] ?? [], disputed)
  }
  cached = { spells: unlockSpells(), skills, scrapedAt: classesJson.scrapedAt }
  return cached
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
