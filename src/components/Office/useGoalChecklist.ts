/**
 * 目标达成清单轮询 hook —— 与看板同节奏（5s），active=false 停止。
 * GoalChecklistCard 与 OfficeTopBar（徽章达成率）共用，避免各自轮询。
 */
import { useEffect, useState } from 'react'
import { readGoalChecklist, type GoalChecklistSummary } from '@/services/targetMode/goalChecklist'

export function useGoalChecklist(root: string | null, active: boolean): GoalChecklistSummary | null {
  const [summary, setSummary] = useState<GoalChecklistSummary | null>(null)

  useEffect(() => {
    if (!root || !active) {
      setSummary(null)
      return
    }
    let alive = true
    const load = () => {
      readGoalChecklist(root).then((s) => {
        if (alive) setSummary(s)
      })
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [root, active])

  return summary
}
