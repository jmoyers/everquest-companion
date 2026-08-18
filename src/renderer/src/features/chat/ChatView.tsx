// chat/ChatView.tsx — THE CHAT LOG. The one tab that shows people's words.
//
// WHAT THIS TAB IS. Every player chat line this character's log holds — tells, guild, group, the
// custom channels, OOC, auction, plus your own /say — oldest first, filterable by channel and
// searchable. It hydrates from the `chat` module (rebuilt from the log every launch) and rides
// deltas live, exactly like Loot. The SAVE half — the same lines appended to a file that survives
// the game rotating its log — is chatArchive.ts in main; the switch for it is in Preferences.
//
// WHY /say READS ONE-SIDED. Only YOUR /say appears: a third party's `<Name> says` is
// indistinguishable from a mob's by shape, so parseChat.ts drops it rather than log "a rock golem"
// as a person. The empty-state and this note are where a user meets that limit; the parseChat
// header is where it is argued.
//
// THE LIST IS ITS OWN SCROLLER (AGENTS.md UI conventions): a chat log grows without bound, so it
// lives in a bounded box rather than growing the page.

import { type JSX, useMemo, useState } from 'react'
import { Box, Chip, Stack, TextField, Typography } from '@mui/material'
import ChatIcon from '@mui/icons-material/Chat'
import type { ChatChannel, ChatLine } from '@shared/types'
import { useChatHistory } from './useChatHistory'

/** Display name + a stable color per channel. The color is the only thing distinguishing a wall of
 *  one-line messages at a glance, so each channel keeps its own. */
const CHANNEL_META: Record<ChatChannel, { label: string; color: string }> = {
  tell: { label: 'Tell', color: '#c586c0' },
  group: { label: 'Group', color: '#4ec9b0' },
  guild: { label: 'Guild', color: '#4fc1ff' },
  raid: { label: 'Raid', color: '#ce9178' },
  ooc: { label: 'OOC', color: '#9cdcfe' },
  auction: { label: 'Auction', color: '#dcdcaa' },
  shout: { label: 'Shout', color: '#f48771' },
  say: { label: 'Say', color: '#b5cea8' },
  channel: { label: 'Channel', color: '#808080' }
}

/** The channels, in the order the filter bar shows them. */
const CHANNEL_ORDER: ChatChannel[] = ['tell', 'group', 'guild', 'raid', 'channel', 'ooc', 'auction', 'shout', 'say']

/** How a line names its speaker/target: `You → Bob` for a tell you sent, `[General:1] Zed` for a
 *  custom channel, `Bob` otherwise. */
function speaker(l: ChatLine): string {
  if (l.channel === 'channel' && l.chan) return `[${l.chan}] ${l.from}`
  if (l.channel === 'tell' && l.self && l.to) return `You → ${l.to}`
  return l.from
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function NoChat({ filtered }: { filtered: boolean }): JSX.Element {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ py: 6, color: 'text.secondary' }}>
      <ChatIcon sx={{ fontSize: 44, opacity: 0.6 }} />
      <Typography variant="body2" data-testid="chat-empty" sx={{ maxWidth: 480, textAlign: 'center' }}>
        {filtered
          ? 'No chat matches those filters.'
          : "No chat captured yet. Tells, guild, group, channels, OOC and auction from your log show up here, plus your own /say. (Other players' /say is left out: the game prints it exactly like a monster's, so it can't be told apart.)"}
      </Typography>
    </Stack>
  )
}

export default function ChatView(): JSX.Element {
  const history = useChatHistory()
  // All channels on by default. A channel toggles off when its chip is clicked.
  const [off, setOff] = useState<Set<ChatChannel>>(() => new Set())
  const [query, setQuery] = useState('')

  const toggle = (c: ChatChannel): void =>
    setOff((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return history.filter((l) => {
      if (off.has(l.channel)) return false
      if (q === '') return true
      return l.text.toLowerCase().includes(q) || l.from.toLowerCase().includes(q)
    })
  }, [history, off, query])

  const filtering = off.size > 0 || query.trim() !== ''

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, p: 2, gap: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        {CHANNEL_ORDER.map((c) => {
          const meta = CHANNEL_META[c]
          const active = !off.has(c)
          return (
            <Chip
              key={c}
              label={meta.label}
              size="small"
              onClick={() => toggle(c)}
              data-testid={`chat-filter-${c}`}
              variant={active ? 'filled' : 'outlined'}
              sx={{
                bgcolor: active ? meta.color : 'transparent',
                color: active ? '#000' : 'text.secondary',
                borderColor: meta.color,
                fontWeight: 600
              }}
            />
          )
        })}
        <Box sx={{ flexGrow: 1 }} />
        <TextField
          size="small"
          placeholder="Search chat..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="chat-search"
          sx={{ minWidth: 200 }}
        />
      </Stack>

      <Typography variant="caption" color="text.secondary">
        {rows.length.toLocaleString()} {rows.length === 1 ? 'line' : 'lines'}
        {filtering ? ` of ${history.length.toLocaleString()}` : ''}
      </Typography>

      <Box
        data-testid="chat-list"
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: 13,
          lineHeight: 1.6,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          px: 1.5,
          py: 1
        }}
      >
        {rows.length === 0 ? (
          <NoChat filtered={filtering} />
        ) : (
          rows.map((l, i) => (
            <Box key={i} sx={{ display: 'flex', gap: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <Box component="span" sx={{ color: 'text.disabled', flexShrink: 0 }}>
                {fmtTime(l.ts)}
              </Box>
              <Box component="span" sx={{ color: CHANNEL_META[l.channel].color, flexShrink: 0, fontWeight: 600 }}>
                {speaker(l)}
              </Box>
              <Box component="span">{l.text}</Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  )
}
