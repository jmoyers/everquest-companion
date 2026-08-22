// FeedbackDialog — "tell us what's wrong / what you want" (Task #65, docs/plans/feedback-triage.md §4.4).
//
// One dialog, three phases (compose → sending → done). What it exists to make TRUE:
//
//   - Send is gated by the SHARED validator (src/shared/feedback.ts), the same function main
//     and the ingest Lambda run — so the button is never enabled for something the server
//     would reject, and a round trip is never spent learning what we already knew.
//   - A BUG REPORT attaches a scrubbed slice of the EverQuest log by default (that is the whole
//     point of a bug report) and shows it EXPANDED, not collapsed, with the §5.3 disclosure in
//     plain language and a "Save a copy…" that writes every byte to disk. Nothing about the log
//     is opt-out-by-obscurity. A FEATURE REQUEST never reads the log at all.
//   - Every ending is stated honestly: sent (with the report id, so it can be quoted), queued
//     offline, the server's own "we're closed" message verbatim, or the error.
//   - A build with no endpoint compiled in (FEEDBACK_API_URL === '', which is every build until
//     wave F2 deploys) SAYS SO rather than failing at Send.
//
// De-nesting: the dialog surface is the one border level. The log preview inside it is a tonal
// FILL, not a second card (LogPreview.tsx).

import { type JSX } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import BugReportIcon from '@mui/icons-material/BugReport'
import LightbulbIcon from '@mui/icons-material/Lightbulb'
import { LOG_WINDOW_CHOICES, MAX_DESCRIPTION, type FeedbackType } from '@shared/feedback'
import InventoryPreview, { AchievementsPreview } from './InventoryPreview'
import LogPreview from './LogPreview'
import PerfPreview from './PerfPreview'
import {
  useFeedback,
  useFeedbackContext,
  useAchievementsDump,
  useInventoryDump,
  useLogSlice,
  type FeedbackContext,
  type FeedbackOutcome,
  type FeedbackPrefill,
  type FeedbackState
} from './useFeedback'

/**
 * The §5.3 disclosure, verbatim. State, never process: it says what IS in the slice and what is
 * NOT, and then tells you to read it — it does not explain how the scrubber works.
 */
const DISCLOSURE =
  'Your log slice is included. Chat, tells, group and /who lines are removed. Your character’s ' +
  'name, zones, spells and combat lines stay - that’s what makes a bug reproducible. Read the ' +
  'whole thing below before you send it.'

/**
 * The dump's disclosure (JOS-296), written to the same rule as the slice's: STATE, never
 * process. It says what the file IS, because the honest answer to "what am I sending" here is
 * short — the export is a table of item names, ids and counts, and the format sweep in
 * `src/main/feedback/inventory.ts` is what lets this sentence be that flat.
 */
const INVENTORY_DISCLOSURE =
  'Your inventory export is included - the file /outputfile inventory writes. It lists your ' +
  'items, where each one sits, and how many. It has no chat in it, so nothing is removed. Read ' +
  'the whole thing below before you send it.'

/**
 * The achievements dump's disclosure (JOS-441), written to the same rule. The format sweep in
 * `src/main/feedback/achievements.ts` is what lets it be this flat: the file is the game's own
 * achievement list with a one-letter status on each row, and the sweep found no chat, no
 * timestamps and not even the character's name inside it.
 */
const ACHIEVEMENTS_DISCLOSURE =
  'Your achievements export is included - the file /outputfile achievements writes. It lists the ' +
  'game’s achievements and whether you have completed each one. It has no chat in it and does not ' +
  'even carry your character’s name, so nothing is removed. Read the whole thing below before you ' +
  'send it.'

/** Feature request | Bug report. The entry point picks the default; this is the override. */
function TypeToggle({
  value,
  onChange
}: {
  value: FeedbackType
  onChange: (t: FeedbackType) => void
}): JSX.Element {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      color="primary"
      value={value}
      data-testid="feedback-type-toggle"
      onChange={(_e, v: FeedbackType | null) => {
        if (v) onChange(v)
      }}
    >
      <ToggleButton value="feature" data-testid="feedback-type-feature">
        <LightbulbIcon fontSize="small" sx={{ mr: 0.75 }} />
        Feature request
      </ToggleButton>
      <ToggleButton value="bug" data-testid="feedback-type-bug">
        <BugReportIcon fontSize="small" sx={{ mr: 0.75 }} />
        Bug report
      </ToggleButton>
    </ToggleButtonGroup>
  )
}

/** Description (required, live counter). The one field — everything else goes in the body. */
function DraftFieldsBlock({ state }: { state: FeedbackState }): JSX.Element {
  const { fields, setField, problem } = state
  const overlong = fields.description.trim().length > MAX_DESCRIPTION
  return (
    <>
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={4}
        maxRows={10}
        autoFocus
        label="What happened / what would you like?"
        value={fields.description}
        data-testid="feedback-description"
        error={overlong}
        helperText={`${fields.description.trim().length.toString()} / ${MAX_DESCRIPTION.toString()}${
          problem ? ` - ${problem}` : ''
        }`}
        onChange={(e) => setField('description', e.target.value)}
      />
      <Typography variant="caption" color="text.secondary">
        You can drop your email or Discord in the message if you care to.
      </Typography>
    </>
  )
}

/** 15 / 30 / 60 minutes, ending at the last line in your log (not at the wall clock). */
function WindowChoice({
  value,
  onChange
}: {
  value: number
  onChange: (m: number) => void
}): JSX.Element {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={value}
      data-testid="feedback-window-select"
      onChange={(_e, v: number | null) => {
        if (v) onChange(v)
      }}
    >
      {LOG_WINDOW_CHOICES.map((m) => (
        <ToggleButton key={m} value={m} data-testid={`feedback-window-${m.toString()}`}>
          {m} min
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

/**
 * The attachment block — bug reports only. Ticked by default, window selector beside it, the
 * disclosure under that, and the preview EXPANDED below (never behind a disclosure triangle:
 * a log slice you have to go looking for is not one you have read).
 */
function AttachLogSection({ state }: { state: FeedbackState }): JSX.Element | null {
  const { fields, attachLog, setAttachLog, windowMinutes, setWindowMinutes } = state
  const active = fields.type === 'bug' && attachLog
  const log = useLogSlice(active, windowMinutes)
  if (fields.type !== 'bug') return null
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
        <FormControlLabel
          sx={{ mr: 0 }}
          control={
            <Checkbox
              size="small"
              checked={attachLog}
              data-testid="feedback-attach-log"
              onChange={(e) => setAttachLog(e.target.checked)}
            />
          }
          label={<Typography variant="body2">Attach a slice of my EverQuest log</Typography>}
        />
        {attachLog && <WindowChoice value={windowMinutes} onChange={setWindowMinutes} />}
      </Stack>

      {attachLog && (
        <>
          <Typography variant="caption" color="text.secondary">
            {DISCLOSURE}
          </Typography>
          <LogPreview
            slice={log.slice}
            requestedMinutes={windowMinutes}
            loading={log.loading}
            onSaveCopy={log.saveCopy}
            saving={log.saving}
            savedPath={log.savedPath}
          />
        </>
      )}
    </Stack>
  )
}

/**
 * The inventory attachment (JOS-296) — bug reports only, ticked BY DEFAULT (owner ruling), and
 * shown EXPANDED for exactly the reason the slice is: an attachment you have to go looking for
 * is not one you have read.
 *
 * THE NO-DUMP STATE DISABLES, IT DOES NOT HIDE. A machine that has never run
 * `/outputfile inventory` gets the checkbox greyed with the command as its hint, so the user
 * learns the option exists and what it would take. Hiding the row would leave them with a bug
 * report we cannot answer and no idea why.
 *
 * `ctx` is null while the header context is still in flight; the control is not disabled on a
 * question we have not had answered yet, so an unknown context reads as available and the
 * preview's own named states take over a moment later.
 */
function AttachInventorySection({
  state,
  ctx
}: {
  state: FeedbackState
  ctx: FeedbackContext | null
}): JSX.Element | null {
  const { fields, attachInventory, setAttachInventory } = state
  const noDump = ctx !== null && !ctx.inventoryAvailable
  const active = fields.type === 'bug' && attachInventory && !noDump
  const inv = useInventoryDump(active)
  if (fields.type !== 'bug') return null
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
        <FormControlLabel
          sx={{ mr: 0 }}
          disabled={noDump}
          control={
            <Checkbox
              size="small"
              checked={attachInventory && !noDump}
              data-testid="feedback-attach-inventory"
              onChange={(e) => setAttachInventory(e.target.checked)}
            />
          }
          label={<Typography variant="body2">Attach my inventory export</Typography>}
        />
        {noDump && (
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="feedback-inventory-hint"
          >
            Type /outputfile inventory in game to make one.
          </Typography>
        )}
      </Stack>

      {active && (
        <>
          <Typography variant="caption" color="text.secondary">
            {INVENTORY_DISCLOSURE}
          </Typography>
          <InventoryPreview dump={inv.dump} loading={inv.loading} onRefresh={inv.refresh} />
        </>
      )}
    </Stack>
  )
}

/**
 * The achievements attachment (JOS-441) — the same section, the same rules, its own file.
 *
 * WHY IT IS A SECOND SECTION AND NOT A SECOND LINE IN THE FIRST: consent here is per-FILE. The two
 * exports say different things about a player, carry different disclosures, and are missing for
 * different reasons; one tick covering both would be consent to something the user was never shown.
 * The cost is one more row in a dialog that already draws two of these, and the shape is identical
 * so it reads as the same idea rather than as a new one.
 */
function AttachAchievementsSection({
  state,
  ctx
}: {
  state: FeedbackState
  ctx: FeedbackContext | null
}): JSX.Element | null {
  const { fields, attachAchievements, setAttachAchievements } = state
  const noDump = ctx !== null && !ctx.achievementsAvailable
  const active = fields.type === 'bug' && attachAchievements && !noDump
  const ach = useAchievementsDump(active)
  if (fields.type !== 'bug') return null
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
        <FormControlLabel
          sx={{ mr: 0 }}
          disabled={noDump}
          control={
            <Checkbox
              size="small"
              checked={attachAchievements && !noDump}
              data-testid="feedback-attach-achievements"
              onChange={(e) => setAttachAchievements(e.target.checked)}
            />
          }
          label={<Typography variant="body2">Attach my achievements export</Typography>}
        />
        {noDump && (
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="feedback-achievements-hint"
          >
            Type /outputfile achievements in game to make one.
          </Typography>
        )}
      </Stack>

      {active && (
        <>
          <Typography variant="caption" color="text.secondary">
            {ACHIEVEMENTS_DISCLOSURE}
          </Typography>
          <AchievementsPreview dump={ach.dump} loading={ach.loading} onRefresh={ach.refresh} />
        </>
      )}
    </Stack>
  )
}

/** Version · channel · queued — the header context, stated, not explained. */
function ContextLine({ ctx }: { ctx: FeedbackContext | null }): JSX.Element | null {
  if (!ctx) return null
  const bits = [`v${ctx.env.appVersion}`, ctx.env.channel, ctx.env.platform]
  if (ctx.queued > 0) bits.push(`${ctx.queued.toString()} waiting to send`)
  return (
    <Typography variant="caption" color="text.secondary">
      Sent with your report: {bits.join(' · ')}
    </Typography>
  )
}

const OUTCOME_SEVERITY: Record<FeedbackOutcome['kind'], 'success' | 'info' | 'warning'> = {
  sent: 'success',
  queued: 'info',
  closed: 'info',
  error: 'warning'
}

/** The done phase: one quiet statement of what actually happened, plus the id if there is one. */
function OutcomeView({ outcome }: { outcome: FeedbackOutcome }): JSX.Element {
  return (
    <Alert severity={OUTCOME_SEVERITY[outcome.kind]} variant="standard" data-testid="feedback-outcome">
      <Stack spacing={0.5}>
        <Typography variant="body2">{outcome.message}</Typography>
        {outcome.reportId && (
          <Typography variant="caption" sx={{ fontFamily: 'ui-monospace, monospace' }}>
            {outcome.reportId}
          </Typography>
        )}
      </Stack>
    </Alert>
  )
}

export interface FeedbackDialogProps {
  open: boolean
  onClose: () => void
  /** Seeds the form — the ErrorBoundary's "Report this" arrives with a bug + the stack. */
  prefill?: FeedbackPrefill
}

export default function FeedbackDialog({ open, onClose, prefill }: FeedbackDialogProps): JSX.Element {
  const ctx = useFeedbackContext(open)
  const state = useFeedback(open, prefill)
  const { phase, outcome, problem, send } = state
  // `null` while the context is still in flight — we don't claim "no endpoint" before we know.
  const dark = ctx !== null && !ctx.endpointConfigured
  const canSend = phase === 'compose' && !problem && !dark

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth data-testid="feedback-dialog">
      <DialogTitle sx={{ pb: 1 }}>Send feedback</DialogTitle>
      <DialogContent dividers>
        {phase === 'done' && outcome ? (
          <OutcomeView outcome={outcome} />
        ) : (
          <Stack spacing={1.5}>
            {dark && (
              <Alert severity="info" variant="standard" data-testid="feedback-unavailable">
                Sending isn’t available in this build - it has no feedback endpoint. You can still
                save a copy of your log slice below and send it another way.
              </Alert>
            )}
            <TypeToggle value={state.fields.type} onChange={state.setType} />
            <DraftFieldsBlock state={state} />
            <AttachLogSection state={state} />
            <AttachInventorySection state={state} ctx={ctx} />
            <AttachAchievementsSection state={state} ctx={ctx} />
            {/* The perf timeline rides `env`, so it is part of EVERY report — feature requests
                included — and it renders itself away when the rings are empty (JOS-369). It reads
                the context itself rather than being handed a block, exactly as the inventory
                section does: a `ctx?.env.perf ?? null` here would be two more branches in a
                function the complexity budget already has at its ceiling. */}
            <PerfPreview ctx={ctx} />
            <ContextLine ctx={ctx} />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{phase === 'done' ? 'Close' : 'Cancel'}</Button>
        {phase !== 'done' && (
          <Button
            variant="contained"
            disabled={!canSend}
            data-testid="feedback-send"
            onClick={send}
            startIcon={
              phase === 'sending' ? <CircularProgress size={14} color="inherit" /> : undefined
            }
          >
            {phase === 'sending' ? 'Sending…' : 'Send'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
