import type { AiLiveStatus, AiStreamChunk } from '@shared/aiChat'

/** Preload may lag the IPC names. Callers degrade when these are missing. */
interface AiEqExtras {
  getAiStatus?: () => Promise<AiLiveStatus>
  onAiChunk?: (cb: (chunk: AiStreamChunk) => void) => () => void
}

function extras(): AiEqExtras {
  return window.eq
}

export function eqGetAiStatus(): Promise<AiLiveStatus> | null {
  const fn = extras().getAiStatus
  return fn ? fn() : null
}

export function eqOnAiChunk(cb: (chunk: AiStreamChunk) => void): (() => void) | null {
  const fn = extras().onAiChunk
  return fn ? fn(cb) : null
}
