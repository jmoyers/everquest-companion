// AiOverlay - the 'ai' overlay kind: last assistant answer over the game, plus an ask box
// while unlocked. MUI-free, same chrome as the event log (header / lock / bg / text scale).
//
// The thread lives in localStorage under AI_CHAT_STORAGE_KEY so the main tab and this window
// share one conversation (same origin). This window listens for `storage` and never assumes
// `window.eq` exists.

import { type JSX } from 'react'
import type { AiUsageSnap } from '@shared/aiChat'
import { formatAiSpend } from '@shared/aiModels'
import { aiChatPhaseColor, aiChatPhaseLabel, type AiChatPhase } from '@shared/aiSlash'
import { AiOverlayComposer } from './AiOverlayComposer'
import { AiOverlayMarkdown } from './AiOverlayMarkdown'
import { BgAlphaSlider } from './BgAlphaSlider'
import { OverlayHeader } from './OverlayHeader'
import { FOOTER_ROW, OverlayContent } from './overlayScale'
import { TextScaleStepper } from './TextScaleStepper'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'
import { useAiOverlaySession } from './useAiOverlaySession'

export { lastAiAnswer, historyFrom, foldAiChunk, foldToolHint } from './aiOverlayThread'

const GOLD = '#d9b25f'

export const AI_OVERLAY_EMPTY = 'Ask about an item, spell, or this fight.'

function AnswerPane({ text, hint }: { text: string | undefined; hint: string | null }): JSX.Element {
  if (!text && !hint) {
    return (
      <div data-testid="ai-overlay-empty" style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
        {AI_OVERLAY_EMPTY}
      </div>
    )
  }
  return (
    <div>
      {hint && (
        <div data-testid="ai-overlay-hint" style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', padding: '4px 2px 0' }}>
          {hint}
        </div>
      )}
      {text && <AiOverlayMarkdown text={text} />}
    </div>
  )
}

function OverlaySpendBar({
  usage,
  phase,
  noDrag
}: {
  usage: AiUsageSnap
  phase: AiChatPhase
  noDrag: React.CSSProperties
}): JSX.Element {
  const phaseText = aiChatPhaseLabel(phase)
  return (
    <div
      data-testid="ai-overlay-spend"
      style={{
        ...noDrag,
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        padding: '3px 8px',
        fontSize: 10,
        color: 'rgba(255,255,255,0.55)',
        flexShrink: 0
      }}
    >
      <span>{formatAiSpend(usage.spendUsd)}</span>
      <span data-testid="ai-overlay-phase" style={{ color: aiChatPhaseColor(phase) ?? undefined }}>
        {phaseText}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {usage.modelLabel}
      </span>
    </div>
  )
}

function AiFooter({
  bgAlpha,
  textScale,
  patch,
  noDrag
}: {
  bgAlpha: number
  textScale: number
  patch: OverlayChrome['patch']
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    <div
      style={{
        ...FOOTER_ROW,
        ...noDrag,
        gap: 8,
        fontSize: 10,
        color: 'rgba(255,255,255,0.6)'
      }}
    >
      <BgAlphaSlider bgAlpha={bgAlpha} patch={patch} noDrag={noDrag} />
      <TextScaleStepper textScale={textScale} patch={patch} noDrag={noDrag} />
    </div>
  )
}

export default function AiOverlay(): JSX.Element {
  const { locked, bgAlpha, textScale, hovering, patch, toggleLock, onEnter, onLeave, dragRegion, noDrag } =
    useOverlayChrome()
  const { shown, toolHint, input, setInput, busy, usage, phase, send } = useAiOverlaySession()

  return (
    <div
      data-testid="ai-overlay"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, "Segoe UI", Roboto, system-ui, sans-serif',
        color: '#f2f2f2',
        background: `rgba(14,17,21,${bgAlpha})`,
        border: locked ? '1px solid rgba(255,255,255,0.04)' : '1px solid rgba(217,178,95,0.4)',
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      <OverlayHeader
        tag="AI"
        title="AI Assistant"
        titleColor={GOLD}
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock }}
      />

      <OverlayContent textScale={textScale}>
        <AnswerPane text={shown} hint={toolHint} />
      </OverlayContent>

      {!locked && (
        <AiOverlayComposer
          value={input}
          setValue={setInput}
          busy={busy}
          onSend={send}
          noDrag={noDrag}
          empty={AI_OVERLAY_EMPTY}
        />
      )}
      <OverlaySpendBar usage={usage} phase={phase} noDrag={noDrag} />
      {!locked && <AiFooter bgAlpha={bgAlpha} textScale={textScale} patch={patch} noDrag={noDrag} />}
    </div>
  )
}
