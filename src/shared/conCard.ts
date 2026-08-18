// conCard.ts — THE CON CARD overlay (JOS-383): its per-kind knobs, the payload one `/con` sends,
// and the two pure rules that decide whether a card is owed at all.
//
// THE ASK (owner, 2026-08-16, following the JOS-321 spike and report STA19Q): when you `/con` a
// creature a card appears at the top centre of the screen - tooltip-shaped, semi-transparent, over
// the game - telling you what you want to know in the two seconds before you decide to fight. Its
// resists, what it drops, its level, its respawn if we know it. Closable, ON by default.
//
// NARROWED TO A LILY PAD (owner, 2026-08-16, JOS-390). The card is the HEADER (name, level, zone),
// the resist chips - and a click target: clicking it anywhere but the × opens that creature's page
// in the app, where the drops, the kills, the quests and the full five-axis resist table already
// live. So the drops and the respawn LEFT this payload rather than being restyled. The argument is
// the one the resist cut (JOS-386) made about chips, taken one step further: every line on a card
// you read in two seconds costs window over a running game, and a drop list is a thing you browse
// rather than glance at. Nothing was deleted from the product - it moved one click away, and the
// card now says where.
//
// IT IS A SEPARATE OVERLAY KIND, and it is a STRIP like the celebration toast and the alert banner:
// its resting state is an empty, click-through window that draws nothing at all. The three differ in
// what they are FOR - a toast is a thing you glance at afterwards, a banner is a raid call read
// mid-pull, and this is a card you READ for a moment before pulling - so each is positioned, sized,
// held and locked independently, which is what a kind is.
//
// ON BY DEFAULT, and unlike the alert banner that is the owner's explicit instruction rather than an
// inference: a con card answers a question the player just ASKED by typing `/con`, so it is not text
// over the game nobody wanted. `DEFAULT_OVERLAY_CONFIG.conCard.open` is true and no migration exists
// - `overlays.conCard` has never been written by any build, so every store reads that default (see
// main/store.ts, which says the same thing about six kinds and the opposite about this one).
//
// WHAT THIS FILE IS NOT. It holds no Electron, no React and no lookup: main builds a payload from
// the mob knowledge and the resist ledger it already owns (main/conCard.ts) and the overlay draws
// it. Everything here is a type, a constant or a total function, so `npm test` exercises every rule.

import { isPlayerShapedName } from './playerShape'
import {
  RESIST_AXES,
  type MobResistAxis,
  type MobResistProfile,
  type ResistAxis,
  type ResistAxisBenchmark,
  type ResistTag
} from './resistTypes'
// TYPE-ONLY, so the cycle it closes (types.ts names this file's config blob) is erased at compile
// time. `shared/buffTimers.ts` takes the same shape for the same reason: the knob-applier belongs
// beside the kind's own vocabulary, not inside a store module at its factoring ceiling.
import type { OverlayConfig, OverlayKind } from './types'

// ---- the kind's own config knobs ---------------------------------------------------------
//
// They ride `overlays.conCard` (OverlayConfig.conCard) for the reason `ToastOverlayConfig` and
// `AlertBannerOverlayConfig` ride theirs: this is an overlay KIND in every sense, so it gets one
// open-state, one persisted bounds and one per-kind config read. `open` IS the design's "enabled".

/**
 * Timing for the con card. Everything else it needs is standard OverlayConfig.
 */
export interface ConCardOverlayConfig {
  /**
   * How long a card stays before it leaves by itself, in ms. `0` means IT NEVER LEAVES - the card
   * then sits there until the next `/con` replaces it or the user closes it, which is a real
   * preference for someone who reads it while deciding rather than at a glance.
   */
  autoHideMs: number
}

/** THREE SECONDS (owner, 2026-08-16, JOS-390 — it was five, and twenty before that). A con is a
 *  glance while you decide whether to pull, and a card that outlasts the decision is a box sitting
 *  on the game. Three is that glance, and it is what the card is now sized for: the drops and the
 *  respawn are one click away rather than on it (the header), so there is less to read and no reason
 *  to hold the screen longer. The knob below is still there for the reader who wants more time, up
 *  to and including "never" — and it is exactly the FLOOR, which is the same statement read twice:
 *  below three seconds a card could not be read at all. */
export const DEFAULT_CON_CARD_AUTO_HIDE_MS = 3_000
/** The sentinel the owner asked for: 0 = never hides. */
export const CON_CARD_NEVER_HIDES = 0
/** Below this a card could not be read at all, so a stored 1 s is a mistake rather than a choice. */
export const CON_CARD_MIN_AUTO_HIDE_MS = 3_000
/** Past two minutes "hides by itself" stops being true in any useful sense; use 0 and mean it. */
export const CON_CARD_MAX_AUTO_HIDE_MS = 120_000

export const DEFAULT_CON_CARD_CONFIG: ConCardOverlayConfig = {
  autoHideMs: DEFAULT_CON_CARD_AUTO_HIDE_MS
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

/**
 * Coerce a stored/patched con-card config into the valid shape (the store's clamp lives here).
 * The result carries ONLY the field above, so a hand-edited key is dropped the next time this blob
 * is written rather than honoured.
 *
 * ZERO SURVIVES THE CLAMP. It is not a small number that got rounded up to the minimum - it is the
 * "never" the owner asked for, and a normalizer that quietly turned it into 3 s would be answering
 * a different question from the one the control asks.
 */
export function normalizeConCardConfig(v: unknown): ConCardOverlayConfig {
  const raw = asRecord(v).autoHideMs
  const ms = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_CON_CARD_AUTO_HIDE_MS
  if (ms <= 0) return { autoHideMs: CON_CARD_NEVER_HIDES }
  return { autoHideMs: Math.min(CON_CARD_MAX_AUTO_HIDE_MS, Math.max(CON_CARD_MIN_AUTO_HIDE_MS, ms)) }
}

/**
 * THE STORE'S ONE LINE ABOUT THIS BLOB, on both sides of it (`applyTimerOverlayKnobs`' arrangement,
 * one file over): read it complete and clamped, write it clamped, and DELETE it on every other
 * kind so a malformed patch cannot grow a con-card knob on a damage meter.
 *
 * It lives here rather than in main/store.ts because that file is at the repo's 400-code-line
 * ceiling and because this is a fact about the kind, not about the store.
 */
export function applyConCardKnob(kind: OverlayKind, cfg: OverlayConfig): void {
  if (kind === 'conCard') cfg.conCard = normalizeConCardConfig({ ...DEFAULT_CON_CARD_CONFIG, ...cfg.conCard })
  else delete cfg.conCard
}

// ---- the two rules about WHEN a card is owed ----------------------------------------------

/**
 * A RE-CON AFTER A CLOSE MUST NOT NAG (owner scope). Closing the card is a statement about THIS
 * creature - "I have read it" - and conning the same thing again ten seconds later while lining up
 * a pull is not a request to read it again. Sixty seconds is the owner's number.
 *
 * It is per MOB KEY and it is cleared by nothing: a card the user closed for `a lava guardian` is
 * suppressed for a minute for every lava guardian, because they are one creature as far as
 * everything this card shows is concerned (the ledger, the drop table and the catalog all key that
 * way - world-model law 2).
 */
export const CON_CARD_REOPEN_SUPPRESS_MS = 60_000

/** True while a close of this mob's card still suppresses a re-open. Absent close ⇒ never. */
export function conCardSuppressed(closedAt: number | undefined, now: number): boolean {
  if (closedAt === undefined) return false
  return now - closedAt < CON_CARD_REOPEN_SUPPRESS_MS && now >= closedAt
}

/**
 * IS THE THING THE PLAYER JUST CONNED A PERSON? (owner scope: never a card over another player.)
 *
 * THE TICKET SAID THE CON LADDER KNOWS, AND IT DOES NOT — measured against the committed fixtures
 * (tests/fixtures/w22-w24): `Lasershark regards you indifferently -- looks like quite a gamble.
 * (Lvl: 50)` is a player and `Blugurg regards you indifferently -- … (Lvl: 40)` is a mob, and the
 * two lines are the same shape on the same rung. A faction rung is about STANDING, not species, so
 * nothing the con line prints answers this.
 *
 * What does answer it is the pair `CasterIndex.judge` (main/resist/world.ts) already uses, and this
 * is deliberately the same two tests in the same order: EQ gives PLAYERS one capitalized word with
 * no space and gives MOBS an article plus a noun phrase (`shared/playerShape.ts` carries the
 * measurement), and the committed catalog knows the proper-named NPCs that shape would otherwise
 * admit (`Innoruuk`, `Blugurg`, `Sheldon`) — which is what `knownMob` is asked.
 *
 * THE RESIDUAL, stated rather than hidden: a proper-named NPC the catalog has never heard of gets
 * no card. That is the safe direction — a card that fails to appear costs a keystroke, and a card
 * over another player's head is the thing the owner asked never to happen.
 */
export function conCardIsPlayer(name: string, knownMob: (n: string) => boolean): boolean {
  return isPlayerShapedName(name) && !knownMob(name)
}

/**
 * The hold ONE card gets, from the kind's config. Zero on the config is the owner's "never", which
 * is an infinite hold: the queue subtracts from it every tick and the card simply never expires.
 *
 * Infinity lives here and NEVER on the wire — a payload carrying it would not survive JSON.
 */
export function conCardHoldMs(cfg: ConCardOverlayConfig): number {
  return cfg.autoHideMs > 0 ? cfg.autoHideMs : Number.POSITIVE_INFINITY
}

// ---- the wire ------------------------------------------------------------------------------

/**
 * ONE AXIS CHIP, as the card receives it.
 *
 * IT CARRIES NUMBERS, NOT SENTENCES, and that is deliberate: the words on the chip
 * (`R 126 (110-144)`, `n=32`, `not enough data (n=2)`) are the mob page's own sentences and are
 * built by the ONE derivation both surfaces read - `features/resists/resistRow.ts`. A payload that
 * carried finished strings would be a second copy of that vocabulary, and the two would drift the
 * first time a word changed.
 *
 * `tag` IS NULL ONLY WHEN THE CELL IS EMPTY (owner ruling, 2026-08-16): a cell with one observation
 * carries its tag, its number and its interval exactly as a cell with six hundred does, and the
 * surfaces add a quieter caveat under `LOW_SAMPLE_BELOW`. All five axes are always here in
 * `RESIST_AXES` order, because "we have not seen fire cast on this" and "fire is fine" are different
 * statements and a missing chip says neither (world-model law 1, and JOS-382's card rule verbatim).
 */
export interface ConCardChip {
  axis: ResistAxis
  /**
   * The guidance band. Null when nothing at all has been observed on this axis — and, since
   * JOS-387, also when the fit is PINNED: a posterior that slid off the end of the grid is the
   * model saying it cannot answer, and a card that printed a band anyway would be inventing one.
   */
  tag: ResistTag | null
  /**
   * The two landing chances behind the band, at the viewer's level. Present exactly when `tag` is;
   * the chip prints both numbers under the band so a player can scale their own case.
   */
  benchmark: ResistAxisBenchmark | null
  /** The fit ran out of grid: no number, no band, and the raw resist rate instead (JOS-387). */
  pinned: boolean
  /** What the informative observations said, with no model in the way: total, and how many resisted. */
  empirical: { total: number; resisted: number }
  /** Every observation behind this axis came from a pet or another creature. The chip says so. */
  npcOnly: boolean
  /**
   * OBSERVATIONS THAT COULD HAVE GONE EITHER WAY (JOS-385): the count the chip prints and the count
   * its low-samples caveat keys off. It is `ResistEstimate.nInformative`, not `n`, and the two are
   * the same number on most cells — they part company exactly where a proc dominates, which is
   * where the old chip claimed eighty observations off eight.
   */
  n: number
  /** Everything the fit saw, informative or not. Printed beside `n` when they differ. */
  nTotal: number
  /** The estimate and its interval, present exactly when `tag` is. Wide at a low `n`, which is the
   *  honest display of a thin cell rather than a reason to withhold it. */
  fit: { R: number; lo: number; hi: number } | null
}

/**
 * ONE `/con`, as the card overlay receives it.
 *
 * SELF-CONTAINED BY LAW, the contract the celebration toast wrote and the alert banner kept: the
 * overlay window fetches NOTHING. Everything on the card is here, because that window has no
 * knowledge service, no ledger and no store beyond its own config - and a card that had to ask
 * questions after it appeared would appear half-empty over a running game.
 *
 * IT IS STILL SENT TWICE, and the second send is not a correction. The first carries what the log
 * line itself said plus whatever the resist ledger can already answer (instant, which is the whole
 * point of a card you read before pulling); the second arrives when the client's own spell table
 * has been read and refreshes the SAME `id` with the chips filled in, which the queue treats as a
 * refresh of the card on screen rather than a second card (renderer/overlay/cardQueue.ts).
 *
 * WHAT IT NO LONGER CARRIES (JOS-390): the drop table, your looted counts, your kill count and the
 * respawn. Those are the MOB PAGE's, and the card is now the click that opens it — so the second
 * pass no longer waits on a mob-knowledge lookup at all (main/conCard.ts).
 */
export interface ConCardPayload {
  /** Queue identity: the mob key. A re-con REFRESHES the card rather than stacking a second one. */
  id: string
  /** When the `/con` happened (ms epoch). */
  ts: number
  /** The mob's display name, exactly as the log printed it. */
  name: string
  /** The level the con line stated. Every con line in the real log states one. */
  level?: number
  /** The zone the player was in when they conned. */
  zone?: string
  /** The ` - a rare creature - ` infix was on the line. */
  rare?: boolean
  /** Always five, always in `RESIST_AXES` order. */
  chips: ConCardChip[]
  /** False when the client's `spells_us.txt` could not be read; the card says so instead of
   *  drawing five identical "not enough data" chips with no explanation. */
  spellData: boolean
}

/**
 * The five chips for a mob, from the profile JOS-382's IPC already builds.
 *
 * ONE call, no second estimator: everything here is a projection of `MobResistProfile`, so the chip
 * on the card and the row on the mob page can never disagree about what the log has seen.
 */
export function conCardChips(profile: MobResistProfile): ConCardChip[] {
  const byAxis = new Map(profile.axes.map((a) => [a.axis, a]))
  return RESIST_AXES.map((axis) => chipFor(axis, byAxis.get(axis)))
}

/** The empty chip: what an axis the profile omits, or has nothing behind, looks like on the wire. */
function blankChip(axis: ResistAxis): ConCardChip {
  return {
    axis,
    tag: null,
    benchmark: null,
    pinned: false,
    empirical: { total: 0, resisted: 0 },
    npcOnly: false,
    n: 0,
    nTotal: 0,
    fit: null
  }
}

/** One axis row projected onto the wire. An axis the profile omits is an EMPTY chip, never absent. */
function chipFor(axis: ResistAxis, row: MobResistAxis | undefined): ConCardChip {
  if (!row) return blankChip(axis)
  const est = row.estimate
  if (!est) return { ...blankChip(axis), n: row.nInformative, nTotal: row.n }
  return {
    axis,
    tag: row.tag,
    benchmark: row.benchmark,
    pinned: est.pinned,
    empirical: est.empirical,
    npcOnly: est.npcOnly,
    // THE SAME TWO NUMBERS THE MOB PAGE PRINTS, and taken off the same estimate rather than
    // recomputed: a chip that counted a -250 proc's casts and a row that did not would be two
    // surfaces disagreeing about how much this app knows (JOS-385).
    n: row.nInformative,
    nTotal: row.n,
    fit: row.tag === null ? null : { R: est.R, lo: est.lo, hi: est.hi }
  }
}

/** Rendering guarantees, not taste: a 40 kB mob name cannot push a card off the screen. */
const MAX_NAME_CHARS = 96

export function cappedName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
}
