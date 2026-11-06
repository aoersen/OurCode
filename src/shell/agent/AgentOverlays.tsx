import SettingsModal from '@/components/Settings/SettingsModal'
import CommandPalette from '@/components/CommandPalette/CommandPalette'
import ContextMenu from '@/components/Common/ContextMenu'
import NotificationToasts from '@/components/Common/NotificationToasts'
import UnsavedDialog from '@/components/Common/UnsavedDialog'
import UpdateDialog from '@/components/Common/UpdateDialog'
import { useUIStore } from '@/stores/uiStore'

/**
 * agent 壳的全局浮层。与 MainLayout 末尾那一组保持一致——壳换了，设置、
 * 命令面板、toast、更新提示还必须能打开，否则用户会「找不到设置」。
 */
export default function AgentOverlays() {
  const isSettingsOpen = useUIStore((s) => s.isSettingsOpen)
  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen)
  const contextMenu = useUIStore((s) => s.contextMenu)

  return (
    <>
      {isSettingsOpen && <SettingsModal />}
      {isCommandPaletteOpen && <CommandPalette />}
      {contextMenu && <ContextMenu />}
      <NotificationToasts />
      <UnsavedDialog />
      <UpdateDialog />
    </>
  )
}
