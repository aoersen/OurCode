/**
 * React binding for the context-usage view model.
 *
 * Every surface (composer ring, status bar, warning banner) calls this, so they
 * cannot disagree about the percentage. Recompute cost is O(messages) — it is
 * keyed on the ACTIVE SESSION OBJECT, which zustand only replaces when a
 * message is added/edited: the live stream lives in `streamingBySession` and
 * deliberately does not touch the session, so a 20 Hz token flush never
 * re-runs the estimate.
 */
import { useMemo } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { computeContextUsage, type ContextUsage } from '@/services/llm/contextUsage'

export function useContextUsage(): ContextUsage | null {
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null,
  )
  const customModels = useConfigStore((s) => s.customModels)
  const groups = useConfigStore((s) => s.configGroups)
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)

  return useMemo(() => {
    if (!session) return null
    // The chat loop resolves the runtime model from the session's own config
    // group; the globally active group is only a last-resort fallback (startup
    // restore can leave the two out of sync). The window must follow whatever
    // model actually answers, or the percentage is measured against the wrong
    // denominator.
    const model =
      session.model ||
      groups.find((g) => g.id === session.configGroupId)?.defaultModel ||
      groups.find((g) => g.id === activeConfigGroupId)?.defaultModel ||
      ''
    return computeContextUsage({ ...session, model }, customModels)
  }, [session, customModels, groups, activeConfigGroupId])
}

export default useContextUsage
