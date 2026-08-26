// THE FOLD: log events in, pooled observations out (JOS-382).
//
// No Electron. `tests/resistFold.test.mts` drives it over committed fixtures cut from the owner's
// log, and `scripts/gen-resist-baseline.ts` drives the same class to mine the shipped baseline —
// one implementation, so what ships and what a user's own log produces cannot drift.
//
// ── IT NEVER READS THE CLIENT'S SPELL TABLE, AND THAT IS A DESIGN DECISION ───────────────────────
//
// `spells_us.txt` knows a spell's resist axis, its resist adjust and its level caps. This fold
// knows none of them, on purpose: everything it writes is something the LOG printed, so the ledger
// is meaningful without a file we are not allowed to redistribute, a shipped baseline is a
// table-independent artifact, and a game patch that retunes a spell costs a re-ESTIMATE rather
// than a re-fold of every log the user has ever tailed. Two exclusions the brief asks for
// therefore live in the estimator instead, which is where the facts are: rows for spells with no
// resist axis, and resists of a spell whose hard level cap the mob is above. The observable result
// is identical (neither reaches a number); the cost is a slightly larger baseline file, and the
// gain is that the fold has no dependency that can be missing.
//
// The two things it DOES consult are both already in this repo: the committed mob catalog (for a
// mob's level when `/con` has not stated one) and the wiki spell catalog (to recognise a resist
// debuff by its verbatim effect line).
//
// ── HOW EACH OUTCOME IS EARNED ──────────────────────────────────────────────────────────────────
//
//   RESIST   `<mob> resisted your <Spell>!` — the game saying it flatly. Incoming resists
//            (`You resist <mob>'s <Spell>!`) are YOURS and out of scope entirely.
//   DAMAGE   `X hit <mob> for N points of <type> damage by <Spell>.` — the number goes into the
//            row's histogram, from which the estimator later derives full-versus-partial. A
//            CRITICAL is counted as a landing and kept OUT of the histogram: its number is not the
//            spell's full damage, and letting it in would invent a second "full" value.
//   LAND     the first tick of a DoT after its cast, and a cast-on-other emote joined back to your
//            own `You begin casting` — but never both for one spell on one mob, because a spell
//            that both emotes and prints damage produced ONE roll. The emote's landing is
//            therefore DEFERRED and cancelled by any damage line that follows it for the same mob
//            and spell, which is the log-only way of saying what the brief says with the client
//            table ("all-or-nothing spells only").
//   SONG     A SONG IS DECIDED BY SPELL IDENTITY, NEVER BY A BEGIN LINE (songIdentity.ts states
//            why at length: EQ Legends bards run under the Symphonic Aura, which re-pulses every
//            six seconds and prints no cast line, so the owner's two-million-line log carries five
//            `You begin singing` lines against 4,152 pulses of one song's landing emote). A spell
//            only the Bard can learn is a song, and a song is NEVER filed as a cast.
//
//            For a song whose landing sentence the catalog knows, the denominator is EXACT and
//            needs no reconstruction at all: every pulse that lands prints the sentence, every
//            pulse that does not prints a resist, so attempts = lands + resists per (song, mob).
//            The pulse machinery in songs.ts is reserved for songs with NO usable landing
//            sentence, where the only witnesses are resist lines, DoT ticks and the aura's own
//            heartbeat.
//
// ── ANOTHER PLAYER'S CASTS ARE RECORDED, AND NEVER ESTIMATED FROM ───────────────────────────────
//
// The owner's ruling admits `self` and `pc` casters. A stranger's damage lines and resists both
// print, so both are filed — but nothing in this app's inputs states another player's LEVEL (the
// parser reads a `/who` row only for the tailed character), and without a level there is no
// `levelMod` and therefore no rc. Those rows are evidence a drilldown can show and the estimator
// deliberately drops (`droppedNoLevel`). Filing them costs a little of the baseline's size and
// buys the per-spell evidence for spells the tailed character does not cast.
//
// ── AND SO ARE NPC CASTERS, WITH A LEVEL THIS TIME (JOS-385) ────────────────────────────────────
//
// Charmed pets and ordinary NPC casters are the third kind. Two things make them different from a
// stranger's casts, and both are why the owner asked for them:
//
//   THEIR LEVEL IS KNOWN. The committed catalog states it (a range folds to its midpoint) and a
//   `/con` of that mob this session beats it — the same ladder the TARGET's level already climbs.
//   So an npc row usually carries both levels and therefore an rc, which a `pc` row never can.
//   Where nothing states one it is null and the estimator drops the row, no special case.
//
//   THEIR SPELLS ARE ORDINARY ROWS in the client's table. `Lava Breath`, `Choking` and
//   `Dry Bone Fire Burst` sit in `spells_us.txt` with a resist type and a resist adjust like any
//   other spell, so the estimate joins them exactly as it joins yours. Nothing here reads that
//   file — see the block at the top — the join happens once, at estimate time.
//
// WHAT THEY DO **NOT** GET, deliberately: an armed cast. `onOtherCast` still arms `pc` casts only,
// so an npc's emote-only landing is never claimed. Two reasons, and the first is enough: the log
// carries 45k third-party cast-begins against 25k of yours, and arming all of them would put the
// fold's join window in contention on every landing sentence YOU earned. The second is that an
// npc's all-or-nothing spell then shows resists with no landings, which the estimator's own
// blindness guard already recognises and holds out of the number (`landingsNotObservable`) rather
// than reading as a 100%-resistant mob.
//
// ── A ROW'S TARGET HAS TO BE A CREATURE ─────────────────────────────────────────────────────────
//
// `isMobTarget` (world.ts, which carries the argument) gates EVERY filing — the resist arm, the
// damage arm, the emote arm and the song sink. It is new here (JOS-385) even though it fixes
// something older: R is a statement about a creature, and while only players could cast, nothing
// ever checked that the thing being cast ON was one. The shipped JOS-382 baseline shows the cost —
// rows keyed `you` (Cannibalization damages its own caster), rows keyed on groupmates (a Superior
// Healing landing, and Jonthan's Provocation pulsing on five of them), ~2,700 observations under 56
// keys that are people's names, in a file this repo publishes. NPC casters would have made it a
// flood, because mobs cast on the player's group constantly.

import { idKey, spellCanonKey, spellRank } from '../../shared/spellKey'
import { ArmedCasts, CastState } from './castState'
import type { LogEvent } from '../../shared/logEvents'
import type { SpellDb } from '../data/spellDb'
import type { ResistCasterKind, ResistFamily, ResistRow } from '../../shared/resistTypes'
import { isoWeekKey } from '../../shared/resistDecay'
import { ResistBucket, type RowSpec } from './ledger'
import { SongFold } from './songFold'
import {
  CasterIndex,
  DebuffWindows,
  MeleeContact,
  MobLevels,
  MobNames,
  isMobTarget,
  isResistDebuff,
  type MobLevelFact,
} from './world'

/** How long a deferred emote-landing waits to see whether a damage line cancels it. */
export const LAND_DEFER_MS = 3_000

/**
 * The separator inside every composite key this module builds. A PRINTABLE byte, deliberately:
 * AGENTS.md's rule about raw control bytes in source exists because one makes git classify the
 * file as binary and blame, diff and grep go dark. No EQ mob or spell name has ever contained a
 * pipe, so it costs nothing.
 */
const SEP = '|'

const pairKey = (mob: string, spell: string): string => mob + SEP + spell

/**
 * Is this name the player? The parser's `norm` produces exactly `You` for every spelling the log
 * uses, so the identity compare answers almost every call and `idKey` (a trim plus a lower-case)
 * is the fallback for the shapes that reach here unnormalised. Worth spelling out because this
 * runs on every melee swing in a two-million-line replay.
 */
const isSelf = (name: string): boolean => name === 'You' || idKey(name) === 'you'

/** One thing the log said, as this fold names it before the bucket pools it. */
interface Observation {
  /** The mob's name as the line spelled it; the key is folded from it (world-model law 2). */
  mob: string
  spellKey: string
  family: ResistFamily
  kind: ResistCasterKind
  /** The CASTER's level, or null when nothing has stated it. */
  level: number | null
  ts: number
  /** The spell upgrade rank this observation was made at. -15 of resist adjust each (JOS-387). */
  rank: number
  /** Whether the overchannel invocation was up. See `ResistRow.overchannel` for the three states. */
  overchannel: boolean | null
}

/**
 * A LANDING WAITING TO SEE WHETHER A DAMAGE LINE CANCELS IT — which is an `Observation` and nothing
 * else, held for `LAND_DEFER_MS` before it is filed. Spelled as the same shape rather than as a
 * near-copy of it: the two lists had drifted apart once already (the rank and the invocation had to
 * be added to both by JOS-387), and a deferred filing that could carry a different set of facts
 * from an immediate one is a bug with nowhere to be caught. `family` is always `cast`: a song pulse
 * is never deferred, because its sentence IS the landing.
 */
type Deferred = Omit<Observation, 'family'>

export interface ResistFoldDeps {
  spellDb?: SpellDb
}

export class ResistFold {
  private bucket = new ResistBucket()
  private readonly levels = new MobLevels()
  private readonly casters = new CasterIndex()
  private readonly debuffs = new DebuffWindows()
  private readonly contact = new MeleeContact()
  private readonly songs: SongFold
  private zone: string | undefined
  private selfLevel: number | null = null
  /** The rank and invocation a self cast is filed under, and the rules for both: castState.ts. */
  private readonly cast = new CastState()
  private readonly casts = new ArmedCasts()
  private dotSeen = new Set<string>()
  private deferred: Deferred | null = null
  /** Mob names both ways, memoised. The measurement behind the memo is in world.ts. */
  private readonly names = new MobNames()

  constructor(private readonly deps: ResistFoldDeps = {}) {
    this.songs = new SongFold(deps.spellDb, {
      land: (mob, key, ts) => {
        const row = this.fileSong(mob, key, ts)
        if (row) row.land += 1
      },
      resist: (mob, key, ts) => {
        const row = this.fileSong(mob, key, ts)
        if (row) row.resist += 1
      },
      keyOf: (display) => this.names.key(display),
      displayFor: (key) => this.names.displayFor(key),
      contactsAt: (ts, windowMs) => this.contact.within(ts, windowMs),
      // Read live rather than captured: the level moves mid-session and the song half asks about
      // it per emote, which is the only reason it is a function.
      casterLevel: () => this.selfLevel,
    })
  }

  /**
   * Start folding a source. Pass the ledger's own freshly-discarded bucket so the fold writes
   * straight into it (JOS-231: the DISCARD is what makes a re-fold idempotent, and it belongs to
   * whoever owns the ledger). With no argument the fold owns a private bucket, which is what the
   * baseline generator and the unit tests want.
   */
  beginSource(bucket?: ResistBucket): ResistBucket {
    this.bucket = bucket ?? new ResistBucket()
    this.resetSession()
    return this.bucket
  }

  /** The mob's level as the fold currently knows it: a `/con` this session, else the catalog. */
  levelOf(key: string, display: string): MobLevelFact | null {
    return this.levels.levelOf(key, display)
  }

  rows(): ResistRow[] {
    return this.bucket.rows()
  }

  /**
   * Everything buffered is now decided, and the runs it belonged to end here. MUST be called
   * before reading the rows.
   */
  finish(): void {
    this.flushDeferred(Number.POSITIVE_INFINITY)
    this.songs.flush()
  }

  /**
   * The live tail's heartbeat: decide anything the passage of time has settled, and leave open
   * what is genuinely still open. Unlike `finish()` this does NOT end a song's run — a bard
   * mid-rotation would forfeit every interpolated pulse across the next gap.
   */
  settle(now: number): void {
    this.flushDeferred(now)
    this.songs.settle(now)
  }

  private resetSession(): void {
    this.levels.reset()
    this.casters.reset()
    this.debuffs.reset()
    this.contact.reset()
    this.songs.reset()
    this.zone = undefined
    this.selfLevel = null
    this.cast.reset()
    this.casts.reset()
    this.dotSeen = new Set()
    this.deferred = null
    this.names.reset()
  }

  onEvent(ev: LogEvent): void {
    this.flushDeferred(ev.ts)
    // TWO CASCADES, along the seam the module already has: lines that move the WORLD (where you
    // are, what level you are, which mob is which, which casts are in flight) and lines that ARE
    // an outcome. Split because one switch over both was a single method with more branches than
    // the factoring rules allow, and because the two halves are read for different reasons.
    if (this.onWorldEvent(ev)) return
    this.onOutcomeEvent(ev)
  }

  /** State the outcomes are interpreted against. Returns true when the event was one of these. */
  private onWorldEvent(ev: LogEvent): boolean {
    switch (ev.kind) {
      case 'zone':
        this.onZone(ev.zone)
        return true
      case 'level':
        this.selfLevel = ev.level
        return true
      case 'selfWho':
        this.selfLevel ??= ev.level
        // The ONE line in the game that states the loadout, and therefore the only thing that can
        // answer "how many non-hybrid caster classes" for the overchannel adjust.
        this.cast.noteClasses(ev.classes)
        return true
      case 'invocationChange':
        this.cast.noteInvocation(ev.invocation)
        return true
      case 'consider':
        this.onConsider(ev.mob, ev.level)
        return true
      case 'death':
        this.onDeath(ev.name)
        return true
      case 'petClaim':
      case 'petSay':
        this.casters.notePet(ev.name)
        return true
      case 'allyPetLeader':
        this.casters.notePet(ev.pet)
        return true
      default:
        return this.onCastLifecycle(ev)
    }
  }

  /**
   * The cast lifecycle: what is in flight, and what stopped being in flight. A fizzle or an
   * interrupt disarms rather than files anything — a cast that never happened is not a resist.
   */
  private onCastLifecycle(ev: LogEvent): boolean {
    switch (ev.kind) {
      case 'castBegin':
        this.onCastBegin(ev.spell, ev.ts, ev.sung === true)
        return true
      case 'otherCastBegin':
        this.onOtherCast(ev.caster, ev.spell, ev.ts)
        return true
      case 'castFizzle':
      case 'castInterrupted':
        this.casts.disarm(spellCanonKey(ev.spell))
        return true
      default:
        return false
    }
  }

  /** The lines that state what happened to a spell. */
  private onOutcomeEvent(ev: LogEvent): void {
    switch (ev.kind) {
      case 'resist':
        this.onResist(ev)
        return
      case 'damage':
        this.onDamage(ev)
        return
      case 'miss':
        this.onMelee(ev.attacker, ev.target, ev.ts)
        return
      case 'buffApply':
        if (ev.target === 'self') this.songs.onSelfLanding(ev.ts, ev.candidates.map((c) => c.name))
        else this.onEmote(ev.target, ev.ts, ev.candidates.map((c) => c.name))
        return
      case 'cc':
      case 'charm':
        this.onEmote(ev.mob, ev.ts, ev.candidates?.map((c) => c.name))
        return
      default:
        return
    }
  }

  private onConsider(mob: string, level: number | undefined): void {
    this.names.remember(mob)
    if (level !== undefined) this.levels.note(this.names.key(mob), level)
  }

  // ---- world housekeeping ---------------------------------------------------------------

  private onZone(zone: string): void {
    this.flushDeferred(Number.POSITIVE_INFINITY)
    this.songs.flush()
    this.zone = zone
    this.debuffs.reset()
    this.contact.reset()
    this.casts.reset()
  }

  private onDeath(name: string): void {
    const key = this.names.key(name)
    this.debuffs.clearMob(key)
    // A dead mob stops being a song target immediately (rule 3: alive AND in contact). The song
    // itself keeps running, so nothing here touches the pulse reconstruction.
    this.contact.drop(key)
  }

  /**
   * Melee proximity, which exists for ONE reader: song rule 3, which needs to know who was in
   * range when a pulse fired. So it is not tracked until a `You begin singing` line has been seen
   * — MEASURED, because this is the busiest arm in the whole fold (two swings a second for hours)
   * and the owner's two-million-line log contains five sing lines. The priced cost is the contact
   * from the six seconds before the very first sing line of a session, which can only UNDER-count
   * a song's attempts: the safe direction, and the one rule 3 already errs in.
   */
  private onMelee(attacker: string, target: string, ts: number): void {
    if (!this.songs.active) return
    if (isSelf(attacker)) {
      this.noteContact(target, ts)
      return
    }
    if (isSelf(target)) this.noteContact(attacker, ts)
  }

  private noteContact(mob: string, ts: number): void {
    this.contact.note(this.names.key(mob), ts)
    this.names.remember(mob)
  }

  // ---- casts ---------------------------------------------------------------------------

  /**
   * The row one song pulse belongs to, or null when the pulse landed on a PERSON. Songs are never
   * filed as an ordinary cast, and NPC casters are never filed as a song: `SongFold` recognises a
   * song by spell identity and hands back anything that is not the tailed character's, so `kind`
   * here is always `self` by construction.
   *
   * The target test is not decoration on this arm — it is the arm it matters most on. A bard's
   * group songs pulse on GROUPMATES and print a landing sentence naming each of them, so the
   * JOS-382 baseline carries `jonthan's provocation` filed against five people's names.
   */
  private fileSong(mobDisplay: string, songKey: string, ts: number): ResistRow | null {
    if (!isMobTarget(mobDisplay)) return null
    this.names.remember(mobDisplay)
    return this.rowFor({
      mob: mobDisplay,
      spellKey: songKey,
      family: 'song',
      kind: 'self',
      level: this.selfLevel,
      ts,
      rank: this.cast.songRank(songKey),
      // A SONG IS NOT A CAST SPELL, so the wiki's -150 does not reach it (JOS-387). If the owner's
      // log ever shows a song's resist rate moving with the invocation state, that is a finding to
      // report, not a term to model.
      overchannel: false,
    })
  }

  private onCastBegin(spell: string, ts: number, sung: boolean): void {
    const key = spellCanonKey(spell)
    const rank = spellRank(spell)
    if (sung) this.songs.noteSung(key, ts)
    this.cast.noteSongRank(key, rank)
    // A fresh cast re-arms the "first tick counts as a landing" memory for this spell.
    for (const seen of [...this.dotSeen]) {
      if (seen.endsWith(SEP + key)) this.dotSeen.delete(seen)
    }
    this.casts.arm({
      spellKey: key,
      display: spell,
      ts,
      kind: 'self',
      level: this.selfLevel,
      rank,
      overchannel: this.cast.overchannel,
      damaged: new Set(),
    })
  }

  private onOtherCast(caster: string, spell: string, ts: number): void {
    if (this.casters.kindOf(caster) !== 'pc') return
    this.casts.arm({
      spellKey: spellCanonKey(spell),
      display: spell,
      ts,
      kind: 'pc',
      level: null,
      rank: spellRank(spell),
      // Nothing states a stranger's invocation, ever. Unknowable, and never assumed.
      overchannel: null,
      damaged: new Set(),
    })
  }

  private onEmote(mobDisplay: string, ts: number, candidates: string[] | undefined): void {
    // A SONG PULSE NEEDS NO ARMED CAST, and that is the whole point: under the Symphonic Aura
    // there is no cast line to arm. The sentence itself is the landing.
    if (this.songs.onEmote(mobDisplay, ts, candidates)) return
    const cast = this.casts.take(ts, candidates)
    if (!cast) return
    // A buff you landed on a GROUPMATE prints the same sentence shape as a debuff on a mob, and
    // filed as a row it becomes a person's name in the ledger. See the header's target block.
    if (!isMobTarget(mobDisplay)) return
    this.names.remember(mobDisplay)
    const key = this.names.key(mobDisplay)
    if (isResistDebuff(this.deps.spellDb, cast.display)) this.debuffs.open(key, cast.spellKey, ts)
    // ONE CAST IS ONE ROLL. If this cast already printed damage on this mob, the damage line IS
    // the observation and the emote is the same roll saying so twice (see Armed.damaged).
    if (cast.damaged.has(key)) return
    // DEFERRED: a damage line for the same mob and spell cancels it (see the header).
    this.flushDeferred(Number.POSITIVE_INFINITY)
    this.deferred = {
      mob: mobDisplay,
      spellKey: cast.spellKey,
      ts,
      kind: cast.kind,
      level: cast.level,
      rank: cast.rank,
      overchannel: this.cast.invocationFor(cast.kind, cast),
    }
  }

  private flushDeferred(now: number): void {
    const d = this.deferred
    if (!d || now - d.ts <= LAND_DEFER_MS) return
    this.deferred = null
    // Only YOUR emote-landings are attributable. A stranger's sentence names no caster, and an
    // npc's cast is never armed in the first place (see the header).
    if (d.kind !== 'self') return
    this.rowFor({ ...d, family: 'cast' }).land += 1
  }

  private cancelDeferred(mobDisplay: string, spellKey: string): void {
    const d = this.deferred
    if (!d) return
    if (d.spellKey === spellKey && this.names.key(d.mob) === this.names.key(mobDisplay)) this.deferred = null
  }

  // ---- outcomes ------------------------------------------------------------------------

  private onResist(ev: Extract<LogEvent, { kind: 'resist' }>): void {
    // `You resist <mob>'s <Spell>!` is YOUR resist and a different feature entirely.
    if (ev.incoming) return
    if (!isMobTarget(ev.target)) return
    const kind = this.casters.kindOf(ev.caster)
    const spellKey = spellCanonKey(ev.spell)
    // The resist line is the one outcome line that PRINTS the rank (719 of the owner's 3,304 do),
    // so it beats the armed cast rather than falling back to it.
    const lineRank = spellRank(ev.spell)
    if (kind === 'self') this.cast.noteSongRank(spellKey, lineRank)
    this.names.remember(ev.target)
    if (this.songs.onResist(ev.target, spellKey, kind, ev.ts)) return
    const level = this.casterLevel(kind, ev.caster)
    const cast = this.casts.ownedBy(kind, spellKey, ev.ts)
    this.rowFor({
      mob: ev.target,
      spellKey,
      family: 'cast',
      kind,
      level,
      ts: ev.ts,
      rank: lineRank > 0 ? lineRank : (cast?.rank ?? 0),
      overchannel: this.cast.invocationFor(kind, cast),
    }).resist += 1
  }

  /**
   * The CASTER's level, by kind. Self is the session level; another player's is never stated
   * anywhere this app reads; an NPC's is the same catalog-or-`/con` ladder the target's level
   * climbs (JOS-385). Null is a first-class answer and simply drops the row from the fit.
   */
  private casterLevel(kind: ResistCasterKind, caster: string): number | null {
    if (kind === 'self') return this.selfLevel
    if (kind === 'pc') return null
    return this.levels.levelOf(this.names.key(caster), caster)?.level ?? null
  }

  private onDamage(ev: Extract<LogEvent, { kind: 'damage' }>): void {
    const attacker = ev.attacker
    if (!attacker) return
    // A swing either way is MELEE CONTACT, which is the only proxy for point-blank range a song
    // pulse gets (songs.ts rule 3). A damage shield firing means the mob hit you, so it counts too.
    if (ev.dtype === 'melee' || ev.dtype === 'ds') {
      this.onMelee(attacker, ev.target, ev.ts)
      // The behavioural guard runs whatever the songs are doing: a name YOU have landed damage on
      // is a mob, and that is what keeps a proper-named guard out of the player roster.
      if (isSelf(attacker)) this.casters.noteStruck(ev.target)
      return
    }
    if (ev.dtype !== 'spell' && ev.dtype !== 'dot') return
    this.onSpellDamage(ev, attacker, this.casters.kindOf(attacker))
  }

  /** A spell or DoT line from somebody this fold is willing to learn from. */
  private onSpellDamage(
    ev: Extract<LogEvent, { kind: 'damage' }>,
    attacker: string,
    kind: ResistCasterKind
  ): void {
    // BEFORE the target test, not after: this is what makes a proper-named creature you have
    // nuked a creature, and it is the evidence the catalog most often lacks.
    if (kind === 'self') this.casters.noteStruck(ev.target)
    if (!isMobTarget(ev.target)) return
    const spellKey = spellCanonKey(ev.skill)
    this.names.remember(ev.target)
    if (this.songs.onDamage(spellKey, kind, ev.ts)) return
    this.cancelDeferred(ev.target, spellKey)
    this.casts.peek(spellKey, ev.ts)?.damaged.add(this.names.key(ev.target))
    const level = this.casterLevel(kind, attacker)
    // A damage line almost never prints the rank (four lines in two million, all Harm Touch), so
    // the armed cast is the ordinary source and the line is the exception that beats it.
    const lineRank = spellRank(ev.skill)
    const cast = this.casts.ownedBy(kind, spellKey, ev.ts)
    const row = this.rowFor({
      mob: ev.target,
      spellKey,
      family: 'cast',
      kind,
      level,
      ts: ev.ts,
      rank: lineRank > 0 ? lineRank : (cast?.rank ?? 0),
      overchannel: this.cast.invocationFor(kind, cast),
    })
    if (ev.dtype === 'dot') this.onDotTick(row, ev.target, spellKey)
    else this.fileHit(row, ev)
  }

  /**
   * One landed direct-damage line. A CRITICAL is counted as a landing and kept OUT of the
   * histogram: its number is not the spell's full damage, and letting it in would invent a second
   * "full" value for the estimator to read partials against.
   */
  private fileHit(row: ResistRow, ev: Extract<LogEvent, { kind: 'damage' }>): void {
    if (ev.crit || (ev.modifiers?.length ?? 0) > 0) row.land += 1
    else this.bucket.addDamage(row, ev.amount)
  }

  private onDotTick(row: ResistRow, target: string, spellKey: string): void {
    const key = pairKey(this.names.key(target), spellKey)
    if (this.dotSeen.has(key)) return
    this.dotSeen.add(key)
    row.land += 1
  }

  // ---- songs ---------------------------------------------------------------------------

  // ---- rows ----------------------------------------------------------------------------

  private spec(obs: Observation): RowSpec {
    const key = this.names.key(obs.mob)
    const level = this.levels.levelOf(key, obs.mob)
    const spec: RowSpec = {
      mobKey: key,
      spellKey: obs.spellKey,
      family: obs.family,
      casterKind: obs.kind,
      casterLevel: obs.level,
      mobLevel: level?.level ?? null,
      debuffs: this.debuffs.active(key, obs.ts),
      rank: obs.rank,
      overchannel: obs.overchannel,
      // THE ONE KEY TERM THAT IS NOT ABOUT `rc` (JOS-397): a row's age, so recent evidence can
      // weigh more than old (shared/resistDecay.ts). Taken off the LOG's own clock, like every
      // other fact here, and never off `Date.now()` — a replay must produce the same ledger twice.
      week: isoWeekKey(obs.ts),
    }
    // Only where it changes rc, which is what keeps it out of the key on every ordinary row.
    if (obs.overchannel === true) spec.casterClasses = this.cast.casterClasses
    if (this.zone !== undefined) spec.zone = this.zone
    if (level && level.lo !== level.hi) {
      spec.mobLevelLo = level.lo
      spec.mobLevelHi = level.hi
    }
    return spec
  }

  private rowFor(obs: Observation): ResistRow {
    return this.bucket.row(this.spec(obs), obs.ts)
  }
}
