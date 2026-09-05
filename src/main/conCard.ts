// conCard.ts — main's half of the CON CARD overlay (JOS-383, shared/conCard.ts).
//
// ONE LOG LINE IN, ONE CARD OUT. The trigger is a `/con` the player typed, and unlike the alert
// banner there is no renderer producer anywhere in this feature: main owns the log, the resist
// ledger, the mob knowledge and the kill counts the card is made of, so main builds it whole and
// the overlay window draws exactly what it is handed (the celebration toast's self-contained
// contract, kept).
//
// A CLOSED OVERLAY IS SILENT. Nothing is sent when the window is not open — that is what makes the
// Preferences switch honest, and it is checked here rather than in the overlay because a window
// that does not exist cannot decline anything.
//
// IT ARRIVES IN TWO PASSES, AND THE SECOND IS NOT A CORRECTION. The whole point of this card is the
// two seconds before you decide to fight, so pass 1 goes out the instant the line is parsed with
// everything that needs no lookup: the name, the level the game just stated, the zone, and the
// resist chips off whatever the ledger can already answer. Pass 2 follows when the client's own
// `spells_us.txt` has been read (once per launch, on a worker thread) and refreshes the SAME queue
// id with the chips filled in, which the overlay treats as the card it already has getting fuller
// rather than a second card. A read that never answers simply leaves pass 1 on screen, which is the
// honest state (world-model law 1).
//
// THE MOB-KNOWLEDGE LOOKUP IS GONE FROM BOTH PASSES (JOS-390). The card used to carry the drop
// table, your looted counts, your kills and the respawn, and pass 2 was `lookupMob` — a cache-first
// call that for a wiki mob rides a politely-spaced network queue. The owner narrowed the card to
// its header, its resist chips and a CLICK that opens the mob page, so all of that is now fetched by
// the page that always owned it. What is left here is local: the ledger, and a spell table this
// process was reading anyway.
//
// THE THREE REFUSALS, all of them the owner's scope:
//   * NEVER FOR A PLAYER. `/con` on another character prints the same shape as `/con` on a mob, so
//     the refusal is `looksLikePlayer` below — and it is stated in one place because it is the one
//     inference in this file.
//   * NEVER TWICE INSIDE A MINUTE OF A CLOSE. Closing the card is a statement about that creature;
//     re-conning it while lining up the pull is not a request to read it again
//     (`CON_CARD_REOPEN_SUPPRESS_MS`). The close arrives from the overlay over `con:card-closed`.
//   * NEVER FOR A HISTORICAL LINE. Only LIVE cons reach here at all (the seam is fed from the
//     consider module's live path), so a startup replay of a month of logs draws nothing.

import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { logError } from './errorLog'
import { getOverlayConfig } from './store'
import { getOverlayWindow } from './windows'
import { mobKey } from '../shared/mobKey'
import {
  cappedName,
  conCardChips,
  conCardIsPlayer,
  conCardSuppressed,
  type ConCardPayload
} from '../shared/conCard'
import type { ConsiderEvent } from '../shared/logEvents'
import { localMobEntry } from './mobLookup'
import { resistProfileDeps, servedMobLevel, type ServedMobLevel } from './ipc/resist'
import { mobResistProfile } from './resist/profile'
import { spellTable } from './resist/spellTable'

/**
 * The player refusal, bound to the committed catalog. The RULE (and the measurement that overturned
 * the ticket's claim that the con ladder answers this) is `conCardIsPlayer` in shared/conCard.ts,
 * where a node test can drive it; this is the one line that knows where the catalog lives.
 */
export function looksLikePlayer(name: string): boolean {
  // `localMobEntry` answers NULL for a mob the catalog has never heard of — not undefined. A
  // `!== undefined` here read as "the catalog knows everything", which is how the first cut of
  // this drew a card over another player's head in the e2e. One comparison, one measured bug.
  return conCardIsPlayer(name, (n) => localMobEntry(n) !== null)
}

/** Which mob the card on screen is about, so a late second pass for a mob that has been replaced by
 *  a newer `/con` is dropped instead of overwriting the newer card. */
let showing: string | null = null

/**
 * mob key -> when its card was last CLOSED by the user. The suppression window's whole memory.
 *
 * NOTHING RESETS IT, and that is deliberate rather than an omission: an entry means nothing one
 * minute after it is written, so a character switch or an epoch boundary has nothing to clear — and
 * every write drops the entries that have expired, so the map holds only the mobs whose cards were
 * closed in the last minute.
 */
const closedAt = new Map<string, number>()

function sendToConCardOverlay(payload: ConCardPayload): void {
  const w = getOverlayWindow('conCard')
  if (!w || w.isDestroyed()) return
  const wc = w.webContents
  // A window still loading its page would silently drop the send — the toast learned this first,
  // and the very first `/con` after a launch is exactly when the page is still loading.
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(IPC.onConCard, payload))
  else wc.send(IPC.onConCard, payload)
}

/**
 * The five chips, off the same profile the mob page's Resists card is drawn from.
 *
 * THE LEVEL ARRIVES RESOLVED (JOS-497 item 1) rather than being read out of this process's fold
 * inside the profile builder. Passing nothing is still legal and still means "ask the app's own
 * fold" — which is what the TS con-card hook does, because that path runs INSIDE the fold's own
 * delivery and has nowhere to put an await. Under serve the hook is not installed at all and the
 * engine's card path resolves the level first, which is where the reader actually closes.
 */
function chipsFor(
  display: string,
  level?: ServedMobLevel
): { chips: ConCardPayload['chips']; spellData: boolean } {
  const profile = mobResistProfile(display, resistProfileDeps(level))
  return { chips: conCardChips(profile), spellData: profile.spellDataAvailable }
}

/** The card as the log line alone can describe it, before the spell table has been read. */
function firstPass(ev: ConsiderEvent, zone: string | undefined, key: string): ConCardPayload {
  const display = cappedName(ev.mob)
  const { chips, spellData } = chipsFor(display)
  const payload: ConCardPayload = { id: key, ts: ev.ts, name: display, chips, spellData }
  if (ev.level !== undefined) payload.level = ev.level
  if (zone !== undefined) payload.zone = zone
  if (ev.rare) payload.rare = true
  return payload
}

/**
 * ONE LIVE `/con`. Returns whether a card was sent, so the tests can drive the whole gate without
 * an overlay window in the way.
 */
export function noteConsider(ev: ConsiderEvent, zone: string | undefined, now = Date.now()): boolean {
  if (looksLikePlayer(ev.mob)) return false
  const key = mobKey(ev.mob)
  if (!key) return false
  return openCard(firstPass(ev, zone, key), key, now)
}

/**
 * THE HALF THAT IS ABOUT THE WINDOW RATHER THAN ABOUT THE LOG (JOS-496, boundary verdict 2).
 *
 * Pulled out of `noteConsider` so the ENGINE's card can reach it. Verdict 2 inverts the con-card
 * hook — today the fold calls synchronously into Electron, and under serve the engine emits a
 * resolved `world.conCard` frame and main only opens the window. What is left here is exactly what
 * "only opens the window" means, and every line of it is about the PERSON rather than about the log:
 *
 *   * A CLOSED OVERLAY IS SILENT (the Preferences switch, checked here because a window that does
 *     not exist cannot decline anything — see the file header).
 *   * THE RE-OPEN SUPPRESSION, and it stays app-side deliberately and permanently. It is measured on
 *     the WALL CLOCK, not the log clock, and the difference is not academic: EQ stamps a line to the
 *     SECOND, so a con played back inside the same second as the close arrives with a `ts` up to
 *     999 ms EARLIER than the close it is supposed to be suppressed by — which the e2e caught by
 *     putting the card straight back up. "Closed within the last minute" is a fact about the person,
 *     so it is measured on the clock the person lives on. The payload's `ts` is still the log's,
 *     because WHEN THE CON HAPPENED is a fact about the log. Its only input is a window event
 *     (`con:card-closed`) that never reaches any fold, and `engine/crates/engined/src/concard.rs`
 *     says the same thing from the other side.
 *   * WHICH CARD IS ON SCREEN, so a late second pass for a mob that has been replaced is dropped.
 */
function openCard(base: ConCardPayload, key: string, now: number): boolean {
  if (!getOverlayConfig('conCard').open) return false
  if (conCardSuppressed(closedAt.get(key), now)) return false
  showing = key
  sendToConCardOverlay(base)
  enrich(base, key)
  return true
}

/** The header the engine resolved, as this file's own vocabulary. See `noteEngineConCard`. */
export interface ServedConCard {
  /** `mobKey(mob)` — the queue identity, folded engine-side. */
  readonly id: string
  /** The log's own clock, as the engine read it. */
  readonly at: number
  /** Whitespace-collapsed and capped engine-side (`capped_name`). */
  readonly name: string
  readonly level?: number
  readonly zone?: string
  readonly rare?: true
}

/**
 * ONE `/con` AS THE ENGINE RESOLVED IT (JOS-496). Returns whether a card was sent, on
 * `noteConsider`'s terms and for its reason.
 *
 * ── WHAT THE ENGINE OWNS HERE, AND IT IS THE WHOLE FOLD HALF ───────────────────────────────────
 *
 * The queue identity, the display name, the level the line stated, the zone, the rare infix and the
 * instant — all six are facts about a log line, and all six arrive resolved. Two of `noteConsider`'s
 * three refusals arrive with them: a line that names nothing (`mob_key` empty) and a line that names
 * a PERSON (`con_card_is_player`, both halves, against the committed catalog) never produce a frame
 * at all. And the third — never for a historical line — is structural one layer down, because the
 * engine's `ConsiderModule` only pushes when live.
 *
 * SO THE SYNCHRONOUS CALL INTO ELECTRON IS GONE UNDER SERVE. That is the census finding verdict 2
 * names: `considerModule.setConCardHook` ran a knowledge lookup, a resist profile and an overlay
 * send ON THE THREAD PARSING THE LOG. Under serve the hook is not installed at all
 * (`registerConCardIpc`), and what reaches this process is a frame off a socket.
 *
 * ── AND WHY THE CHIPS ARE STILL JOINED HERE, WHICH IS THE HONEST PART ──────────────────────────
 *
 * Verdict 2's full form is "the fully resolved card, resist profile joined engine-side", and the
 * chips are NOT joined engine-side yet. `engined/src/concard.rs` states why at length and it is not
 * an oversight: the resist estimate needs the client's own `spells_us.txt` (boundary verdict 8,
 * still open) for every axis, every resist adjust and every fit, and downstream of that sit
 * `shared/resistModel.ts`, `resistFit.ts` and `resistFormula.ts` — a second body of work. So the
 * engine sends the five EMPTY chips with `spellData: false`, which is the honest branch its own
 * profile builder takes when the table has not been read.
 *
 * TAKING THE ENGINE'S EMPTY FIVE HERE WOULD THEREFORE BE A REGRESSION WEARING A CUTOVER'S CLOTHES:
 * every card under serve would draw "no notable resists · nothing seen yet" forever, while the app
 * holds a ledger that can answer. So this joins the chips from `chipsFor` — the SAME call the app's
 * own card makes, off the same ledger and the same table, both of which are still app-owned until
 * verdicts 4 and 8 land. The engine's `chips` and `spellData` fields are deliberately ignored, and
 * the day the table lands engine-side this function loses its join rather than growing one.
 */
export async function noteEngineConCard(card: ServedConCard, now = Date.now()): Promise<boolean> {
  if (!card.id) return false
  // THE DOUBLE GATE, kept rather than trusted away. The engine refuses a person's card with exactly
  // this rule against exactly this catalog (`concard.rs con_card_is_player`), so this can only ever
  // agree — which is the point: a card over another player's head is the thing the owner asked never
  // to happen, and neither side may admit what the other refuses. It costs one catalog lookup.
  if (looksLikePlayer(card.name)) return false
  // THE LEVEL IS ASKED OF WHICHEVER WORLD ANSWERS THIS APP'S READS (JOS-497 item 1), and this is
  // why the function is asynchronous now. It is the same round trip `ipc/resist.ts` makes for the
  // mob page, and on this path it is free in the way that matters: the card's trigger has ALREADY
  // crossed a socket to get here, so the await costs one more loopback hop to a process that has
  // finished folding — microseconds — against a card whose whole promise is the two seconds before
  // you decide to fight. `conCardServe.ts` narrates the outcome when this settles.
  const { chips, spellData } = chipsFor(card.name, await servedMobLevel(card.name))
  const payload: ConCardPayload = { id: card.id, ts: card.at, name: card.name, chips, spellData }
  if (card.level !== undefined) payload.level = card.level
  if (card.zone !== undefined) payload.zone = card.zone
  if (card.rare === true) payload.rare = true
  return openCard(payload, card.id, now)
}

/**
 * The second pass, off the event path, and since JOS-390 it is about ONE thing: the resist chips.
 *
 * `spellTable()` is awaited because the client's own table is read once per launch on a worker
 * thread — so the FIRST con of a session draws its chips from whatever was already loaded (usually
 * nothing, i.e. an honest "no notable resists · nothing seen yet") and this pass fills them in a
 * moment later. Every con after that resolves an already-settled promise, so this is a microtask
 * and a re-send rather than a second round trip.
 *
 * IT IS STILL A SEPARATE PASS RATHER THAN AN AWAIT ON THE EVENT PATH, and that is the whole design:
 * the card exists to be on screen the instant the line is parsed, and a payload that waited for a
 * 38 MB table would be a card that appeared late for the two seconds it is for.
 */
function enrich(base: ConCardPayload, key: string): void {
  void spellTable()
    .then(() => {
      // The player has conned something else since, or closed this card. Either way the newer
      // state is the true one and this answer is stale.
      if (showing !== key) return
      const { chips, spellData } = chipsFor(base.name)
      // Nothing to say when the table changed nothing — the first con of a launch is the case this
      // pass exists for, and a re-send restarts the card's hold (cardQueue `fresh`).
      if (spellData === base.spellData && JSON.stringify(chips) === JSON.stringify(base.chips)) return
      sendToConCardOverlay({ ...base, chips, spellData })
    })
    .catch((err: unknown) => {
      logError('main:conCard', err)
    })
}

/** How long a mob key a renderer may name. A key is a folded mob name; this is its cap. */
const MAX_KEY_CHARS = 120

/**
 * The user closed the card. Recorded here because the SUPPRESSION is main's business — the overlay
 * has no idea what a re-con is — and re-validated because it is a renderer-supplied string.
 */
export function noteConCardClosed(input: unknown, now = Date.now()): void {
  if (typeof input !== 'string') return
  const key = input.trim().slice(0, MAX_KEY_CHARS)
  if (!key) return
  for (const [k, at] of closedAt) {
    if (!conCardSuppressed(at, now)) closedAt.delete(k)
  }
  closedAt.set(key, now)
  if (showing === key) showing = null
}

/**
 * The close channel AND the trigger seam, installed together because they are two halves of one
 * feature: the consider module is where a `/con` becomes a fact, and this file is where a fact
 * becomes a card. Called from `ipc/index.ts` beside the other producer registrations.
 */
export function registerConCardIpc(): void {
  // WHO DRAWS THE CARD, ASKED PER `/con` (JOS-496, boundary verdict 2).
  //
  // THE HOOK IS STILL INSTALLED, AND THE FIRST CUT OF THIS DID NOT INSTALL IT. That version read
  // `shimServing()` once at registration and skipped the hook when it was true — and it was WRONG
  // in a way worth writing down, because the same shape is a live hazard elsewhere in this feature.
  // `shimServing()` IS NOT "AN ENGINE EXISTS". It is `EQC_ENGINE` AND `EQC_ENGINE_SERVE`, both
  // default-on since JOS-495, and it is answered `true` on every dev checkout that has never run
  // `cargo build` — where there is no binary, no client, and no frame will ever arrive. A hook
  // skipped on that answer is a con card that silently never appears again, in exactly the tree
  // `engineHost.ts`'s header promises "exactly the app it got before this ticket". A packaged build
  // whose engine failed to spawn is the same state with a user on the other end of it.
  //
  // SO THE QUESTION IS ASKED AT THE MOMENT IT CAN BE ANSWERED HONESTLY, and the authority is the
  // one the read path already uses: `engineServeReadiness()` — is there a client, is it connected,
  // are both worlds on the SAME log, and has the engine's fold gone live. All four hold exactly
  // when the engine is folding the line this hook just received and will emit a frame for it. One
  // gate, one authority, and no second opinion about what "serving" means.
  //
  // A DOUBLE IS IMPOSSIBLE TO RULE OUT AND HARMLESS BY CONSTRUCTION; A MISS IS NEITHER. If
  // readiness flips between the frame and the hook, both draw — and they draw the SAME card, under
  // the same `mobKey` queue identity, so the overlay treats the second as the first getting fuller
  // (`enrich`'s re-send does exactly this on every launch already). That asymmetry is why the gate
  // is written to fail towards drawing.
  //
  // IT ARRIVES AS A FUNCTION RATHER THAN BEING READ HERE for a structural reason: `serveShim.ts`
  // and the client reach this file through the serve receiver (serveShim → engineClientHost →
  // conCardServe → conCard), so importing either would close a module cycle between a leaf and the
  // composition root. `ipc/index.ts` holds both halves and is where the decision belongs.
  //
  // THE CLOSE CHANNEL IS REGISTERED IN BOTH WORLDS, because the suppression it feeds is app-side in
  // both (see `openCard`) — the engine has no idea what a re-con is and by design never will.
  // THE TS HOOK IS GONE (JOS-499, boundary verdict 2 completed). `considerModule.setConCardHook`
  // was the fold calling SYNCHRONOUSLY INTO ELECTRON from inside itself — the census finding the
  // verdict exists to resolve — and it drew the card whenever the engine was not going to. The
  // engine emits `world.conCard` fully resolved now and `dataServer/conCardServe.ts` opens the
  // window, so there is one producer and the predicate this function takes has one honest use
  // left: refusing to draw twice. It is kept as a parameter because `ipc/index.ts` still owns
  // the readiness question and the close channel below is registered in every world.
  ipcMain.on(IPC.conCardClosed, (_e, key: unknown) => {
    try {
      noteConCardClosed(key)
    } catch (err: unknown) {
      logError('main:conCardClosed', err)
    }
  })
}
