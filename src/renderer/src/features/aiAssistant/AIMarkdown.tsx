import { type JSX, type MouseEvent, type ReactNode } from 'react'
import { Button } from '@mui/material'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AiMentions } from '@shared/aiChat'
import type { MobTarget } from '../mobs/mobTarget'
import { SpellTooltip } from '../../lib/SpellCard'
import { linkMentions, parseMentionHref } from './mentionLinks'

const LINK_SX = { p: 0, minWidth: 0, textTransform: 'none', verticalAlign: 'baseline' } as const

function MentionAnchor(props: {
  href: string | undefined
  children: ReactNode
  onOpenLoot: (name: string) => void
  onOpenMob: (t: MobTarget) => void
}): JSX.Element {
  const parsed = parseMentionHref(props.href)
  if (!parsed) {
    return (
      <a href={props.href} target="_blank" rel="noreferrer">
        {props.children}
      </a>
    )
  }
  const click = (e: MouseEvent): void => {
    e.preventDefault()
    if (parsed.kind === 'item') props.onOpenLoot(parsed.name)
    if (parsed.kind === 'mob') props.onOpenMob({ mob: parsed.name })
  }
  const btn = (
    <Button component="a" href={props.href} size="small" variant="text" sx={LINK_SX} onClick={click}>
      {props.children}
    </Button>
  )
  if (parsed.kind === 'spell') {
    return (
      <SpellTooltip name={parsed.name} placement="right">
        {btn}
      </SpellTooltip>
    )
  }
  return btn
}

export function AIMarkdown(props: {
  text: string
  mentions?: AiMentions
  onOpenLoot: (name: string) => void
  onOpenMob: (t: MobTarget) => void
}): JSX.Element {
  const { text, mentions, onOpenLoot, onOpenMob } = props
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <MentionAnchor href={href} onOpenLoot={onOpenLoot} onOpenMob={onOpenMob}>
            {children}
          </MentionAnchor>
        )
      }}
    >
      {linkMentions(text, mentions)}
    </ReactMarkdown>
  )
}
