// IPC: the buff EXTERNALS ALLOWLIST (JOS-140 — shared/buffTrust.ts).
//
// Two channels over one small list of names: whose casts, besides your own, may anchor a landing
// onto your buff and debuff bars. It ships EMPTY and stays empty for almost everybody. The reason
// it exists at all is the duo: a player who groups with the same enchanter every night asked to
// see that enchanter's mez timers, and the model's whole attribution rule is that a landing needs
// a cast line — so the only honest way to grant it is to name the caster whose cast lines count.
//
// AN ALLOWLISTED NAME GETS THE IDENTICAL RULE, not a looser one. `<Name> begins casting <Spell>.`
// is a real line the log prints (measured: two distinct player names casting in one fifteen-minute
// reporter slice), it is matched inside the same window, and everything downstream — the clean
// cycles, the count chip, the classification — is the same code. What it does NOT do is pool the
// durations: a sample is keyed on (spell line, caster), so their 31-second mez never becomes your
// 44-second one.
//
// UNLIKE the graphics switches, the setter DOES bring the running session into line: the model
// keeps the allowlist in `CastAnchors`, so a name added mid-session anchors the very next cast
// rather than the next launch. It does NOT retro-admit anything that already landed — a landing
// was either anchored when it arrived or it was not, and rewriting the past would be a second
// opinion about a decision the log has already settled.
//
// VALIDATED AT THE HANDLER, never trusted because today's only caller is the app's own UI (the
// `sounds:getData` rule). The value runs through `normalizeBuffTrustPrefs` — the same normalizer
// the store reader uses — so a renderer and a hand-edited settings file cannot end up with two
// ideas of what a storable name is.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { getBuffTrustPrefs, setBuffTrustPrefs } from '../store'
// The engine's copy of the same allowlist (JOS-482, boundary verdict 3) — additive, and a no-op
// unless this launch asked for an engine. Its `CastAnchors` obeys the same "a name added mid-session
// anchors the very next cast, and retro-admits nothing" rule this setter's header states.
import { pushAppKnowledge } from '../dataServer/definePush'

export function registerBuffTrustIpc(): void {
  ipcMain.handle(IPC.buffTrustGet, () => getBuffTrustPrefs())
  ipcMain.handle(IPC.buffTrustSet, (_e, value: unknown) => {
    const next = setBuffTrustPrefs(value)
    pushAppKnowledge('buffTrust.define')
    return next
  })
}
