// The small world the resist fold needs: how old a mob is, who is allowed to teach us anything,
// which resist debuffs are up, and who is standing in melee range of you (JOS-382).
//
// Everything here is either read off the log or read off the committed mob catalog. Nothing reads
// the client's `spells_us.txt`: that is the whole point of the ledger's design — a fold that never
// needs the client table can be replayed, shipped and re-estimated without one.

import { localMobEntry } from '../mobLookupLocal'
import { resolveMobIdentity } from '../mobAliases'
import { idKey, spellCanonKey } from '../log/parseCommon'
import { isPlayerShapedName } from '../../shared/playerShape'
import { mobKey } from '../../shared/mobKey'
import type { SpellDb } from '../data/spellDb'
import type { ResistCasterKind } from '../../shared/resistTypes'

/** A mob's level, and how sure we are. `/con` is the game telling you; the catalog is the wiki. */
export interface MobLevelFact {
  /** What the estimator uses: the stated level, or a range's midpoint. */
  level: number
  lo: number
  hi: number
  from: 'con' | 'catalog'
}

/**
 * The catalog's `level` is free text scraped off a wiki page: "39", "39 - 43", "45-50". Two
 * numbers is a range; one is a level; anything else says nothing and is refused rather than
 * guessed at (world-model law 1).
 */
export function parseCatalogLevel(text: string | undefined): { lo: number; hi: number } | null {
  if (!text) return null
  const nums = text.match(/\d+/g)
  if (!nums || nums.length === 0) return null
  const lo = Number(nums[0])
  const hi = nums.length > 1 ? Number(nums[1]) : lo
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo || hi > 200) return null
  return { lo, hi }
}

/** `/con` for this mob this session beats the catalog beats nothing. */
export class MobLevels {
  private conned = new Map<string, number>()
  private catalog = new Map<string, MobLevelFact | null>()

  reset(): void {
    this.conned = new Map()
  }

  /**
   * A `/con` line stated a level. Latest statement wins — the game just said it.
   *
   * FILED UNDER EVERY SPELLING THE ROSTER STATES FOR THE CREATURE (JOS-422), so a `/con` of
   * `Innoruuk` answers a row keyed `innoruuk, the prince of hate` and the other way round. The
   * fold-out happens on the WRITE side on purpose: a session sees a handful of con lines, while
   * `levelOf` runs on every filed row of a two-million-line replay.
   */
  note(mobKey: string, level: number): void {
    if (level <= 0) return
    const id = resolveMobIdentity(mobKey)
    if (!id.aliased) this.conned.set(mobKey, level)
    else for (const key of id.keys) this.conned.set(key, level)
  }

  levelOf(mobKey: string, display: string): MobLevelFact | null {
    const con = this.conned.get(mobKey)
    if (con !== undefined) return { level: con, lo: con, hi: con, from: 'con' }
    const cached = this.catalog.get(mobKey)
    if (cached !== undefined) return cached
    const fact = catalogLevelOf(display)
    this.catalog.set(mobKey, fact)
    return fact
  }
}

/**
 * THE CATALOG IS ASKED UNDER EVERY SPELLING THE ROSTER STATES (JOS-422 — the owner's own bug).
 *
 * The committed catalog carries `Innoruuk` (level 60, page `Innoruuk (God)`); every line the game
 * prints spells him `Innoruuk, the Prince of Hate`. A plain catalog lookup misses, the row files
 * `mobLevel: null`, and `rowTerm` (shared/resistTerms.ts) drops every levelless row because there
 * is no `levelMod` without both levels — so the con card read "no data" over three weeks of fights
 * with ~672 of the owner's own observations dark, including a day his poison went 8/8 resisted.
 * `mobAliases.ts` is where this tree already STATES the two spellings are one creature (the
 * roster's own `match` list — world-model law 2's canonicalize-at-a-boundary, never a fuzzy match),
 * and the READ side used it (`ipc/resist.ts rowsForIdentity`); only the FOLD did not.
 *
 * THE KNOWN LIMIT, so nobody reads this as making `droppedNoLevel` a bug counter: its other half is
 * ANOTHER PLAYER'S casts. Nothing in this app's inputs states a stranger's level (the fold.ts
 * header argues it), those rows are dropped by design, and no alias table can ever recover them.
 * That part of the count is correct behaviour and stays.
 *
 * Costs one extra lookup per aliased miss and nothing on the hot path: `levelOf` caches the verdict
 * per mob key, negatives included, so this runs once per distinct creature per fold.
 */
function catalogLevelOf(display: string): MobLevelFact | null {
  let entry = localMobEntry(display)
  if (!entry) {
    const id = resolveMobIdentity(display)
    if (id.aliased) entry = localMobEntry(id.canonical)
  }
  const range = parseCatalogLevel(entry?.level)
  if (!range) return null
  const level = Math.round((range.lo + range.hi) / 2)
  return { level, lo: range.lo, hi: range.hi, from: 'catalog' }
}

/**
 * WHO IS A PERSON AND WHO IS A CREATURE — the one question the whole fold is filed by.
 *
 * Owner ruling, 2026-08-16 (JOS-382): only `self` and other PLAYERS teach us anything. REVISED the
 * same day (JOS-385): charmed pets and NPC casters are a THIRD kind, `npc`, folded like any other
 * observation, with a preference deciding whether the estimator weighs them. So this class no
 * longer answers "may we learn from this name" with a null — it NAMES the caster, and the
 * weighting argument moved to `shared/resistPrefs.ts` where it can be re-decided without a re-fold.
 *
 * The tests, in the order they are cheap: a name YOU have landed damage on is a mob (the
 * behavioural guard `EngineState.everStruck` uses, and it holds for a proper-named guard the
 * catalog never heard of); a name bound as somebody's pet is a pet; a leading article or an
 * interior space is a mob, because EQ player names are one word and never carry one; a name the
 * committed catalog knows is a mob.
 *
 * The residual risk is stated rather than hidden: a proper-named NPC that the catalog does not
 * carry and that you never hit is called a player. It contributes evidence counts and — because
 * its level is unknown — never enters the estimate.
 */
export class CasterIndex {
  private pets = new Set<string>()
  private struck = new Set<string>()
  private verdicts = new Map<string, 'pc' | 'npc'>()

  reset(): void {
    this.pets = new Set()
    this.struck = new Set()
    this.verdicts = new Map()
  }

  notePet(name: string): void {
    const key = idKey(name)
    this.pets.add(key)
    this.verdicts.delete(key)
  }

  /** You landed damage on it, so it is a mob. One direction only; this never un-files a player. */
  noteStruck(name: string): void {
    const key = idKey(name)
    this.struck.add(key)
    this.verdicts.delete(key)
  }

  kindOf(name: string): ResistCasterKind {
    // The identity compare answers almost every call; `idKey` is the fallback. See fold.ts.
    if (name === 'You') return 'self'
    const key = idKey(name)
    if (key === 'you') return 'self'
    const cached = this.verdicts.get(key)
    if (cached !== undefined) return cached
    const verdict = this.judge(key, name)
    this.verdicts.set(key, verdict)
    return verdict
  }

  private judge(key: string, name: string): 'pc' | 'npc' {
    if (this.pets.has(key) || this.struck.has(key)) return 'npc'
    if (/^(?:a|an|the)\s/i.test(name.trim())) return 'npc'
    if (/\s/.test(name.trim())) return 'npc'
    if (localMobEntry(name)) return 'npc'
    return 'pc'
  }
}

/**
 * MAY A ROW BE FILED ABOUT THIS NAME AS A TARGET? (JOS-385.)
 *
 * A resist row is a statement about a CREATURE's resist stat, so its target has to be a creature.
 * While only players could cast, this question was never asked out loud — and the shipped JOS-382
 * baseline shows what that cost: rows keyed `you` (your own Cannibalization damages its caster),
 * rows keyed on GROUPMATES (a Superior Healing landing, a group song's pulse), roughly 2,700
 * observations under 56 keys that are people's names, in a file this repo publishes. NPC casters
 * make it acute rather than merely untidy, because mobs cast on the player's group constantly.
 *
 * THE TEST IS `conCardIsPlayer`'S, DELIBERATELY, and not `CasterIndex`'s. The two questions look
 * the same and are not. For a CASTER, "you have landed damage on this name" is a reason to REFUSE
 * it as a teacher, which is safe in the direction it points. For a TARGET the same fact would
 * ADMIT the name — and a groupmate can end up in `struck` through a damage shield or an area
 * effect, which is exactly how the first cut of this guard let `Dranix` back in. So the target
 * test is the app's standing "is this a person" pair and nothing else: EQ gives players one
 * capitalized word with no space, and the committed catalog knows the proper-named NPCs that shape
 * would otherwise refuse.
 *
 * THE RESIDUAL IS THE SAME ONE THE CON CARD ALREADY ACCEPTS: a proper-named NPC the catalog has
 * never heard of is read as a person and teaches us nothing. That is the safe direction — a
 * creature we decline to learn about costs a cell, and a person's name in a published file is a
 * different kind of mistake.
 */
export function isMobTarget(name: string): boolean {
  const hit = targetVerdicts.get(name)
  if (hit !== undefined) return hit
  const verdict = judgeTarget(name)
  if (targetVerdicts.size >= MAX_TARGET_VERDICTS) targetVerdicts.clear()
  targetVerdicts.set(name, verdict)
  return verdict
}

/**
 * MEMOISED, for the reason `ResistFold.keyOf` is (that method's comment carries the original
 * measurement): this runs on every resist line, every spell damage line and every landing sentence
 * in a two-million-line replay, and the uncached answer is two regexes plus a `mobKey` — itself
 * three regex replacements and a lower-case — plus a map lookup. Bounded and cleared wholesale
 * rather than evicted one at a time, because a long session meets thousands of distinct names and
 * an unbounded map is a slow leak. The verdict is a pure function of the NAME (the catalog is
 * committed and `isPlayerShapedName` reads nothing), so nothing can invalidate an entry.
 */
const targetVerdicts = new Map<string, boolean>()
const MAX_TARGET_VERDICTS = 4_096

function judgeTarget(name: string): boolean {
  const n = name.trim()
  // The catalog happens to hold an entry that folds to the key `you`, so self is tested first and
  // by identity, exactly as the fold's own `isSelf` does.
  if (n === 'You' || idKey(n) === 'you') return false
  return !isPlayerShapedName(n) || localMobEntry(n) !== null
}

/**
 * How long a tash/malo line is assumed to hold. The doc's number, and deliberately a constant
 * rather than a per-spell duration: what the row records is WHICH debuffs were up, and the
 * estimator joins the amount from the client table at read time. Closed early by the mob's death
 * or a zone change, both of which the log states.
 */
export const DEBUFF_WINDOW_MS = 11 * 60 * 1000

const RESIST_DEBUFF_LINE = /^Decrease\s+(?:Magic|Fire|Cold|Poison|Disease|All)\s+Resists?\b/i

/**
 * Is this spell a resist debuff? Answered off the WIKI catalog's verbatim effect list
 * (`SpellEntry.effects`, JOS-251) and anchored at the head of the line, exactly as
 * `spellEffectClass.ts` anchors its rules — a stem match would find "Resist" inside a name.
 * Deliberately not answered from the client table: the fold must not need it.
 */
export function isResistDebuff(db: SpellDb | undefined, spell: string): boolean {
  const entry = db?.byKey.get(spellCanonKey(spell))
  return entry?.effects?.some((line) => RESIST_DEBUFF_LINE.test(line.trim())) === true
}

/** Which resist debuffs are up on which mob. The row stores the keys; nothing else. */
export class DebuffWindows {
  private byMob = new Map<string, Map<string, number>>()

  reset(): void {
    this.byMob = new Map()
  }

  open(mobKey: string, spellKey: string, ts: number): void {
    let m = this.byMob.get(mobKey)
    if (!m) {
      m = new Map()
      this.byMob.set(mobKey, m)
    }
    m.set(spellKey, ts + DEBUFF_WINDOW_MS)
  }

  /** The row's `debuffs` field: sorted, '|'-joined, '' when nothing is up. */
  active(mobKey: string, ts: number): string {
    const m = this.byMob.get(mobKey)
    if (!m) return ''
    const live: string[] = []
    for (const [key, until] of m) {
      if (until <= ts) m.delete(key)
      else live.push(key)
    }
    return live.sort().join('|')
  }

  clearMob(mobKey: string): void {
    this.byMob.delete(mobKey)
  }
}

/** Bound on the display-name -> key cache. Cleared wholesale rather than evicted one at a time. */
const MAX_KEY_CACHE = 4_096

/**
 * MOB NAMES, BOTH WAYS, MEMOISED — and the memo is a measurement rather than a habit.
 *
 * The fold sees every one of the two million events a full replay produces, and the busiest arm by
 * far is melee: two swings a second for hours, each one asking for a mob key so a song pulse can
 * later know who was in range. `mobKey` is a trim, three regex replacements and a lower-case —
 * cheap once and not cheap two million times. MEASURED on the owner's log with
 * `npm run bench:replay`: 1,779 ms of fold with the naive call, 1,067 ms with this cache, on
 * identical input. The map is bounded because a long session meets thousands of distinct names and
 * an unbounded one is a slow leak.
 *
 * The other direction (key -> the name the game last printed) is not a cache but a FACT the ledger
 * needs: the fold keys rows canonically and the surfaces show the spelling the log used.
 */
export class MobNames {
  private keys = new Map<string, string>()
  private display = new Map<string, string>()

  reset(): void {
    this.keys = new Map()
  }

  key(display: string): string {
    const hit = this.keys.get(display)
    if (hit !== undefined) return hit
    const key = mobKey(display)
    if (this.keys.size >= MAX_KEY_CACHE) this.keys.clear()
    this.keys.set(display, key)
    return key
  }

  /** Note the spelling the game just used for this creature. */
  remember(display: string): void {
    this.display.set(this.key(display), display)
  }

  displayFor(key: string): string {
    return this.display.get(key) ?? key
  }
}

/** Melee proximity, the stand-in for point-blank range that song rule 3 needs. */
export class MeleeContact {
  private last = new Map<string, number>()

  reset(): void {
    this.last = new Map()
  }

  note(mobKey: string, ts: number): void {
    this.last.set(mobKey, ts)
  }

  drop(mobKey: string): void {
    this.last.delete(mobKey)
  }

  /** Every mob you traded blows with inside the window ending at `ts`. */
  within(ts: number, windowMs: number): string[] {
    const out: string[] = []
    for (const [key, at] of this.last) {
      if (at <= ts && ts - at <= windowMs) out.push(key)
    }
    return out
  }
}
