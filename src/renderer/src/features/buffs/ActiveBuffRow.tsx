// ActiveBuffRow — ONE live buff, as a card: what it is, how long it's been up, and how much
// longer it is estimated to last. Split out of BuffsView because the countdown carries the
// whole of world-model law 1 for this feature: every number here is either message-driven or
// LABELED as an estimate, and an unknown duration says "unknown duration" rather than
// drawing a fake bar.

import type { JSX } from 'react'
import { Box, Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import type { ActiveBuff } from '@shared/types'
import { rowRankLabel } from '@shared/buffTimers'
import {
  fmtDuration,
  remainingFraction,
  isOverdue,
  classAccent,
  estimatePrefix,
  estimatorSourceTitle
} from './format'
import { Tooltip } from '../../lib/Tooltip'
// The rich spell card (JOS-293). The row states what this INSTANCE is doing (elapsed, estimate,
// provenance); the card behind the name states what the SPELL is - its effect list, its stated
// duration, what it costs to put back up when this one falls off.
import { SpellTooltip } from '../../lib/SpellCard'
// THE TRACKING BOX (JOS-168) — one per card, on the SELF group and on every entity group, because
// a debuff you cast lives on the mob's card and it is the same box as the one on your own.
import { BuffAllowCheck } from './BuffAllowCheck'

/** Everything the countdown bar needs, resolved once so nothing downstream re-derives it. */
interface EstimateState {
  /** the estimated duration when we HAVE one (>0), else null — the whole bar hinges on it */
  est: number | null
  /** ± spread from the p25/p75 IQR around the estimate */
  spread: number | null
  overdue: boolean
}

/**
 * Overdue (Task #30 + #34): run past the estimated window → show "past estimate" instead
 * of a bottomed-out countdown. For mined estimates this needs n≥2 past p75; for a DB
 * (authoritative) estimate, being past the DB duration itself is enough (expiry is now
 * message-driven, so a DB buff sits "past estimate" until its wear-off line lands).
 */
function estimateState(buff: ActiveBuff, elapsed: number): EstimateState {
  const est = buff.estimatedMs != null && buff.estimatedMs > 0 ? buff.estimatedMs : null
  const spread = buff.p25 != null && buff.p75 != null ? (buff.p75 - buff.p25) / 2 : null
  // A DEATH BOUND JOINS THE DB ARM (JOS-379) and not the mined one: like a database figure it is a
  // number no cast of yours was ever seen ENDING at, so being past it is a statement about the
  // model waiting for a line rather than about a distribution. It is a FLOOR, so "past estimate" is
  // the literal truth — the spell has outlasted everything the log can prove.
  const stated = buff.durationSource === 'db' || buff.durationSource === 'deathBound'
  const overdue =
    isOverdue(elapsed, buff.p75, buff.n) || (stated && buff.estimatedMs != null && elapsed > buff.estimatedMs)
  return { est, spread, overdue }
}

/**
 * A buff that never fades: a full, steady bar and an explicit label — no countdown.
 *
 * THE LABEL SAYS WHY, AND IT USED TO GUESS (JOS-215). This read `permanent · illusion AA`
 * unconditionally, because when Task #34 wrote it the Permanent Illusion AA was the only way an
 * instance could be permanent. Since JOS-215 the far larger case is the spell's own duration — 62
 * rows the wiki states as `Permanent`, from Yaulp to a rogue's blade coat to a druid's wolf form —
 * and telling a rogue their poison coat is an illusion AA is a caption that is simply false.
 * `permanentSource` is the model's own answer (shared/buffTypes.ts), so nothing is inferred here.
 */
function PermanentBar({ source }: { source: ActiveBuff['permanentSource'] }): JSX.Element {
  return (
    <>
      <LinearProgress
        variant="determinate"
        value={100}
        sx={{ height: 8, borderRadius: 1, '& .MuiLinearProgress-bar': { bgcolor: 'warning.main' } }}
      />
      <Typography variant="caption" color="warning.main">
        {source === 'illusion-aa' ? 'permanent · illusion AA' : 'permanent'}
      </Typography>
    </>
  )
}

/** No estimate at all — an indeterminate bar that says so rather than faking a countdown. */
function UnknownBar(): JSX.Element {
  return (
    <>
      <LinearProgress variant="indeterminate" sx={{ height: 8, borderRadius: 1, opacity: 0.5 }} />
      <Typography variant="caption" color="text.disabled">
        unknown duration
      </Typography>
    </>
  )
}

/** The estimated-remaining bar plus its caption: time left (or "past estimate"), ±, source, n. */
function EstimateBar({
  est,
  elapsed,
  state,
  buff
}: {
  est: number
  elapsed: number
  state: EstimateState
  buff: ActiveBuff
}): JSX.Element {
  const remaining = Math.max(0, est - elapsed)
  const frac = remainingFraction(elapsed, est)
  const { overdue, spread } = state
  // Estimate provenance (JOS-117 + JOS-212 + JOS-379): 'db' (the spell-database floor held) vs
  // 'observed' (a logged cast ran LONGER than the floor) vs 'cluster' (your own clean cycles agree
  // it is SHORTER than the floor and overruled it) vs 'deathBound' (a mob died still carrying it,
  // so the number is a FLOOR under the truth and not the truth). All the learned sources show a
  // "log" chip — the number came from the log either way — but they say different things about the
  // database, so the tooltip says which, and a bound wears a `≥` on the figure itself.
  const source = buff.durationSource
  const boundPrefix = estimatePrefix(source)
  const left = `${boundPrefix === '' ? '~' : boundPrefix}${fmtDuration(remaining)} left`
  return (
    <>
      <LinearProgress
        variant="determinate"
        value={frac * 100}
        sx={{
          height: 8,
          borderRadius: 1,
          // Fade toward warning as the estimated window empties / runs overdue.
          '& .MuiLinearProgress-bar': {
            bgcolor: overdue || frac < 0.2 ? 'warning.main' : 'primary.main'
          }
        }}
      />
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="caption" color={overdue ? 'warning.main' : 'text.secondary'}>
          {overdue ? 'past estimate' : left}
          {!overdue && spread != null && spread > 1000 ? ` (± ${fmtDuration(spread)})` : ''}
        </Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          {source && (
            <Tooltip title={estimatorSourceTitle(source)}>
              <Chip
                size="small"
                label={source === 'db' ? 'db' : 'log'}
                variant="outlined"
                sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
              />
            </Tooltip>
          )}
          <Typography variant="caption" color="text.disabled">
            n={buff.n}
          </Typography>
        </Stack>
      </Stack>
    </>
  )
}

/** One active-buff row: name, elapsed, estimated remaining bar, ± spread, n. */
export function ActiveRow({ buff, now }: { buff: ActiveBuff; now: number }): JSX.Element {
  const elapsed = Math.max(0, now - buff.startedTs)
  const state = estimateState(buff, elapsed)

  // Debuff target is INFERRED (castBegin carries no target) — surface it honestly as a
  // "target: inferred" chip, never a silent guess (Task #32 rule 5c).
  const inferred = buff.inferredTarget === true

  // A buff that never fades — the spell's own `Permanent` duration (JOS-215) or a self-cast
  // illusion under the Permanent Illusion AA (Task #34). No countdown; the caption says which.
  const permanent = buff.permanent === true

  // The rank the cast line spelled, when this instance was resolved from one (JOS-238).
  const rank = rowRankLabel(buff.spell, buff.castName)

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        // Class accent: red-ish left border for debuffs, green for pet, gold for self.
        borderLeft: '3px solid',
        borderLeftColor: classAccent(buff.cls)
      }}
    >
      <Stack direction="row" alignItems="baseline" spacing={1}>
        {/* THE BOX, FIRST ON THE ROW (JOS-168): "you would check a box on the card for each
            buff/debuff after casting". It keys on the SPELL LINE, so this box and the one on the
            same spell's stats row are one box, and unchecking it removes the bar from the timer
            window while leaving this card exactly where it is - the model is untouched. */}
        <BuffAllowCheck spell={buff.spell} />
        {/* The card is asked about the RANKED name when this instance came from a cast line that
            spelled one (`rank` is non-null exactly then, and only for the same line) - that is the
            only way the card can name what this rank replaces. Otherwise it is asked about the
            identity, which is what the row prints. */}
        <SpellTooltip name={rank != null && buff.castName != null ? buff.castName : buff.spell}>
          <Typography variant="body2" data-testid="active-buff-name" sx={{ fontWeight: 600 }}>
            {buff.spell}
          </Typography>
        </SpellTooltip>
        {/* THE RANK, BESIDE THE NAME AND NOT INSIDE IT (JOS-238). `spell` is the identity — the
            DB's own display name, which is what alerts, the learner and the wear-off sentence
            all speak — and the numeral the cast line spelled is a separate fact about this
            instance. Absent whenever the cast line named no rank. */}
        {rank != null && (
          <Typography variant="caption" color="text.secondary" data-testid="active-buff-rank">
            {rank}
          </Typography>
        )}
        {/* The chip's own word IS the disclosure — a tooltip re-explaining `inferred` is the
            defensive footnoting the UI conventions ban (AGENTS.md tooltip and caveat diet). */}
        {inferred ? (
          <Chip
            size="small"
            label={buff.target ? `target: ${buff.target} (inferred)` : 'target: inferred'}
            variant="outlined"
            color="warning"
            sx={{ height: 18, fontSize: 11, maxWidth: 180, '& .MuiChip-label': { px: 0.75 } }}
          />
        ) : null}
        {buff.messageDriven && (
          <Tooltip title="Confirmed by a chat message">
            <Chip
              size="small"
              label="message"
              variant="outlined"
              color="success"
              sx={{ height: 18, fontSize: 11 }}
            />
          </Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {fmtDuration(elapsed)} elapsed
        </Typography>
      </Stack>

      {permanent ? (
        <PermanentBar source={buff.permanentSource} />
      ) : state.est !== null ? (
        <EstimateBar est={state.est} elapsed={elapsed} state={state} buff={buff} />
      ) : (
        <UnknownBar />
      )}
    </Paper>
  )
}
