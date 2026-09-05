// ============================================================================
// hostClock.ts — WHAT THIS MACHINE SAYS ABOUT ITS OWN ZONE, for the attach to carry (JOS-536).
// ============================================================================
//
// An EverQuest log stamp is a zone-less local wall clock, so a fold has to resolve the zone the
// game wrote it in. The engine's own probe is `iana_time_zone`, which on Windows is a WinRT call —
// and Wine does not implement it. The probe errors, the engine reads every stamp as UTC, and every
// surface that ages the log against this machine's clock (fights, buffs, timers) is out by a whole
// number of hours. THE APP ALREADY KNOWS THE ANSWER: V8 resolves the zone through ICU, which works
// under Wine, and that is what the first year of this product's timestamps were parsed with.
//
// TWO FACTS, NOT ONE, AND THE ENGINE RANKS THEM. A NAME carries DST rules a bare offset cannot. An
// OFFSET is a measurement of the same clock that stamped the log, so it is evidence rather than a
// lookup — and when the two disagree the engine keeps the offset (`eqlog::resolve_zone`). Sending
// both is what makes that ranking possible.
//
// PURE, AND READ FRESH AT EVERY ATTACH. A respawn is a launch and a launch is a fresh reading: the
// offset is a function of the date (DST), so a value cached at boot is wrong twice a year and wrong
// for the whole of a session that crosses a transition.

/** The hint `session.attach` carries. `tz` is omitted when the host will not name one; the offset
 *  is always available, because it is arithmetic on a `Date` rather than a lookup. */
export interface HostClockHint {
  tz?: string
  utcOffsetMin: number
}

/**
 * This machine's zone, as the attach spells it.
 *
 * `utcOffsetMin` is minutes EAST of UTC — the negation of `Date.getTimezoneOffset()`, which counts
 * the other way. Los Angeles in September is -420.
 *
 * `intl` is injected so a test can state what the host answered; production passes the real reader.
 * A THROW IS AN ANSWER: an environment with no ICU data raises rather than returning a name, and the
 * honest hint then carries the offset alone, which is exactly the case the engine's `offset` rung
 * exists for.
 */
export function hostClockHint(now: Date, intl: () => string | undefined): HostClockHint {
  const utcOffsetMin = -now.getTimezoneOffset()
  let tz: string | undefined
  try {
    const named = intl()
    if (typeof named === 'string' && named.length > 0) tz = named
  } catch {
    tz = undefined
  }
  return tz === undefined ? { utcOffsetMin } : { tz, utcOffsetMin }
}

/** The real reader. Its own function so the injected seam above has something to stand in for. */
export function resolvedTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
