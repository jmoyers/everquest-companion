import { useEffect, useState } from 'react'
import type { AiUsageSnap } from '@shared/aiChat'

const EMPTY: AiUsageSnap = { spendUsd: null, modelLabel: '' }

export function useAiUsage(refreshKey: boolean): AiUsageSnap {
  const [usage, setUsage] = useState<AiUsageSnap>(EMPTY)

  useEffect(() => {
    const get = window.eq.getAiUsage
    if (!get) return
    void get().then(setUsage).catch(() => undefined)
  }, [refreshKey])

  useEffect(() => {
    const on = window.eq.onAiUsage
    if (!on) return
    return on(setUsage)
  }, [])

  return usage
}
