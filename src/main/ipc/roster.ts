// IPC: group-roster user edits — the two WRITE channels of the group model.
//
// Reads do not appear here on purpose. The roster rides the COMBAT snapshot
// (`CombatSnapshot.roster`), which the Combat tab and every meter overlay already poll, so the
// chip that filters rows and the rows it filters are read in one call and can never describe
// two different groups. An edit is different in kind — it is persisted per character and it
// outlives every replay.
//
// EVERY FIELD IS VALIDATED AT THE HANDLER (the trust-boundary rule in AGENTS.md): a renderer
// string is a renderer string whether or not today's only caller is the app's own UI. The name
// must survive a trim, fit inside MAX_NAME_LEN, and match the shape a real EQ character name
// has — the same one-word letters-with-backtick-or-apostrophe pattern parseGroup.ts requires of
// a `<Name> has joined the group.` subject. That is not decoration: the key derived from it is
// compared against attacker names off the damage stream, so a name shape the parser could never
// produce is a key that could never match, and storing one would be a permanent silent no-op.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { idKey } from '../../shared/spellKey'
// The engine's copy (JOS-482, boundary verdict 3) — the same pull-becomes-push story combo tells,
// and additive in the same way: a launch with no engine finds a null.
import { pushAppKnowledge } from '../dataServer/definePush'
import { activeCharId } from '../session'
import { clearRosterEdit, setRosterEdit } from '../store'

/** Long enough for every EQ name; short enough that nothing can wedge a paragraph into the
 *  store. The game's own limit is 15; the slack is for a future server that raises it. */
const MAX_NAME_LEN = 24

/** The shape a character name has — see parseGroup.ts NAME, which this deliberately mirrors. */
const NAME_RE = /^[A-Za-z][A-Za-z`'-]*$/

/** A validated display name, or null. Rejected whole, never silently repaired. */
function name(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LEN) return null
  return NAME_RE.test(trimmed) ? trimmed : null
}

export function registerRosterIpc(): void {
  // Character-scoped, PULLED rather than pushed — the ComboModule precedent: `reset()` on a
  // character switch bumps the module's revision and the next read simply asks this provider
  // again, so the module never has to know which character is active.

  ipcMain.handle(IPC.rosterSetEdit, (_e, payload: unknown) => {
    const p = payload as { name?: unknown; action?: unknown } | null
    const display = name(p?.name)
    const action = p?.action
    if (!display || (action !== 'add' && action !== 'remove')) {
      return { ok: false as const, error: 'That is not a usable character name.' }
    }
    setRosterEdit(activeCharId(), { key: idKey(display), name: display, action, setAt: Date.now() })
    pushAppKnowledge('roster.define')
    return { ok: true as const }
  })

  ipcMain.handle(IPC.rosterClearEdit, (_e, payload: unknown) => {
    const display = name((payload as { name?: unknown } | null)?.name)
    if (!display) return { ok: false as const, error: 'That is not a usable character name.' }
    clearRosterEdit(activeCharId(), idKey(display))
    pushAppKnowledge('roster.define')
    return { ok: true as const }
  })
}
