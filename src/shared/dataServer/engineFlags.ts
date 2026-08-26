// ============================================================================
// engineFlags.ts — how the engine's three environment flags are READ (JOS-495).
// ============================================================================
//
// ONE PREDICATE, FIVE READERS. `engineHost.ts` (the feature as a whole), `serveShim.ts` and
// `serveDeltas.ts` (the read path's two halves), `alertsAudio.ts` (the sound) and
// `preload/engine.ts` (the renderer's readout) all ask the same question of `process.env`, and until
// this ticket they all spelled it `=== '1'` in five separate places. That was survivable while the
// answer was "off unless somebody says otherwise", because the four spellings a developer could get
// wrong all failed the same safe way. The cutover INVERTS it — default ON, `=0` off — and five
// copies of an inverted comparison is five chances to invert four of them and ship a gate that
// still reads the old way. So the comparison lives here: in `shared/` because a preload is not main
// and reads these variables too, and PURE so a node test can drive the whole matrix directly rather
// than grepping five files for a string.
//
// WHY `!== '0'` AND NOT A TRUTHINESS TEST. The escape hatch has exactly one spelling, and it is the
// one the READMEs, the e2e harness (`appWindow.mts ENGINE_OFF`) and the ticket all say:
// `EQC_ENGINE=0`. A predicate that also honoured `false`, `off`, `no` or the empty string would be
// inventing a vocabulary nobody wrote down, and the failure that invites is silent in the worst
// direction — a developer who typed `EQC_ENGINE=false` to take the engine out of a diagnosis, got
// it anyway, and spent the next hour reading the wrong process. Everything that is not the one
// documented off switch means ON, which above all includes the UNSET variable that every ordinary
// launch — dev, packaged, and the owner's — now has.
//
// `=1` STILL MEANS ON, and not as a special case: it is simply not `'0'`. Every shell, script, spec
// and README that carries the explicit spelling keeps working unchanged, which is what makes the
// flip a one-line change at each gate rather than a sweep through everything that ever set one.

/**
 * Is a gate whose escape hatch is this environment variable OPEN on this launch?
 *
 * Takes the VALUE rather than the name so it stays pure — the caller does the `process.env` read,
 * which is the part that differs between a main-process module and a preload, and is the part each
 * gate already documents for itself (read once at module load; an env var is a fact about how the
 * process was started, not a thing that changes under a running app).
 */
export function engineFlagOn(value: string | undefined): boolean {
  return value !== '0'
}
