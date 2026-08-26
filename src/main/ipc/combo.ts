// IPC: class-combo user corrections — the two WRITE channels of the combo feature.
//
// Reads do not appear here on purpose: the combo module rides the generic module transport
// (`module:getSnapshot('combo')` + `module:delta`, ipc/world.ts), like every other module.
// A correction is different in kind — it is persisted per character and it re-labels the past.
//
// EVERY FIELD IS VALIDATED AT THE HANDLER (the trust-boundary rule in AGENTS.md): a renderer
// string is a renderer string whether or not today's only caller is the app's own UI. `classes`
// must be 1–3 members of the closed ClassAbbr set, deduped; timestamps must be finite, ordered,
// and at/after the launch epoch (a pre-launch correction describes the wiped beta character and
// the store migration drops it anyway — refusing it here means it never gets written).

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { isClassAbbr, MAX_COMBO_SLOTS, type ClassAbbr, type ComboCorrection } from '../../shared/classCombo'
/**
 * THE LAUNCH EPOCH, INLINED (JOS-499 item 2). It lived in `log/epochDetector.ts`, which is deleted
 * with the fold; this file survives and still has to refuse a correction that describes the wiped
 * beta character.
 *
 * INLINED RATHER THAN SHARED, following the precedent `storeMigrations.ts` already set for exactly
 * this constant and for exactly this reason: it is ONE DATE, and a shared module would have to be
 * imported by two files that otherwise have no dependency on each other or on the parse tree.
 * `storeMigrations.ts` carries its own copy (and says why in its header), so this is the second of
 * two rather than the first of many.
 *
 * LOCAL TIME, DELIBERATELY, and do not "tidy" it to UTC — `epochDetector.ts`'s header made the same
 * point. The epoch is the instant EQ Legends officially launched as the owner experienced it.
 * 2026-07-28 00:00 local. (Month 6 is July: the Date constructor's month is 0-based.)
 */
const LAUNCH_MS = new Date(2026, 6, 28, 0, 0, 0, 0).getTime()
// The engine's copy (JOS-482, boundary verdict 3). Over here corrections are PULLED through a
// provider, so a character switch needs no notification; the engine has no store to ask, so the
// push replaces the pull and every write says so. Additive: a launch with no engine finds a null.
import { pushAppKnowledge } from '../dataServer/definePush'
import { activeCharId } from '../session'
import { clearComboCorrections, setComboCorrection } from '../store'

/** A validated `[startTs, endTs]` span, or null. `endTs` null means "from startTs onward". */
function span(raw: unknown): { startTs: number; endTs: number | null } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { startTs, endTs } = raw as { startTs?: unknown; endTs?: unknown }
  if (typeof startTs !== 'number' || !Number.isFinite(startTs) || startTs < LAUNCH_MS) return null
  if (endTs === null || endTs === undefined) return { startTs, endTs: null }
  if (typeof endTs !== 'number' || !Number.isFinite(endTs) || endTs < startTs) return null
  return { startTs, endTs }
}

/** 1–3 distinct ClassAbbr codes, or null. Anything else is rejected whole, never filtered. */
function classes(raw: unknown): ClassAbbr[] | null {
  if (!Array.isArray(raw)) return null
  const deduped = [...new Set(raw)]
  if (deduped.length !== raw.length) return null
  if (deduped.length < 1 || deduped.length > MAX_COMBO_SLOTS) return null
  return deduped.every(isClassAbbr) ? deduped : null
}

/**
 * A correction has been written: rebuild and PUSH, now.
 *
 * `invalidate()` alone only marks the fold dirty and leaves the delta to the next flush the
 * registry happens to run — which, on an idle log, is the 1 s heartbeat, and a user editing
 * their loadout in Preferences is by definition not generating log lines. `flushNow()` is the
 * registry's existing "push immediately" path (it is what a character switch uses), so the write
 * a user just confirmed is on screen before their hand leaves the mouse.
 *
 * The other half of that fix is in ComboModule: the delta's `seq` had to become the module's own
 * revision, because the renderer dedupes on it and a correction advances no log seq at all.
 * Flushing promptly is useless if the push is then dropped as a duplicate — both are needed, and
 * the second one is what `tests/e2e/loadout-override.e2e.mts` caught in the running app.
 */
function republish(): void {
  // …and the engine's module gets the same two, engine-side: `Defines::define` replaces the set and
  // bumps the revision that IS its published seq, for exactly the JOS-87 reason this function
  // exists.
  pushAppKnowledge('combo.define')
}

export function registerComboIpc(): void {
  // Character-scoped, PULLED rather than pushed: `reset()` on a character switch marks the
  // module stale and the next recompute asks this provider again. See ComboModule.

  ipcMain.handle(IPC.comboSetCorrection, (_e, payload: unknown) => {
    const range = span(payload)
    const picked = classes((payload as { classes?: unknown } | null)?.classes)
    if (!range || !picked) return { ok: false as const, error: 'Invalid combo correction.' }
    const correction: ComboCorrection = { ...range, classes: picked, setAt: Date.now() }
    setComboCorrection(activeCharId(), correction)
    republish()
    return { ok: true as const }
  })

  ipcMain.handle(IPC.comboClearCorrection, (_e, payload: unknown) => {
    const range = span(payload)
    if (!range) return { ok: false as const, error: 'Invalid combo range.' }
    clearComboCorrections(activeCharId(), range.startTs, range.endTs)
    republish()
    return { ok: true as const }
  })
}
