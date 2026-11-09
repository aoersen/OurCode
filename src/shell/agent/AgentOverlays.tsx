import OfficeSurface from '../office/OfficeSurface'
import SettingsSurface from '../settings/SettingsSurface'
import CommandPalette from '@/components/CommandPalette/CommandPalette'
import ContextMenu from '@/components/Common/ContextMenu'
import NotificationToasts from '@/components/Common/NotificationToasts'
import UnsavedDialog from '@/components/Common/UnsavedDialog'
import UpdateDialog from '@/components/Common/UpdateDialog'
import { useUIStore } from '@/stores/uiStore'

/**
 * agent 壳的全局浮层。
 *
 * - 设置：新壳用 `SettingsSurface`（两栏纯文字导航 + 760 阅读列），旧
 *   `SettingsModal` 只留给旧工作台窗口，不再从这里挂载。
 * - 一人公司（B9）是整窗 surface，不是第二条布局：打开时盖住工作区，
 *   关闭即回到对话；不持久化、不占三栏。
 */
export default function AgentOverlays() {
  const isSettingsOpen = useUIStore((s) => s.isSettingsOpen)
  const closeSettings = useUIStore((s) => s.closeSettings)
  const settingsTarget = useUIStore((s) => s.settingsTarget)
  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen)
  const contextMenu = useUIStore((s) => s.contextMenu)
  const isOfficeSurfaceOpen = useUIStore((s) => s.isOfficeSurfaceOpen)
  const setOfficeSurfaceOpen = useUIStore((s) => s.setOfficeSurfaceOpen)

  return (
    <>
      {isOfficeSurfaceOpen && (
        <div className="absolute inset-0 z-40 bg-[var(--pure-canvas)]">
          <OfficeSurface onClose={() => setOfficeSurfaceOpen(false)} />
        </div>
      )}
      {isSettingsOpen && (
        <SettingsSurface onClose={closeSettings} initialTab={settingsTarget?.tab} />
      )}
      {isCommandPaletteOpen && <CommandPalette />}
      {contextMenu && <ContextMenu />}
      <NotificationToasts />
      <UnsavedDialog />
      <UpdateDialog />
    </>
  )
}
