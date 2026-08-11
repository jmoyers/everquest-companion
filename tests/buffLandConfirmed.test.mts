// JOS-118 — A TRACKED INSTANCE EXISTS ONLY ONCE THE SPELL LANDS ON A NAMED TARGET.
//
// THE DEFECT: owner validation of the buff/debuff overlay found a debuff bar appearing for a
// spell that was RESISTED. The cause was not the resist handling (there was none) but the
// optimistic display on the other side: `castBegin` opened a `provisional` ActiveBuff bound to
// a target the model INFERRED, retracted only by a fizzle or an interrupt. A resist is neither,
// so the bar stayed — and fifteen seconds later the same guess was promoted to a solid row plus
// an open cast that could pair into a duration sample.
//
// THE RULE, one shape for buffs, debuffs and crowd control alike (mez and slow ARE debuffs;
// buffs land on individuals too, so none of them is a special case):
//
//   An instance opens ONLY on a line that CONFIRMS the landing, keyed to the entity that line
//   NAMES. Never a cast, never an inferred or "current" target, never a resist.
//
// So the resist case is correct BY CONSTRUCTION: there was never anything to retract. These
// tests pin both halves — that a resisted/unconfirmed cast shows nothing and mints nothing, and
// that a real landing still produces the row it should, keyed to the right entity — because a
// fix that only deleted things would pass the first half and break the product.
//
// THE OWNERSHIP GATES ARE PINNED HERE TOO (owner: "make sure we're only capturing our
// buffs/debuffs - not others"). They pre-date this ticket — `onBuffApply`'s own-cast gate
// (Task #45) and the CC hold's own-cast requirement (JOS-89) — and unifying the world model
// must not have weakened either, so all three shapes get an explicit regression pin.
//
// EVERY SENTENCE BELOW IS A SHAPE THE REAL LOG PRINTS, verbatim from the tree or the owner's
// own log, with only names/timestamps substituted (the reporter-slice precedent):
//   `You feel much faster.`                        w1-current-session.log  (self haste landing)
//   `Darmoss feels much faster.`                   w1-current-session.log  (the SAME message
//                                                   naming another person — a group buff landing
//                                                   on an individual who is not you)
//   `<mob> slows down.`                            w6-rank-pairing.log, and many others
//   `<mob> has been mesmerized.`                   g1-group-lifecycle.log
//   `<mob> resisted your <Spell>!`                 g1-group-lifecycle.log, w42-…, and the owner's
//                                                   own six consecutive `Guard Gehnus resisted
//                                                   your Shiftless Deeds IV!` lines
//   `Your <Spell> spell has worn off of <mob>.`    w6-rank-pairing.log
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replayBuffTimers } from './harness.mts'
import type { BuffTimerRow } from '../src/shared/buffTimers.ts'
import type { BuffsSnap } from '../src/shared/types.ts'

// ---------------------------------------------------------------------------------------------
// A tiny script builder. Lines are (offsetSeconds, text) so each test reads as a transcript.
// ---------------------------------------------------------------------------------------------

const DAY = 'Sat Aug 01'
const YEAR = '2026'

/** An EQ-stamped line at `sec` seconds past 19:00:00 — the real `[Day Mon DD HH:MM:SS YYYY] ` shape. */
function at(sec: number, text: string): string {
  const h = 19 + Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return `[${DAY} ${two(h)}:${two(m)}:${two(s)} ${YEAR}] ${text}`
}

function script(...rows: [number, string][]): string[] {
  return rows.map(([sec, text]) => at(sec, text))
}

/**
 * Replay a script through the real parser + the real buffs AND buffTimers modules.
 *
 * `observeSec` DEFAULTS TO 120, not 600, since JOS-140. The unwitnessed-expiry cull retires a
 * DEBUFF row once its countdown has run out and the grace has passed (the owner's slow-a-boss-
 * then-die case), so a test that wants to assert a bar EXISTS has to look while it is up — the
 * old ten-minute observation is now nine minutes past a two-and-a-half-minute slow. Cases that
 * assert an ABSENCE still pass a long instant deliberately, and say so.
 */
function run(lines: string[], observeSec = 120): { buffs: BuffsSnap; rows: BuffTimerRow[] } {
  const { buffs, rows } = replayBuffTimers(lines, { tickMs: new Date(at(observeSec, 'x').slice(1, 25)).getTime() })
  return { buffs, rows }
}

const rowNames = (rows: BuffTimerRow[]): string[] => rows.map((r) => `${r.kind}:${r.name}@${r.target ?? 'self'}`)
const totalSamples = (buffs: BuffsSnap): number =>
  Object.values(buffs.stats).reduce((acc, s) => acc + s.n, 0)

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 1 — A RESISTED CAST OPENS NOTHING AND MINTS NOTHING. The reported defect.
// ---------------------------------------------------------------------------------------------

test('JOS-118 the defect: a resisted DEBUFF cast shows no bar and mints no sample', () => {
  // The owner's own sequence, six consecutive times in his log: cast, then the resist.
  const { buffs, rows } = run(
    script(
      [0, 'You begin casting Shiftless Deeds IV.'],
      [3, 'Guard Gehnus resisted your Shiftless Deeds IV!']
    )
  )
  assert.deepEqual(buffs.active, [], 'a resisted cast leaves NOTHING active — this was the bug')
  assert.deepEqual(rowNames(rows), [], 'and the overlay draws no row for it')
  assert.equal(totalSamples(buffs), 0, 'and no duration sample is minted (the clean-sample rule)')
})

test('JOS-118: the resisted cast opens nothing even after the old 15s land timeout elapses', () => {
  // The old model promoted the inferred guess to a SOLID row at LAND_TIMEOUT_MS (15s) and on the
  // next castBegin. Both clocks are run past here, and both must still produce nothing.
  const { buffs, rows } = run(
    script(
      [0, 'You begin casting Shiftless Deeds IV.'],
      [3, 'Guard Gehnus resisted your Shiftless Deeds IV!'],
      [40, 'You begin casting Shiftless Deeds IV.'],
      [43, 'Guard Gehnus resisted your Shiftless Deeds IV!']
    ),
    300
  )
  assert.deepEqual(buffs.active, [], 'no row appears when the land timeout passes with no landing')
  assert.deepEqual(rowNames(rows), [], 'and none on the overlay')
  assert.equal(totalSamples(buffs), 0, 'and still no sample')
})

test('JOS-118: a resisted CC cast opens no hold', () => {
  // Observed at 10s, well inside a mez's own duration, so the emptiness is the rule at work and
  // not a hold that quietly expired before we looked.
  const { buffs, rows } = run(
    script(
      [0, 'You begin casting Mesmerization.'],
      [1, 'A wan ghoul knight resisted your Mesmerization!']
    ),
    10
  )
  assert.deepEqual(rowNames(rows), [], 'a resisted mez holds nobody')
  assert.deepEqual(buffs.active, [], 'and opens no buff instance either')
})

test('JOS-118: a cast with NO landing line of any kind tracks nothing — silence stays silence', () => {
  // The honesty limit the ticket states: where EQ surfaces no landing, the app says nothing
  // rather than inventing a target. (This is also W2's Intensify Death, on real bytes.)
  const { buffs, rows } = run(script([0, 'You begin casting Boon of the Garou.']), 300)
  assert.deepEqual(buffs.active, [], 'no landing line ⇒ no instance')
  assert.deepEqual(rowNames(rows), [], 'and no row')
  assert.equal(totalSamples(buffs), 0, 'and no sample')
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 2 — A LANDED INSTANCE IS KEYED TO THE ENTITY THE LANDING MESSAGE NAMED.
// The other half: the fix must not be "show less of everything".
// ---------------------------------------------------------------------------------------------

test('JOS-118: a landed DEBUFF is a bar on the MOB the landing line named', () => {
  const { buffs, rows } = run(
    script(
      [0, 'You begin casting Shiftless Deeds IV.'],
      [3, 'Guard Gehnus slows down.']
    )
  )
  // The row carries the RANKED name the cast line spelled (JOS-140) - the landing sentence names
  // no spell and the wear-off names the rank-less base, so the cast is the only line that knows.
  const deeds = buffs.active.find((a) => a.spell === 'Shiftless Deeds IV')
  assert.ok(deeds, 'the landed slow is tracked')
  assert.equal(deeds.self, false, 'a debuff on a mob is not a self buff')
  assert.equal(deeds.target, 'Guard Gehnus', 'keyed to the entity the LANDING line named')
  assert.equal(deeds.cls, 'debuff')
  assert.equal(deeds.messageDriven, true, 'opened by the landing line')
  assert.equal(deeds.inferredTarget, undefined, 'a named target is never flagged inferred')
  assert.deepEqual(rowNames(rows), ['debuff:Shiftless Deeds IV@Guard Gehnus'])
})

test('JOS-118: a landed SELF buff is a bar on you', () => {
  const { buffs, rows } = run(
    script(
      [0, 'You begin casting Swift Like the Wind I.'],
      [3, 'You feel much faster.']
    )
  )
  const swift = buffs.active.find((a) => a.spell.toLowerCase().includes('swift like the wind'))
  assert.ok(swift, 'the landed self buff is tracked')
  assert.equal(swift.self, true, 'bound to the player')
  assert.equal(swift.target ?? undefined, undefined, 'a self buff has no target chip')
  assert.deepEqual(rowNames(rows), ['buff:Swift Like the Wind I@self'])
})

test('JOS-118: a buff landing on a NAMED group member is keyed to that person, not to me', () => {
  // `Darmoss feels much faster.` is the SAME haste message as `You feel much faster.`, naming
  // someone else — the exact "buffs land on individuals too" case, and the one place a model
  // that defaulted to self would silently claim another player's buff as the player's own.
  const { buffs, rows } = run(
    script(
      [0, 'You begin casting Swift Like the Wind I.'],
      [3, 'Darmoss feels much faster.']
    )
  )
  const swift = buffs.active.find((a) => a.spell.toLowerCase().includes('swift like the wind'))
  assert.ok(swift, 'the buff on the group member is tracked')
  assert.equal(swift.self, false, 'it is NOT on me — the line named somebody else')
  assert.equal(swift.target, 'Darmoss', 'keyed to the person the landing line named')
  assert.deepEqual(rowNames(rows), ['buff:Swift Like the Wind I@Darmoss'])
})

test('JOS-118: a landed CC hold is keyed to the mob the broadcast named', () => {
  const { rows } = run(
    script(
      [0, 'You begin casting Mesmerization.'],
      [1, 'a ghoul sentinel has been mesmerized.']
    ),
    10
  )
  assert.deepEqual(rowNames(rows), ['cc:Mesmerization@a ghoul sentinel'])
})

test('JOS-118: a resist naming one mob never suppresses a landing on another', () => {
  // REAL BYTES, g1-group-lifecycle.log lines 501-505: ONE `You begin casting Mesmerization.`
  // prints BOTH `A wan ghoul knight resisted your Mesmerization!` AND `a ghoul sentinel has been
  // mesmerized.` in the same second — an AE that some targets resist and others do not. So the
  // resist ruling has to be per-INSTANCE. A fix that cleared the own-cast history on a resist
  // (the way a fizzle does) would have deleted the mez that really landed.
  const { rows } = run(
    script(
      [0, 'You begin casting Mesmerization.'],
      [0, 'A wan ghoul knight resisted your Mesmerization!'],
      [0, 'a ghoul sentinel has been mesmerized.']
    ),
    10
  )
  assert.deepEqual(rowNames(rows), ['cc:Mesmerization@a ghoul sentinel'], 'the mob that WAS mezzed is held; the one that resisted is not')
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 3 — OWNERSHIP. Only OUR buffs/debuffs, never a stranger's (owner).
// ---------------------------------------------------------------------------------------------

test('ownership (a): a stranger casts and it lands on a nearby mob — we track nothing', () => {
  // The owner's log, line ~1406459: another player casts the same slow family and it lands on a
  // mob beside us. Without the own-cast gate that landing binds as ours.
  const { buffs, rows } = run(
    script(
      [0, "Sluberg begins casting Shiftless Deeds V."],
      [3, 'a greater kobold slows down.']
    )
  )
  assert.deepEqual(buffs.active, [], "a stranger's debuff is not ours to track")
  assert.deepEqual(rowNames(rows), [])
})

test('ownership (b): another player buffs YOU — the cast-on-you line alone tracks nothing', () => {
  // `You feel much faster.` with no own cast in the window is somebody else's haste landing on
  // the player. The bar tracks what WE cast, so this is refused too.
  const { buffs, rows } = run(script([3, 'You feel much faster.']))
  assert.deepEqual(buffs.active, [], "a buff we did not cast is not tracked, even when it is on us")
  assert.deepEqual(rowNames(rows), [])
})

test("ownership (c): a stranger's crowd control holds nobody", () => {
  const { rows } = run(script([1, 'a ghoul sentinel has been mesmerized.']))
  assert.deepEqual(rowNames(rows), [], "another enchanter's mez is an observation about the room")
})

test('ownership (d): our OWN cast + its landing IS tracked, keyed to the named entity', () => {
  // The positive control for all three refusals above — same sentences, own cast in front.
  const { buffs, rows } = run(
    script(
      [0, 'You begin casting Shiftless Deeds IV.'],
      [3, 'a greater kobold slows down.'],
      [4, 'You begin casting Mesmerization.'],
      [5, 'a ghoul sentinel has been mesmerized.']
    ),
    10
  )
  assert.equal(buffs.active.length, 1, 'exactly the one debuff we cast')
  assert.equal(buffs.active[0].target, 'a greater kobold', 'on the mob the landing line named')
  assert.deepEqual(
    rowNames(rows).sort(),
    ['cc:Mesmerization@a ghoul sentinel', 'debuff:Shiftless Deeds IV@a greater kobold'],
    'both of our own land, each keyed to its own named mob'
  )
})

// ---------------------------------------------------------------------------------------------
// ACCEPTANCE 4 — A SAMPLE REQUIRES AN EXACT (own cast → landing on THAT entity → wear-off on
// THAT entity) CHAIN (owner). Only our own modifiers may shape a duration we learn from.
// ---------------------------------------------------------------------------------------------

test('sampling: a slow on two mobs measures each against its OWN landing, never across them', () => {
  // THE MIS-PAIRING THIS KILLS: `recordFade` used to fall back to the OLDEST open cast of the
  // same spell on ANY entity, so mob B's wear-off was measured from mob A's older landing — a
  // span that is too LONG, in exactly the direction the recency-weighted MAX estimator trusts.
  // Here A lands at 1s and B at 61s; B wears off at 181s. The honest sample is B's own 120s.
  // The old fallback would have produced 180s.
  //
  // THE SPANS ARE SHORTER THAN THEY WERE (JOS-140): the observation has to land while Gehnus's
  // slow is still inside its life, because the unwitnessed-expiry cull now retires a debuff that
  // is long overdue with nothing to close it — which is a different rule from this one and is
  // pinned separately below. 200 s against a 150 s DB floor plus its grace leaves the scoping
  // claim about a FADE where it belongs.
  const { buffs } = run(
    script(
      [0, 'You begin casting Shiftless Deeds IV.'],
      [1, 'Guard Gehnus slows down.'],
      [60, 'You begin casting Shiftless Deeds IV.'],
      [61, 'Guard Hewet slows down.'],
      [181, 'Your Shiftless Deeds spell has worn off of Guard Hewet.']
    ),
    200
  )
  const stat = buffs.stats['shiftless deeds']
  assert.ok(stat, 'the wear-off on Hewet mints a sample')
  assert.equal(stat.n, 1, 'exactly one — only the instance that actually wore off')
  assert.equal(stat.maxMs, 120_000, "measured from Hewet's OWN landing (61s→181s), not from Gehnus's")
  // Gehnus's slow is still up: another mob's wear-off never speaks for it.
  assert.ok(
    buffs.active.some((a) => a.target === 'Guard Gehnus'),
    "the still-live slow on the other mob survives — a fade names one entity and only that one"
  )
})

test('sampling: a wear-off with no landing of its own mints nothing', () => {
  // The cast was resisted, so nothing opened; a later wear-off line for that spell (an older
  // instance, or somebody else's) must not retro-pair with the cast and invent a duration.
  const { buffs } = run(
    script(
      [0, 'You begin casting Shiftless Deeds IV.'],
      [3, 'Guard Gehnus resisted your Shiftless Deeds IV!'],
      [120, 'Your Shiftless Deeds spell has worn off of Guard Gehnus.']
    ),
    300
  )
  assert.equal(totalSamples(buffs), 0, 'an unmatched fade is not a measurement')
})

test('sampling: three OVERLAPPING slows on three mobs are three instances and three clean samples', () => {
  // THE CANONICAL MULTI-TARGET CASE, generated live by the owner in an instance for this ticket
  // (Aug 08 15:06–15:11). Three Shiftless Deeds IV casts stagger 12–16 s apart, all three land on
  // different mobs, all three are up SIMULTANEOUSLY, and all three wear off:
  //   a gnoll pup         land 15:06:21 → worn off 15:10:15   234 s
  //   a fire beetle       land 15:06:33 → worn off 15:10:30   237 s
  //   a decaying skeleton land 15:06:49 → worn off 15:10:44   235 s
  // Offsets below are those exact stamps rebased to 19:06:00, and each cast precedes its landing
  // by the real ~4 s.
  //
  // WHAT IT PROVES: the instance is the (spell, entity) PAIR, not the spell. Three rows coexist
  // for one spell, each keyed to the mob its own landing line named, and each wear-off closes and
  // measures only its own — so the three spans agree to within tick jitter (234/237/235) instead
  // of skewing by the 12–16 s cast stagger. The discriminating case for the deleted cross-entity
  // fallback is the two-mob test above, where the first mob never fades; this one is the shape a
  // player actually produces, and it is the one that would have been quietly wrong.
  const { buffs } = run(
    script(
      [17, 'You begin casting Shiftless Deeds IV.'],
      [21, 'a gnoll pup slows down.'],
      [29, 'You begin casting Shiftless Deeds IV.'],
      [33, 'a fire beetle slows down.'],
      [45, 'You begin casting Shiftless Deeds IV.'],
      [49, 'a decaying skeleton slows down.'],
      [255, 'Your Shiftless Deeds spell has worn off of a gnoll pup.'],
      [270, 'Your Shiftless Deeds spell has worn off of a fire beetle.'],
      [284, 'Your Shiftless Deeds spell has worn off of a decaying skeleton.']
    ),
    300
  )
  const stat = buffs.stats['shiftless deeds']
  assert.ok(stat, 'the three wear-offs mint samples')
  assert.equal(stat.n, 3, 'three instances ⇒ three samples, one per (spell, entity) pair')
  assert.equal(stat.minMs, 234_000, 'the gnoll pup span, measured from ITS landing')
  assert.equal(stat.maxMs, 237_000, 'the fire beetle span, measured from ITS landing')
  assert.ok(stat.maxMs - stat.minMs <= 3_000, 'all three agree within tick jitter — no cast-stagger skew')
  assert.deepEqual(buffs.active, [], 'and all three rows are closed by their own wear-off')
})

test('sampling: mobs KILLED BY OTHER PLAYERS before wear-off are censored and mint nothing', () => {
  // THE NEGATIVE HALF of the same session (the 15:01 overworld trio): three slows land, and every
  // one of those mobs is killed by SOMEBODY ELSE before it can wear off, so no wear-off line for
  // them exists anywhere in the log. Those instances must be censored by the deaths — the whole
  // reason the censor exists (world-model law 4: an unobservable fade must never pair with a much
  // later unrelated one and mint a bogus duration).
  //
  // THE DEATH IS A THIRD PARTY'S, which is the arm worth pinning: `<mob> has been slain by
  // <another player>!` is not the player's own kill and not the killerless form, and the censor
  // has to cover it or a stranger's kill leaves a permanent phantom bar on a corpse.
  const { buffs, rows } = run(
    script(
      [56, 'You begin casting Shiftless Deeds IV.'],
      [60, 'a decaying skeleton slows down.'],
      [69, 'You begin casting Shiftless Deeds IV.'],
      [73, 'a gnoll pup slows down.'],
      [86, 'You begin casting Shiftless Deeds IV.'],
      [90, 'Fippy Darkpaw slows down.'],
      [100, 'A decaying skeleton has been slain by Lashun Novashine!'],
      [102, 'A gnoll pup has been slain by Lashun Novashine!'],
      [104, 'Fippy Darkpaw has been slain by Lashun Novashine!']
    ),
    200
  )
  assert.deepEqual(buffs.active, [], 'a mob someone else killed carries no surviving debuff bar')
  assert.deepEqual(rowNames(rows), [], 'and no row is left on a corpse')
  assert.equal(totalSamples(buffs), 0, 'and no duration is mined from a fade that can never be observed')
})

test('sampling: two clean exact-instance spans on different mobs agree — the owner’s validation', () => {
  // The owner measured Shiftless Deeds IV at 3m52s on Guard Hewet and 3m54s on a grass snake an
  // hour apart, and asked whether debuff durations were target-dependent. They are not: with
  // exact-instance sampling both spans are clean and they agree to two seconds. This pins that
  // the pairing is per-instance rather than per-spell, which is what makes the agreement legible.
  const { buffs } = run(
    script(
      [0, 'You begin casting Shiftless Deeds IV.'],
      [1, 'Guard Hewet slows down.'],
      [233, 'Your Shiftless Deeds spell has worn off of Guard Hewet.'],
      [300, 'You begin casting Shiftless Deeds IV.'],
      [301, 'a grass snake slows down.'],
      [535, 'Your Shiftless Deeds spell has worn off of a grass snake.']
    ),
    600
  )
  const stat = buffs.stats['shiftless deeds']
  assert.ok(stat)
  assert.equal(stat.n, 2, 'two clean samples, one per instance')
  assert.equal(stat.minMs, 232_000, 'Hewet: 1s→233s')
  assert.equal(stat.maxMs, 234_000, 'the snake: 301s→535s')
  assert.ok(stat.maxMs - stat.minMs <= 2_000, 'they agree to two seconds — not target-dependent')
})
