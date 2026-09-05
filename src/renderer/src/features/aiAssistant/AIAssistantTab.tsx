import { type JSX, useEffect, useRef, useState } from 'react'
import { Box, Stack } from '@mui/material'
import type { MobTarget } from '../mobs/mobTarget'
import { ChatColumn } from './AIAssistantChat'
import { AIStatusStrip } from './AIStatusStrip'
import { dropDraft } from './streamApply'
import { useAiChat } from './useAiChat'
import { useAiSend } from './useAiSend'
import { useAiStatus } from './useAiStatus'
import { useAiUsage } from './useAiUsage'

export default function AIAssistantTab(props: {
  onOpenLoot: (item?: string) => void
  onOpenMob: (t: MobTarget) => void
  onOpenAlerts: () => void
}): JSX.Element {
  const [messages, setMessages] = useAiChat()
  const { loading, send, phase } = useAiSend(messages, setMessages)
  const { status, dumpNotices } = useAiStatus()
  const usage = useAiUsage(loading)
  const [needsKey, setNeedsKey] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.eq.getAiConfig().then((c) => {
      setNeedsKey(!c.apiKey)
    })
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const onOpenLoot = (name: string): void => {
    props.onOpenLoot(name)
  }

  return (
    <Stack spacing={1} sx={{ height: '100%', p: 1, minHeight: 0 }} data-testid="ai-assistant-tab">
      <AIStatusStrip status={status} dumpNotices={dumpNotices} />
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ChatColumn
          messages={messages}
          loading={loading}
          status={status}
          dumpNotices={dumpNotices}
          onSend={send}
          bottomRef={bottomRef}
          onOpenLoot={onOpenLoot}
          onOpenMob={props.onOpenMob}
          onOpenAlerts={props.onOpenAlerts}
          usage={usage}
          needsKey={needsKey}
          phase={phase}
          onDropDraft={(msgIndex, draftId) => {
            setMessages((prev) => dropDraft(prev, msgIndex, draftId))
          }}
        />
      </Box>
    </Stack>
  )
}
