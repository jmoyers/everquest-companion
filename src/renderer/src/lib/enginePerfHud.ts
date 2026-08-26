// lib/enginePerfHud.ts — the renderer's half of the ENGINE section (JOS-483).
//
// > "i want to see the server in the cpu/performance overlay in app." — owner, ruling 19.
//
// `perfHud.ts` is the same idea for the app's own processes, and this is deliberately NOT in that
// file, for two reasons that are both about keeping a boundary honest:
//
//   * DIFFERENT LIFETIME. `usePerfHud` is mounted in the title bar for the whole session and
//     subscribes to a channel main leaves silent. This one ARMS A POLL, and it must be mounted
//     only while somebody is looking — a different contract with a different failure mode.
//   * IT MUST BE UNIT-TESTABLE. `tests/enginePerf.test.mts` runs this hook for real over
//     `tests/hookHost.mts`, and the unit suite resolves no `@shared/*` alias (only the web
//     tsconfig declares it), so a file a test imports must reach shared code by RELATIVE path —
//     the same shape `lib/useView.ts` already has, and for the same reason.
//
// NOTHING IS KEPT HERE. There is no ring: the engine's counters are cumulative for a generation and
// the panel draws the latest reading of them, so a history would be sixty copies of a running
// total. The two-minute ring `perfHud.ts` keeps is for a RATE, which is a different thing.

import { useEffect, useState } from 'react'
import type { EnginePerfSample } from '../../../shared/enginePerf'

/**
 * The ENGINE section's numbers, and the WHOLE of the polling discipline (JOS-483).
 *
 * > "i want to see the server in the cpu/performance overlay in app."
 *
 * `open` IS THE ARMING SIGNAL AND THIS HOOK IS THE ONLY THING THAT SENDS IT. The engine's numbers
 * cost a loopback round trip to a child process plus a native per-pid read, and the section they
 * fill lives inside a popover that is open for seconds at a time — so main polls only while this
 * says so, and stops the moment it stops. The `false` on unmount is not tidiness: a window closed
 * with the popover open would otherwise leave a timer polling a socket for nobody.
 *
 * `null` IS A REAL ANSWER, not a loading state. It means there is nothing to draw — the engine flag
 * is off, or this build carries no engine binary, which is the ordinary state of any checkout that
 * has not built one. The section renders nothing at all, the same way the chip hides entirely when
 * the HUD is off rather than showing a greyed placeholder.
 *
 * NOTHING IS KEPT. There is no ring here: the engine's counters are cumulative for a generation and
 * the panel draws the latest reading of them, so a history would be sixty copies of a running
 * total. The two-minute ring `usePerfHud` keeps is for a RATE, which is a different thing.
 */
export function useEnginePerf(open: boolean): EnginePerfSample | null {
  const [sample, setSample] = useState<EnginePerfSample | null>(null)

  useEffect(() => {
    if (!open) return undefined
    // Subscribe BEFORE arming, so the immediate first push main sends on arming is heard. The
    // other order loses it and leaves the section blank for one whole interval.
    const off = window.eq.onEnginePerf(setSample)
    void window.eq.watchEnginePerf(true)
    return () => {
      off()
      void window.eq.watchEnginePerf(false)
      // Dropped on close rather than kept for the next open: a reading from the last time this was
      // open is a number about a moment that has passed, and drawing it while the fresh one is in
      // flight is how a panel reports a dead engine as live.
      setSample(null)
    }
  }, [open])

  return sample
}
