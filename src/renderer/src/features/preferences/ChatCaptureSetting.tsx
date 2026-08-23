// ChatCaptureSetting — Preferences → Chat → "Save chat to a file" (chat capture).
//
// ONE SWITCH, AND IT SHIPS ON. The Chat tab exists to keep your chat; this decides whether it also
// keeps it BEYOND the game's log — a file the companion appends to as chat arrives, so a rotated or
// deleted EQ log does not take the history with it. Off, the tab still works (it is rebuilt from
// the log every launch); only the durable copy stops.
//
// STATE, NEVER PROCESS (the repo's UI law): the caption says what the switch DOES and where the
// file is, not that main holds an append stream or reads the switch per line.
//
// NO push listener, unlike CloseToTraySetting: this preference has exactly one control — this card
// — so it seeds from the pane's snapshot (JOS-340: a control never paints a value it does not
// know) and follows only its own writes. ONE BORDER: PreferencesView wraps each item in a Paper,
// so this renders bare Stacks.

import { type JSX, useCallback, useState } from 'react'
import { FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import ChatIcon from '@mui/icons-material/Chat'
import { recordPref, usePrefsSeed } from './prefsHydration'
import type { PrefSection } from './PreferencesView'

function useChatCapture(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(usePrefsSeed().chatCapture)

  const update = useCallback((next: boolean) => {
    setEnabled(next)
    recordPref('chatCapture', next)
    void window.eq.setChatCapture(next).then((stored) => {
      setEnabled(stored)
      recordPref('chatCapture', stored)
    })
  }, [])

  return [enabled, update]
}

export function ChatCaptureSetting(): JSX.Element {
  const [enabled, update] = useChatCapture()
  return (
    <Stack spacing={0.5} data-testid="pref-chat-capture">
      <FormControlLabel
        control={
          <Switch
            size="small"
            data-testid="pref-save-chat"
            checked={enabled}
            onChange={(e) => update(e.target.checked)}
          />
        }
        label={<Typography variant="body2">Also save chat to a file</Typography>}
      />
      <Typography variant="caption" color="text.secondary">
        {enabled
          ? "New chat is appended to a file in the companion's data folder as it arrives, so it survives the game rotating its log. The Chat tab works either way, and nothing chat-related ever leaves this machine."
          : 'The Chat tab still shows chat from your current log, but nothing is written to a separate file.'}
      </Typography>
    </Stack>
  )
}

/**
 * The section this card is the whole of. A section of its own rather than a line under Overlays or
 * Window, because it is about the Chat TAB — its own destination in the nav. Descriptor beside the
 * card for the `windowSection` reason: buildSections is at the 100-code-line ceiling.
 */
export function chatSection(): PrefSection {
  return {
    id: 'chat',
    label: 'Chat',
    icon: <ChatIcon fontSize="small" />,
    items: [
      {
        id: 'chat-capture',
        label: 'Save chat to a file',
        keywords: 'chat save log tells guild group channel ooc auction archive file capture messages',
        content: <ChatCaptureSetting />
      }
    ]
  }
}
