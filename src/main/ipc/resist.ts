// IPC: per-mob resist profiles (JOS-382).
//
// Read-only pulls off the resist ledger. Both handlers derive their whole answer on every call —
// see the channel comments in `shared/ipc.ts` for why nothing here is cached and nothing is stored.
//
// THE CLIENT SPELL TABLE IS LOADED LAZILY, HERE, AND ONLY ONCE. `spellTable()` reads the player's
// own 38 MB `spells_us.txt` on a worker thread the first time somebody asks for a profile, then
// serves a userData cache keyed by that file's size and mtime. Kicking it off at registration
// (rather than at boot) keeps it off the startup path entirely, and the first mob page pays for it
// once; every launch after a patch-free week pays nothing.
//
// AND IT IS ALLOWED TO BE MISSING. An `EQ_INSTALL_DIR` override pointed at a folder of logs with
// no EverQuest behind it is a supported state, so `spellTable()` resolving to null is not an
// error: the profile comes back with `spellDataAvailable: false` and the card says so.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { RESIST_AXES, type ResistAxis, type ResistRow } from '../../shared/resistTypes'
import { BASELINE_SOURCE_KEY } from '../../shared/resistTypes'
import { mobKey } from '../../shared/mobKey'
import { resolveMobIdentity } from '../mobAliases'
// THE MIRROR (JOS-496). `viewerLevel` is read on every draw from inside a synchronous profile
// builder, so it cannot be a query — see `serveMirrors.ts` for the third shape and its price.
import { mirroredModuleState } from '../dataServer/serveMirrors'
// THE LEVEL PULL (JOS-497 item 1) — the op that closes the census's last synchronous fold reader.
import { serveMobLevel } from '../dataServer/serveShim'
import type { MobLevelFact } from '../resist/world'
import { mobResistCell, mobResistProfile, type ProfileDeps } from '../resist/profile'
import type { CharacterSnap } from '../../shared/types'
import { fullDamageRefs, unobservableSpells } from '../../shared/resistModel'
import type { DamageRef } from '../../shared/resistDamage'
import { spellTable, spellTableNow, spellTableStatus } from '../resist/spellTable'
import { baselineFrozenAt, resistLedger } from '../resist/store'
import { getResistPrefs, setResistPrefs } from '../storeResists'

/** A mob name is a display string off the renderer's own catalog; bound it anyway. */
const MAX_MOB_NAME = 96

/**
 * EVERY SPELLING OF THE CREATURE, not just the one the page happens to be titled with (JOS-382,
 * round 2). The mob catalog and the log disagree by NAME rather than by spelling — `Cazic Thule`
 * on the wiki page, `Cazic-Thule` in every line the game prints — and `mobAliases` is the
 * verified roster that already knows those pairs (world-model law 12: a cross-source rename is
 * knowledge, never a fuzzy match). Without this, the card on a renamed boss's page reads "not
 * enough data" while the ledger holds hundreds of observations under the other spelling.
 */
function rowsForIdentity(display: string): ResistRow[] {
  const ledger = resistLedger()
  const id = resolveMobIdentity(display)
  if (!id.aliased) return ledger.rowsFor(mobKey(display), BASELINE_SOURCE_KEY)
  const out: ResistRow[] = []
  for (const key of id.keys) out.push(...ledger.rowsFor(key, BASELINE_SOURCE_KEY))
  return out
}

/**
 * The whole-ledger blindness verdict, computed once per app run. It only changes when the fold
 * files a landing for a spell that had none, which is a once-per-install event in practice; the
 * profile reads it on every draw, so a scan of every row on every draw would be the wasteful half.
 */
let blindCache: ReadonlySet<string> | null = null
function unobservable(): ReadonlySet<string> {
  blindCache ??= unobservableSpells(allLedgerRows())
  return blindCache
}

/**
 * The full-damage reference per (spell, caster level), computed once per app run for the same
 * reason and with the same lifetime as the blindness verdict above. It moves only when the fold
 * files damage at a value it has not seen before, and the profile reads it on every draw.
 */
let modesCache: ReadonlyMap<string, DamageRef> | null = null
function modes(): ReadonlyMap<string, DamageRef> {
  modesCache ??= fullDamageRefs(allLedgerRows())
  return modesCache
}

function allLedgerRows(): ResistRow[] {
  const out: ResistRow[] = []
  for (const src of resistLedger().toLedger().sources) out.push(...src.rows)
  return out
}

/**
 * The profile builder's inputs, bound to this process's ledger, catalog and spell table.
 *
 * EXPORTED FOR THE CON CARD (JOS-383), which draws the same five axes over the game from the same
 * profile: `main/conCard.ts` calls `mobResistProfile` with exactly these deps, so the chip on the
 * card and the row on the mob page are the same estimate rather than two that agree today. It is a
 * function rather than a constant because two of the four members read live state (the ledger and
 * the spell table are both filled in after boot).
 */
/**
 * THE VIEWER'S LEVEL, FROM WHICHEVER WORLD ANSWERS THIS APP'S READS (JOS-496).
 *
 * READ LIVE for the reason JOS-387 gives: the tag is a benchmark AT THAT LEVEL, so a ding has to
 * move every card on the next draw with no re-fold. The character module already resolves
 * ding-versus-`/who` by recency (`shared/currentLevel.ts`), and both worlds fold the same rule —
 * that equality is what the parity probe has been checking on `character` every rebuild.
 *
 * THE MIRROR FIRST, THE APP'S OWN FOLD OTHERWISE, and the fallback is not a fallback of last resort:
 * it is the answer on every launch with no engine, every moment before the engine goes live, and
 * every re-fold. `serveMirrors.ts` reserves `null` for exactly that, which is why the two arms can
 * be one `??` — a mirrored state is never null and a level of 0 is not a level.
 */
function viewerLevel(): number | null {
  // THE MIRROR IS THE ONLY ARM NOW (JOS-499). It used to fall back to this process's own
  // `character` module for every launch with no engine and every moment before one went live;
  // there is no such module, so an unmirrored moment answers `null` — which is what this
  // function has always returned when the level is unknown, and what its callers already draw.
  const mirrored = mirroredModuleState('character') as CharacterSnap | null
  return mirrored?.level?.level ?? null
}

/**
 * THE CREATURE'S LEVEL, ALREADY RESOLVED BY WHOEVER IS ABOUT TO DRAW (JOS-497 item 1).
 *
 * It is a BOX rather than a bare fact for the reason `serveShim.ts serveMobLevel` boxes its own
 * answer: `null` is a real level fact ("nothing states a level for this creature") and `undefined`
 * has to mean something else — here, "nobody resolved one, so ask this process's fold". A caller
 * that cannot await (there are none left on this path) still gets the old behaviour by passing
 * nothing.
 */
export interface ServedMobLevel {
  /** The display name the level was resolved FOR. Checked, so a stale resolution cannot answer for
   *  a creature it is not about — the same echo discipline the shim applies one layer down. */
  readonly display: string
  readonly fact: MobLevelFact | null
}

/**
 * ASK WHICHEVER WORLD ANSWERS THIS APP'S READS how old a creature is (JOS-497 item 1).
 *
 * THE CENSUS'S LAST SYNCHRONOUS READER CLOSES HERE. `levelOf` used to be
 * `resistModule.levelOf(key, display)` — a direct call into this process's fold from inside a
 * synchronous profile builder — and JOS-496 named it in place because the engine's resist module
 * publishes counts and nothing else, so there was no op to ask and no cursor to mirror. There is an
 * op now, and this is the one place that asks it.
 *
 * THE KEY IS NOT SENT. The engine folds it (`consider::mob_key`, the port of `shared/mobKey.ts`),
 * because a pre-folded key on the wire would be a second opinion about a join key — the same rule
 * `knowledge.mob` states. Under fallback the shim hands the same display name to this process's
 * own fold, which folds its own key exactly as it always has.
 */
export async function servedMobLevel(display: string): Promise<ServedMobLevel> {
  // NO SECOND FOLD TO ASK (JOS-499): an engine that cannot answer means nobody can, and `null` is
  // the answer `levelOf` has always given for a creature nothing has ever conned.
  const fact = await serveMobLevel(display, () => null)
  return { display, fact }
}

export function resistProfileDeps(level?: ServedMobLevel): ProfileDeps {
  return {
    rowsFor: rowsForIdentity,
    unobservable,
    damageModes: modes,
    spells: () => spellTableNow(),
    // THE READER JOS-496 NAMED IN PLACE, AND IT IS CLOSED (JOS-497 item 1).
    //
    // What stood here was `resistModule.levelOf(key, display)` — a synchronous call into this
    // process's own fold from inside a profile builder, the last of the census's eighteen — with a
    // note saying it could not be served because the engine's `resist` module publishes counts and
    // nothing else. `resist.levels` is the op that answers it now, and `servedMobLevel` above is
    // the one place that asks; by the time this closure runs, the answer is already in hand.
    //
    // THE DISPLAY NAME IS COMPARED, not trusted. A resolution is about ONE creature and this
    // closure is handed a `(key, display)` pair by the profile builder, so a box resolved for a
    // different name must not answer for this one — it would be a level from the wrong card. The
    // mismatch arm and the no-box arm are the same arm on purpose: both mean "nobody resolved this
    // creature", and this process's own fold is what has always answered that.
    //
    // AND THE MISMATCH ARM IS SIMPLY `null` NOW (JOS-499). It used to reach this process's own
    // fold; there is none, and a creature nobody resolved has no level — which is exactly what
    // the profile builder has always drawn for an unknown mob.
    levelOf: (_key, display) => (level?.display === display ? level.fact : null),
    viewerLevel,
    frozenAt: () => baselineFrozenAt(),
    // READ HERE, ON EVERY DRAW (JOS-385). The ledger folded those rows whatever this says; this is
    // the one place the answer is consulted, which is what makes the switch free to flip.
    includeNpcCasters: () => getResistPrefs().includeNpcCasters,
    spellStatus: () => spellTableStatus(),
    // NOT CACHED, and it does not need to be (JOS-397): the buckets maintain their own maximum as
    // rows arrive, so this is a walk over a handful of sources rather than over the ledger. The two
    // caches above exist because their answers cost a pass over every row; this one does not.
    newestWeek: () => resistLedger().newestWeek(),
  }
}

function validMob(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MOB_NAME
}

function validAxis(value: unknown): value is ResistAxis {
  return typeof value === 'string' && (RESIST_AXES as readonly string[]).includes(value)
}

export function registerResistIpc(): void {
  // BOTH HANDLERS RESOLVE THE LEVEL BEFORE THEY BUILD (JOS-497 item 1). They are `ipcMain.handle`
  // bodies and already await the spell table, so the level resolution rides the same shape — and
  // under serve it is a loopback round trip to a process that has already folded, which is the
  // sub-millisecond cost `readShim.ts` prices for every other served read.
  ipcMain.handle(IPC.resistProfile, async (_e, mob: unknown) => {
    if (!validMob(mob)) return null
    await spellTable()
    return mobResistProfile(mob, resistProfileDeps(await servedMobLevel(mob)))
  })
  ipcMain.handle(IPC.resistCell, async (_e, mob: unknown, axis: unknown) => {
    if (!validMob(mob) || !validAxis(axis)) return null
    await spellTable()
    return mobResistCell(mob, axis, resistProfileDeps(await servedMobLevel(mob)))
  })
  ipcMain.handle(IPC.resistPrefsGet, () => getResistPrefs())
  // The renderer supplies it, so the shared normalizer decides what it meant; a patch with nothing
  // recognisable in it leaves the stored value exactly where it was.
  ipcMain.handle(IPC.resistPrefsSet, (_e, patch: unknown) =>
    typeof patch === 'object' && patch !== null && !Array.isArray(patch)
      ? setResistPrefs(patch)
      : getResistPrefs()
  )
}
