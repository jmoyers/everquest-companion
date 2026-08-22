// useFeedback — the feedback dialog's state, held apart from its markup (Task #65, §4.4).
//
// Three concerns, three hooks:
//   useFeedbackContext  the header context main pulls together (versions, channel, queued
//                       count, and whether this build has an endpoint compiled in at all).
//   useLogSlice         build/rebuild the scrubbed slice for the chosen window, plus the
//                       "Save a copy…" escape hatch. Only ever active for a bug report with
//                       the attachment ticked — a feature request never reads the log.
//   useInventoryDump    package the CURRENT `/outputfile inventory` dump for preview (JOS-296).
//                       Same gate as the slice, and same rule: a feature request never reads it.
//   useFeedback         the composed dialog state: draft + validation gate + submit outcome.
//
// The VALIDATION GATE is the point of `draftProblem`: it runs the SAME `validateDraft` the
// main process and (later) the Lambda run, so Send is never enabled for something the server
// would reject, and a round trip is never spent learning what we already knew. It is the one
// place the validator's result shape is read, so a contract tweak lands in one line.

import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_LOG_WINDOW,
  MAX_DESCRIPTION,
  validateDraft,
  type FeedbackDraft,
  type FeedbackType
} from '@shared/feedback'
import type { TelemetryEvent } from '@shared/telemetry'
import { CRASH_REPORT_KEY } from '../../lib/ErrorBoundary'
import { track, trackFeature } from '../../lib/telemetry'

/**
 * The BRIDGE's own reply shapes, derived from the bridge rather than re-declared.
 *
 * `src/shared/feedback.ts` owns the WIRE contract (draft, env, limits, validators) — the part
 * the renderer, main and the ingest Lambda all have to agree on. The three shapes below are
 * renderer-facing IPC replies, so they are declared beside the methods that return them
 * (`src/preload/index.ts`, the same place `ShareSaveResult` lives). The renderer cannot import
 * that file — tsconfig.web includes `src/preload/index.d.ts` only — and a second hand-written
 * copy of a contract is a contract that will eventually disagree with itself. So we read them
 * off `window.eq`, which index.d.ts does declare.
 */
type Bridge = Window['eq']
export type FeedbackContext = Awaited<ReturnType<Bridge['getFeedbackContext']>>
export type FeedbackSlicePreview = NonNullable<Awaited<ReturnType<Bridge['buildFeedbackSlice']>>>
export type FeedbackInventoryPreview = Awaited<ReturnType<Bridge['buildFeedbackInventory']>>
export type FeedbackAchievementsPreview = Awaited<ReturnType<Bridge['buildFeedbackAchievements']>>
export type SubmitResult = Awaited<ReturnType<Bridge['submitFeedback']>>

/** What the dialog is doing right now. `done` renders an outcome instead of the form. */
export type FeedbackPhase = 'compose' | 'sending' | 'done'

/** The four honest endings of a Send (§4.4 step 6). `closed` carries the SERVER's message. */
export interface FeedbackOutcome {
  kind: 'sent' | 'queued' | 'closed' | 'error'
  message: string
  reportId?: string
}

/** Seed values for an entry point that already knows something (ErrorBoundary → a bug). */
export interface FeedbackPrefill {
  type?: FeedbackType
  description?: string
}

// The dialog asks for the user's words and nothing else — title and contact were dropped
// (anyone who wants a follow-up puts their email/Discord in the body). The WIRE contract
// (src/shared/feedback.ts) still carries both as optionals; this client just never sends them.
interface DraftFields {
  type: FeedbackType
  description: string
}

const EMPTY: DraftFields = { type: 'feature', description: '' }

/** The typed fields as the contract wants them: trimmed. */
export function toDraft(f: DraftFields): FeedbackDraft {
  return {
    type: f.type,
    description: f.description.trim()
  }
}

/**
 * `null` when the draft is sendable, else the reason — from the SHARED validator, so the
 * button's enabled state and the server's answer can never disagree.
 */
export function draftProblem(draft: FeedbackDraft): string | null {
  const res = validateDraft(draft)
  return res.ok ? null : res.message
}

/** Pull the header context when the dialog opens. Null until it lands. */
export function useFeedbackContext(open: boolean): FeedbackContext | null {
  const [ctx, setCtx] = useState<FeedbackContext | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.eq.getFeedbackContext().then((c) => {
      if (alive) setCtx(c)
    })
    return () => {
      alive = false
    }
  }, [open])
  return ctx
}

export interface LogSliceState {
  slice: FeedbackSlicePreview | null
  loading: boolean
  saving: boolean
  savedPath: string | null
  saveCopy: () => void
}

/**
 * Build the slice for `windowMinutes` whenever the attachment is active. Main caches per
 * session, so re-ticking the checkbox is free; changing the window is a fresh build.
 */
export function useLogSlice(active: boolean, windowMinutes: number): LogSliceState {
  const [slice, setSlice] = useState<FeedbackSlicePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let alive = true
    setLoading(true)
    setSavedPath(null)
    void window.eq
      .buildFeedbackSlice(windowMinutes)
      .then((s) => {
        if (alive) setSlice(s)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [active, windowMinutes])

  const saveCopy = useCallback(() => {
    setSaving(true)
    void window.eq
      .saveFeedbackSlice(windowMinutes)
      .then((r) => {
        if (r.ok && r.path) setSavedPath(r.path)
      })
      .finally(() => {
        setSaving(false)
      })
  }, [windowMinutes])

  return { slice, loading, saving, savedPath, saveCopy }
}

/**
 * Package the current inventory dump whenever the attachment is active (JOS-296).
 *
 * NO CACHE AND NO KEY, unlike `useLogSlice`: main re-reads the file on every call on purpose
 * (see `currentInventory`'s header), because the player may re-run `/outputfile inventory` while
 * the dialog is open and the whole point of the attachment is that it is the CURRENT export.
 * `refresh` is what a "re-read it" affordance calls; the reply always carries either a dump or
 * the named reason there is none, so there is no third "unknown" state to render.
 */
export interface DumpPreviewState<T> {
  dump: T | null
  loading: boolean
  refresh: () => void
}

/**
 * ONE HOOK BODY FOR BOTH DUMPS (JOS-441). The nonce-driven re-read, the alive guard and the
 * loading flag are facts about "packaging a file main owns while a dialog is open", not about
 * which file — so the second attachment took a call argument rather than a copied hook.
 */
function useDumpPreview<T>(active: boolean, build: () => Promise<T>): DumpPreviewState<T> {
  const [dump, setDump] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!active) return
    let alive = true
    setLoading(true)
    void build()
      .then((d) => {
        if (alive) setDump(d)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // `build` is a stable bridge call in both callers; re-reading is driven by `active`/`nonce`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, nonce])

  const refresh = useCallback((): void => {
    setNonce((n) => n + 1)
  }, [])

  return { dump, loading, refresh }
}

export type InventoryDumpState = DumpPreviewState<FeedbackInventoryPreview>

export function useInventoryDump(active: boolean): InventoryDumpState {
  return useDumpPreview(active, () => window.eq.buildFeedbackInventory())
}

export type AchievementsDumpState = DumpPreviewState<FeedbackAchievementsPreview>

export function useAchievementsDump(active: boolean): AchievementsDumpState {
  return useDumpPreview(active, () => window.eq.buildFeedbackAchievements())
}

/** The sentence for each way of having no dump. Pure, so the wording is testable and so the
 *  `/outputfile inventory` command appears in exactly one place in the renderer. */
export function inventoryProblem(reason: FeedbackInventoryPreview['unavailable']): string {
  switch (reason) {
    case 'no-dump':
      return 'No inventory export on this machine yet - type /outputfile inventory in game, then re-open this dialog.'
    case 'unreadable':
      return 'Your inventory export could not be read - nothing would be attached.'
    case 'empty':
      return 'Your inventory export is empty - nothing would be attached.'
    case 'too-large':
      return 'Your inventory export is too large to send. It is not trimmed, because half an inventory reads as a wrong one.'
    default:
      return ''
  }
}

/** The same four sentences for the achievements dump (JOS-441), naming its own command. Kept as
 *  a second function rather than a parameterised one because every sentence differs in more than
 *  the noun, and the `no-dump` line is the one that TEACHES the command. */
export function achievementsProblem(reason: FeedbackInventoryPreview['unavailable']): string {
  switch (reason) {
    case 'no-dump':
      return 'No achievements export on this machine yet - type /outputfile achievements in game, then re-open this dialog.'
    case 'unreadable':
      return 'Your achievements export could not be read - nothing would be attached.'
    case 'empty':
      return 'Your achievements export is empty - nothing would be attached.'
    case 'too-large':
      return 'Your achievements export is too large to send. It is not trimmed, because a partial one can drop the very rows that explain the bug.'
    default:
      return ''
  }
}

/**
 * What the attachment lines say once a Send has landed. Pure, and the one place the booleans are
 * turned into English, so a report with three attachments cannot claim only one.
 *
 * BUILT AS A LIST RATHER THAN AS A TRUTH TABLE (JOS-441). Two attachments were four branches;
 * three would be eight, and four would be sixteen — a shape that grows like that is the wrong
 * shape. The wording of the one- and two-attachment cases is unchanged, which is what the tests
 * that predate this pin.
 */
export function sentMessage(
  logUploaded: boolean,
  inventoryUploaded: boolean,
  achievementsUploaded: boolean
): string {
  const parts = [
    ...(logUploaded ? ['its log slice'] : []),
    ...(inventoryUploaded ? ['your inventory export'] : []),
    ...(achievementsUploaded ? ['your achievements export'] : [])
  ]
  if (parts.length === 0) return 'Thanks - your report is in.'
  if (parts.length === 1) return `Thanks - your report and ${parts[0]} are in.`
  const last = parts[parts.length - 1]
  return `Thanks - your report, ${parts.slice(0, -1).join(', ')} and ${last} are in.`
}

/** Map the typed submit result onto the outcome the dialog renders. Never throws. */
export function toOutcome(res: SubmitResult): FeedbackOutcome {
  if (res.ok) {
    return {
      kind: 'sent',
      reportId: res.reportId,
      message: sentMessage(res.logUploaded, res.inventoryUploaded, res.achievementsUploaded)
    }
  }
  if (res.queued) {
    return { kind: 'queued', message: "Saved - we'll send it next time you're online." }
  }
  return { kind: res.error === 'closed' ? 'closed' : 'error', message: res.message }
}

/**
 * Step 3 of the feedback funnel (usage-analytics §3), or `null` for an ending that filed
 * nothing. `sent` and `queued` both close it: a queued report EXISTS on disk and goes out on the
 * next connection, so "did the press end in a filed report" is yes for both.
 *
 * A FAILED send emits nothing, deliberately, and both halves of that are constraints:
 *   * the readout SUMS a step's count across outcomes (`countSteps`, main/triage/analytics.ts),
 *     so a `sendFinished` carrying `outcome:'failed'` would count itself into the very bar the
 *     gap from `sendPressed` is supposed to measure;
 *   * `failureClass` cannot pay for it either. The schema's enum is network/checksum/disk/
 *     timeout/other and it is CLOSED (widening it is a wire change the server validates); a
 *     network failure already resolves as `queued`, so every remaining feedback failure — a
 *     rejection, a full queue, a dark build — would land on 'other'. A constant says nothing
 *     `outcome` does not.
 */
export function sendFinishedStep(outcome: FeedbackOutcome): TelemetryEvent | null {
  if (outcome.kind !== 'sent' && outcome.kind !== 'queued') return null
  return {
    t: 'funnelStep',
    funnel: 'feedback',
    step: 'sendFinished',
    outcome: outcome.kind === 'sent' ? 'ok' : 'queued'
  }
}

/**
 * The crash the ErrorBoundary parked before reloading, as a bug prefill — read ONCE and
 * cleared, so a later reload never re-opens a report for a crash that is already filed.
 * Everything is defensive: the value is JSON we wrote, but it survived a process the whole
 * point of which is that something went wrong.
 */
function readCrashPrefill(): FeedbackPrefill | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(CRASH_REPORT_KEY)
    if (raw !== null) sessionStorage.removeItem(CRASH_REPORT_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const v = parsed as { message?: unknown; stack?: unknown }
  const message = typeof v.message === 'string' ? v.message : ''
  const stack = typeof v.stack === 'string' ? v.stack : ''
  if (!message && !stack) return null
  // Truncated to the contract's own ceiling: a prefill the SHARED validator would reject is a
  // Send button that can never light up, which reads as the report form being broken too.
  return {
    type: 'bug',
    description: `The app hit a render error and I reloaded it.\n\n${message}\n\n${stack}`.slice(
      0,
      MAX_DESCRIPTION
    )
  }
}

export interface FeedbackDialogControl {
  open: boolean
  prefill: FeedbackPrefill | undefined
  openFeedback: (prefill?: FeedbackPrefill) => void
  close: () => void
}

/**
 * App-level ownership of the dialog: who has it open and what it was seeded with. Also the one
 * place the ErrorBoundary's parked crash is picked up — App.tsx mounts once per reload, which
 * is exactly when a "Report this" reload arrives.
 */
export function useFeedbackDialog(): FeedbackDialogControl {
  const [open, setOpen] = useState(false)
  const [prefill, setPrefill] = useState<FeedbackPrefill | undefined>(undefined)

  useEffect(() => {
    const crash = readCrashPrefill()
    if (!crash) return
    setPrefill(crash)
    setOpen(true)
  }, [])

  const openFeedback = useCallback((p?: FeedbackPrefill): void => {
    setPrefill(p)
    setOpen(true)
    // usage-analytics §2/§3: reach ("did anyone find this at all") and the first step of the
    // feedback funnel, whose interesting number is the GAP between opened and sent. Both are
    // counts with no content attached — the schema has no field the description could go in.
    trackFeature('feedbackOpen')
    track({ t: 'funnelStep', funnel: 'feedback', step: 'dialogOpened' })
  }, [])
  const close = useCallback((): void => {
    setOpen(false)
  }, [])

  return { open, prefill, openFeedback, close }
}

export interface FeedbackState {
  fields: DraftFields
  setField: <K extends keyof DraftFields>(key: K, value: DraftFields[K]) => void
  setType: (t: FeedbackType) => void
  attachLog: boolean
  setAttachLog: (v: boolean) => void
  windowMinutes: number
  setWindowMinutes: (m: number) => void
  attachInventory: boolean
  setAttachInventory: (v: boolean) => void
  attachAchievements: boolean
  setAttachAchievements: (v: boolean) => void
  draft: FeedbackDraft
  problem: string | null
  phase: FeedbackPhase
  outcome: FeedbackOutcome | null
  send: () => void
}

/**
 * The dialog's whole state machine. Everything resets when the dialog OPENS (never on close —
 * the closing animation would visibly wipe the outcome the user is still reading).
 */
export function useFeedback(open: boolean, prefill?: FeedbackPrefill): FeedbackState {
  const [fields, setFields] = useState<DraftFields>(EMPTY)
  const [attachLog, setAttachLog] = useState(false)
  const [windowMinutes, setWindowMinutes] = useState<number>(DEFAULT_LOG_WINDOW)
  const [attachInventory, setAttachInventory] = useState(false)
  const [attachAchievements, setAttachAchievements] = useState(false)
  const [phase, setPhase] = useState<FeedbackPhase>('compose')
  const [outcome, setOutcome] = useState<FeedbackOutcome | null>(null)

  useEffect(() => {
    if (!open) return
    const type = prefill?.type ?? 'feature'
    setFields({
      ...EMPTY,
      type,
      description: prefill?.description ?? ''
    })
    // Bug reports attach the log BY DEFAULT — it is the whole point of a bug report.
    setAttachLog(type === 'bug')
    setWindowMinutes(DEFAULT_LOG_WINDOW)
    // …and the inventory export too, by explicit owner ruling (JOS-296). The export-dependent
    // bugs — Sky quest recognition, ownership, held counts — are un-answerable without it, and
    // a default-off box on a diagnostic attachment is a box nobody ticks. It is DEFAULT, not
    // silent: the checkbox is visible, states what it sends, and is one click to clear.
    setAttachInventory(type === 'bug')
    // …and the achievements export on the same terms (JOS-441). ITS OWN BOX, not a shared one:
    // these are two different files with two different disclosures, and one "send my exports"
    // tick would be consent to something the user was never shown.
    setAttachAchievements(type === 'bug')
    setPhase('compose')
    setOutcome(null)
  }, [open, prefill])

  const setField = useCallback(
    <K extends keyof DraftFields>(key: K, value: DraftFields[K]): void => {
      setFields((f) => ({ ...f, [key]: value }))
    },
    []
  )

  // A type switch re-arms the attachment default rather than remembering the last answer:
  // "Bug report" means "attach my log" unless this bug report says otherwise.
  const setType = useCallback((t: FeedbackType): void => {
    setFields((f) => ({ ...f, type: t }))
    setAttachLog(t === 'bug')
    setAttachInventory(t === 'bug')
    setAttachAchievements(t === 'bug')
  }, [])

  const draft = toDraft(fields)
  const problem = draftProblem(draft)

  const send = useCallback((): void => {
    setPhase('sending')
    // usage-analytics §3, step 2: recorded on the PRESS, never on the reply, so a send that
    // never comes back is a drop-off in the funnel instead of an event nobody emitted.
    track({ t: 'funnelStep', funnel: 'feedback', step: 'sendPressed' })
    const attach = fields.type === 'bug' && attachLog
    const attachInv = fields.type === 'bug' && attachInventory
    const attachAch = fields.type === 'bug' && attachAchievements
    void window.eq
      .submitFeedback(toDraft(fields), {
        attachLog: attach,
        windowMinutes,
        attachInventory: attachInv,
        attachAchievements: attachAch
      })
      .then((res) => {
        const ending = toOutcome(res)
        setOutcome(ending)
        setPhase('done')
        const step = sendFinishedStep(ending)
        if (step) track(step)
      })
      .catch((err: unknown) => {
        // submitFeedback is contractually non-rejecting; if the IPC itself dies we still owe
        // the user an answer rather than a dialog frozen on "Sending…".
        setOutcome({ kind: 'error', message: String(err) })
        setPhase('done')
      })
  }, [fields, attachLog, windowMinutes, attachInventory, attachAchievements])

  return {
    fields,
    setField,
    setType,
    attachLog,
    setAttachLog,
    windowMinutes,
    setWindowMinutes,
    attachInventory,
    setAttachInventory,
    attachAchievements,
    setAttachAchievements,
    draft,
    problem,
    phase,
    outcome,
    send
  }
}
