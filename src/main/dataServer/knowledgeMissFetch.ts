// ============================================================================
// knowledgeMissFetch.ts — THE HALF OF BOUNDARY VERDICT 5 THE APP OWNS (JOS-499 item 1).
// ============================================================================
//
// The engine ships without a network stack, so a name no committed corpus holds is a question it
// can state but not answer. JOS-486 built the engine's whole side of that conversation: the
// `knowledgeMiss` stream frame (connection-wide, no id, no epoch, each name announced at most once
// per process) and the `knowledge.define` command that takes the answer back. THIS IS THE MIDDLE —
// the app hearing the frame, running the wiki lookup it already owns, and pushing the record in.
//
// ── WHY IT IS THIS RELEASE'S WORK AND NOT JOS-486'S ────────────────────────────────────────────
//
// JOS-486 left it deliberately, on the grounds that the surface cutover is where the app stops
// asking its own lookups anything and the scrape queue goes from two callers to one. That release
// is THIS one. Without this file the deletion would stop the corpus growing on the day the TS
// fold's `lookupItem`/`lookupMob` callers die: the engine would announce every unknown name into a
// silence, answer `found: false` forever, and no amount of playing would ever teach it a page the
// wiki has had all along. The knowledge surface would be frozen at the committed bytes.
//
// ── WHAT IT DOES NOT TOUCH, EMPHATICALLY ───────────────────────────────────────────────────────
//
// The scrape etiquette is a LAW here (memory: respectful scraping; `itemLookup.ts`/`mobLookup.ts`
// headers) and this file adds nothing to it and weakens nothing in it. `lookupItem`/`lookupMob`
// already carry the serialized queue, the 150 ms spacing, the `Retry-After` cooldown honoured
// across the whole queue, and the negative cache. This file CALLS them and does not re-implement
// one line of any of it — which is the entire reason the fetch stayed app-side in verdict 5 rather
// than being ported into Rust with the corpora. A miss is one more caller of a queue that has
// always paced itself.
//
// ── THE ONE-SLOT INJECTION, AND WHY THE LOOKUPS COME THROUGH IT TOO ────────────────────────────
//
// `serveMirrors.installMirrors(deps)` and `definePush.ts` are the pattern: a leaf that main-side
// code imports gets its capability handed to it, because a leaf that imported `engineClientHost`
// back would be a cycle between two modules that boot each other. The REQUESTER is here for that
// reason.
//
// The LOOKUPS are injected for a second, different reason: `itemLookup.ts` and `mobLookup.ts` both
// `import { app } from 'electron'` at module scope, which no node unit suite can load. Keeping
// this file electron-free is what makes the decision it holds — which domain goes to which lookup,
// what happens to a rejection, what happens when nobody armed it — pinnable at all
// (tests/knowledgeMissFetch.test.mts). The concrete types live at the call site in
// `engineClientHost.ts`, which is also where the `KnowledgeRecord` widening belongs: a record's
// field set is the SCRAPER's, and the protocol says so by declaring it an open map.
//
// ── SPELL IS EXCLUDED BY SHAPE, NOT BY A CHECK ─────────────────────────────────────────────────
//
// `KnowledgePushDomain` is `item | mob` — strictly smaller than `KnowledgeDomain`, which also has
// `spell`. The schema states the reason: the spell catalog has no live fallback, being regenerated
// by `npm run scrape:spells` and committed, so a spell the DB lacks is not a miss and a
// `knowledge.define` naming one would be asking the engine to take an answer nothing produced.
// The switch below is exhaustive over the two, and a third domain would fail to compile rather
// than fall into a default that invented a fetch for it.

import type {
  KnowledgeDefineParams,
  KnowledgeMissMessage,
  KnowledgePushDomain,
  KnowledgeRecord
} from '../../shared/dataServer/protocol.generated'

/**
 * WHAT THIS FILE NEEDS FROM THE WORLD. Filled by `engineClientHost.installEngineClient`, and by
 * nothing else — one slot, on `installMirrors`'s rule.
 */
export interface KnowledgeMissDeps {
  /** `main/itemLookup.ts lookupItem`, widened. Never throws by contract — it degrades to a
   *  cached-negative/offline record — but this file does not rely on that. */
  readonly lookupItem: (name: string) => Promise<KnowledgeRecord>
  /** `main/mobLookup.ts lookupMob`, widened. Same contract. */
  readonly lookupMob: (name: string) => Promise<KnowledgeRecord>
  /** `knowledge.define`, sent back over the same connection the miss arrived on. */
  readonly define: (params: KnowledgeDefineParams) => Promise<void>
  /** The dev-log line. */
  readonly note: (line: string) => void
}

let deps: KnowledgeMissDeps | null = null

/**
 * NAMES THIS PROCESS IS CURRENTLY FETCHING, so a second frame for one of them does not open a
 * second wiki request.
 *
 * IT IS BELT AND BRACES AND IS SAID TO BE. The engine already announces each name at most once per
 * process — the schema states it as a law and the Rust side's miss ledger enforces it — so on the
 * shipped path this set never has two frames for one name to catch. It earns its place on the
 * paths the law does not cover: an engine RESPAWN is a fresh process with an empty ledger, and the
 * app's own `lookupItem` has a serialized queue whose in-flight window is long enough for a
 * relaunch to land inside it. Cheap, bounded by what is in flight, and it clears itself.
 *
 * A NAME LEAVES THE SET WHEN THE FETCH SETTLES, never on a timer. The point is not to remember
 * what was fetched — the engine's overlay is that memory, and `knowledge.define` is what writes
 * it — only to avoid two simultaneous requests for one page.
 */
const inFlight = new Set<string>()

/**
 * Arm the handler. Null lets go, and clears what was in flight: the fetches themselves keep
 * running (a promise cannot be recalled) but their answers will find no requester and be dropped,
 * which is right — the connection they were an answer FOR is gone.
 */
export function installKnowledgeMissFetch(d: KnowledgeMissDeps | null): void {
  deps = d
  if (d === null) inFlight.clear()
}

/** Widen a lookup's concrete record to the open map the protocol declares. See the header: the
 *  field set belongs to the scraper, and a typed mirror's only job would be to lose a field. */
export function asKnowledgeRecord(value: object): KnowledgeRecord {
  // A SPREAD RATHER THAN A CAST, and it needs no assertion: the protocol declares the record an
  // open map, and a fresh object literal satisfies it structurally. The copy is the point — the
  // record crosses a socket, so handing over the caller's live object would let a later mutation
  // change what was already sent.
  return { ...value }
}

/** What one miss turned into. Returned for the tests and for the dev line; nothing branches on it. */
export type MissOutcome = 'defined' | 'refused' | 'duplicate' | 'unarmed'

/** The key the in-flight set uses. Domain-qualified because an item and a mob may share a name and
 *  are two different pages. */
function flightKey(domain: KnowledgePushDomain, name: string): string {
  return `${domain}:${name}`
}

/**
 * ONE MISS, FETCHED AND PUSHED BACK.
 *
 * IT NEVER THROWS, and that is a contract rather than a courtesy: the caller runs inside the
 * client's frame dispatch, where a throw surfaces as a TRANSPORT FAULT — a missing wiki page would
 * take the connection down and with it every subscription in the app. Every failure below becomes
 * a line and a `'refused'`.
 *
 * A FAILED FETCH DEFINES NOTHING, deliberately. The schema allows a real negative — a record
 * carrying `notFound: true` is the app saying "I looked and the wiki has no page", and it stops the
 * engine ever announcing that name again — but a network error is not that statement. Pushing one
 * in would burn the name permanently on the strength of a timeout. `lookupItem` already draws the
 * distinction itself (an offline record is `offline: true`, a genuine absence is not), so what
 * reaches `define` on the success path is whatever the lookup concluded, unedited.
 */
export async function fetchAndDefine(miss: KnowledgeMissMessage): Promise<MissOutcome> {
  const d = deps
  if (d === null) return 'unarmed'
  const key = flightKey(miss.domain, miss.name)
  if (inFlight.has(key)) return 'duplicate'
  inFlight.add(key)
  try {
    // EXHAUSTIVE OVER THE TWO PUSHABLE DOMAINS — see the header. A third would not compile.
    const entry =
      miss.domain === 'item' ? await d.lookupItem(miss.name) : await d.lookupMob(miss.name)
    await d.define({ domain: miss.domain, name: miss.name, entry })
    d.note(`data-server knowledge: fetched and defined ${miss.domain} ${miss.name}`)
    return 'defined'
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    d.note(`data-server knowledge: ${miss.domain} ${miss.name} could not be answered (${why})`)
    return 'refused'
  } finally {
    inFlight.delete(key)
  }
}

/**
 * THE LISTENER'S SHAPE — synchronous, because the client's frame dispatch is.
 *
 * The promise is voided rather than awaited for that reason, and `fetchAndDefine` is total, so
 * there is no rejection to lose.
 */
export function onKnowledgeMiss(miss: KnowledgeMissMessage): void {
  void fetchAndDefine(miss)
}
