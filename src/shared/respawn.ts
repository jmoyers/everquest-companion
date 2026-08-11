// RESPAWN CLOCKS — the vocabulary shared by the main-process module, the Timers view and the
// Timers overlay (JOS-194). Pure: no Electron, no node, no React. Unit-tested by
// tests/respawnTimers.test.mts.
//
// WHAT THE FEATURE IS. A mob dies, the log prints a sentence saying so, and this app starts a
// clock. The owner's direction was explicit about where the number on that clock comes from:
// "the wiki is a bad primary source — build CUSTOM TIMERS TRIGGERED ON DEATH MESSAGES, with the
// wiki respawn value as a floor/default only." So the estimate is a three-rung ladder and the
// rungs are ranked by how much the app actually knows:
//
//   1. YOUR NUMBER      — you typed it. Nothing outranks a user who camped the spot.
//   2. YOUR KILLS       — the shortest gap between two deaths of this mob that you were present
//                         for, floored by the wiki (below).
//   3. THE WIKI         — the default before rung 2 has any evidence, and the floor under it.
//
// WHAT A DEATH→DEATH GAP ACTUALLY PROVES, stated honestly because the UI states it too. You
// cannot kill a mob before it spawns, so every gap you observe is `respawn + however long you
// took to find and re-kill it`. A gap is therefore an UPPER BOUND on the respawn, never a
// measurement of it, and the tightest bound your kills can produce is the SMALLEST gap. That is
// why rung 2 is a minimum and not a mean or a median: the minimum converges downward onto the
// truth as you camp, where an average would sit permanently above it and drift with how
// distracted you were. Every surface that prints rung 2 prints it as "≤", with the sample count
// beside it.
//
// WHY ONLY GAPS YOU WERE PRESENT FOR (`sameStay`). An upper bound is only useful if it is tight,
// and a gap spanning "I killed it Tuesday and came back Friday" is a true bound of three days
// that tells nobody anything. The log states exactly the thing that separates the two cases —
// the zone lines — so a gap counts as a sample only when BOTH deaths fall inside one continuous
// stay in the zone. A camped respawn produces samples; a return visit produces none. No timeout,
// no heuristic: it is the same "evidence, not a clock" rule the offline-gap work landed on.
//
// WHY THE WIKI IS A FLOOR AND NOT A TIEBREAK. Two different spawns can print the SAME NAME — a
// placeholder camp with two spawn points, or plain trash like `a froglok guk shaman` standing in
// pairs — and when they die minutes apart your minimum gap collapses to something far below the
// real cycle. That is the one failure mode rung 2 has, and the wiki number is the cheap guard
// against it: the estimate is never allowed below what the wiki states. It is not consulted for
// anything else, and where the wiki says nothing (85% of the mobs in the dungeons this ticket
// targets — see respawnWiki.ts for the measurement) rung 2 stands alone.
//
// WHAT THE APP NEVER DOES. It never claims the mob IS up: it says the clock ran out. A spawn
// this app did not see cannot be reported, a placeholder cycle can put the trash mob there
// instead, and none of that is in the log. `due` means "the estimate elapsed" and every label
// says so (world-model law 1, and law 6's "say what the log cannot say").
//
// TRACKING IS OPT-IN, PER MOB (owner ruling, 2026-08-10, prototype round 1). There is no rule
// that clocks a mob you did not ask about — not even "anything the wiki states a duration for",
// which is what the first prototype shipped and what the owner threw out after using it. The
// argument is the game's, not the UI's: EQ names are massively DUPLICATED (`a froglok guk
// shaman` is dozens of unrelated spawn points across four zones, and a name that means one mob
// in Befallen means trash in Guk), so a clock the player did not choose is a clock about a mob
// the app cannot identify. Clocking everything the wiki knows therefore produces confident
// countdowns for things nobody is camping. So: the Recently-killed panel is the DISCOVERY
// surface — it lists what has died, which costs nothing and claims nothing — and a clock exists
// only once the player clicks Watch or types a number. The wiki keeps both of its remaining
// jobs (the default estimate for a watched mob you have no gap for yet, and the floor under the
// gaps you do have); what it lost is the power to ADMIT a mob on its own.
//
// THE DISPLAY IS ZONE-SCOPED, THE DATA IS NOT (owner ruling, same round). The fold keeps every
// (zone, mob) it has seen — walking away from Guk must not throw away what Guk taught — but a
// respawn clock is only actionable where you are standing, and the overlay showing a mob due in
// a zone three loading screens away is noise on top of the game. So the surfaces FILTER by the
// zone the fold is currently in (`RespawnSnap.zone`, which is the module's own zone-stay state —
// the same field that decides whether a gap counts, never a second tracker): the floating window
// shows that zone and nothing else, and the Timers tab defaults to it with an explicit all-zones
// view for editing. `respawnInZone` below is the ONE comparison both surfaces call.

/** Which rung of the ladder produced the estimate on a row. `'none'` = no rung had anything. */
export type RespawnSource = 'custom' | 'observed' | 'wiki' | 'none'

/** The shape version — bumped when a renderer holding an older baseline must re-hydrate. */
export const RESPAWN_SHAPE_VERSION = 1

/**
 * How long a row lingers after its clock runs out before the module drops it. A respawn that
 * elapsed an hour ago is not a timer any more, it is history, and history belongs on the mob
 * page. Rows with no estimate at all count UP and use this against their elapsed time instead.
 */
export const RESPAWN_LINGER_MS = 30 * 60 * 1000

/** Most rows the module will publish. Bounded because a dungeon prints a lot of death lines. */
export const RESPAWN_MAX_ROWS = 60

/** Most recently-killed mobs offered as watch candidates in the view. */
export const RESPAWN_MAX_RECENT = 40

// ─────────────────────────────────────────────────────────────────────────────
// PREFERENCES (electron-store, additive optional key — no migration)
// ─────────────────────────────────────────────────────────────────────────────

/** One mob the user has chosen to watch, and the number they chose for it. */
export interface RespawnWatchPref {
  /** Canonical (lowercased) mob name — what a death line's name canonicalizes to. */
  key: string
  /** The name as the log printed it, for display. */
  display: string
  /** The user's own respawn, in SECONDS. Rung 1; absent means "use what you learn". */
  customSec?: number
}

export interface RespawnPrefs {
  /**
   * The mobs the player asked for, and the ONLY mobs that get a clock. An empty list means no
   * clocks at all, which is what a fresh install has and what it keeps until somebody clicks
   * Watch — see the opt-in paragraph in the header for why there is no rule that fills this in.
   */
  watches: RespawnWatchPref[]
}

export const DEFAULT_RESPAWN_PREFS: RespawnPrefs = { watches: [] }

/** Longest custom respawn the editor accepts (a week), and the shortest (one second). */
export const RESPAWN_CUSTOM_MIN_SEC = 1
export const RESPAWN_CUSTOM_MAX_SEC = 7 * 24 * 3600

/** Most watches a user may keep. Bounded for the same reason every store list here is. */
export const RESPAWN_MAX_WATCHES = 200

/**
 * Normalize whatever came out of the store or in over IPC. Runs at BOTH ends — the store reader
 * and the IPC handler — so a renderer can never write a shape the module then has to defend
 * against. Unknown fields are dropped rather than carried, which is also how the retired
 * `autoWiki` flag leaves: a store written by the prototype build loads here as its watch list and
 * nothing else, so the ruling that removed auto-watch takes effect on the next read with no
 * migration to write.
 */
export function normalizeRespawnPrefs(raw: unknown): RespawnPrefs {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_RESPAWN_PREFS, watches: [] }
  const obj = raw as Partial<RespawnPrefs>
  const seen = new Set<string>()
  const watches: RespawnWatchPref[] = []
  for (const w of Array.isArray(obj.watches) ? obj.watches : []) {
    const clean = normalizeWatch(w)
    if (!clean || seen.has(clean.key)) continue
    seen.add(clean.key)
    watches.push(clean)
    if (watches.length >= RESPAWN_MAX_WATCHES) break
  }
  return { watches }
}

function normalizeWatch(raw: unknown): RespawnWatchPref | null {
  if (typeof raw !== 'object' || raw === null) return null
  const w = raw as Partial<RespawnWatchPref>
  const display = typeof w.display === 'string' ? w.display.trim().slice(0, 64) : ''
  const key = typeof w.key === 'string' ? w.key.trim().toLowerCase().slice(0, 64) : ''
  if (key.length === 0) return null
  const out: RespawnWatchPref = { key, display: display.length > 0 ? display : key }
  const sec = typeof w.customSec === 'number' && Number.isFinite(w.customSec) ? Math.round(w.customSec) : 0
  if (sec >= RESPAWN_CUSTOM_MIN_SEC && sec <= RESPAWN_CUSTOM_MAX_SEC) out.customSec = sec
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ESTIMATE LADDER
// ─────────────────────────────────────────────────────────────────────────────

/** Everything known about one mob's respawn, before the ladder picks a rung. */
export interface RespawnEvidence {
  /** Rung 1 — the user's own number, in ms. */
  customMs?: number
  /** Rung 2 — the SMALLEST same-stay death→death gap, in ms. */
  observedMs?: number
  /** How many same-stay gaps back `observedMs`. Zero when there are none. */
  samples: number
  /** Rung 3 — the wiki's stated duration, in ms. Absent when it states none. */
  wikiMs?: number
}

export interface RespawnEstimate {
  /** The countdown length. Absent when no rung had anything — the row then counts UP. */
  estimateMs?: number
  source: RespawnSource
}

/**
 * Pick the rung. See the header for why rung 2 is floored by rung 3 rather than averaged with it,
 * and why a user's own number is never floored at all (they are looking at the spawn; the wiki is
 * describing a different server).
 */
export function resolveRespawn(ev: RespawnEvidence): RespawnEstimate {
  if (ev.customMs !== undefined && ev.customMs > 0) return { estimateMs: ev.customMs, source: 'custom' }
  if (ev.observedMs !== undefined && ev.observedMs > 0 && ev.samples > 0) {
    const floored = ev.wikiMs !== undefined ? Math.max(ev.observedMs, ev.wikiMs) : ev.observedMs
    return { estimateMs: floored, source: 'observed' }
  }
  if (ev.wikiMs !== undefined && ev.wikiMs > 0) return { estimateMs: ev.wikiMs, source: 'wiki' }
  return { source: 'none' }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ROW
// ─────────────────────────────────────────────────────────────────────────────

/** One live respawn clock. Carries its own `diedTs` so the renderer ticks with no IPC at all. */
export interface RespawnRow {
  /** Stable across ticks — React key and e2e selector. `<zone key>::<mob key>`. */
  id: string
  /** Canonical mob name. */
  key: string
  /** The name as the death line printed it. */
  display: string
  /** The zone you were standing in when it died. Empty when the scan had seen no zone line. */
  zone: string
  /** The death line's OWN timestamp, in ms. Never a wall clock read at fold time. */
  diedTs: number
  estimateMs?: number
  source: RespawnSource
  /** Rung 2's raw bound, kept beside `estimateMs` so the UI can show when the floor lifted it. */
  observedMs?: number
  samples: number
  /** The wiki's verbatim text, when it has one — shown as-is, including "Triggered" and "?". */
  wikiText?: string
  wikiMs?: number
  /** How many deaths of this mob this fold has counted in this zone. */
  kills: number
}

/** A mob you recently killed, offered in the view as a one-click watch. */
export interface RespawnCandidate {
  key: string
  display: string
  zone: string
  lastTs: number
  kills: number
  watched: boolean
  wikiText?: string
  wikiMs?: number
}

export interface RespawnSnap {
  v: number
  /** The zone the fold is currently in, for the view's header. */
  zone: string
  rows: RespawnRow[]
  recent: RespawnCandidate[]
  prefs: RespawnPrefs
}

/**
 * The delta is a WHOLE snapshot. Rows are bounded at RESPAWN_MAX_ROWS and change on nearly every
 * death anyway, so a per-row merge would buy nothing and cost a second definition of the state.
 */
export type RespawnDelta = RespawnSnap

export const EMPTY_RESPAWN_SNAP: RespawnSnap = {
  v: RESPAWN_SHAPE_VERSION,
  zone: '',
  rows: [],
  recent: [],
  prefs: DEFAULT_RESPAWN_PREFS
}

export function respawnBaselineStale(state: RespawnSnap, delta: RespawnDelta): boolean {
  return state.v !== delta.v
}

export function mergeRespawnDelta(_state: RespawnSnap, delta: RespawnDelta): RespawnSnap {
  return delta
}

// ─────────────────────────────────────────────────────────────────────────────
// SCOPING THE DISPLAY TO ONE ZONE (owner ruling — see the header)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The zone comparison key: trimmed and lowercased, the same canonicalization `idKey` applies to
 * every other dirty name in this app (world-model law 2 — canonicalize at boundaries, display
 * raw). Spelled here rather than imported because this file is pure and `idKey` lives in the
 * main-process parser; the two agree by rule, and a row's `id` is built from `idKey(zone)` on the
 * far side of that rule.
 */
export function respawnZoneKey(zone: string): string {
  return zone.trim().toLowerCase()
}

/**
 * Everything from one zone, in order, out of a list of rows or candidates.
 *
 * THE EMPTY ZONE IS A ZONE — its own bucket, not a wildcard. Before the fold has seen any
 * `You have entered` line the snapshot's zone is `''` and so is every row's, so an unplaced kill
 * shows while the app is still unplaced and vanishes the moment a zone line says where you are.
 * The alternative (treat unknown as "show everything") would put the exact cross-zone list the
 * owner rejected on screen for the first seconds of every launch, and the opposite (show nothing)
 * would hide rows that are, as far as anything knows, right here.
 *
 * A DUE CLOCK IN ANOTHER ZONE IS STILL ANOTHER ZONE'S. Nothing about `due` widens this filter: a
 * mob that came up in Guk while you are in Befallen is not something you can act on, and the row
 * is waiting in the tab's all-zones view (and in the fold) for when you go back.
 */
export function respawnInZone<T extends { zone: string }>(items: readonly T[], zone: string): T[] {
  const want = respawnZoneKey(zone)
  return items.filter((i) => respawnZoneKey(i.zone) === want)
}

// ─────────────────────────────────────────────────────────────────────────────
// READING A ROW AGAINST THE CLOCK
// ─────────────────────────────────────────────────────────────────────────────

export interface RespawnReading {
  /** How long since it died. */
  elapsedMs: number
  /** How long the estimate has left. Absent when the row has no estimate. */
  remainingMs?: number
  /** Share of the estimate still to run, 1 → 0. Zero when there is no estimate. */
  fraction: number
  /** The estimate elapsed. Never a claim that the mob is standing there. */
  due: boolean
  /** How long ago it came due. Zero until it does. */
  overdueMs: number
}

export function respawnReading(row: RespawnRow, nowMs: number): RespawnReading {
  const elapsedMs = Math.max(0, nowMs - row.diedTs)
  if (row.estimateMs === undefined || row.estimateMs <= 0) {
    return { elapsedMs, fraction: 0, due: false, overdueMs: 0 }
  }
  const left = row.estimateMs - elapsedMs
  return {
    elapsedMs,
    remainingMs: left > 0 ? left : 0,
    fraction: Math.min(1, Math.max(0, left / row.estimateMs)),
    due: left <= 0,
    overdueMs: left < 0 ? -left : 0
  }
}

/**
 * Has this row outlived its usefulness? A clock that ran out half an hour ago is not telling you
 * to go look any more. Rows with no estimate are judged on elapsed time by the same window.
 */
export function respawnRowExpired(row: RespawnRow, nowMs: number): boolean {
  const r = respawnReading(row, nowMs)
  if (row.estimateMs === undefined) return r.elapsedMs > RESPAWN_LINGER_MS
  return r.overdueMs > RESPAWN_LINGER_MS
}

/**
 * Display order: soonest due first, then the ones with no estimate. Ties break on name so the
 * list never shuffles under a re-render.
 *
 * There is no "pinned first" tier any more, and there is nothing to be pinned ABOVE: every row on
 * screen is a mob the player asked for by name (the opt-in ruling in the header), so a rank that
 * says "this one was your idea" would sort every row into the same bucket.
 */
export function orderRespawnRows(rows: readonly RespawnRow[], nowMs: number): RespawnRow[] {
  return [...rows].sort((a, b) => {
    const ra = respawnReading(a, nowMs)
    const rb = respawnReading(b, nowMs)
    const ka = ra.remainingMs ?? Number.POSITIVE_INFINITY
    const kb = rb.remainingMs ?? Number.POSITIVE_INFINITY
    if (ka !== kb) return ka - kb
    return a.display.localeCompare(b.display)
  })
}

/**
 * Did the wiki floor LIFT this row's estimate above what your own kills said? True only when both
 * numbers exist and the wiki's is the larger — i.e. when the guard in the header actually fired.
 */
export function respawnFloored(row: RespawnRow): boolean {
  if (row.source !== 'observed') return false
  return row.observedMs !== undefined && row.wikiMs !== undefined && row.wikiMs > row.observedMs
}

/** The one-line provenance the UI prints beside a row. Written once, shown on every surface. */
export function respawnSourceLabel(row: RespawnRow): string {
  if (row.source === 'custom') return 'your number'
  if (row.source === 'observed') {
    const n = row.samples === 1 ? '1 gap' : `${String(row.samples)} gaps`
    return respawnFloored(row) ? `your kills (${n}), floored by the wiki` : `your kills (${n})`
  }
  if (row.source === 'wiki') return 'wiki default'
  return 'no estimate yet'
}

/**
 * THE NUMBER ON THE CLOCK, worded once for every surface that draws one — the Timers tab and the
 * floating window both call this, so a countdown can never read one way in the app and another way
 * over the game.
 *
 * `fmt` is injected because the app's ONE duration formatter lives in the renderer
 * (features/buffs/format.ts) and this module is pure. Injecting it is what keeps that rule — one
 * formatter — from being broken by a second spelling written down here.
 */
export function respawnClockLabel(
  row: RespawnRow,
  nowMs: number,
  fmt: (ms: number | null | undefined) => string
): string {
  const r = respawnReading(row, nowMs)
  if (row.estimateMs === undefined) return `+${fmt(r.elapsedMs)}`
  return r.due ? `due ${fmt(r.overdueMs)} ago` : fmt(r.remainingMs ?? 0)
}
