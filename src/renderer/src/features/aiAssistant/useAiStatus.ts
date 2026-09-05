import { useEffect, useRef, useState } from 'react'
import type { AiLiveStatus } from '@shared/aiChat'
import { eqGetAiStatus } from './aiEq'
import { dumpNoticesFor } from './dumpStatus'

export const EMPTY_AI_STATUS: AiLiveStatus = {
  zone: null,
  loadout: { ready: false, classes: [], inferred: false, uncertain: false },
  dumps: [],
  recap: []
}

const POLL_MS = 5000

export function useAiStatus(): { status: AiLiveStatus; dumpNotices: string[] } {
  const [status, setStatus] = useState<AiLiveStatus>(EMPTY_AI_STATUS)
  const [dumpNotices, setDumpNotices] = useState<string[]>([])
  const prevRef = useRef<AiLiveStatus | null>(null)

  useEffect(() => {
    let alive = true
    const apply = (next: AiLiveStatus): void => {
      if (!alive) return
      const notices = dumpNoticesFor(prevRef.current, next)
      prevRef.current = next
      setStatus(next)
      if (notices.length > 0) setDumpNotices(notices)
    }
    const tick = (): void => {
      const live = eqGetAiStatus()
      if (live) {
        void live.then(apply).catch(() => undefined)
        return
      }
      void window.eq
        .getAiContext()
        .then((recap) => {
          apply({ ...EMPTY_AI_STATUS, recap })
        })
        .catch(() => undefined)
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  return { status, dumpNotices }
}
