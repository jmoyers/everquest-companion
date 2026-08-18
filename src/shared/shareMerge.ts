// shareMerge.ts — the APPLY half of settings sharing: how an incoming bundle combines with
// what you already have. The additive law ("an import NEVER deletes or replaces what you
// already have") is enforced here, in `planAlertMerge`/`applyAlertMerge` for alerts and in
// `planScalarChanges` for the settings that cannot be merged additively at all.
//
// Split out of src/shared/profiles.ts (which had grown past the 400-code-line factoring
// ceiling) with the rules unchanged. `shared/profiles` re-exports every name here, so it is
// still the one import site for consumers and no import path changed.

import type { AlertDef, OverlayKind, AlertPrefs } from './types'
import { OVERLAY_KIND_LABEL } from './overlayLabels'
import {
  DEFAULT_OVERLAY_BG_ALPHA,
  deriveBgAlphaPrefs,
  normalizeOverlayBgAlpha,
  type OverlayBgAlphaPrefs
} from './overlayBgAlpha'
import {
  canonicalJson,
  checksum,
  sanitizeAlertDef,
  EXPORTABLE_OVERLAY_KINDS,
  SHARE_LIMITS,
  UI_PREF_SPECS,
  type SettingsBundleBody,
  type UiPrefMerge,
  type UiPrefSpec
} from './shareSchema'

/**
 * The BEHAVIOR fingerprint of an alert: what it listens for and what it plays. Name, note
 * and enabled state are deliberately EXCLUDED — two alerts that fire on the same thing with
 * the same sound ARE the same alert however they're labelled, so:
 *   - re-importing the same string twice is a no-op (idempotent),
 *   - a friend's set that overlaps yours doesn't spam duplicate sounds,
 *   - renaming your copy doesn't make the next import duplicate it.
 */
export function alertBehaviorKey(def: AlertDef): string {
  return checksum(
    canonicalJson({
      trigger: def.trigger,
      sound: def.sound,
      volume: def.volume ?? 1,
      cooldownMs: def.cooldownMs ?? 2000
    })
  )
}

export type AlertMergeAction = 'add' | 'rekey' | 'skip'

/** One planned import. The UI renders these as the preview; apply consumes the same list. */
export interface AlertMergeItem {
  /** the sanitized incoming def, EXCEPT id/name which become finalId/finalName */
  incoming: AlertDef
  action: AlertMergeAction
  /** id it will be stored under (differs from incoming.id only when action === 'rekey') */
  finalId: string
  /** name it will be stored under (suffixed only on a same-name/different-behavior clash) */
  finalName: string
  /** why — shown in the preview so the user can see nothing is being overwritten */
  reason: string
  /** set when the alert's sound pack is not installed here; the alert still imports */
  missingPackId?: string
  behaviorKey: string
}

/**
 * CONFLICT RULES (additive by law — nothing existing is ever modified or deleted):
 *
 *   same behavior already present   → SKIP. You already have this alert; a second copy
 *                                     would just double the sound. Makes import idempotent.
 *   same id, different behavior     → REKEY to `<id>~<behaviorKey4>` and keep BOTH. Ids
 *                                     like 'charm-break' are seeded identically for every
 *                                     user, so an id collision means "different objects,
 *                                     colliding namespace", never "same object". The suffix
 *                                     is derived from the behavior (not a random or a
 *                                     counter) so importing the SAME string twice lands on
 *                                     the same id and the second pass skips.
 *   otherwise                       → ADD under its own id, preserving it across the hop so
 *                                     round-tripping a set is stable.
 *
 * Name clashes never affect identity; a colliding name just gets " (imported)" appended so
 * the list stays readable.
 *
 * MISSING SOUND PACK: if the sound's packId isn't installed, the alert is STILL imported —
 * flagged, with the pack name surfaced so the user can install it from the registry
 * browser. We never silently re-point it at a default (that would fabricate the sender's
 * intent) and never silently drop it (that would mute it invisibly).
 */
export function planAlertMerge(
  existing: readonly AlertDef[],
  incoming: readonly AlertDef[],
  installedPackIds: Iterable<string>
): AlertMergeItem[] {
  const installed = new Set(installedPackIds)
  const byBehavior = new Map<string, AlertDef>()
  const byId = new Map<string, AlertDef>()
  const names = new Set<string>()
  for (const a of existing) {
    byBehavior.set(alertBehaviorKey(a), a)
    byId.set(a.id, a)
    names.add(a.name.toLowerCase())
  }

  const out: AlertMergeItem[] = []
  for (const raw of incoming.slice(0, SHARE_LIMITS.maxAlerts)) {
    const def = sanitizeAlertDef(raw)
    if (!def) continue
    const behaviorKey = alertBehaviorKey(def)
    const missingPackId = installed.size && !installed.has(def.sound.packId) ? def.sound.packId : undefined

    const twin = byBehavior.get(behaviorKey)
    if (twin) {
      out.push({
        incoming: def,
        action: 'skip',
        finalId: twin.id,
        finalName: twin.name,
        reason: `Already have this - “${twin.name}”`,
        missingPackId,
        behaviorKey
      })
      continue
    }

    let finalId = def.id
    let action: AlertMergeAction = 'add'
    let reason = 'New alert'
    if (byId.has(finalId)) {
      finalId = `${def.id}~${behaviorKey.slice(0, 4)}`
      action = 'rekey'
      reason = `Id “${def.id}” is taken by a different alert - imported alongside it`
    }

    let finalName = def.name
    if (names.has(finalName.toLowerCase())) finalName = `${def.name} (imported)`

    // Reserve so two incoming alerts in the SAME payload can't collide with each other.
    byBehavior.set(behaviorKey, { ...def, id: finalId, name: finalName })
    byId.set(finalId, { ...def, id: finalId, name: finalName })
    names.add(finalName.toLowerCase())

    out.push({ incoming: def, action, finalId, finalName, reason, missingPackId, behaviorKey })
  }
  return out
}

/**
 * Apply a plan. `selected` (by finalId) makes import per-item opt-in; omit it to take
 * everything. Skips are never applied. The existing list is returned UNTOUCHED at its head —
 * additions are appended, so ordering (and therefore the user's mental model) is preserved.
 */
export function applyAlertMerge(
  existing: readonly AlertDef[],
  plan: readonly AlertMergeItem[],
  selected?: ReadonlySet<string>
): { alerts: AlertDef[]; added: number; skipped: number; rekeyed: number } {
  const next = [...existing]
  let added = 0
  let rekeyed = 0
  let skipped = 0
  for (const item of plan) {
    if (item.action === 'skip') {
      skipped++
      continue
    }
    if (selected && !selected.has(item.finalId)) {
      skipped++
      continue
    }
    next.push({ ...item.incoming, id: item.finalId, name: item.finalName })
    added++
    if (item.action === 'rekey') rekeyed++
  }
  return { alerts: next, added, skipped, rekeyed }
}

// ------------------------------------------------------------------ scalar (opt-in) changes

/**
 * A setting that CANNOT be merged additively — a volume, a mute flag, a density. Importing
 * one necessarily replaces yours, so each is surfaced individually in the preview with your
 * current value beside the incoming one, and is OFF by default. The user opts in per row.
 */
export interface ScalarChange {
  /** stable address, e.g. 'alertPrefs.globalVolume' | 'overlay.fight.bgAlpha' | 'ui.eq.favorites' */
  id: string
  label: string
  current: string
  incoming: string
  /** 'union' rows are additive (lists) and default to ON; 'replace' rows default to OFF */
  merge: UiPrefMerge
}

/** Current values the preview compares against (main + renderer both contribute). */
export interface ScalarContext {
  alertPrefs: AlertPrefs
  overlays: Partial<Record<OverlayKind, { bgAlpha: number }>>
  /** The shared transparency preference (JOS-407). Optional: a caller that predates it — every
   *  test written before this ticket — compares against the shipped answer. */
  overlayBgAlpha?: OverlayBgAlphaPrefs
  ui: Record<string, string>
}

/**
 * THE TRANSPARENCY PREFERENCE A BUNDLE IS ASKING FOR, INCLUDING WHEN IT DOES NOT SAY (JOS-407).
 *
 * A bundle written by 1.5.0 or later carries `overlayBgAlpha` and this simply reads it. An OLDER
 * bundle carries only per-kind alphas, and the honest reading of those is the same least-harm rule
 * the store's own upgrade uses (shared/overlayBgAlpha.ts `deriveBgAlphaPrefs`): if the sender's
 * overlays all agreed, they were asking for one transparency; if they differed, they were asking
 * for exactly those differences, which is independent mode. Either way the preview offers the
 * recipient the same two rows and the import cannot land in a state the sender's screen was not in.
 *
 * `null` means the bundle says nothing at all about transparency — no prefs and no overlays — and a
 * row is not offered. AN ABSENT KIND IS NOT A VOTE HERE, which is the one place this differs from
 * the store's derivation: a bundle carries what it carries (five kinds today), so a kind the sender
 * did not export is silence, not a window at 0.72.
 */
export function bodyBgAlphaPrefs(body: SettingsBundleBody): OverlayBgAlphaPrefs | null {
  if (body.overlayBgAlpha) return normalizeOverlayBgAlpha(body.overlayBgAlpha)
  const incoming = body.overlays
  if (!incoming) return null
  const alphas = EXPORTABLE_OVERLAY_KINDS.map((k) => incoming[k]?.bgAlpha).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v)
  )
  return alphas.length ? deriveBgAlphaPrefs(alphas) : null
}

// THE KIND LABELS ARE NOT THIS FILE'S ANY MORE (JOS-405).
//
// There were two maps — this one and the title bar's Overlay menu — and they DISAGREED about two
// windows: a bundle offered to change the opacity of an "Overall meter" and an "Event feed" that
// the menu, three inches away, calls the Zone meter and the Event log. Neither spelling was wrong;
// having two was, because an import preview is read beside the menu it describes.
//
// `shared/overlayLabels.ts` now holds the one map, in the MENU's wording — the name a user meets
// first, because it is what they clicked to make the window exist. It is keyed by the WHOLE union
// for the reason every row of the local copy said it was: kinds with no shared field today are
// named there too (only `EXPORTABLE_OVERLAY_KINDS` below decides what actually travels), so a
// future shared field can never render as a raw kind id.

/**
 * Everything a scalar row compares is a PRIMITIVE (a volume, a flag, a density, a JSON
 * string) — spelled out so the preview's rendering can never be an accidental
 * `[object Object]`.
 */
type ScalarValue = string | number | boolean | undefined

interface ScalarRowInput {
  id: string
  label: string
  current: ScalarValue
  incoming: ScalarValue
  merge: UiPrefMerge
}

/** Record a row only when the two sides genuinely differ, as the preview renders them. */
function pushScalar(out: ScalarChange[], row: ScalarRowInput): void {
  const current = String(row.current ?? '')
  const incoming = String(row.incoming ?? '')
  if (current !== incoming) {
    out.push({ id: row.id, label: row.label, current, incoming, merge: row.merge })
  }
}

function pushAlertPrefRows(out: ScalarChange[], body: SettingsBundleBody, ctx: ScalarContext): void {
  if (!body.alertPrefs) return
  pushScalar(out, {
    id: 'alertPrefs.globalVolume',
    label: 'Global alert volume',
    current: ctx.alertPrefs.globalVolume,
    incoming: body.alertPrefs.globalVolume,
    merge: 'replace'
  })
  pushScalar(out, {
    id: 'alertPrefs.muted',
    label: 'Mute all alerts',
    current: ctx.alertPrefs.muted,
    incoming: body.alertPrefs.muted,
    merge: 'replace'
  })
  // JOS-222. Absent on both sides means OFF on both sides, and pushScalar's String(x ?? '')
  // makes absent and false the same reading — so a bundle written before this preference existed
  // offers no row here, which is exactly right: it has no opinion to import.
  pushScalar(out, {
    id: 'alertPrefs.alwaysPlayAll',
    label: 'Always play all alerts',
    current: ctx.alertPrefs.alwaysPlayAll ?? false,
    incoming: body.alertPrefs.alwaysPlayAll ?? false,
    merge: 'replace'
  })
}

function pushOverlayRows(out: ScalarChange[], body: SettingsBundleBody, ctx: ScalarContext): void {
  for (const kind of EXPORTABLE_OVERLAY_KINDS) {
    const inc = body.overlays?.[kind]
    if (!inc) continue
    const cur = ctx.overlays?.[kind]
    pushScalar(out, {
      id: `overlay.${kind}.bgAlpha`,
      label: `${OVERLAY_KIND_LABEL[kind]} - background opacity`,
      current: cur?.bgAlpha,
      incoming: inc.bgAlpha,
      merge: 'replace'
    })
    // The other overlay row used to be `topN`, the 5-or-10 bar budget. It was retired (every row
    // renders, the pane scrolls), so a bundle that still carries it offers nothing to opt into.
  }
}

function pushUiPrefRows(out: ScalarChange[], body: SettingsBundleBody, ctx: ScalarContext): void {
  for (const spec of UI_PREF_SPECS) {
    const inc = body.ui?.[spec.key]
    if (inc === undefined) continue
    // A union that adds nothing is not a change worth showing — pushScalar drops it.
    const incoming = spec.merge === 'union' ? mergeUiPref(spec, ctx.ui?.[spec.key], inc) : inc
    pushScalar(out, {
      id: `ui.${spec.key}`,
      label: spec.label,
      current: ctx.ui?.[spec.key] ?? '',
      incoming,
      merge: spec.merge
    })
  }
}

/** How a transparency mode reads in a preview row. Not `true`/`false`: the row is a sentence a
 *  person opts into, and "Independent transparency per overlay: false → true" is not one. */
const alphaMode = (independent: boolean): string => (independent ? 'On' : 'Off')

/**
 * The overlays' shared TRANSPARENCY, as two rows (JOS-407): the alpha, and whether it is in force.
 *
 * TWO ROWS RATHER THAN ONE, because they are two decisions and this list is opt-in per row: a
 * person taking a friend's transparency should not have to take their independent-mode answer with
 * it, and vice versa.
 */
function pushBgAlphaRows(out: ScalarChange[], body: SettingsBundleBody, ctx: ScalarContext): void {
  const incoming = bodyBgAlphaPrefs(body)
  if (!incoming) return
  const current = ctx.overlayBgAlpha ?? DEFAULT_OVERLAY_BG_ALPHA
  pushScalar(out, {
    id: 'overlayBgAlpha.shared',
    label: 'Overlay transparency',
    current: `${String(Math.round(current.shared * 100))}%`,
    incoming: `${String(Math.round(incoming.shared * 100))}%`,
    merge: 'replace'
  })
  pushScalar(out, {
    id: 'overlayBgAlpha.independent',
    label: 'Independent transparency per overlay',
    current: alphaMode(current.independent),
    incoming: alphaMode(incoming.independent),
    merge: 'replace'
  })
}

/**
 * Diff a settings body against the current state; only genuinely different rows come back.
 *
 * THE PREFERENCE ROWS COME BEFORE THE PER-KIND ONES, and the order is load-bearing: turning
 * independent transparency on for the first time SEEDS every kind from the shared alpha
 * (main/storeOverlayBgAlpha.ts), so a per-kind value applied first would be overwritten moments
 * later by the mode row the same import selected. `applySelectedScalars` walks this list in order.
 */
export function planScalarChanges(body: SettingsBundleBody, ctx: ScalarContext): ScalarChange[] {
  const out: ScalarChange[] = []
  pushAlertPrefRows(out, body, ctx)
  pushBgAlphaRows(out, body, ctx)
  pushOverlayRows(out, body, ctx)
  pushUiPrefRows(out, body, ctx)
  return out
}

/**
 * Combine one UI pref value. 'union' parses both sides as JSON string arrays and unions
 * them (order-stable: yours first, then theirs) — nothing you had is dropped. Anything that
 * doesn't parse as an array falls back to 'replace' semantics rather than guessing.
 */
export function mergeUiPref(spec: UiPrefSpec, current: string | undefined, incoming: string): string {
  if (spec.merge !== 'union') return incoming
  const parse = (s: string | undefined): string[] | null => {
    if (!s) return []
    try {
      const v: unknown = JSON.parse(s)
      return Array.isArray(v) ? v.map((x) => String(x)) : null
    } catch {
      return null
    }
  }
  const mine = parse(current)
  const theirs = parse(incoming)
  if (mine === null || theirs === null) return incoming
  const seen = new Set(mine)
  const merged = [...mine]
  for (const t of theirs) {
    if (!seen.has(t)) {
      seen.add(t)
      merged.push(t)
    }
  }
  return JSON.stringify(merged)
}

/** The rows that are ON by default in the preview: additive unions, never scalar replaces. */
export function defaultSelectedScalars(changes: readonly ScalarChange[]): string[] {
  return changes.filter((c) => c.merge === 'union').map((c) => c.id)
}
