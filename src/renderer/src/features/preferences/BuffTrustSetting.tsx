// BuffTrustSetting — Preferences → Buffs → "Track other casters" (JOS-140).
//
// ONE LIST OF NAMES, and the shortest surface that can express the rule the owner asked for. The
// buff and debuff bars only ever show spells a CAST LINE anchors, and the only cast lines that are
// yours say "You begin casting". A player who duos with the same enchanter every night wants that
// enchanter's mez timers on their debuff window; the honest way to give it to them is to let them
// NAME the person, because the game's landing sentences name nobody.
//
// STATE, NEVER PROCESS (the repo's UI law): this is a list you edit, not a scan you run. There is
// deliberately no "add everyone in my group" button and no suggestion from the roster — a group
// changes without the user choosing it, and this preference is a choice. The caption says what the
// empty state means rather than leaving it to be inferred, because "why do I not see their buffs"
// is the question this control exists to answer.
//
// AND ONE SWITCH (upstream issue #69): count a debuff your held weapon or item procs as yours. The
// game prints no line when an item procs, so the engine reads two other facts instead — your own
// swing at that mob in the last two seconds, and the spell being a combat effect of an item your
// latest inventory dump holds. Off by default; the caption says why, because the residual (anyone's
// landing of that spell on a mob you are hitting reads as yours) is the user's to accept, not the
// app's.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders bare
// Stacks.

import { type JSX, useCallback, useState } from 'react'
import { Button, Chip, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material'
import GroupIcon from '@mui/icons-material/Group'
import {
  addExternalCaster,
  MAX_CASTER_NAME_CHARS,
  MAX_EXTERNAL_CASTERS,
  removeExternalCaster,
  setProcDebuffs,
  type BuffTrustPrefs
} from '@shared/buffTrust'
import { recordPref, usePrefsSeed } from './prefsHydration'
import type { PrefSection } from './PreferencesView'

/**
 * The list, SEEDED from the pane's hydration snapshot and written back on every edit. The local
 * write is optimistic (a chip must not lag an IPC round trip) and main's reply is authoritative,
 * being what was actually stored after the shared normalizer had its say.
 *
 * It used to mount on `DEFAULT_BUFF_TRUST_PREFS` — the EMPTY allowlist — and correct itself
 * (JOS-340), so a user with three trusted casters opened this section to a card that said they
 * trusted nobody, and then watched their own list appear. Of every field in the pane this was the
 * one whose wrong frame told the biggest lie, because "empty" here is a claim about who the app is
 * listening to.
 */
function useBuffTrust(): [BuffTrustPrefs, (next: BuffTrustPrefs) => void] {
  const [prefs, setPrefs] = useState<BuffTrustPrefs>(usePrefsSeed().buffTrust)

  const update = useCallback((next: BuffTrustPrefs) => {
    setPrefs(next)
    void window.eq.setBuffTrust(next).then((stored) => {
      setPrefs(stored)
      recordPref('buffTrust', stored)
    })
  }, [])

  return [prefs, update]
}

export function BuffTrustSetting(): JSX.Element {
  const [prefs, update] = useBuffTrust()
  const [draft, setDraft] = useState('')
  const full = prefs.externals.length >= MAX_EXTERNAL_CASTERS

  const add = (): void => {
    const name = draft.trim()
    if (!name) return
    update(addExternalCaster(prefs, name))
    setDraft('')
  }

  return (
    <Stack spacing={1.5} data-testid="pref-buff-trust">
      <Typography variant="body2">
        Show buffs and debuffs cast by these people, as well as your own
      </Typography>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          size="small"
          label="Character name"
          value={draft}
          disabled={full}
          slotProps={{ htmlInput: { maxLength: MAX_CASTER_NAME_CHARS, 'data-testid': 'pref-buff-trust-input' } }}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <Button size="small" variant="outlined" disabled={full || !draft.trim()} onClick={add} data-testid="pref-buff-trust-add">
          Add
        </Button>
      </Stack>

      {prefs.externals.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap data-testid="pref-buff-trust-list">
          {prefs.externals.map((name) => (
            <Chip
              key={name.toLowerCase()}
              size="small"
              label={name}
              onDelete={() => {
                update(removeExternalCaster(prefs, name))
              }}
            />
          ))}
        </Stack>
      )}

      <Typography variant="caption" color="text.secondary" data-testid="pref-buff-trust-note">
        {prefs.externals.length === 0
          ? 'Empty, so the bars show only spells you cast. A landing message names no caster, so without a name here there is no way to tell your work from a stranger`s in a crowded zone.'
          : 'Their casts appear on the same bars as yours. Learned durations stay separate: their spell timers come from their gear and abilities, not yours.'}
      </Typography>

      <FormControlLabel
        control={
          <Switch
            size="small"
            data-testid="pref-buff-trust-procs"
            checked={prefs.procDebuffs}
            onChange={(e) => {
              update(setProcDebuffs(prefs, e.target.checked))
            }}
          />
        }
        label="Count debuffs your weapon or item procs as yours"
      />
      <Typography variant="caption" color="text.secondary" data-testid="pref-buff-trust-procs-note">
        A proc prints no cast line, so a landing counts only on a mob you swung at in the last two seconds, and only
        for a combat effect of an item in your latest /outputfile inventory. Any landing of that spell on a mob you are
        hitting is counted as yours, including a group member`s cast, click or proc of the same spell, which is why this
        is off by default.
      </Typography>
    </Stack>
  )
}

/**
 * The section descriptor, living with its card like `graphicsSection` does — PreferencesView is at
 * the 400-code-line factoring ceiling, and the words someone types to find this setting belong
 * beside the setting. The keywords carry the SYMPTOM vocabulary ("missing", "not showing",
 * "group") as well as the mechanism, because a user in this situation searches for what they are
 * not seeing.
 */
export function buffTrustSection(): PrefSection {
  return {
    id: 'buffs',
    label: 'Buffs',
    icon: <GroupIcon fontSize="small" />,
    items: [
      {
        id: 'buff-trust',
        label: 'Track other casters',
        keywords:
          'buff buffs debuff debuffs timer timers bar bars mez mesmerize charm slow snare root overlay other caster casters group party friend enchanter cleric shaman missing not showing hidden allow allowlist trust duration durations proc procs weapon item tash tashania orb inventory',
        content: <BuffTrustSetting />
      }
    ]
  }
}
