// GOLDEN WINDOWS + STATE MACHINE: somebody else's charm pet has an owner, and it is not you.
// (JOS-250 — src/main/combat/allyCharms.ts carries the design and the whole-log measurements.)
//
// THE REPORT (reddit, lalvarien, 2026-08-12): "how do i get charm pets to even show on any parser
// - i have no idea what these enchanters in my groups are doing because charm never shows up."
//
// Task #65's answer was that a caster-less `<mob> has been charmed.` binds only when it resolves
// one of YOUR OWN casts, and everything else is dropped at the admission gate with the rest of the
// mob-vs-mob traffic. That answer was right about YOUR rows and is untouched (W45 and the whole of
// tests/combatCharmOwnership.test.mts still pin it, byte for byte). What it could not see is the
// line sitting one second above every one of those broadcasts:
//
//     <Name> begins casting <charm spell>.
//
// parsed since JOS-140 for the buffs allowlist, ingested by combat nowhere. Joined to the
// broadcast it names the charmer, and the whole-log sweep says it does so cleanly: 456 broadcasts,
// 441 the owner's, 15 a named third party's, 0 unmatched, 0 resolving both.
//
// THE FOUR WINDOWS, all cut verbatim from the owner's real log (`npm run fixtures:combat`):
//
//   W66  Fri Jul 31 20:05:40→20:06:35  Gordon's imp protector. The clean case, and it carries
//        three of the four bind/unbind ends in fifty seconds: bind, SOFT-HOSTILE PROOF (the pet
//        turns on Gordon), re-charm.
//   W67  Thu Jul 30 18:27:08→18:27:36  the rock golem. The canonical twin refusal — a whole
//        window of `A rock golem pierces a rock golem` — with a bard singing his own charm over
//        the top of it, which must NOT be read as a competing claim.
//   W68  Fri Jul 31 21:13:09→21:13:20  Paladrial and Satya, one second apart, on one lava duct
//        crawler. The ONLY multi-caster tie in 1.6M lines, and therefore the only sample the
//        refusal has.
//   W44  (in tests/combatCharmOwnership.test.mts) Scooba's Knight and dragoon — the window whose
//        law this build supersedes, and where the byte-identical evidence for YOUR rows lives.
//
// The state-machine half — the shapes no real line in this corpus prints — is at the bottom,
// driven through `AllyCharms` directly and labelled as such.
//
// JOS-270 SPLIT OFF NEXT DOOR (tests/allyPetLifecycle.test.mts): which ENDINGS a bind wears
// depends on what the evidence says the creature is, and the hold now measures silence rather
// than a spell's listed duration. Everything measured here is unchanged by it.
//
// Regenerate the fixtures with `npm run fixtures:combat -- <path to the real log>`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import { AllyCharms } from '../src/main/combat/allyCharms'
import { isPlayerShapedName } from '../src/shared/playerShape'
import type { SourceView } from '../src/shared/combat'

installSpellDb(loadSpellDb())
installCharacterName('Primitive')

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (name: string): string[] => {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const W66 = read('w66-ally-charm-credited-and-broken.log')
const W67 = read('w67-ally-charm-same-named-twin.log')
const W68 = read('w68-ally-charm-multi-caster-tie.log')

/** Replay through the REAL parser + engine, optionally truncated at a wall clock. */
function replay(lines: string[], upTo = Number.POSITIVE_INFINITY): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setLive()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev || ev.ts > upTo) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, lastTs }
}

const zone = (eng: CombatEngine, lastTs: number): { entities: SourceView[]; outTotal: number } => {
  const sel = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' }).selected!
  return { entities: sel.entities, outTotal: sel.outTotal }
}
const allyRows = (eng: CombatEngine, lastTs: number): SourceView[] =>
  zone(eng, lastTs).entities.filter((e) => e.kind === 'allyPet')

// ============================================================================
// W66 — THE CLEAN CASE. Fri Jul 31 20:05:40 → 20:06:35, raw 741548..741690.
//
// Hand-read:
//   20:05:57  Gordon begins casting Cajoling Whispers III.   (DB cast time 5,500 ms)
//   20:05:58  an imp protector has been charmed.             +1s → BIND to Gordon
//   20:05:59→ the imp trades blows with a lava guardian
//   20:06:05  An imp protector slashes a lava guardian for 88 points of damage.   ← still bound
//   20:06:05  An imp protector hits Gordon for 8 points of damage.                ← BREAK
//   20:06:05→ eight seconds of the imp beating on Gordon, credited to NOBODY
//   20:06:12  Gordon begins casting Cajoling Whispers III.
//   20:06:14  an imp protector has been charmed.             → RE-CHARM, crediting resumes
//
// The owner does not swing once in this window. Every number in it belongs to somebody else,
// which is exactly why it is the window: it can only pass if the ally row exists AND is separate.
// ============================================================================

const skip66 = W66.length === 0 && 'fixture not present'

test('W66: an ally charm binds to the caster the log names, and earns its own row', { skip: skip66 }, () => {
  const { eng, lastTs } = replay(W66)
  const z = zone(eng, lastTs)
  assert.deepEqual(eng.petDisplayNames(), [], 'nothing here is a pet of yours')
  assert.deepEqual(eng.allyPetNames(), ['an imp protector'], "…it is Gordon's")

  const ally = z.entities.filter((e) => e.kind === 'allyPet')
  assert.equal(ally.length, 1)
  assert.equal(ally[0].id, 'allypet:gordon:an imp protector')
  assert.equal(ally[0].name, 'Pet (an imp protector) - Gordon')
  assert.equal(ally[0].total, 1_399, "hand-countable: the imp's damage on a lava guardian")
  assert.equal(ally[0].hits, 18)
  assert.equal(ally[0].misses, 25)
  // The row is the WHOLE window: the owner is idle, so there is nothing else to be.
  assert.equal(z.outTotal, 1_399)
  assert.equal(z.entities.filter((e) => e.id === 'you').length, 0, 'you did nothing here')
})

test('W66: the SOFT-HOSTILE PROOF stops the credit at the instant of the break', { skip: skip66 }, () => {
  const at = (clock: string): number => Date.parse(`Fri Jul 31 ${clock} 2026`)

  // 20:06:04 — bound and earning.
  const a = replay(W66, at('20:06:04'))
  assert.deepEqual(a.eng.allyPetNames(), ['an imp protector'])
  assert.equal(allyRows(a.eng, a.lastTs)[0].total, 251)

  // 20:06:05 — the same second holds a slash at the lava guardian AND the first swing at Gordon,
  // in that order. The slash lands (88, taking the row to 339); the bind is over by the end of
  // the second. NOTHING IS RETRO-UNCREDITED — the pet really was charmed when it swung.
  const b = replay(W66, at('20:06:05'))
  assert.deepEqual(b.eng.allyPetNames(), [], "the imp turned on Gordon, so it is nobody's")
  assert.equal(allyRows(b.eng, b.lastTs)[0].total, 339)

  // 20:06:13 — eight seconds later, and not one point has been added. This is the measurement
  // behind the whole design: a broken pet STOPS FIGHTING MOBS and starts hitting its ex-charmer,
  // so the window between the real break and the proof of it is nearly empty by construction.
  const c = replay(W66, at('20:06:13'))
  assert.equal(allyRows(c.eng, c.lastTs)[0].total, 339, 'nothing credited while unbound')
  assert.deepEqual(c.eng.allyPetNames(), [])

  // 20:06:14 — the re-charm restates the bind, on the same row (same charmer, same pet).
  const d = replay(W66, at('20:06:14'))
  assert.deepEqual(d.eng.allyPetNames(), ['an imp protector'])
  assert.equal(allyRows(d.eng, d.lastTs).length, 1, 'one row, not one per charm')
})

test('W66: an ally pet opens no fight of yours, and engages nothing', { skip: skip66 }, () => {
  // The 214-second merged pull (Task #65) said what it costs to let a stranger into your fight.
  // An ally pet is booked like a miss or a resist (world-model law 8): the zone lane always, the
  // in-progress fight only if one is already open, and never a reason for one to exist.
  const { eng, lastTs } = replay(W66)
  const snap = eng.snapshot(lastTs + 120_000, {})
  assert.equal(snap.segments.filter((s) => s.kind === 'fight').length, 0, 'no fight was finalized')
  assert.equal(snap.segments.filter((s) => s.kind === 'current').length, 0, 'and none was opened')
  assert.equal(snap.inCombat, false)
})

// ============================================================================
// W67 — THE SAME-NAMED TWIN. Thu Jul 30 18:27:08 → 18:27:36, raw 508140..508430.
// ============================================================================

const skip67 = W67.length === 0 && 'fixture not present'

test('W67: a same-named twin makes the name unreadable, and the credit is ZERO', { skip: skip67 }, () => {
  const { eng, lastTs } = replay(W67)
  const z = zone(eng, lastTs)
  // The bind is REAL — President's Cajoling Whispers V is one second above the broadcast and the
  // model says so. What it cannot do is read the name's lines: `A rock golem pierces a rock
  // golem` is the very next line and the window never stops printing them.
  assert.equal(z.entities.filter((e) => e.kind === 'allyPet').length, 0, 'no ally row exists')
  assert.deepEqual(eng.petDisplayNames(), [], 'and none of it is yours either')
  assert.equal(
    z.entities.filter((e) => e.kind === 'you' || e.kind === 'pet' || e.kind === 'allyPet').length,
    0,
    'the owner is idle and the twin-ambiguous pet is credited nothing — the point of the window'
  )
  // THE TWO PEOPLE IN IT ARE RECORDED, and that is JOS-430 rather than a hole in this refusal:
  // `President` and `Enzee` swing at rock golems under their own names, so they are combatants the
  // log named. The CHARMED GOLEM still books nothing, and it cannot: its lines read
  // `A rock golem pierces a rock golem`, and a mob-shaped name never passes the record gate at all
  // (src/main/combat/otherCombatants.ts), let alone the twin-ambiguity refusal above it.
  assert.deepEqual(
    z.entities.filter((e) => e.kind === 'other').map((e) => e.name).sort(),
    ['Enzee', 'President']
  )
  assert.ok(!z.entities.some((e) => /golem/i.test(e.name)), 'the unreadable twin has no row of any kind')
})

test("W67: the BARD singing over it is not a competing claim", { skip: skip67 }, () => {
  // `Enzee begins singing Solon's Bewitching Bravura III.` lands in the same second as President's
  // cast. It is a charm (JOS-200) — but its landing sentence is `Someone 's eyes glaze over.`,
  // which is shared with three real mezzes and is NOT the charm broadcast, so it can never be the
  // cast a `has been charmed.` line resolved. If it armed the join, this window would refuse as a
  // two-caster tie instead of binding — and so would every enchanter bind next to a bard.
  //
  // THIS ASSERTION CAUGHT A REAL BUG, which is why it is spelled out: the exclusion table is keyed
  // by spell NAME, spells.json spells the song `Solon's Bravura` and the log prints `Solon's
  // Bewitching Bravura`, so the first cut of the table missed it entirely and this window refused
  // for the wrong reason (charmModel.ts CHARM_SPELLS_WITH_OTHER_CAST_MESSAGE now enters both).
  const { eng, lastTs } = replay(W67)
  const lines = eng.snapshot(lastTs + 120_000, {}).recent.filter((l) => l.cat === 'charm')
  assert.ok(
    lines.some((l) => /charmed by President/.test(l.text)),
    'the broadcast is attributed to the enchanter, not refused as a tie'
  )
  assert.ok(
    lines.some((l) => /second one is active/.test(l.text)),
    'and then the twin makes it unreadable'
  )
})

// ============================================================================
// W68 — THE MULTI-CASTER TIE. Fri Jul 31 21:13:09 → 21:13:20, raw 747240..747300.
// ============================================================================

const skip68 = W68.length === 0 && 'fixture not present'

test('W68: two casters over one broadcast is a REFUSAL, not a coin flip', { skip: skip68 }, () => {
  const { eng, lastTs } = replay(W68)
  assert.deepEqual(eng.allyPetNames(), [], 'nobody is credited')
  const z = zone(eng, lastTs)
  assert.equal(z.entities.filter((e) => e.kind === 'allyPet').length, 0)
  // The CHARM is credited to nobody — which is this window's whole subject — while the two
  // enchanters who tied over it are recorded under their own names (JOS-430). Refusing to say
  // WHOSE the pet is has never meant refusing to see the people; it means refusing to guess.
  assert.ok(!z.entities.some((e) => /golem|imp|elemental/i.test(e.name)), 'no charmed mob is credited')
  const lines = eng.snapshot(lastTs + 120_000, {}).recent.filter((l) => l.cat === 'charm')
  assert.ok(lines.some((l) => /2 casters armed/.test(l.text)), 'the reason is stated')
})

// ============================================================================
// THE STATE MACHINE — the shapes this corpus does not print.
//
// Everything below drives `AllyCharms` directly with constructed inputs. It is STRUCTURAL
// coverage and says so: the owner's log holds no third-party leader say, no ally pet that
// outlives its charm's own duration inside a cut window, and no mob-shaped charmer that reaches
// the model (the parser's caster gate stops those before they arrive).
// ============================================================================

const CAJOLING = 'Cajoling Whispers III'

test('PLAYER SHAPE: a single capitalized word is a person; an article-led phrase is a mob', () => {
  for (const n of ['Scooba', 'Kaldurak', 'Primitive', "T`Kail", "N'Kari"]) {
    assert.ok(isPlayerShapedName(n), `${n} is player-shaped`)
  }
  for (const n of [
    'a fire giant warrior',
    'A fire giant warrior', // EQ capitalizes a sentence-initial article — the trap
    'an elite dragoon',
    'The Hand of Veeshan',
    'Lord Nagafen',
    ''
  ]) {
    assert.ok(!isPlayerShapedName(n), `${n} is not player-shaped`)
  }
})

test('the mob that sings a charm can never become a charmer', () => {
  // `A fire giant warrior begins singing Solon's Bewitching Bravura.` is a real line in a real
  // reporter's log (JOS-200's evidence). Two independent gates refuse it, and this asserts the
  // one inside the model: the name is not player-shaped.
  const m = new AllyCharms()
  m.noteCast({ caster: 'A fire giant warrior', casterKey: 'a fire giant warrior', spell: CAJOLING, ts: 1_000, allowed: true })
  assert.deepEqual(m.broadcast('a rock golem', 'a rock golem', 2_000), { kind: 'none' })
})

test('a caster the engine has been KILLING is never a charmer either', () => {
  // The behavioural half of the gate (EngineState.allyCasterAllowed): shared/playerShape.ts
  // cannot refuse a single-word proper-named MOB, and `everStruck` / `everCharmed` / `everPet`
  // are what catch it — the same three absolute guards notePlayer wears.
  const m = new AllyCharms()
  m.noteCast({ caster: 'Innoruuk', casterKey: 'innoruuk', spell: CAJOLING, ts: 1_000, allowed: false })
  assert.deepEqual(m.broadcast('a rock golem', 'a rock golem', 2_000), { kind: 'none' })
})

test('the bard charm arms nothing, even from a player-shaped caster', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Enzee', casterKey: 'enzee', spell: "Solon's Bewitching Bravura III", ts: 1_000, allowed: true })
  assert.deepEqual(m.broadcast('a rock golem', 'a rock golem', 2_000), { kind: 'none' })
  // …but he IS remembered as a friendly, which is what makes his own charm pet's swing at him
  // readable as the break.
  assert.ok(m.isFriendly('enzee'), 'a player-shaped caster is a person whatever they cast')
})

test('the arm expires with the spell, not with the session', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 1_000, allowed: true })
  // Cajoling Whispers is a 5,500 ms cast + 1,500 ms slack = 7,000 ms of window, so the arm this
  // cast opened closes at 8,000 and a broadcast a half-second later is somebody else's business.
  assert.equal(m.broadcast('an imp protector', 'an imp protector', 7_900).kind, 'bind', 'inside')
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 10_000, allowed: true })
  assert.equal(m.broadcast('a lava guardian', 'a lava guardian', 17_100).kind, 'none', 'too late')
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 20_000, allowed: true })
  assert.equal(m.broadcast('an imp protector', 'an imp protector', 22_000).kind, 'bind', 'inside')
})

test('THE LEADER SAY binds outright, and covers a summoned pet no broadcast can reach', () => {
  // STRUCTURAL COVERAGE, stated as such: the owner's whole log (1,608,483 lines) holds exactly one
  // `says, 'My leader is …'` line and it names HIM. There is no third-party instance in this
  // corpus, so the sentence shape is proven by a real line, the third-party variant is that line
  // with a different name in one capture, and this is where it is exercised. (Until JOS-270 no
  // fixture could ever have carried one either — the pet-leader scrub carve-out was SELF-GATED.)
  const line = `[Thu Jul 30 16:10:11 2026] Kober says, 'My leader is Gonekn.'`
  const ev = parseEvent(line, 0)
  assert.equal(ev?.kind, 'allyPetLeader')

  const m = new AllyCharms()
  const bind = m.bindByLeader({
    petKey: 'kober', pet: 'Kober', owner: 'Gonekn', ownerKey: 'gonekn', ts: 1_000, everCharmed: false
  })
  assert.equal(bind.via, 'leader')
  assert.equal(bind.charmer, 'Gonekn')
  assert.equal(m.creditable('kober')?.charmerKey, 'gonekn')
  assert.ok(m.isFriendly('gonekn'), "the named owner is on their own pet's friendly side")
})

// THE HOLD MOVED (JOS-270). What used to be "a bind cannot outlive its own charm" is now a
// SILENCE window that slides on every line the pet acts on — the fixed clock was wrong about a
// game with AAs and focus effects in it. The reaper, the slide and the two lifecycles are pinned
// in tests/allyPetLifecycle.test.mts.

test('a re-charm by a DIFFERENT caster rebinds; the same caster restates', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 0, allowed: true })
  const first = m.broadcast('an imp protector', 'an imp protector', 1_000)
  assert.equal(first.kind === 'bind' && first.bind.charmerKey, 'gordon')

  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 60_000, allowed: true })
  const same = m.broadcast('an imp protector', 'an imp protector', 61_000)
  assert.equal(same.kind === 'bind' && same.bind.boundTs, 1_000, 'the same bind, re-based')

  m.noteCast({ caster: 'Phatez', casterKey: 'phatez', spell: CAJOLING, ts: 120_000, allowed: true })
  const other = m.broadcast('an imp protector', 'an imp protector', 121_000)
  assert.equal(other.kind === 'bind' && other.bind.charmerKey, 'phatez', 'a new owner')
  assert.equal(other.kind === 'bind' && other.bind.boundTs, 121_000, 'and a new bind')
})

test('AMBIGUITY IS STICKY — a re-charm does not un-see the twin', () => {
  // The twin does not announce its departure, so "it got better" is not something this log can
  // say. Once a name has printed `X hits X` the model refuses that name's mob-vs-mob lines for
  // as long as the same charmer holds it.
  const m = new AllyCharms()
  m.noteCast({ caster: 'President', casterKey: 'president', spell: 'Cajoling Whispers V', ts: 0, allowed: true })
  m.broadcast('a rock golem', 'a rock golem', 1_000)
  assert.ok(m.markAmbiguous('a rock golem'))
  assert.equal(m.creditable('a rock golem'), undefined)
  m.noteCast({ caster: 'President', casterKey: 'president', spell: 'Cajoling Whispers V', ts: 60_000, allowed: true })
  m.broadcast('a rock golem', 'a rock golem', 61_000)
  assert.equal(m.creditable('a rock golem'), undefined, 'still unreadable')
  // A DIFFERENT charmer is a different claim about a different entity, so it starts clean.
  m.noteCast({ caster: 'Enzee', casterKey: 'enzee', spell: 'Cajoling Whispers V', ts: 120_000, allowed: true })
  m.broadcast('a rock golem', 'a rock golem', 121_000)
  assert.equal(m.creditable('a rock golem')?.charmerKey, 'enzee')
})

test('a zone drops every bind and every arm, and keeps the people', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 0, allowed: true })
  m.broadcast('an imp protector', 'an imp protector', 1_000)
  m.zone()
  assert.ok(m.idle, 'charm cannot survive a zone')
  assert.ok(m.isFriendly('gordon'), 'a person does not stop being one because you walked a door')
})

