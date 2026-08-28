// THE ONE TIMER THIS PROTOCOL OWNS (JOS-518).
//
// `client.ts` had no clock in it at all until a request needed one, and that was worth keeping true
// for as long as it could be: a protocol whose correctness depends on timing is a protocol that
// cannot be replayed in a straight line, which is the whole reason `memoryTransport.ts` delivers
// synchronously and the whole reason the committed conversations are assertable. So the clock lives
// here, in one function, where its arguments can be stated once.
//
// WHY IT IS NOT A ONE-LINER AT THE CALL SITE. `src/shared` is bundled into BOTH the renderer and
// main, and the two runtimes return different things from `setTimeout`: Node hands back a `Timeout`
// object whose `unref()` says "do not keep the process alive for this", a browser hands back a
// number and has no such method. A pending request must never be the reason an Electron main
// process refuses to quit — `engineHost.ts`'s timer rule — and a renderer must not crash on a method
// that is not there. That is a shape test rather than a platform check, deliberately: this module
// has no business knowing which bundle it landed in.

/**
 * How long one request may go unanswered before its client gives up on it.
 *
 * GENEROUS ON PURPOSE, and the number is chosen against the engine's own door rather than against a
 * round trip. `SNAPSHOT_PATIENCE` in `engine/crates/engined/src/world.rs` is 5 s — an engine whose
 * fold cannot answer refuses at five seconds and says so — so anything under that would be a client
 * racing a refusal that is already on its way, and every millisecond above the real wait is spent
 * only on an engine that is never going to answer. A healthy loopback round trip to a process that
 * has folded the log is sub-millisecond; the shapes in between are a fold answering between its own
 * read boundaries, which is bounded by one slice of a scan.
 *
 * IT IS A FAILURE MECHANISM, NOT A LATENCY BUDGET — the same sentence `World::module_snapshot`
 * writes about its own patience, and the distinction the whole of JOS-518 turns on.
 */
export const REQUEST_DEADLINE_MS = 15_000

/** Arm one request's deadline. Disarm with `clearTimeout`; see the header for the `unref`. */
export function armDeadline(expired: () => void): ReturnType<typeof setTimeout> {
  const handle = setTimeout(expired, REQUEST_DEADLINE_MS)
  const timer: unknown = handle
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
  return handle
}
