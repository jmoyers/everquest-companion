// posky/ItemOverrides.tsx — the two surfaces that speak about a HAND-STATED HELD COUNT (JOS-186).
//
// The owner's ruling asked for a manual override "wherever necessary in the Sky module" so a
// destroyed or false-positive item can be corrected: mark a quest complete by hand, clear a stuck
// ready-state, force an item count. The first of those already existed (TurnInControls.tsx's
// counter, JOS-131), and the third is what this file draws. THE SECOND IS THE THIRD: a quest sits
// on the Ready tab because `hasEveryItem` is true of it, so the way to clear a stuck ready-state is
// to correct the count that is wrong — not to invent a per-quest "not ready" flag that would be a
// second truth about the same question, drifting out of step with the ledger the first one reads.
// questCompletion.ts's `readyQuests` block already refuses a dismiss button for exactly this
// reason, and this ticket does not overturn it; it gives that block's "stop holding the items" the
// mechanism it was missing for an item the log cannot see you lose.
//
// WHERE IT LIVES: the expanded quest panel's item table, in the Have cell — beside the number it
// corrects, on the row that names the item, on BOTH tabs that draw a quest row (Quests and Ready
// draw the same accordion, which is JOS-147's rule and the reason this needed no second mount).
//
// NO POPPER, like everything else on this tab (JOS-143). The editor opens INLINE, inside the
// accordion panel that is already expanded — it displaces its own row's cell and nothing else, so
// there is no floating layer to land on the toolbar's dropdowns. Every sentence rides a native
// `title`, which is an OS tooltip with no hit area at all.

import { type JSX, useState } from 'react'
import { Box, Chip, IconButton, Stack, TextField, Typography } from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import CloseIcon from '@mui/icons-material/Close'
import EditIcon from '@mui/icons-material/Edit'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import type { ItemCountOverride } from '@shared/types'
import type { ItemProgress } from './useProgress'
// The one caveat that belongs in this cell without being about a statement (JOS-409) — see below.
import { DUMP_BLIND_ITEM_NOTE, isDumpBlindItem } from './dumpBlindItems'

/** State this item's count, or take the statement back with `null`. The name is what was drawn. */
export type SetItemCount = (name: string, count: number | null) => void

/** How a statement's date reads on a hover line. Local, quiet, and never a sort key. */
function statedOn(o: ItemCountOverride): string {
  return o.setAt > 0 ? new Date(o.setAt).toLocaleString() : 'an unknown date'
}

/**
 * THE PROVENANCE CHIP — "this number is yours, not the log's" (the ticket's first design
 * constraint, and the same shape the class-combo corrections use).
 *
 * Its delete affordance is the take-back, which is why the chip and the undo are one control: the
 * user's eye lands on the thing that looks unusual and the way out is attached to it. `data-count`
 * states the number a test can read without parsing a label.
 */
function OverrideChip({ o, onClear }: { o: ItemCountOverride; onClear: () => void }): JSX.Element {
  return (
    <Chip
      size="small"
      color="warning"
      variant="outlined"
      data-testid="posky-item-override"
      data-count={o.count}
      title={`You stated ${String(o.count)} of these on ${statedOn(o)}. Anything looted since then is counted on top, and any turn-in recorded since then is taken off. Remove this to go back to counting from the log and the export.`}
      label={`By hand: ${String(o.count)}`}
      onDelete={onClear}
      sx={{ height: 20, fontSize: 11 }}
    />
  )
}

/** The open editor: a number, a commit, a cancel. Enter commits and Escape cancels, because a
 *  one-field form that can only be finished with the mouse is a form nobody finishes. */
function CountEditor({
  value,
  onValue,
  onCommit,
  onCancel
}: {
  value: string
  onValue: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={0.25} alignItems="center">
      <TextField
        size="small"
        type="number"
        autoFocus
        data-testid="posky-item-count-input"
        label="I hold"
        value={value}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit()
          if (e.key === 'Escape') onCancel()
        }}
        slotProps={{ htmlInput: { min: 0, step: 1, style: { width: 56, padding: '4px 6px' } } }}
      />
      <IconButton
        size="small"
        data-testid="posky-item-count-save"
        title="Use this count from now on"
        onClick={onCommit}
      >
        <CheckIcon fontSize="inherit" />
      </IconButton>
      <IconButton size="small" data-testid="posky-item-count-cancel" title="Leave the count alone" onClick={onCancel}>
        <CloseIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  )
}

/**
 * WHY THIS ROW CAN READ ZERO WHILE YOU HOLD THE ITEM (JOS-409) — the dump-blind caveat, drawn
 * beside the count it explains and pointing at the pencil next to it.
 *
 * It lives in THIS file, which is otherwise entirely about hand-stated counts, on the same argument
 * the file's own header makes about where the correction goes: the sentence is about a NUMBER, its
 * remedy is the control in this cell, and a caveat rendered anywhere else would be a note about a
 * row the reader has to go and find. It is not about a statement, so it draws whether or not one is
 * in force — except that a row the user has already spoken about needs no explanation of where its
 * number came from, which is the one suppression below.
 *
 * SHOWN ONLY WHILE THE ROW IS SHORT. A rune reading 1/1 is a rune the log saw and nothing needs
 * excusing; the caveat exists to explain a shortfall, and drawing it on every satisfied rune row
 * would put a warning on every quest in the tab.
 */
function DumpBlindNote(): JSX.Element {
  return (
    <Box
      component="span"
      data-testid="posky-item-dump-blind"
      title={DUMP_BLIND_ITEM_NOTE}
      sx={{ display: 'inline-flex', color: 'text.secondary' }}
    >
      <InfoOutlinedIcon sx={{ fontSize: 14 }} />
    </Box>
  )
}

/**
 * THE HAVE CELL: what you hold toward this item, and the one control that can correct it.
 *
 * The editor is pre-filled with the UNCAPPED held count (`ItemProgress.held`) rather than with the
 * `have/need` figure beside it — a player holding seven claws for a five-claw quest reads 5/5, and
 * opening the box on 5 would quietly propose throwing two away.
 *
 * A blank box commits NOTHING. The way to say "I have none" is to type 0, which is a statement;
 * an empty field is a user who changed their mind, and inventing a zero out of it would be the
 * one mistake this control cannot let a mis-click make.
 */
export function ItemHaveCell({
  it,
  onSetItemCount
}: {
  it: ItemProgress
  /** absent in a tree mounted without the store — the cell then simply states the number */
  onSetItemCount?: SetItemCount
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const commit = (): void => {
    const n = Number(text.trim())
    if (text.trim() !== '' && Number.isFinite(n) && n >= 0) onSetItemCount?.(it.name, Math.floor(n))
    setEditing(false)
  }
  if (editing && onSetItemCount) {
    return (
      <CountEditor value={text} onValue={setText} onCommit={commit} onCancel={() => setEditing(false)} />
    )
  }
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Typography variant="body2" component="span">
        {it.have}/{it.need}
      </Typography>
      {it.have < it.need && !it.override && isDumpBlindItem(it.name) && <DumpBlindNote />}
      {it.override && onSetItemCount && (
        <OverrideChip o={it.override} onClear={() => onSetItemCount(it.name, null)} />
      )}
      {onSetItemCount && (
        <IconButton
          size="small"
          data-testid="posky-item-count-edit"
          title="Correct this count by hand - for an item you destroyed, gave away or never had. The log and the export cannot see any of those, so this is how you tell the app."
          onClick={() => {
            setText(String(it.held))
            setEditing(true)
          }}
        >
          <EditIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
    </Stack>
  )
}

/**
 * HOW MANY COUNTS THE USER IS CURRENTLY OVERRIDING, on the tab's own status line.
 *
 * A correction that can only be seen by expanding the one quest it was made on is invisible state,
 * and invisible state is what makes a wrong number un-diagnosable six weeks later (JOS-253's whole
 * lesson: the app was counting from a source nothing on screen named). So the tab says the number
 * out loud, and the hover names every item and every count — which is enough to go and find the
 * row that carries the take-back.
 *
 * Nothing at all when nothing is stated, which is every user who has never used the control.
 */
export function OverrideSummaryChip({
  overrides
}: {
  overrides: readonly ItemCountOverride[]
}): JSX.Element | null {
  if (overrides.length === 0) return null
  return (
    <Chip
      size="small"
      color="warning"
      variant="outlined"
      data-testid="posky-overrides-active"
      data-count={overrides.length}
      title={`Counts you stated by hand: ${overrides.map((o) => `${o.name} = ${String(o.count)}`).join(', ')}. Expand the quest that needs one and use the pencil beside its Have column to change or remove it.`}
      label={`${String(overrides.length)} count${overrides.length === 1 ? '' : 's'} set by hand`}
      sx={{ height: 18, fontSize: 11, ml: 1 }}
    />
  )
}
