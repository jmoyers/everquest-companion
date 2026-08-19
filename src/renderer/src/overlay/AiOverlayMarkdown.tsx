// MUI-free markdown for the AI overlay. The tab uses AIMarkdown (MUI + mention
// buttons); this window only paints headings/lists/code so ## Heading is not raw.

import { type CSSProperties, type JSX, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const GOLD = '#d9b25f'

const root: CSSProperties = { fontSize: 12, lineHeight: 1.4, color: '#f2f2f2' }
const p: CSSProperties = { margin: '0 0 6px' }
const h: CSSProperties = { fontSize: 13, fontWeight: 700, margin: '8px 0 4px', color: GOLD }
const list: CSSProperties = { margin: '0 0 6px', paddingLeft: 18 }
const code: CSSProperties = {
  fontFamily: 'ui-monospace, Consolas, monospace',
  fontSize: 11,
  background: 'rgba(255,255,255,0.08)',
  padding: '0 3px',
  borderRadius: 3
}
const pre: CSSProperties = { ...code, display: 'block', padding: 6, overflow: 'auto', margin: '0 0 6px' }

function Heading({ children }: { children?: ReactNode }): JSX.Element {
  return <div style={h}>{children}</div>
}

export function AiOverlayMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div data-testid="ai-overlay-answer" style={root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: Heading,
          h2: Heading,
          h3: Heading,
          p: ({ children }) => <p style={p}>{children}</p>,
          ul: ({ children }) => <ul style={list}>{children}</ul>,
          ol: ({ children }) => <ol style={list}>{children}</ol>,
          li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
          strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          code: ({ children }) => <code style={code}>{children}</code>,
          pre: ({ children }) => <pre style={pre}>{children}</pre>,
          a: ({ children }) => <span style={{ color: GOLD }}>{children}</span>,
          hr: () => <hr style={{ border: 0, borderTop: '1px solid rgba(255,255,255,0.12)', margin: '8px 0' }} />
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
