// ============================================================================
// THE ACHIEVEMENTS → SKY QUEST JOIN (JOS-429), and the ladder it composes on.
// ============================================================================
//
// THE AUDIT IS THE POINT OF THIS FILE. The join is 95 item names on one side and 95 item names on
// the other, and a name is a join key (world-model law 2) — so a re-scrape that renames a reward, a
// client patch that rewords an `Obtain` row, or a correction landing upstream all break it SILENTLY
// unless something counts. `covers every Sky quest` is that count, run against the committed
// fixture and the committed scrape, and it fails the moment either side moves.
//
// It is also why `ACHIEVEMENT_REWARD_ALIASES` states what the SCRAPE says today rather than only
// what the file says: an alias whose `reward` no longer matches any quest has stopped describing
// anything, and the audit says so instead of letting a dead row look like coverage. That is the
// `SkyQuestReward.from` idempotence rule, restated for this table.
//
// THE QUEST DATA IS READ THROUGH THE SAME CORRECTIONS THE APP APPLIES (`renderer/src/data/index.ts`
// composes `renameItemName` and `correctSkyQuestReward` onto the scrape). Testing the raw JSON
// would be testing a dataset no surface ever sees — and would miss the finding that the
// achievements file independently CONFIRMS both overlays.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classUnlockClaims,
  classUnlockGrants,
  parseAchievementsDump,
  type ClassUnlockClaim
} from '../src/shared/outputs/achievements'
import {
  ACHIEVEMENT_REWARD_ALIASES,
  achievementItemsFor,
  achievementVouchedQuests
} from '../src/renderer/src/features/posky/achievementInference'
import { rewardInferredQuests } from '../src/renderer/src/features/posky/rewardInference'
import { withDerivedCompletion } from '../src/renderer/src/features/posky/questCompletion'
import { questKey } from '../src/renderer/src/features/posky/keys'
import { renameItemName } from '../src/shared/itemRenames'
import { correctSkyQuestReward } from '../src/shared/skyQuestRewards'
import {
  DERIVED_EVIDENCE_FLOORS,
  DERIVED_EVIDENCE_RANK,
  derivedCompletion,
  derivedEvidence,
  type DerivedCompletionSource
} from '../src/shared/questTurnIns'
import posky from '../src/renderer/src/data/eqlegends/posky.json'
import type { QuestProgress } from '../src/renderer/src/features/posky/useProgress'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Achievements.txt')
const DUMP = parseAchievementsDump(readFileSync(FIXTURE, 'utf8'))

/**
 * The SYNTHESIZED token-unlock dump (JOS-441) — the owner's real file with ONE class's block
 * rewritten, and nothing else touched: `diff` reports eight lines, all inside `Primary Class Unlock
 * - Enchanter`. Enchanter because report 01M0JHQWS2N75Z4WPZHDSCSYJR named it ("I have bought tokens
 * for enchanter and berserker").
 *
 * IT ENCODES AN ASSUMPTION, NOT A MEASUREMENT, and that is stated here as loudly as in the code it
 * gates: no achievements export from a token user exists to read, so what this file asserts is the
 * SYMMETRY — the token pseudo-row flips to `C` exactly as the confirm pseudo-row is MEASURED to on
 * the owner's Paladin, with the same all-components cascade behind it. Its confirm-half sibling
 * (Paladin, untouched in this same file) is the measured control that rides along in every
 * assertion below. If a real token export ever contradicts it, this fixture is what gets replaced.
 */
const TOKEN_FIXTURE = join(
  import.meta.dirname,
  'fixtures',
  'synthetic-token-unlock-Achievements.txt'
)
const TOKEN_DUMP = parseAchievementsDump(readFileSync(TOKEN_FIXTURE, 'utf8'))

/** A claim the way a genuinely-earned class's row arrives — the shape most of these tests want. */
const earned = (className: string, item: string): ClassUnlockClaim => ({
  className,
  item,
  grant: 'quest'
})

/** The quest set as the RENDERER sees it: the scrape with both correction overlays applied. */
const QUESTS = posky.quests.map((q) => {
  const c = correctSkyQuestReward({
    className: q.className,
    name: q.name,
    reward: q.reward,
    rewardPage: q.rewardPage,
    rewardStats: q.rewardStats
  })
  return {
    className: q.className,
    name: q.name,
    reward: c.reward === undefined ? undefined : renameItemName(c.reward),
    rewardStats: c.rewardStats
  }
})

/** Every `Obtain` row, earned or not — coverage is a claim about all 95, not about the owner's 48. */
const ALL_OBTAIN = DUMP.rows
  .filter(
    (r) =>
      r.category === 'Untapped Potential: Classes' && r.component?.startsWith('Obtain ') === true
  )
  .map((r) =>
    earned(
      r.achievement.replace('Primary Class Unlock - ', ''),
      (r.component ?? '').replace('Obtain ', '').replace(/\.$/, '')
    )
  )

// ---------------------------------------------------------------------------
// THE AUDIT.
// ---------------------------------------------------------------------------

test('the two sides are the same size, class for class', () => {
  assert.equal(ALL_OBTAIN.length, 95, 'Obtain rows in the real dump')
  assert.equal(QUESTS.length, 95, 'Sky quests in the committed scrape')
  const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, '')
  const perClass = (rows: { className: string }[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(fold(r.className), (m.get(fold(r.className)) ?? 0) + 1)
    return m
  }
  assert.deepEqual(
    [...perClass(ALL_OBTAIN)].sort(),
    [...perClass(QUESTS)].sort(),
    'per-class counts agree — the file says Shadowknight, the scrape Shadow Knight'
  )
})

test('every Sky quest is covered by exactly one achievement row', () => {
  // Pretend the whole file is earned: coverage is a fact about the JOIN, not about the owner.
  const vouched = achievementVouchedQuests(QUESTS, ALL_OBTAIN)
  const missing = QUESTS.filter((q) => !vouched.quest.has(questKey(q)))
  assert.deepEqual(
    missing.map((q) => `${q.className} / ${q.name} / ${String(q.reward)}`),
    [],
    'no Sky quest is left without an achievement row'
  )
  assert.equal(vouched.quest.size, 95)
  assert.equal(vouched.classUnlock.size, 0, 'every row here is stamped as earned')
})

test('no achievement row is left without a quest', () => {
  // The other direction: a row that matches nothing is data drift the audit must also catch.
  const claimed = new Set<string>()
  for (const q of QUESTS) {
    if (q.reward === undefined) continue
    for (const item of achievementItemsFor(q.className, q.reward)) {
      claimed.add(`${q.className.toLowerCase().replace(/\s+/g, '')} ${item.toLowerCase()}`)
    }
  }
  const orphans = ALL_OBTAIN.filter(
    (r) => !claimed.has(`${r.className.toLowerCase().replace(/\s+/g, '')} ${r.item.toLowerCase()}`)
  )
  assert.deepEqual(orphans, [])
})

test('the alias table still describes the scrape it was written against', () => {
  // 3 -> 1 on 2026-08-22: the Bard row (wiki fixed its own reward cell) and the Rogue row (wiki
  // retitled the typo'd item page) both retired — the deletions this test's own message
  // prescribes when a rescrape catches up to a row.
  assert.equal(ACHIEVEMENT_REWARD_ALIASES.length, 1, 'one row; 94 of 95 need none')
  for (const a of ACHIEVEMENT_REWARD_ALIASES) {
    const q = QUESTS.find((q) => q.className === a.className && q.name === a.questName)
    assert.ok(q, `${a.questName} is a real quest`)
    assert.equal(
      q?.reward,
      a.reward,
      `${a.questName}: the scrape still says "${a.reward}" — if a re-scrape fixed it, delete this row`
    )
    assert.ok(
      ALL_OBTAIN.some((r) => r.item === a.achievementItem),
      `${a.questName}: the file still says "${a.achievementItem}"`
    )
    assert.match(a.verified, /^\d{4}-\d{2}-\d{2}$/, 'a checked date')
    assert.ok(a.evidence.length > 60, 'an entry with no stated evidence is a guess')
  }
})

test('the achievements file independently confirms both existing overlays', () => {
  // JOS-428 corrected Bard Test of Wind's reward from the wiki's `Fae Amulet` to `Amulet of the
  // Fae` on the strength of a reporter's inventory export; JOS-415 renamed `Scintillating` to
  // `Shimmering Bracer of Protection` on the strength of a wiki redirect. Neither consulted this
  // file, which did not exist yet — and the game agrees with both. Needing NO alias row for either
  // is what proves it, so this asserts the absence.
  assert.ok(ALL_OBTAIN.some((r) => r.item === 'Amulet of the Fae'))
  assert.equal(ALL_OBTAIN.some((r) => r.item === 'Fae Amulet'), false)
  assert.ok(ALL_OBTAIN.some((r) => r.item === 'Shimmering Bracer of Protection'))
  assert.equal(ALL_OBTAIN.some((r) => r.item === 'Scintillating Bracer of Protection'), false)
  for (const name of ['Bard Test of Wind', 'Rogue Test of Stealth']) {
    assert.equal(
      ACHIEVEMENT_REWARD_ALIASES.some((a) => a.questName === name),
      false,
      `${name} needs no alias — the overlay already agrees with the game`
    )
  }
})

// ---------------------------------------------------------------------------
// THE JOIN, on the owner's real dump — the ticket's acceptance criterion.
// ---------------------------------------------------------------------------

test('the owner’s own achievements file marks their completed Sky quests', () => {
  const vouched = achievementVouchedQuests(QUESTS, classUnlockClaims(DUMP))
  // 48 rows read C; four of them are the CONFIRMED Paladin's, and JOS-441 moves those to the rung
  // that does not count. The remaining 44 are the owner's genuinely-earned completions.
  assert.equal(vouched.quest.size, 44, 'the owner’s 48 marked rewards, less the four cascaded ones')
  assert.equal(vouched.classUnlock.size, 4, 'the confirmed Paladin’s whole block')
  assert.ok(vouched.quest.has('Bard::Bard Test of Wind'), 'a quest whose reward needed JOS-428’s fix')
  assert.ok(vouched.quest.has('Ranger::Ranger Test of Defense'), 'Dark Cloak of the Sky')
  assert.equal(
    vouched.quest.has('Berserker::Berserker Test of Fools Errand'),
    false,
    'Cudgel of the Fool is I — not vouched for'
  )
  assert.deepEqual(
    [...vouched.classUnlock].sort(),
    [
      'Paladin::Paladin Test of Compassion',
      'Paladin::Paladin Test of Love',
      'Paladin::Paladin Test of Sacrifice',
      'Paladin::Paladin Test of Spirit'
    ],
    'the blast radius on the owner’s real file, named quest by quest'
  )
})

test('a file with no sky rows changes nothing', () => {
  const other = parseAchievementsDump(
    ['EverQuest: Raids', 'C\tConqueror of Kedge Keep', 'C\t\tPhinigel Autropos'].join('\r\n')
  )
  const none = achievementVouchedQuests(QUESTS, classUnlockClaims(other))
  assert.equal(none.quest.size + none.classUnlock.size, 0)
  const empty = achievementVouchedQuests(QUESTS, [])
  assert.equal(empty.quest.size + empty.classUnlock.size, 0)
  const never = achievementVouchedQuests(QUESTS, undefined)
  assert.equal(never.quest.size + never.classUnlock.size, 0, 'command never run')
})

test('the class is checked, so a reward under the wrong class vouches for nothing', () => {
  const q = QUESTS.find((q) => q.name === 'Ranger Test of Defense')
  assert.ok(q?.reward)
  assert.equal(achievementVouchedQuests(QUESTS, [earned('Wizard', q?.reward ?? '')]).quest.size, 0)
  assert.equal(achievementVouchedQuests(QUESTS, [earned('Ranger', q?.reward ?? '')]).quest.size, 1)
})

test('the class fold spans the game’s spelling and the wiki’s', () => {
  const sk = QUESTS.find((q) => q.className === 'Shadow Knight')
  assert.ok(sk?.reward, 'the scrape spells it with a space')
  // The FILE spells it Shadowknight, and that is the spelling stored in `achievementUnlocks`.
  const vouched = achievementVouchedQuests(QUESTS, [earned('Shadowknight', sk?.reward ?? '')])
  assert.equal(vouched.quest.size, 1)
  assert.ok(vouched.quest.has(questKey(sk as { className: string; name: string })))
})

test('the item fold is case and whitespace only — apostrophes are load-bearing', () => {
  const q = QUESTS.find((q) => q.reward === "Al`Kabor's Cap of Binding")
  assert.ok(q, 'the backtick-and-apostrophe reward is in the data')
  assert.equal(
    achievementVouchedQuests(QUESTS, [earned('Wizard', "al`kabor's cap of binding")]).quest.size,
    1,
    'case folds'
  )
  assert.equal(
    achievementVouchedQuests(QUESTS, [earned('Wizard', 'AlKabors Cap of Binding')]).quest.size,
    0,
    'punctuation does NOT fold — a looser fold is a guess bought for nothing'
  )
})

// ---------------------------------------------------------------------------
// THE DISCRIMINATION (JOS-441) — a class-unlock-driven C versus a genuinely-earned one.
// ---------------------------------------------------------------------------

test('the owner’s real file: exactly one class is bypass-flagged, and it is the confirmed one', () => {
  const grants = classUnlockGrants(DUMP)
  assert.equal(grants.size, 16, 'sixteen class-unlock achievements')
  assert.equal(grants.get('Paladin'), 'confirm', 'the autocomplete pseudo-row reads C')
  assert.deepEqual(
    [...grants].filter(([, g]) => g !== 'quest').map(([c]) => c),
    ['Paladin'],
    'and nothing else in the file carries either flag'
  )
})

test('the cascade is visible in the file: the flagged class is the only unanimous one', () => {
  // THE CHARACTERIZATION THE TICKET ASKED FOR, as an assertion rather than a note. A granted unlock
  // cascades C into every component; an earned one cannot be unanimous unless the class is finished.
  // The owner's Paladin is 4/4 while every other class sits between 1/6 and 5/7 — so the flag and
  // the cascade appear together, on the one class where a grant is known to have happened.
  const perClass = new Map<string, { c: number; total: number }>()
  for (const r of DUMP.rows) {
    if (r.category !== 'Untapped Potential: Classes') continue
    if (r.component?.startsWith('Obtain ') !== true) continue
    const cls = r.achievement.replace('Primary Class Unlock - ', '')
    const seen = perClass.get(cls) ?? { c: 0, total: 0 }
    perClass.set(cls, { c: seen.c + (r.status === 'complete' ? 1 : 0), total: seen.total + 1 })
  }
  const unanimous = [...perClass].filter(([, v]) => v.c === v.total).map(([c]) => c)
  assert.deepEqual(unanimous, ['Paladin'], 'only the confirmed class is complete on every component')
  const paladin = perClass.get('Paladin')
  assert.deepEqual(paladin, { c: 4, total: 4 })
})

test('a confirmed class’s rows are stamped, stored and joined as class-unlock evidence', () => {
  const claims = classUnlockClaims(DUMP)
  assert.equal(claims.length, 48, 'nothing is filtered away — the evidence is kept, not dropped')
  const paladin = claims.filter((c) => c.className === 'Paladin')
  assert.equal(paladin.length, 4)
  assert.deepEqual([...new Set(paladin.map((c) => c.grant))], ['confirm'])
  assert.deepEqual(
    [...new Set(claims.filter((c) => c.className !== 'Paladin').map((c) => c.grant))],
    ['quest'],
    'and every other class’s rows keep speaking for their quests'
  )
})

test('the ASSUMED token half: a tokened class marks no quests, honest classes keep theirs', () => {
  // The acceptance criterion, against the synthesized fixture whose header states exactly what is
  // assumed. Enchanter is the tokened class; Paladin rides along as the MEASURED confirm control.
  const grants = classUnlockGrants(TOKEN_DUMP)
  assert.equal(grants.get('Enchanter'), 'token', 'the token pseudo-row reads C')
  assert.equal(grants.get('Paladin'), 'confirm', 'the measured half is untouched by the synthesis')
  const vouched = achievementVouchedQuests(QUESTS, classUnlockClaims(TOKEN_DUMP))
  assert.equal(
    [...vouched.quest].filter((k) => k.startsWith('Enchanter::')).length,
    0,
    'NO quest of the tokened class is marked complete'
  )
  assert.equal(
    [...vouched.classUnlock].filter((k) => k.startsWith('Enchanter::')).length,
    6,
    'all six are tracked, under the kind they actually are'
  )
  // The three Enchanter rows the owner's real file already had as C are among those six, so the
  // honest-classes claim is about the OTHER fifteen classes — which are byte-identical here.
  const real = achievementVouchedQuests(QUESTS, classUnlockClaims(DUMP))
  assert.deepEqual(
    [...vouched.quest].sort(),
    [...real.quest].filter((k) => !k.startsWith('Enchanter::')).sort(),
    'every class the token did not touch keeps exactly the completions it had'
  )
})

test('a claim with no grant is dropped — the v1.7.0 store cannot say which kind it is', () => {
  const legacy = [{ className: 'Ranger', item: 'Dark Cloak of the Sky' }] as ClassUnlockClaim[]
  const vouched = achievementVouchedQuests(QUESTS, legacy)
  assert.equal(vouched.quest.size, 0, 'not believed as per-quest evidence')
  assert.equal(vouched.classUnlock.size, 0, 'and not invented as the other kind either')
})

// ---------------------------------------------------------------------------
// THE LADDER — which source speaks, and what the row is labelled.
// ---------------------------------------------------------------------------

const row = (over: Partial<QuestProgress> = {}): QuestProgress => ({
  key: 'Bard::Bard Test of Wind',
  className: 'Bard',
  name: 'Bard Test of Wind',
  items: [],
  haveCount: 0,
  needCount: 0,
  ratio: 0,
  missing: [],
  turnIns: 0,
  logTurnIns: 0,
  completed: false,
  ...over
})

const sources = (a: string[], r: string[], u: string[] = []): DerivedCompletionSource[] => [
  { evidence: 'achievement', vouched: new Set(a) },
  { evidence: 'reward', vouched: new Set(r) },
  { evidence: 'class-unlock', vouched: new Set(u) }
]

test('the ladder ranks the server’s answer above the inference from possession', () => {
  assert.deepEqual([...DERIVED_EVIDENCE_RANK], ['achievement', 'reward', 'class-unlock'])
  const both = sources(['q'], ['q'])
  assert.equal(derivedCompletion('q', both), 'achievement')
  // …and the array's ORDER must not decide it.
  assert.equal(derivedCompletion('q', [...both].reverse()), 'achievement')
  assert.equal(derivedCompletion('q', sources([], ['q'])), 'reward')
  assert.equal(derivedCompletion('q', sources([], [])), null)
})

test('class-unlock is a rung that speaks and never floors', () => {
  assert.deepEqual(DERIVED_EVIDENCE_FLOORS, {
    achievement: true,
    reward: true,
    'class-unlock': false
  })
  // It SPEAKS…
  assert.equal(derivedEvidence('q', sources([], [], ['q'])), 'class-unlock')
  // …and it does not count.
  assert.equal(derivedCompletion('q', sources([], [], ['q'])), null)
  // A stronger rung on the same quest is the one named, whichever order they arrive in.
  assert.equal(derivedEvidence('q', sources([], ['q'], ['q'])), 'reward')
  assert.equal(derivedEvidence('q', [...sources([], ['q'], ['q'])].reverse()), 'reward')
  assert.equal(derivedCompletion('q', sources([], ['q'], ['q'])), 'reward')
})

test('a class-unlock row is labelled without being completed — the defect, as a test', () => {
  // 01M0J9RHV7Y5F80E9NPSYVXM7Y in one assertion: the token user's Sky quest reads NOT turned in,
  // and still says out loud what their achievements export claims about it.
  const q = withDerivedCompletion(row(), sources([], [], ['Bard::Bard Test of Wind']))
  assert.equal(q.turnIns, 0, 'no forged turn-in')
  assert.equal(q.completed, false)
  assert.equal(q.completionEvidence, 'class-unlock', 'tracked and labelled as what it is')
})

test('a hand-recorded turn-in still wins over a class-unlock row', () => {
  // The reporter could not REMOVE a completion; with the floor gone there is nothing to remove, and
  // adding one by hand is the honest way to say "I did run this" — the ledger wins outright, so the
  // row loses the derived label entirely.
  const q = withDerivedCompletion(
    row({ turnIns: 1, completed: true }),
    sources([], [], ['Bard::Bard Test of Wind'])
  )
  assert.equal(q.turnIns, 1)
  assert.equal(q.completionEvidence, undefined)
})

test('a derived floor is one turn-in, completed, and says which source', () => {
  const q = withDerivedCompletion(row(), sources(['Bard::Bard Test of Wind'], []))
  assert.equal(q.turnIns, 1)
  assert.equal(q.completed, true)
  assert.equal(q.completionEvidence, 'achievement')
  assert.equal(q.logTurnIns, 0, 'the log’s share is a fact about the log')
})

test('two sources vouching for one quest are two witnesses, not two turn-ins', () => {
  const q = withDerivedCompletion(row(), sources(['Bard::Bard Test of Wind'], ['Bard::Bard Test of Wind']))
  assert.equal(q.turnIns, 1, 'they do not add')
  assert.equal(q.completionEvidence, 'achievement', 'the stronger one is named')
})

test('any ledger evidence wins outright — count AND label', () => {
  const q = withDerivedCompletion(row({ turnIns: 3, logTurnIns: 3, completed: true }), sources(['Bard::Bard Test of Wind'], []))
  assert.equal(q.turnIns, 3, 'a derived floor can only say "at least once"')
  assert.equal(q.completionEvidence, undefined, 'so it does not label a ledger row')
})

test('a quest no source vouches for is returned untouched, by identity', () => {
  const before = row()
  assert.equal(withDerivedCompletion(before, sources([], [])), before)
  assert.equal(withDerivedCompletion(before, []), before)
})

test('the two derived sources compose on the real data', () => {
  // The reward inference alone vouches for what the export holds; the achievements dump alone
  // vouches for 48. Composed, the achievement label wins wherever both speak — which is exactly
  // the ordering the ticket asked for.
  const achievement = achievementVouchedQuests(QUESTS, classUnlockClaims(DUMP))
  const reward = rewardInferredQuests(QUESTS, { 'dark cloak of the sky': 1 })
  assert.equal(reward.size, 1, 'the export holds one reward')
  const key = [...reward][0]
  assert.ok(achievement.quest.has(key), 'and the achievements dump marks that quest too')
  const both: DerivedCompletionSource[] = [
    { evidence: 'achievement', vouched: achievement.quest },
    { evidence: 'reward', vouched: reward }
  ]
  assert.equal(withDerivedCompletion(row({ key }), both).completionEvidence, 'achievement')
  // A quest ONLY the export can speak for still reads 'reward'.
  const rewardOnly: DerivedCompletionSource[] = [
    { evidence: 'achievement', vouched: new Set<string>() },
    { evidence: 'reward', vouched: reward }
  ]
  assert.equal(withDerivedCompletion(row({ key }), rewardOnly).completionEvidence, 'reward')
})

test('the reward inference still speaks for a cascaded quest whose reward is in the bag', () => {
  // THE OTHER HALF OF THE BLAST RADIUS. Withdrawing the four Paladin rows does not withdraw every
  // witness to them: all four rewards are NO DROP, so any of them sitting in the inventory export
  // floors its quest on the JOS-428 rung, which stays believable because it reasons from an item
  // that cannot move rather than from an achievement the game granted.
  const vouched = achievementVouchedQuests(QUESTS, classUnlockClaims(DUMP))
  const key = 'Paladin::Paladin Test of Love'
  assert.ok(vouched.classUnlock.has(key), 'the achievements row alone would not count it')
  const reward = rewardInferredQuests(QUESTS, { 'thelvorn, blade of light': 1 })
  assert.ok(reward.has(key), 'but holding Thelvorn does')
  const q = withDerivedCompletion(row({ key }), [
    { evidence: 'achievement', vouched: vouched.quest },
    { evidence: 'reward', vouched: reward },
    { evidence: 'class-unlock', vouched: vouched.classUnlock }
  ])
  assert.equal(q.turnIns, 1)
  assert.equal(q.completionEvidence, 'reward', 'and the row is labelled with the witness that spoke')
})
