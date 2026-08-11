// UNIT tests for the charm/CC ownership state machine (src/main/combat/charmModel.ts).
//
// The module is pure and clock-injected, so every transition in its state table is testable
// without an engine, a fixture or a wall clock. The GOLDEN-WINDOW half — the same rules
// replayed over verbatim real log spans — lives in tests/combatCharmOwnership.test.mts.
//
// The numbers asserted here are the ones charmModel.ts's header measured against
// eqlog_Primitive_freeport.txt; a test that pins them is what stops the window quietly
// becoming a guess again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAST_SLACK_MS,
  CHARM_SPELLS_BY_MESSAGE,
  CharmModel,
  DEFAULT_CAST_MS,
  DEFAULT_CHARM_DURATION_MS,
  DURATION_SLACK_MS,
  PROMOTE_MS,
  armWindowMs,
  isCcSpell,
  isCharmSpell,
  provisionalWindowMs
} from '../src/main/combat/charmModel'

const T0 = Date.parse('Tue Jul 28 16:47:33 2026')

test('the charm family is DERIVED from the spell DB, not hand-listed', () => {
  // Every spell whose msg_cast_on_other IS the broadcast, per the committed spells.json.
  // These five are the owner-castable ones (Alluring Whispers / Vampire Charm are flagged
  // "cast by NPCs only" but still carry the message, so they ride along harmlessly).
  for (const s of ['charm', 'beguile', "boltran's agacerie", 'cajoling whispers', 'dictate']) {
    assert.ok(CHARM_SPELLS_BY_MESSAGE.has(s), `${s} produces "Someone has been charmed."`)
  }
  // …and the membership test is WIDER than that table on purpose: `Allure` is a real charm
  // the owner cast 159 times (its `Your Allure VII spell has worn off of …` lines already
  // drive the un-charm path) but the scraped DB carries no cast-on-other message for it.
  //
  // STILL TRUE OF THE SCRAPE, AND NO LONGER TRUE OF THE LOADED DB (JOS-159). This table is built
  // from the raw `spells.json` import, which is why it still excludes Allure; the corrections
  // overlay in `src/main/data/spellCorrections.ts` supplies the missing message at
  // `loadSpellDb()` time, so the charm COUNTDOWN does now see Allure as a candidate. The two
  // facts live at different layers on purpose and the assertion below is about the lower one.
  assert.ok(!CHARM_SPELLS_BY_MESSAGE.has('allure'), 'the DB has no charm message for Allure')
  assert.ok(isCharmSpell('Allure VII'), 'but it IS a charm spell')
})

test('charm and CC membership are disjoint, and rank suffixes are folded', () => {
  for (const s of ['Charm', 'Beguile', 'Allure VII', "Boltran's Agacerie", 'Cajoling Whispers']) {
    assert.ok(isCharmSpell(s), `${s} is a charm`)
    assert.ok(!isCcSpell(s), `${s} is not a mez`)
  }
  for (const s of ['Dazzle', 'Mesmerization VI', 'Enthrall', 'Entrance', 'Ensnare', 'Screaming Terror']) {
    assert.ok(isCcSpell(s), `${s} is crowd control`)
    assert.ok(!isCharmSpell(s), `${s} is not a charm`)
  }
  assert.ok(!isCharmSpell('Superior Healing IV') && !isCcSpell('Superior Healing IV'))
})

test('the arm window is PER SPELL (cast time + slack), not a flat constant', () => {
  // This is the brief-overturning measurement: `You begin casting X.` → the broadcast is
  // 0–3s for Charm, 1–4s for Beguile, 1–6s for Cajoling Whispers, 2–5s for Allure. A flat
  // 2s window would have bound Charm and MISSED 271 of the owner's 366 real charms.
  assert.equal(armWindowMs('Charm'), 2400 + CAST_SLACK_MS)
  assert.equal(armWindowMs('Beguile'), 3500 + CAST_SLACK_MS)
  assert.equal(armWindowMs('Cajoling Whispers'), 5500 + CAST_SLACK_MS)
  assert.equal(armWindowMs('Allure VII'), 6000 + CAST_SLACK_MS, 'rank folds to the line cast time')
  assert.equal(armWindowMs('Dazzle'), 2500 + CAST_SLACK_MS)
  assert.equal(armWindowMs('A Spell The Wiki Never Heard Of'), DEFAULT_CAST_MS + CAST_SLACK_MS)
})

test('a broadcast inside an own charm cast BINDS; one with no cast behind it does not', () => {
  const m = new CharmModel()
  // No cast at all — the foreign case (Scooba's Allure VII, Aug 04 16:59:27).
  assert.equal(m.charmBroadcast('a knight of innoruuk', 'a Knight of Innoruuk', T0), 'foreign')

  m.noteCastBegin('Charm', T0)
  assert.equal(m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000), 'own', 'the measured +2s bind')
})

test('the charm arm expires exactly at cast time + slack', () => {
  const at = (dt: number): 'own' | 'foreign' => {
    const m = new CharmModel()
    m.noteCastBegin('Charm', T0)
    return m.charmBroadcast('a kodiak', 'a kodiak', T0 + dt)
  }
  assert.equal(at(3_900), 'own', 'the last instant inside the window')
  assert.equal(at(3_901), 'foreign', 'and one millisecond past it is somebody else')
})

test('a charm arm is CONSUMED — charm is single-target, so the second broadcast is foreign', () => {
  const m = new CharmModel()
  m.noteCastBegin('Charm', T0)
  assert.equal(m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000), 'own')
  assert.equal(m.charmBroadcast('a plains cat', 'a plains cat', T0 + 2_100), 'foreign')
})

test('a CC arm is NOT consumed — one AE mez prints one broadcast per mob', () => {
  // Verbatim from the real log: `Scooba begins casting Mesmerization VI.` at 16:59:34, then
  // BOTH `a Knight of Innoruuk has been mesmerized.` and `an elite dragoon has been
  // mesmerized.` at 16:59:35.
  const m = new CharmModel()
  m.noteCastBegin('Mesmerization VI', T0)
  assert.equal(m.ccBroadcast(T0 + 1_000), true)
  assert.equal(m.ccBroadcast(T0 + 1_000), true, 'the same cast gates every mob it landed on')
  assert.equal(m.ccBroadcast(T0 + 4_501), false, '3000ms cast + 1500ms slack, and no more')
})

test('a charm cast never gates a mez, and a mez cast never gates a charm', () => {
  const charm = new CharmModel()
  charm.noteCastBegin('Charm', T0)
  assert.equal(charm.ccBroadcast(T0 + 1_000), false)

  const mez = new CharmModel()
  mez.noteCastBegin('Dazzle', T0)
  assert.equal(mez.charmBroadcast('a kodiak', 'a kodiak', T0 + 1_000), 'foreign')
})

test('fizzle / interrupt / resist of the ARMED spell disarms; an unrelated one does not', () => {
  for (const fail of ['Charm', 'Charm II']) {
    const m = new CharmModel()
    m.noteCastBegin('Charm', T0)
    m.noteCastFailed(fail, T0 + 1_000)
    assert.equal(m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000), 'foreign', `${fail} killed the cast`)
  }
  const m = new CharmModel()
  m.noteCastBegin('Charm', T0)
  m.noteCastFailed('Chaotic Feedback', T0 + 1_000)
  assert.equal(m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000), 'own', 'somebody else fizzling is not our problem')
})

test('starting an unrelated cast clears a stale arm', () => {
  const m = new CharmModel()
  m.noteCastBegin('Charm', T0)
  m.noteCastBegin('Superior Healing IV', T0 + 500)
  assert.equal(m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000), 'foreign')
})

test('the demotion horizon is the CHARM SPELL\'S OWN DURATION, not a tuned timeout', () => {
  // The whole family is listed at 16 minutes except Dictate (8 ticks) and Boltran's Agacerie.
  assert.equal(provisionalWindowMs('Charm'), 960_000 + DURATION_SLACK_MS)
  assert.equal(provisionalWindowMs('Allure VII'), 960_000 + DURATION_SLACK_MS)
  assert.equal(provisionalWindowMs('Dictate'), 48_000 + DURATION_SLACK_MS)
  assert.equal(provisionalWindowMs("Boltran's Agacerie"), 420_000 + DURATION_SLACK_MS)
  assert.equal(provisionalWindowMs('Not A Real Spell'), DEFAULT_CHARM_DURATION_MS + DURATION_SLACK_MS)
  // …and it must exceed any plausible idle stretch. A 60s version silently deleted 35,956
  // points of a real Plane of Sky pet's damage: bound 01:02:56, first swing 01:05:01.
  assert.ok(provisionalWindowMs('Allure IV') > 300_000, 'a pet may stand idle for minutes')
})

test('an uncorroborated bind DEMOTES when its charm could no longer be running, and only then', () => {
  const m = new CharmModel()
  const w = provisionalWindowMs('Charm')
  m.noteCastBegin('Charm', T0)
  m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000)
  assert.deepEqual(m.sweep(T0 + 2_000 + w - 1), [], 'the charm could still be up')
  assert.deepEqual(m.sweep(T0 + 2_000 + w), [{ nameKey: 'a kodiak', display: 'a kodiak' }])
  assert.ok(m.idle, 'and the model has nothing left to expire')
  assert.deepEqual(m.sweep(T0 + 10_000_000), [], 'a demotion happens once')
})

test('everCharmed remembers every name a broadcast named, ours or not', () => {
  // This is what stops `You healed <your charmed pet>` from filing that mob as a player.
  const m = new CharmModel()
  assert.equal(m.everCharmed('bzzazzt'), false)
  m.charmBroadcast('bzzazzt', 'Bzzazzt', T0) // foreign-looking, still remembered
  assert.equal(m.everCharmed('bzzazzt'), true)
  m.release('bzzazzt')
  assert.equal(m.everCharmed('bzzazzt'), true, 'releasing a bind does not un-see the charm')
  m.reset()
  assert.equal(m.everCharmed('bzzazzt'), false, 'but a session reset does')
})

test('pet-shaped evidence CONFIRMS a bind, which then never expires', () => {
  // 336 of the owner's 366 real binds produce one of these inside 60s: 204 a `… Master.`
  // tell, 125 the pet's own outgoing damage, 7 the owner's charm wearing off. All three
  // funnel through notePetEvidence.
  const m = new CharmModel()
  m.noteCastBegin('Charm', T0)
  m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000)
  m.notePetEvidence('a kodiak')
  assert.ok(m.idle)
  assert.deepEqual(m.sweep(T0 + 10 * provisionalWindowMs('Charm')), [], 'a proven pet is never demoted')
})

test('a `… Master.` tell PROMOTES a charm we saw but declined to bind', () => {
  const m = new CharmModel()
  // Foreign-looking (no own cast) — declined…
  assert.equal(m.charmBroadcast('a kodiak', 'a kodiak', T0), 'foreign')
  // …but the tell is ownership-definitive and pet-only, so it binds after the fact.
  assert.equal(m.claimIsCharmed('a kodiak', T0 + 4_000), true)
  assert.equal(m.claimIsCharmed('a kodiak', T0 + 5_000), false, 'promotion happens once')
  assert.ok(m.idle, 'a promoted bind is CONFIRMED, not provisional')
})

test('promotion has a memory limit, and never invents one for a name never seen charmed', () => {
  const m = new CharmModel()
  m.charmBroadcast('a kodiak', 'a kodiak', T0)
  assert.equal(m.claimIsCharmed('a kodiak', T0 + PROMOTE_MS + 1), false, 'too old to be that charm')

  const fresh = new CharmModel()
  assert.equal(fresh.claimIsCharmed('vebarn', T0), false, 'a summoned pet was never charmed')
})

test('release and zone forget bindings; zone keeps only the pets that walked through', () => {
  const m = new CharmModel()
  m.noteCastBegin('Charm', T0)
  m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000)
  m.release('a kodiak')
  assert.ok(m.idle)

  m.notePetEvidence('vebarn') // a summoned pet, confirmed
  m.noteCastBegin('Charm', T0 + 10_000)
  m.charmBroadcast('a kodiak', 'a kodiak', T0 + 12_000)
  m.zone(['vebarn'])
  assert.ok(m.idle, 'the charmed pet is left behind, arm and all')
  // Vebarn survived as CONFIRMED: a later broadcast for it is treated as already ours.
  assert.equal(m.charmBroadcast('vebarn', 'Vebarn', T0 + 20_000), 'own')
  // The kodiak did not: with no arm, its next broadcast is somebody else's.
  assert.equal(m.charmBroadcast('a kodiak', 'a kodiak', T0 + 20_000), 'foreign')
})

test('reset() returns the model to a virgin state', () => {
  const m = new CharmModel()
  m.noteCastBegin('Charm', T0)
  m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_000)
  m.reset()
  assert.ok(m.idle, 'the provisional bind is gone')
  assert.equal(m.claimIsCharmed('a kodiak', T0 + 2_100), false, 'and so is the sighting behind it')
  assert.equal(m.charmBroadcast('a kodiak', 'a kodiak', T0 + 2_200), 'foreign', 'the arm went with it')
})
