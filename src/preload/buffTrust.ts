// preload/buffTrust.ts — the buff EXTERNALS ALLOWLIST half of the app bridge (JOS-140).
//
// Its own module, spread into `api` in index.ts, for the same reason `./graphics.ts` and
// `./perf.ts` are: that file is at the repo's 400-code-line factoring ceiling and the answer to
// that is a split, not a widened threshold. On `window.eq` these two methods are
// indistinguishable from the ones written out there.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { BuffTrustPrefs } from '../shared/buffTrust'

export const buffTrustBridge = {
  /** The persisted allowlist. `{externals: []}` — you and nobody else — by default. */
  getBuffTrust: (): Promise<BuffTrustPrefs> => ipcRenderer.invoke(IPC.buffTrustGet),
  /**
   * Replace the allowlist; resolves to what was ACTUALLY stored (the handler re-normalizes).
   *
   * Unlike the graphics switches this DOES take effect on the call — the model keeps the list in
   * its attribution gate, so a name added now anchors the next cast. It does not retro-admit a
   * landing that already arrived unanchored: that decision was made when the line was folded, and
   * re-deciding it later would be a second opinion about settled evidence.
   */
  setBuffTrust: (prefs: BuffTrustPrefs): Promise<BuffTrustPrefs> =>
    ipcRenderer.invoke(IPC.buffTrustSet, prefs)
}
