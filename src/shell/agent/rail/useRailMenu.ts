import { useCallback } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore, type ContextMenuItem } from '@/stores/uiStore'
import type { RailSessionRow } from './railModel'

export interface RailMenuOptions {
  /** 重命名 → 行内编辑（与双击同一入口，不弹额外对话框）。 */
  onRename: (id: string) => void
  /** 删除是破坏性操作：这里只把目标交给父组件弹确认框，绝不直接删。 */
  onRequestDelete: (row: RailSessionRow) => void
}

/**
 * 对话行的上下文菜单（复用 `components/Common/ContextMenu` + uiStore.showContextMenu，
 * 与旧侧栏共用同一套菜单宿主）：
 *   重命名 / 置顶（取消置顶）/ 复制路径 / 归档（取消归档）/ 删除
 * 归档在 chatStore 里是 `toggleArchive`（可逆），所以不做二次确认；删除必须确认。
 */
export function useRailMenu({ onRename, onRequestDelete }: RailMenuOptions) {
  const togglePin = useChatStore((s) => s.togglePin)
  const toggleArchive = useChatStore((s) => s.toggleArchive)
  const showContextMenu = useUIStore((s) => s.showContextMenu)
  const showNotification = useUIStore((s) => s.showNotification)

  const copyPath = useCallback(
    async (path: string) => {
      try {
        await navigator.clipboard.writeText(path)
        showNotification('已复制路径', 'success')
      } catch {
        showNotification('复制路径失败', 'warning')
      }
    },
    [showNotification],
  )

  const openMenu = useCallback(
    (row: RailSessionRow, x: number, y: number) => {
      const items: ContextMenuItem[] = [
        { label: '重命名', icon: '✏️', action: () => onRename(row.id) },
        {
          label: row.pinnedAt ? '取消置顶' : '置顶',
          icon: '📌',
          action: () => togglePin(row.id),
        },
        {
          label: '复制路径',
          icon: '📋',
          // 对话本身没有文件路径 —— 复制的是它绑定的项目路径；
          // 未绑定项目的对话（未归类）没有可复制的路径，禁用而不是复制空串。
          disabled: !row.projectPath,
          action: () => {
            if (row.projectPath) void copyPath(row.projectPath)
          },
        },
        {
          label: row.archivedAt ? '取消归档' : '归档',
          icon: '📦',
          action: () => toggleArchive(row.id),
        },
        { separator: true, label: '' },
        { label: '删除', icon: '🗑️', action: () => onRequestDelete(row) },
      ]
      showContextMenu(x, y, items)
    },
    [copyPath, onRename, onRequestDelete, showContextMenu, toggleArchive, togglePin],
  )

  return { openMenu }
}
