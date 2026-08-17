// alerts module — the first real proof of the EqModule extension contract.
//
// It evaluates 'event' and 'raw' alert triggers against LIVE LogEvents only (the
// registry never flushes during replay, but we ALSO gate here so a future direct
// caller can't accidentally fire on historical events), respecting each alert's
// enabled flag and cooldown. Each fire is accumulated and pushed as the standard
// `module:delta` payload `{ fired: FiredAlert[] }`; the renderer's always-mounted
// player turns those into actual audio.
//
// 'app'-type triggers (e.g. bossDefeat) are evaluated RENDERER-side (they depend
// on derived boss state that lives in the renderer), so this module stores/serves
// their defs via snapshot() but never fires them itself.
//
// COMPOSITE triggers (Task #47): a trigger may be `{type:'any'|'all', conditions:[…]}` over
// the primitive event/raw/app shapes. 'any' fires when ANY condition matches a single event
// (OR); 'all' fires only when EVERY condition matches THE SAME event (AND — same-event only,
// no cross-event windows). Cooldown is per ALERT, not per condition — and, since the owner's
// 2026-08-04 slow incident, per alert-and-TARGET when the def asks for it (`cooldownScope`,
// see `cooldownKey` below). It also matches the DERIVED
// `buffExpired` event the buffs module synthesizes (a resolved, unambiguous "wears off you /
// your pet" signal) — see shared/logEvents.ts BuffExpiredEvent + log/bus.ts emitDerived.
//
// Alert defs are owned by the store; the module holds a live copy that main keeps
// in sync (setDefs) whenever the user saves/deletes an alert.
//
// A LITERAL `where.spell` MATCHER IS RANK-BLIND (JOS-259). A spell alert fires for ALL RANKS of
// that spell — the owner's ruling, and the domain law behind it is that an upgraded spell never
// downgrades. Both sides of the compare fold through `spellLineKey`, so `Elemental Maelstrom`,
// `Elemental Maelstrom II` and `Elemental Maelstrom III` are one def's business. `/regex/` specs
// are untouched. The argument, and its scope, are on `accepts` below.
//
// AND SINCE JOS-276 THE DAMAGE LANE FOLDS TOO — `where.skill` on a `damage` trigger, for the
// dtypes whose `skill` IS a spell name ('spell' | 'dot'). The owner's law is now stated without a
// carve-out: ranks are not used for ANYTHING in the alert system. `foldsRank` decides at compile
// time which key can fold and `foldReaches` decides per event whether it does; the melee and
// damage-shield dtypes are excluded there rather than by measurement. Full argument on
// `foldReaches`.
//
// CAPTURE GROUPS (JOS-103). A trigger's regexes may declare NAMED groups, and what they capture
// rides out on `FiredAlert.captures` so a spoken alert can say it ("Puma on Fail"). THIS FILE IS
// ONE OF THE TWO ENFORCEMENT POINTS — read the threat model in shared/alertCaptures.ts before
// touching `fieldMatches`, `capturesFrom` or `conditionMatches`. The short form of what is
// enforced HERE, and it is control 3 of that model: a capture may only come from the text the
// def's OWN condition just tested, on an event this alert already subscribed to — a `raw`
// condition captures from `ev.raw`, a `where` matcher captures from that one field's value.
// There is no path to another event, another alert, or app state, and there are no ambient
// tokens. Every value leaves through `harvestCaptures`, which sanitizes it and caps both its
// length and the number of groups; nothing downstream is trusted to do that for us.
//
// …AND SINCE JOS-353 THERE IS EXACTLY ONE TOKEN THE APP FILLS IN ITSELF: `{target}`, the entity
// the matched event says the spell is affecting. It is not a general ambient facility and the
// exemption is argued in full in shared/alertTargets.ts. What this file enforces is the SHAPE of
// it: the wanted set is compiled from the def's OWN PHRASE (so a def that never says `{target}`
// carries none, and its delta is byte-identical to before), the value is resolved from the SAME
// event the alert just fired on, and a group the pattern declared always wins over the derived
// one — see `withAutoCaptures`.

import type { EqModule } from './types'
import {
  EarlyWarnings,
  breakEventIdentity,
  earlyWarnSubject,
  type BreakWatcher,
  type EarlyWarnDue
} from './alertsEarlyWarning'
// The pure field readers, split out of this file so it stays under its factoring ceiling — the
// `where` matcher's two (`fieldText`, `spellCandidateNames`) and the firing payload's one
// (`firingSpell`). Their arguments live with them in alertsFields.ts.
import { fieldText, firingSpell, spellCandidateNames, withAutoCaptures } from './alertsFields'
import { idKey } from '../log/parseCommon'
import { harvestCaptures } from '../../shared/alertCaptures'
// `{target}` — the ONE token the app fills in without a declared capture group (JOS-353). The
// table of which field of which kind names the entity, the sentinel rendering ('self' → "you"),
// and the security argument for the exemption all live in shared/alertTargets.ts; this file is the
// other enforcement point and does exactly two things with it: compile the WANTED set from the
// def's own phrase, and merge the resolved value UNDER the pattern's own captures
// (`withAutoCaptures`, which lives beside the other pure field readers in alertsFields.ts).
import { autoTokensWanted, type AutoTokenName } from '../../shared/alertTargets'
import type { BuffTimerRow } from '../../shared/buffTimers'
import {
  breakProbes,
  breakTriggerKinds,
  normalizeEarlyWarnSec,
  type BreakTriggerKind
} from '../../shared/earlyWarning'
import type { LogEvent } from '../../shared/logEvents'
// The repo-wide rank fold (JOS-259). `spellLineKey` is shared/'s mirror of the parser's
// `spellCanonKey` — tests/spellLines.test.mts pins the two equal — and it is what makes a literal
// `where.spell` matcher rank-blind; see `accepts`.
import { spellLineKey } from '../../shared/spellLines'
import type {
  AlertDef,
  AlertFireRecord,
  AlertsDelta,
  AlertsSnap,
  AlertTrigger,
  AlertTriggerPrimitive,
  FiredAlert,
  PoisonSlowRecency
} from '../../shared/types'

const DEFAULT_COOLDOWN_MS = 2000
/** Max fires kept per alert in the recent-fires ring buffer (Task #22). */
const HISTORY_CAP = 20
/**
 * Max distinct spell DISPLAY names kept in the rank recency map. A character's own cast
 * vocabulary is well under 300 in the reference log; the cap is a bound, not a policy, and
 * it evicts the least-recently-cast name so the map always describes what you use NOW.
 */
const SPELL_CAST_CAP = 400
/**
 * Max distinct cooldown clocks kept at once, across every alert (Task: per-target cooldowns).
 *
 * An alert-level clock is ONE entry per alert, so this cap exists entirely for the
 * `cooldownScope:'target'` alerts, which mint an entry per mob: a marathon session slays
 * thousands, and an unbounded map would keep a row for every corpse of the day.
 *
 * Eviction is least-recently-FIRED (the map is re-inserted on write, so its iteration order is
 * oldest-first — the same trick `spellLastCast` uses). That ordering is what makes the bound
 * safe rather than merely small: the entry discarded is the one whose cooldown is the closest
 * to having expired anyway, so the worst case of an eviction is one extra alert on a mob
 * nobody has hit in hundreds of fires — never a suppressed one.
 */
const COOLDOWN_KEY_CAP = 500

/**
 * A compiled matcher value: the predicate, plus the RegExp it compiled to when the spec was
 * written in `/regex/` form, plus the rank-folded key when it is a LITERAL `spell` matcher.
 *
 * The regex is kept BESIDE the predicate rather than behind it because a named capture group is
 * only readable from the RegExp itself (`exec().groups`) — see `fieldMatches`. Nothing else about
 * matching changed: `test` is the same predicate it always was, and a literal spec has no `re` at
 * all, so it can capture nothing.
 */
interface CompiledMatch {
  test: (fieldValue: string) => boolean
  re?: RegExp
  /**
   * `spellLineKey(spec)` — set ONLY for a literal matcher on a key that NAMES A SPELL (`spell`
   * anywhere, and `skill` on a `damage` trigger — `foldsRank`), and only when the fold leaves
   * something to compare (a spec that is nothing but a roman numeral folds to '' and is left alone
   * rather than turned into a wildcard). Absent everywhere else, which is what keeps `caster`,
   * `target`, `refresh` and every `/regex/` spec byte-for-byte what they were.
   */
  lineKey?: string
}

/**
 * WHICH (kind, key) PAIRS NAME A SPELL — the compile-time half of the rank fold.
 *
 * `spell` folds on every kind that has one, which is every kind the alert surface authors
 * (alertsFields.ts SPELL_FIELD_BY_KIND). `damage.skill` joins it in JOS-276: the typed-nuke and
 * DoT shapes put the SPELL NAME there (log/parseCombat.ts), and the owner's law leaves no lane
 * out. Whether that fold actually reaches a given event is a second question, asked per event by
 * `foldReaches` — a `damage` event's `skill` is only a spell name for two of its four dtypes.
 *
 * Nothing else folds, and the two near-misses are provable no-ops rather than judgement calls:
 * `poisonProc.strike` and `poisonCoat.poison` draw from shared/poisons.ts, whose 40-odd names
 * carry no roman-numeral rank at all.
 */
function foldsRank(kind: string, key: string): boolean {
  return key === 'spell' || (kind === 'damage' && key === 'skill')
}

/**
 * Compile a matcher value into a predicate. A value wrapped in slashes (`/.../`)
 * is a case-insensitive regex; anything else is a case-insensitive exact match on
 * the stringified field. Invalid regex falls back to literal equality so a bad
 * def degrades gracefully instead of throwing in the hot path.
 *
 * A LITERAL SPELL-NAMING MATCHER IS RANK-BLIND (JOS-259, extended by JOS-276) — see `accepts`.
 * The trigger's kind and the `where` key are both passed in because the fold belongs to the fields
 * that name a spell and to nothing else (`foldsRank`).
 */
function compileFieldMatch(spec: string, key: string, kind: string): CompiledMatch {
  if (spec.length >= 2 && spec.startsWith('/') && spec.endsWith('/')) {
    const body = spec.slice(1, -1)
    try {
      // No 'g' flag, so `exec`/`test` are stateless and this compiled object is safe to reuse
      // across every event without a `lastIndex` reset (the trap `hasWireControls` documents).
      const re = new RegExp(body, 'i')
      return { test: (v) => re.test(v), re }
    } catch {
      // fall through to literal
    }
  }
  const lower = spec.toLowerCase()
  const test = (v: string): boolean => v.toLowerCase() === lower
  if (!foldsRank(kind, key)) return { test }
  const lineKey = spellLineKey(spec)
  return lineKey ? { test, lineKey } : { test }
}

/**
 * WHETHER A COMPILED MATCHER ACCEPTS ONE PIECE OF TEXT — exact as it always was, plus the RANK
 * FOLD for a literal `spell` matcher.
 *
 * THE RULE (JOS-259, owner ruling 2026-08-12 — "rank-blind matching, full stop"): a spell alert
 * fires for ALL RANKS OF THE SPELL. EQ Legends re-tiers the classic spells as roman-numeral ranks
 * of one base name, and only SOME of the lines a spell prints carry the suffix — `castBegin` and
 * `resist` keep it (`You begin casting Elemental Maelstrom II.` / `<mob> resisted your Elemental
 * Maelstrom II!`), while the wear-off/fade family prints the bare name. So a def pinned to one
 * spelling was an alert that half the spell's own lines could never satisfy: the reporter's
 * resisted alert for `Elemental Maelstrom` went silent the day they unlocked rank II, while their
 * fade alert — pinned to the same string, matched against a line that never carried a suffix —
 * kept working. Folding both sides through `spellLineKey` (the repo-wide rank fold, mirrored from
 * the parser's `spellCanonKey`) makes every line of one spell answer to one def.
 *
 * IT WIDENS ONLY, AND ONLY FOR LITERALS. The fold is a superset of the old case-insensitive
 * equality it replaces, so a def pinned to `Elemental Maelstrom II` still fires on II — it now
 * also fires on I and on III, which is the ruling. A `/regex/` spec is USER-AUTHORED PATTERN and
 * is left exactly alone: someone who wrote `/Maelstrom II$/` asked a narrower question on purpose,
 * and rewriting their intent is not ours to do.
 *
 * SCOPE: EVERY KEY THAT NAMES A SPELL (`foldsRank`). `castBegin`, `castFizzle`,
 * `castInterrupted`, `resist`, `cc`, `uncharm`, `heal`, `buffApply`, `buffFade`, `buffWearOff` and
 * the derived `buffExpired` all spell it `spell` (alertsFields.ts SPELL_FIELD_BY_KIND), so one
 * key folds them all and they cannot disagree about which def owns a line; JOS-276 added
 * `damage.skill` for the two dtypes whose skill IS a spell name. The two other fields that name a
 * spell-ish thing are left alone because the fold would be a provable no-op there:
 * `poisonProc.strike` and `poisonCoat.poison` draw from shared/poisons.ts, whose 40-odd names
 * carry no roman-numeral rank at all.
 *
 * NO UPGRADE-OFFER COMPENSATION. The offer strip (shared/spellLines.ts `detectRankUpgrades`) is
 * untouched by this: the ruling is that no offer is needed to keep an alert firing, and the
 * domain law behind it is that once you upgrade a spell it never downgrades, even on a loadout
 * swap. An offer that still appears is now a convenience, never the thing standing between a user
 * and a sound.
 *
 * `folds` is the per-event gate (`foldReaches`); it is true for every caller that asks about a
 * `spell` key, which is what keeps this identical to what JOS-259 shipped.
 */
function accepts(f: CompiledMatch, text: string, folds = true): boolean {
  if (f.test(text)) return true
  return folds && f.lineKey !== undefined && spellLineKey(text) === f.lineKey
}

/**
 * WHETHER THE RANK FOLD REACHES THIS EVENT — the runtime half, and it exists for exactly one
 * field: `damage.skill` (JOS-276).
 *
 * `damage` PUTS FOUR DIFFERENT VOCABULARIES IN ONE FIELD (log/parseCombat.ts), and only two of
 * them are spell names:
 *   'spell' — the typed nuke, `<A> hits <B> for N points of <class> damage by <Spell>.` A SPELL,
 *             and it prints the rank when the caster has one: the owner's log carries both
 *             `… damage by Harm Touch.` (488) and `… damage by Harm Touch III/IV/VI/IX.` (23) —
 *             one spell, two spellings, in one lane. This is the defect.
 *   'dot'   — the tick, `<B> has taken N damage from <Spell> by <caster>.` Also a spell, also
 *             ranked in the wild: `Chords of Dissonance I/III/IV/V` off four different bards.
 *   'melee' — NOT a log string at all. `meleeSkill(verb)` maps the swing verb onto a CLOSED table
 *             of ten constants (Backstab, Bash, Kick, Cleave, Smite, Ranged, Strike, Frenzy,
 *             Flurry, Melee), so no melee skill can ever carry a roman-numeral tail. That is the
 *             JOS-259 worker's "provably inert" measurement, re-verified for JOS-276 and now
 *             pinned in tests/rankBlindSpellAlerts.test.mts (D3).
 *   'ds'    — the damage-shield element, and this one IS free text off the line (DS_RE group 3).
 *             The owner's whole log spells three of them — flames (17,780), thorns (7,861),
 *             frost (152) — so it is inert today, but nothing in the parser BOUNDS it. That is
 *             why this gate is written on the dtype rather than left to the measurement: an
 *             element the game adds tomorrow cannot quietly start folding.
 *
 * Every other key answers true, which is the identity this had before the damage lane existed.
 */
function foldReaches(f: CompiledField, ev: LogEvent): boolean {
  if (f.key !== 'skill') return true
  return ev.kind === 'damage' && (ev.dtype === 'spell' || ev.dtype === 'dot')
}

/** One compiled `where` entry: the event field it names and the matcher it compiled to. */
interface CompiledField extends CompiledMatch {
  key: string
}

/**
 * A CONDITION THAT MATCHED, plus whatever its named groups captured (JOS-103).
 *
 * An object rather than a boolean because "matched" and "matched, and here is what it named" are
 * one answer: recomputing the captures afterwards would mean running the pattern a second time
 * and hoping the second run agreed with the first. `captures` is absent for the overwhelming
 * majority of conditions, which declare no named group at all.
 */
interface ConditionHit {
  captures?: Record<string, string>
}

/** Merge a hit's captures into an accumulator, first writer wins. Undefined stays undefined. */
function mergeCaptures(
  into: Record<string, string> | undefined,
  from: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!from) return into
  if (!into) return { ...from }
  for (const [k, v] of Object.entries(from)) if (!(k in into)) into[k] = v
  return into
}

/**
 * Whether ONE compiled `where` field accepts `ev`, and what it captured.
 *
 * An ABSENT field is still an immediate no-match, exactly as before — that is what keeps a
 * `where:{spell:…}` written against a family with no `spell` field (poisonProc names its
 * `strike`) from being admitted through the candidate list below.
 *
 * CAPTURES COME FROM THE TEXT THIS MATCHER ACTUALLY TESTED, and from nowhere else — control 3 of
 * the threat model in shared/alertCaptures.ts. For a `/regex/`-form matcher that means the
 * stringified value of the ONE field this `where` entry names, on the ONE event kind the trigger
 * subscribed to. A literal matcher has no RegExp and therefore captures nothing.
 *
 * The JOS-84 spell widening captures from the CANDIDATE NAME that satisfied the matcher, for the
 * same reason `matchedSpellName` reports that name rather than the event's best-effort pick: the
 * text the pattern matched is the text it named.
 *
 * The JOS-259 rank fold rides inside `accepts`, so it applies to the field's own value and to
 * every candidate name alike — a candidate list that spells a rank cannot be a second way for one
 * spell to have two identities. `foldReaches` is asked ONCE here, because the answer is a property
 * of this (field, event) pair and both compares below are about the same pair.
 */
function fieldMatches(ev: LogEvent, f: CompiledField): ConditionHit | null {
  const raw = (ev as unknown as Record<string, unknown>)[f.key]
  if (raw == null) return null
  const folds = foldReaches(f, ev)
  const text = fieldText(raw)
  if (accepts(f, text, folds)) return capturesFrom(f, text)
  // Only the `spell` key widens, and only when the event carries candidates (JOS-84).
  if (f.key !== 'spell') return null
  const hit = spellCandidateNames(ev).find((n) => accepts(f, n, folds))
  return hit === undefined ? null : capturesFrom(f, hit)
}

/** Run a matcher's own RegExp over the text it just accepted, and bound what it named. */
function capturesFrom(f: CompiledMatch, text: string): ConditionHit {
  if (!f.re) return {}
  const m = f.re.exec(text)
  const captures = harvestCaptures(m?.groups)
  return captures ? { captures } : {}
}

/** A single PRIMITIVE condition prepared for fast evaluation (regex compiled once). */
interface CompiledCondition {
  event?: { kind: string; fields: CompiledField[] }
  raw?: RegExp
  // 'app' primitives compile to neither event nor raw → they never match main-side.
}

/** What a matching trigger yields: the text to record, plus anything its pattern named. */
interface AlertMatch {
  text: string
  captures?: Record<string, string>
}

/**
 * A compiled alert. A primitive trigger compiles to a single condition (`composite:'single'`);
 * a composite compiles to its type ('any'/'all') + the list of compiled conditions (Task #47).
 */
interface CompiledAlert {
  def: AlertDef
  composite: 'single' | 'any' | 'all'
  conditions: CompiledCondition[]
  /**
   * The ENDING kinds this def watches for, empty for every other def (JOS-235,
   * shared/earlyWarning.ts `breakTriggerKinds`). Non-empty is what makes an `earlyWarnSec` arm
   * from the timer row instead of from this def's own trigger — for a break def the trigger IS
   * the end, and arming on it silenced the alert entirely.
   */
  breakKinds: BreakTriggerKind[]
  /**
   * The auto tokens THIS DEF'S PHRASE writes (JOS-353) — empty for every alert that does not
   * speak `{target}`, which is nearly all of them.
   *
   * COMPILED FROM THE PHRASE, NOT FROM THE TRIGGER, and that is the bound on the whole feature:
   * a def that never says `{target}` carries no target on its firing, so its `module:delta` is
   * byte-identical to what it was before the token existed. Resolving one costs a table lookup
   * and a sanitize per FIRE; deciding whether to is done once, here, at compile time.
   */
  autoTokens: AutoTokenName[]
}

/** Compile one PRIMITIVE trigger into a matcher condition. */
function compileCondition(t: AlertTriggerPrimitive): CompiledCondition {
  if (t.type === 'event') {
    const fields: CompiledField[] = Object.entries(t.where ?? {}).map(([key, spec]) => ({
      key,
      ...compileFieldMatch(spec, key, t.kind)
    }))
    return { event: { kind: t.kind, fields } }
  }
  if (t.type === 'raw') {
    let re: RegExp
    try {
      re = new RegExp(t.regex, 'i')
    } catch {
      // A bad regex should never match (and never throw); use a pattern that can't.
      re = /$.^/
    }
    return { raw: re }
  }
  // 'app' triggers are renderer-evaluated; compile to an empty condition (never matches here).
  return {}
}

/**
 * The spell name to SPEAK for this firing — `base` (the event's own best-effort pick) unless the
 * alert matched a different candidate (JOS-84).
 *
 * The companion to `spellCandidateNames`: once a Shiftless Deeds alert is allowed to fire on a
 * line whose `spell` field says "Forlorn Deeds", announcing "Forlorn Deeds" would be a second
 * wrong answer wearing the first one's clothes. So the name reported is the one that actually
 * satisfied the alert's OWN `spell` matcher. A def whose matcher already accepts the base pick
 * keeps it (nothing changes for the unambiguous case, which is every family without candidates),
 * and a regex-shaped matcher resolves to the first candidate it accepts — the honest answer when
 * one sentence is five spells, since the log itself does not say which.
 *
 * IT ASKS THE SAME QUESTION THE MATCH DID (`accepts`, not `test`), so the JOS-259 rank fold cannot
 * split the two apart: a def pinned to `Elemental Maelstrom` that fired on a line naming
 * `Elemental Maelstrom II` keeps the event's own pick and SAYS the rank it saw. Announcing the
 * def's spelling instead would be reporting the alert back to the user rather than the log.
 *
 * Runs once per FIRE, never per compiled alert per event: firings are rare, matching is not.
 */
function matchedSpellName(c: CompiledAlert, ev: LogEvent, base: string | undefined): string | undefined {
  if (base === undefined) return undefined
  const names = spellCandidateNames(ev)
  if (names.length === 0) return base
  for (const cond of c.conditions) {
    if (cond.event?.kind !== ev.kind) continue
    const f = cond.event.fields.find((x) => x.key === 'spell')
    if (!f || accepts(f, base)) continue
    const hit = names.find((n) => accepts(f, n))
    if (hit !== undefined) return hit
  }
  return base
}

/**
 * The cooldown clock this firing belongs to (AlertDef.cooldownScope).
 *
 * 'alert' (and absent, which means the same thing) → the alert's own id: one clock, exactly as
 * every alert behaved before per-target scope existed.
 *
 * 'target' → `<id>\0<idKey(target)>`, so the first match on a mob always fires and only re-lands
 * on THAT mob are rate-limited. `target` is read dynamically because it is a field of some
 * LogEvent shapes and not others — the same arbitrary-field access `where` matchers have always
 * done. A family that names no target (or names an empty one) has nothing to scope by and
 * DEGRADES to the alert-level clock rather than minting a bogus one: that is a quieter alert,
 * never a missing cooldown, and it never throws in the hot path.
 *
 * `idKey` is the repo-wide canonicalization (world-model law 2: names are dirty — damage lines
 * capitalize the article, lifecycle lines lowercase it), so "King Tranix" and "king tranix" are
 * one mob and cannot hold two clocks between them.
 *
 * RANK-BLIND BY CONSTRUCTION (JOS-276 sweep) — no spell name enters this key. A clock is
 * `<alert>` or `<alert, mob>`, so one def firing on rank I and on rank III of its own spell shares
 * ONE cooldown, which is what the fold above means: they are the same alert about the same spell.
 * Adding the spelling here would hand the same def two clocks and re-introduce the split JOS-259
 * closed, one layer down.
 */
function cooldownKey(def: AlertDef, ev: LogEvent): string {
  if (def.cooldownScope !== 'target') return def.id
  const target = (ev as unknown as Record<string, unknown>).target
  if (typeof target !== 'string') return def.id
  const key = idKey(target)
  return key ? `${def.id}\u0000${key}` : def.id
}

function compileAlert(def: AlertDef): CompiledAlert {
  const t: AlertTrigger = def.trigger
  const breakKinds = breakTriggerKinds(t)
  // Only a 'custom' phrase can carry a token at all — the other three speech modes resolve to
  // values the app owns and have no template to substitute into (shared/speechText.ts).
  const autoTokens = autoTokensWanted(def.speech?.mode === 'custom' ? def.speech.phrase : undefined)
  if ('conditions' in t) {
    return {
      def,
      composite: t.type,
      conditions: t.conditions.map(compileCondition),
      breakKinds,
      autoTokens
    }
  }
  return { def, composite: 'single', conditions: [compileCondition(t)], breakKinds, autoTokens }
}

export class AlertsModule implements EqModule<AlertsSnap, AlertsDelta> {
  readonly id = 'alerts'
  private compiled: CompiledAlert[] = []
  private seq = 0
  /**
   * COOLDOWN CLOCK → last fire timestamp (ms).
   *
   * The key is `def.id` for an ordinary (alert-scoped) alert and `def.id\0<targetKey>` for a
   * `cooldownScope:'target'` one — see `cooldownKey`. One map holds both because the two are
   * never confusable: a NUL can appear in no alert id and in no mob name, so an alert-level
   * row can never collide with one of its own per-target rows. Bounded by COOLDOWN_KEY_CAP,
   * least-recently-fired first.
   */
  private lastFire = new Map<string, number>()
  /** fires accumulated since the last flush. */
  private pending: FiredAlert[] = []
  /**
   * Per-alert ring buffer of recent fires (last HISTORY_CAP, newest last). The
   * single source of truth for the renderer's "recent fires" panel — fed by both
   * main-side event/raw fires (onEvent) and renderer-routed app fires (appFired).
   * Persists across character switches so history isn't lost on a reload.
   */
  private history = new Map<string, AlertFireRecord[]>()
  /**
   * RANK-PRESERVING cast recency: spell DISPLAY name (suffix intact — "Mesmerization III") →
   * the newest ts you were seen to begin casting it.
   *
   * WHY IT LIVES HERE. The buffs model's own `lastSeen` map is keyed by `spellCanonKey`, which
   * STRIPS the rank — so it cannot answer "which rank am I actually using", the question the
   * suggestions surface and the upgrade offers are built on. `castBegin` is the literal
   * definition of "most recently cast" and is the ONE event family that keeps the rank
   * (fizzle / interrupt / wears-off lines all drop it). Recording it here costs one map write
   * per cast and adds no IPC: the alerts snapshot already flows to the renderer via useModule.
   *
   * Recorded for REPLAY events too (unlike firing, which is live-only) so the map is complete
   * the moment the renderer hydrates.
   *
   * RANK-SENSITIVE ON PURPOSE, and it is the one map in the alert system that stays so (JOS-276
   * sweep). It answers "which rank am I actually using", which is a question about ranks; nothing
   * downstream of it decides whether an alert FIRES. Its readers are the suggestions surface
   * (which rank a chip is offered for) and the upgrade offers — both now conveniences rather than
   * the thing between a user and a sound.
   */
  private spellLastCast = new Map<string, number>()
  /** Names whose recency advanced since the last flush (delta payload). */
  private castPending = new Map<string, number>()
  /**
   * ROGUE SLOW POISON RECENCY (docs/plans/poison-slow-alerts.md §1.3) — the observation the
   * "alert when a mob gets slowed?" offer is made from. Recorded on REPLAY as well as live,
   * exactly like `spellLastCast` above and for the same reason: the offer must be right at
   * hydration, not one proc later. Null until a slow has actually been seen — an offer is
   * never made from an assumption about what class you are playing beside.
   */
  private poisonSlowSeen: PoisonSlowRecency | null = null
  /** true when `poisonSlowSeen` advanced since the last flush (delta payload). */
  private poisonSlowDirty = false
  /**
   * THE ARMED EARLY WARNINGS (JOS-216) — the alerts whose fire has been MOVED to N seconds before a
   * tracked debuff's estimated end. Its whole state machine, and why an arm resolves on the next
   * tick rather than at the match, is in alertsEarlyWarning.ts.
   */
  private early = new EarlyWarnings()

  /** Replace the live alert set (called by main after load + every save/delete). */
  setDefs(defs: AlertDef[]): void {
    this.compiled = defs.map(compileAlert)
  }

  /**
   * Where the early-warning offset reads its estimated ends from (JOS-216) — the PUBLIC timer
   * projection, `buildTimerRows(buffs, buffTimers)`, injected by modules/wiring.ts.
   *
   * A seam rather than a direct dependency because this module is registered BEFORE the two it
   * would have to reach for, and because the rows are the one output both timer overlays already
   * draw: consuming them is what keeps this feature from growing a duration model of its own.
   */
  setTimerRows(rows: () => readonly BuffTimerRow[]): void {
    this.early.setRowSource(rows)
  }

  /** The defs currently loaded (for snapshot()). */
  private defs(): AlertDef[] {
    return this.compiled.map((c) => c.def)
  }

  reset(): void {
    // Defs persist across character switches (they're user prefs, not log state);
    // only the per-character firing bookkeeping resets. The cast-recency map IS character
    // state (a different character casts different ranks), so it resets with it — the
    // replay that follows repopulates it.
    this.seq = 0
    this.lastFire = new Map()
    this.pending = []
    this.spellLastCast = new Map()
    this.castPending = new Map()
    this.poisonSlowSeen = null
    this.poisonSlowDirty = false
    // A pending warning is about a debuff on a mob this character was fighting; the next character
    // is not fighting it, and the replay that follows will re-arm nothing (a replay never fires).
    this.early.reset()
  }

  /**
   * Record a rank-preserving cast. Runs for replay events as well as live ones — the map
   * describes the character, not the session, and the renderer must see it at hydration.
   */
  private noteCast(ev: LogEvent): void {
    if (ev.kind !== 'castBegin') return
    const name = ev.spell.trim()
    if (!name) return
    const prev = this.spellLastCast.get(name)
    if (prev !== undefined && prev >= ev.ts) return
    // Re-insert so Map iteration order stays least-recent-first for the eviction below.
    this.spellLastCast.delete(name)
    this.spellLastCast.set(name, ev.ts)
    this.castPending.set(name, ev.ts)
    if (this.spellLastCast.size > SPELL_CAST_CAP) {
      const oldest = this.spellLastCast.keys().next()
      if (!oldest.done) this.spellLastCast.delete(oldest.value)
    }
  }

  /**
   * Record a rogue slow landing. Like `noteCast`, this runs for REPLAY events too — the
   * record describes the character's fights, not the current session, and the offer strip
   * must be correct at hydration.
   *
   * `effect` is the unambiguous half of a poison proc: the two shared emotes are shared
   * between strikes that agree on their effect (shared/poisons.ts), so 'slow' is exactly
   * Weakening Strike's landing and nothing else.
   */
  private notePoisonSlow(ev: LogEvent): void {
    if (ev.kind !== 'poisonProc' || ev.effect !== 'slow') return
    const prev = this.poisonSlowSeen
    this.poisonSlowSeen = {
      lastAt: Math.max(prev?.lastAt ?? 0, ev.ts),
      count: (prev?.count ?? 0) + 1,
      lastTarget: ev.ts >= (prev?.lastAt ?? 0) ? ev.target : (prev?.lastTarget ?? ev.target)
    }
    this.poisonSlowDirty = true
  }

  onEvent(ev: LogEvent, live: boolean): void {
    this.seq = ev.seq
    this.noteCast(ev)
    this.notePoisonSlow(ev)
    // Fire on LIVE events only — replay must never make a sound.
    if (!live) return
    // The event's own best-effort spell is resolved once per firing (fires are rare), not once
    // per compiled alert; `matchedSpellName` then refines it PER ALERT for the shared-message
    // families, where which name is right depends on which alert matched (JOS-84).
    let base: string | undefined
    let spellResolved = false
    for (const c of this.compiled) {
      if (!c.def.enabled) continue
      const match = this.matches(c, ev)
      if (match == null) continue
      const key = cooldownKey(c.def, ev)
      if (!spellResolved) {
        base = firingSpell(ev)
        spellResolved = true
      }
      const spell = matchedSpellName(c, ev, base)
      const fired: FiredAlert = { alertId: c.def.id, ts: ev.ts, matchedText: match.text }
      // Omitted rather than set to undefined: the delta is JSON over IPC, and an absent key
      // is the honest encoding of "this family names no spell".
      if (spell !== undefined) fired.spell = spell
      // Likewise absent when the trigger declared no named group AND the phrase asked for no auto
      // token — which is nearly every alert, so the delta stays byte-identical for them. The
      // values are already sanitized and capped (shared/alertCaptures.ts `harvestCaptures`,
      // shared/alertTargets.ts `resolveTarget`); nothing downstream re-derives them.
      const captures = withAutoCaptures(match.captures, c.autoTokens, ev)
      if (captures) fired.captures = captures
      if (this.earlyWarnTakesIt(c, ev, key, fired)) continue
      if (this.onCooldown(key, c.def, ev.ts)) continue
      this.noteFire(key, ev.ts)
      this.pending.push(fired)
      this.record(c.def.id, ev.ts, match.text)
    }
  }

  /**
   * WHETHER THE EARLY-WARNING OFFSET CLAIMS THIS MATCH — true when nothing sounds right now.
   *
   * THE OFFSET MOVES THE ONE FIRE; IT DOES NOT ADD A SECOND ONE (JOS-216). An alert with an early
   * warning says nothing when its trigger matches: the match ARMS a warning against the timer row
   * this landing produces, and the firing the caller built is made later, N seconds before that
   * row's estimated end. The cooldown is deliberately NOT spent here — the clock belongs to the
   * sound, and no sound has been made yet.
   *
   * …UNLESS THIS DEF'S TRIGGER IS THE ENDING (JOS-235), in which case there is nothing left to arm
   * against and arming was the bug that ate the alert whole. A break-family def arms from the ROW
   * APPEARING instead (`breakWatchers`) and still FIRES on its own trigger — except for the one
   * landing whose warning already spoke, which `breakSpoken` swallows. An early break never
   * reached its warning, so nothing suppresses it: it fires, exactly as it always did.
   */
  private earlyWarnTakesIt(c: CompiledAlert, ev: LogEvent, key: string, fired: FiredAlert): boolean {
    const sec = normalizeEarlyWarnSec(c.def.earlyWarnSec)
    if (sec === undefined) return false
    // The names this line could answer to — the event's own resolved pick (already on the firing)
    // plus the JOS-84 candidate list, which is the truth when one sentence is a whole family.
    const names = [...(fired.spell === undefined ? [] : [fired.spell]), ...spellCandidateNames(ev)]
    if (c.breakKinds.length === 0) {
      this.early.arm({ sec, cooldownKey: key, subject: earlyWarnSubject(ev, names), ts: ev.ts, fired })
      return true
    }
    return this.early.breakSpoken(c.def.id, breakEventIdentity(ev, names))
  }

  /**
   * The wall-clock heartbeat (~1×/sec while the LIVE tail runs, never during replay). It exists for
   * ONE thing: the early-warning offset, whose whole subject is a deadline that arrives while the
   * log is idle — which is exactly when a player is watching a mez run down.
   */
  onTick(nowMs: number): void {
    for (const due of this.early.tick(nowMs, this.breakWatchers(nowMs))) this.fireWarning(due, nowMs)
  }

  /**
   * The break-family defs that want to be told about live rows (JOS-235).
   *
   * Rebuilt each tick rather than cached with the compile, because "enabled" and the offset can
   * change under it and the list is at most a handful of defs — a user has one charm-break alert,
   * not four hundred. When it is empty (the overwhelmingly common case) the scheduler does not read
   * the timer projection at all.
   */
  private breakWatchers(nowMs: number): BreakWatcher[] {
    const out: BreakWatcher[] = []
    for (const c of this.compiled) {
      if (!c.def.enabled || c.breakKinds.length === 0) continue
      const sec = normalizeEarlyWarnSec(c.def.earlyWarnSec)
      if (sec === undefined) continue
      out.push({ alertId: c.def.id, sec, probe: (row) => this.probeBreak(c, row, nowMs) })
    }
    return out
  }

  /**
   * WOULD THIS DEF ANNOUNCE THE BREAK OF THIS ROW — asked of the def's OWN matcher, never of a
   * second one written to guess at the same question (the seam, and the whole blast radius of the
   * hypothetical event it is asked with, are documented on `breakProbes`).
   *
   * The firing it hands back is built exactly like an ordinary one: the same `matchedText` the
   * matcher reports (here a projection sentence, because no line has been printed), the same
   * captures its own named groups took from the fields it tested, and the same cooldown clock the
   * REAL break event would have chosen — so `cooldownScope:'target'` still means one clock per mob,
   * and the families whose break line names a `mob` rather than a `target` degrade to the
   * alert-level clock here in exactly the way they already do there.
   *
   * The spoken spell is the probe's — the rank-less name the wear-off line prints — for the same
   * reason `matchedSpellName` reports the candidate that satisfied the def rather than the event's
   * best-effort pick: the name the alert matched on is the name it should say.
   */
  private probeBreak(
    c: CompiledAlert,
    row: BuffTimerRow,
    nowMs: number
  ): { fired: FiredAlert; cooldownKey: string } | null {
    for (const kind of c.breakKinds) {
      for (const p of breakProbes(kind, row, nowMs)) {
        const match = this.matches(c, p.ev)
        if (!match) continue
        const fired: FiredAlert = { alertId: c.def.id, ts: nowMs, matchedText: match.text, spell: p.spell }
        // The probe's hypothetical event carries the ROW's subject, so an early warning speaks the
        // same mob name the real break would have (`breakProbes`, shared/earlyWarning.ts).
        const captures = withAutoCaptures(match.captures, c.autoTokens, p.ev)
        if (captures) fired.captures = captures
        return { fired, cooldownKey: cooldownKey(c.def, p.ev) }
      }
    }
    return null
  }

  /**
   * Make an early warning's firing, if the alert behind it still wants it.
   *
   * The def is re-read rather than trusted: a warning can be armed for a minute, and an alert the
   * user deleted or switched off in the meantime must not speak. The cooldown is spent HERE, on the
   * clock the ARMING event chose (so `cooldownScope:'target'` still means one clock per mob), and
   * `seq` is bumped by hand — a tick advances no log seq, and `useModule` would drop the delta as a
   * duplicate (JOS-87; `appFired` bumps it for the same reason).
   */
  private fireWarning(due: EarlyWarnDue, nowMs: number): void {
    const def = this.compiled.find((c) => c.def.id === due.fired.alertId)?.def
    if (!def?.enabled) return
    if (this.onCooldown(due.cooldownKey, def, nowMs)) return
    this.noteFire(due.cooldownKey, nowMs)
    this.seq += 1
    // `dueAt` rides the firing so a consumer can COUNT DOWN to the deadline this warning is early
    // of (JOS-378). It is carried only here, on the early-warning path, because it is only here
    // that a deadline exists — see FiredAlert.dueAt.
    this.pending.push({ ...due.fired, ts: nowMs, dueAt: due.dueAt })
    this.record(def.id, nowMs, due.fired.matchedText)
  }

  /**
   * Record a renderer-evaluated 'app' fire (e.g. bossDefeat) into the history so
   * the module stays the single source of truth for recent fires. `context` is the
   * signal's matched text (e.g. the boss name). The renderer already applied the
   * cooldown before calling this; we just append to the ring. Returns the updated
   * history for that alert so main can push it back if desired.
   */
  appFired(alertId: string, context: string, ts: number = Date.now()): void {
    // Only record for a known 'app' alert id (ignore stale/unknown ids).
    const known = this.compiled.some((c) => c.def.id === alertId)
    if (!known) return
    this.record(alertId, ts, context)
    // Also queue a delta so the renderer's history updates over the same module
    // transport as event/raw fires. Bump seq so useModule doesn't reject it as a
    // dupe (app fires arrive off the bus, so there's no fresh LogEvent seq); a
    // trailing flushNow() by main pushes it. matchedText = the signal context.
    this.seq += 1
    // MARKED AS AN ECHO (JOS-380). The renderer has already played this one — it is the only side
    // that can evaluate an app signal — so the record travels for history's sake and the player
    // skips playback on it. An unmarked record here is what made every app-signal alert fire
    // twice; only audio coalescing kept it inaudible.
    this.pending.push({ alertId, ts, matchedText: context, origin: 'app' })
  }

  /** Append a fire to an alert's ring buffer, capping at HISTORY_CAP (newest last). */
  private record(alertId: string, ts: number, matchedText: string): void {
    const arr = this.history.get(alertId) ?? []
    arr.push({ ts, matchedText })
    if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP)
    this.history.set(alertId, arr)
  }

  /** The recent-fires ring as a plain object for the snapshot. */
  private historyObj(): Record<string, AlertFireRecord[]> {
    const out: Record<string, AlertFireRecord[]> = {}
    for (const [id, arr] of this.history) out[id] = arr.slice()
    return out
  }

  /** Whether the clock `key` is still within alert `def`'s cooldown window at `ts`. */
  private onCooldown(key: string, def: AlertDef, ts: number): boolean {
    const cd = def.cooldownMs ?? DEFAULT_COOLDOWN_MS
    const last = this.lastFire.get(key)
    return last !== undefined && ts - last < cd
  }

  /**
   * Stamp a fire on clock `key`, keeping the map bounded and its iteration order
   * least-recently-fired first (delete-then-set re-inserts at the tail).
   */
  private noteFire(key: string, ts: number): void {
    this.lastFire.delete(key)
    this.lastFire.set(key, ts)
    if (this.lastFire.size > COOLDOWN_KEY_CAP) {
      const oldest = this.lastFire.keys().next()
      if (!oldest.done) this.lastFire.delete(oldest.value)
    }
  }

  /**
   * Returns the matched text if the alert's trigger matches `ev`, else null.
   *
   * Composite semantics (Task #47) — evaluated against the SINGLE incoming event:
   *   'any'    → fires when at least ONE condition matches (OR).
   *   'all'    → fires only when EVERY condition matches THE SAME event (AND).
   *   'single' → the one primitive condition (backward-compatible, unchanged).
   * Cross-event correlation is deliberately out of scope; an 'all' over conditions that can
   * never co-occur on one event (e.g. two different `kind`s) simply never fires.
   */
  private matches(c: CompiledAlert, ev: LogEvent): AlertMatch | null {
    if (c.composite === 'all') {
      // Every condition must match this one event. An empty condition list can't be satisfied
      // meaningfully — treat it as no-match to avoid a firehose.
      if (c.conditions.length === 0) return null
      // 'all' means EVERY condition matched this one event, so every one of them is "the
      // condition that matched" and all their captures are in scope. First writer wins on a
      // name collision, which is source order — the same rule the whole file reads by.
      let captures: Record<string, string> | undefined
      for (const cond of c.conditions) {
        const hit = this.conditionMatches(cond, ev)
        if (!hit) return null
        captures = mergeCaptures(captures, hit.captures)
      }
      return { text: ev.raw, ...(captures ? { captures } : {}) }
    }
    // 'any' and 'single': fire on the first matching condition, and take ITS captures. A
    // later condition that would also have matched is never evaluated, so it can never
    // contribute a value the firing did not actually match on.
    for (const cond of c.conditions) {
      const hit = this.conditionMatches(cond, ev)
      if (hit) return { text: ev.raw, ...(hit.captures ? { captures: hit.captures } : {}) }
    }
    return null
  }

  /** Whether ONE primitive condition matches `ev`, and what its named groups captured. */
  private conditionMatches(cond: CompiledCondition, ev: LogEvent): ConditionHit | null {
    if (cond.event) {
      if (ev.kind !== cond.event.kind) return null
      let captures: Record<string, string> | undefined
      for (const f of cond.event.fields) {
        const hit = fieldMatches(ev, f)
        if (!hit) return null
        captures = mergeCaptures(captures, hit.captures)
      }
      return captures ? { captures } : {}
    }
    if (cond.raw) {
      // A raw condition captures from `ev.raw` — the exact line it just tested, and the only
      // text it ever sees. `cond.raw` carries no 'g' flag, so `exec` is stateless.
      const m = cond.raw.exec(ev.raw)
      if (!m) return null
      const captures = harvestCaptures(m.groups)
      return captures ? { captures } : {}
    }
    // 'app' conditions never match main-side.
    return null
  }

  snapshot(): { seq: number; state: AlertsSnap } {
    const state: AlertsSnap = {
      defs: this.defs(),
      history: this.historyObj(),
      spellLastCast: Object.fromEntries(this.spellLastCast)
    }
    // Omitted rather than null: the snapshot is JSON over IPC and an absent key is the honest
    // encoding of "no slow has ever been observed for this character".
    if (this.poisonSlowSeen) state.poisonSlowSeen = { ...this.poisonSlowSeen }
    return { seq: this.seq, state }
  }

  flushDelta(): { seq: number; delta: AlertsDelta } | null {
    // A flush is warranted by a fire, a cast-recency advance OR a slow landing — the upgrade
    // offers recompute off the second and the poison-slow offer off the third, and neither
    // may wait for an unrelated alert to fire.
    const slow = this.poisonSlowDirty ? this.poisonSlowSeen : null
    if (this.pending.length === 0 && this.castPending.size === 0 && !slow) return null
    const fired = this.pending
    this.pending = []
    const cast = [...this.castPending].map(([spell, ts]) => ({ spell, ts }))
    this.castPending = new Map()
    this.poisonSlowDirty = false
    const delta: AlertsDelta = { fired }
    if (cast.length > 0) delta.cast = cast
    if (slow) delta.poisonSlow = { ...slow }
    return { seq: this.seq, delta }
  }
}
