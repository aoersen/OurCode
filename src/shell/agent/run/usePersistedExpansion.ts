import { useCallback, useState } from 'react'
import {
  isExpanded,
  readExpansionMap,
  withExpanded,
  writeExpansionMap,
  type ExpansionMap,
} from './runExpansion'

/**
 * 一条消息的展开状态（持久化在 localStorage）。
 *
 * fallback 只用于「还没被用户手动开合过」的情况：思考块在流式时希望默认展开，
 * 一旦用户点过（有记录）就以记录为准，流式结束也不会自己收起来 —— 和旧壳里
 * userToggledRef 的行为一致，只是这里把选择记到磁盘上。
 */
export function usePersistedExpansion(
  key: string,
  messageId: string,
  fallback = false,
): [boolean, () => void] {
  const [map, setMap] = useState<ExpansionMap>(() => readExpansionMap(key))
  const [trackedId, setTrackedId] = useState(messageId)

  // 换了一条消息（列表虚拟化/会话切换）时重新读盘，而不是复用上一条的状态。
  if (trackedId !== messageId) {
    setTrackedId(messageId)
    setMap(readExpansionMap(key))
  }

  const expanded = isExpanded(map, messageId, fallback)

  const toggle = useCallback(() => {
    setMap((prev) => {
      const current = isExpanded(prev, messageId, fallback)
      const next = withExpanded(prev, messageId, !current)
      writeExpansionMap(key, next)
      return next
    })
  }, [key, messageId, fallback])

  return [expanded, toggle]
}
