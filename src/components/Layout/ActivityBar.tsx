import { useUIStore, type SidebarTab } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import { IS_OFFICE } from '@/utils/windowMode'
import type { TranslationKey } from '@/i18n'

const OFFICE_ICON = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 21V8l6-4 6 4v13" />
    <path d="M16 21V5l4 3v13" />
    <path d="M2 21h20" />
    <path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
  </svg>
)

export default function ActivityBar() {
  const activeSidebarTab = useUIStore((s) => s.activeSidebarTab)
  const isSidebarVisible = useUIStore((s) => s.isSidebarVisible)
  const t = useI18n()

  const topIcons: Array<{ key: SidebarTab; titleKey: TranslationKey; icon: JSX.Element }> = [
    // 办公室窗口（一人公司）：顶部最上方放「办公室」图标（从项目工作区回到 3D
    // 视图），位于「代码管理」之上。
    ...(IS_OFFICE
      ? [{ key: 'office' as const, titleKey: 'activityBar.office' as TranslationKey, icon: OFFICE_ICON }]
      : []),
    // 办公室窗口（一人公司）不显示「文件」入口（项目文件树在办公室视图左侧栏内
    // 就地打开）；代码管理/文件变更/Agent任务/使用统计/技能/MCP 全部保留。
    ...(IS_OFFICE ? [] : [
    {
      key: 'files' as const,
      titleKey: 'activityBar.conversation' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
    ]),
    {
      key: 'git',
      titleKey: 'activityBar.scm' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <line x1="6" y1="8.5" x2="6" y2="15.5" />
          <path d="M6 12C6 12 12 9 15.5 6" />
          <path d="M6 12C6 12 12 15 15.5 18" />
        </svg>
      ),
    },
    {
      key: 'changes',
      titleKey: 'activityBar.history' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
          <path d="M14 2v6h6" />
          <path d="M12.2 17.8l.9-2.6 4.2-4.2 1.7 1.7-4.2 4.2-2.6.9z" />
        </svg>
      ),
    },
    {
      key: 'agent',
      titleKey: 'activityBar.agent' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="8" width="16" height="12" rx="2" />
          <path d="M12 8V4" />
          <circle cx="12" cy="3" r="1.2" />
          <path d="M9 13h.01M15 13h.01M9 17h6" />
        </svg>
      ),
    },
    {
      key: 'usage',
      titleKey: 'activityBar.usage' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="20" x2="4" y2="14" />
          <line x1="10" y1="20" x2="10" y2="6" />
          <line x1="16" y1="20" x2="16" y2="11" />
          <line x1="22" y1="20" x2="22" y2="3" />
          <path d="M2 20h22" />
        </svg>
      ),
    },
    {
      key: 'skills',
      titleKey: 'activityBar.skills' as TranslationKey,
      icon: (
        <svg viewBox="0 0 1024 1024" width="22" height="22" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M823.296 64.96l135.744 135.744-769.28 769.28-135.808-135.68L823.296 64.96z m0 108.544L162.432 834.24l27.2 27.136L850.432 200.704l-27.2-27.2zM803.2 512a15.68 15.68 0 0 1 15.232 14.336 146.88 146.88 0 0 0 127.68 133.12 15.68 15.68 0 0 1-0.64 31.232 146.752 146.752 0 0 0-133.12 127.744 15.68 15.68 0 0 1-31.104-0.64 146.816 146.816 0 0 0-127.488-133.184 15.68 15.68 0 0 1 0.64-31.232 146.752 146.752 0 0 0 132.992-127.744 15.68 15.68 0 0 1 12.032-13.248l3.84-0.384z m-576-448a15.68 15.68 0 0 1 15.232 14.336 146.88 146.88 0 0 0 127.68 133.12 15.68 15.68 0 0 1-0.64 31.232 146.752 146.752 0 0 0-133.12 127.744 15.68 15.68 0 0 1-31.104-0.64 146.816 146.816 0 0 0-127.488-133.184 15.68 15.68 0 0 1 0.64-31.232 146.752 146.752 0 0 0 132.992-127.744 15.68 15.68 0 0 1 12.032-13.248L227.328 64z m282.624 0a10.24 10.24 0 0 1 10.496 8.832c3.328 23.36 22.4 41.216 45.952 42.944a10.24 10.24 0 0 1 0.64 20.48 50.112 50.112 0 0 0-42.944 45.888 10.24 10.24 0 0 1-20.48 0.64 50.112 50.112 0 0 0-45.888-42.944 10.24 10.24 0 0 1-0.64-20.416 50.112 50.112 0 0 0 42.944-45.952 10.24 10.24 0 0 1 6.912-8.96L509.888 64z" />
        </svg>
      ),
    },
    {
      key: 'mcp',
      titleKey: 'activityBar.mcp' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      ),
    },
    {
      key: 'browser',
      titleKey: 'activityBar.browser' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
        </svg>
      ),
    },
  ]

  // 底部图标。主窗口：设置正上方放「一人公司」入口（点击打开独立办公室窗口）；
  // 办公室窗口本身不重复放该入口。
  const bottomIcons: Array<{ key: string; titleKey: TranslationKey; icon: JSX.Element; action: () => void }> = [
    ...(IS_OFFICE
      ? []
      : [{
          key: 'office',
          titleKey: 'activityBar.office' as TranslationKey,
          icon: OFFICE_ICON,
          action: () => window.electronAPI.openOfficeWindow(),
        }]),
    {
      key: 'settings',
      titleKey: 'activityBar.settings' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
      action: () => useUIStore.getState().openSettings(),
    },
    {
      key: 'account',
      titleKey: 'activityBar.account' as TranslationKey,
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="8" r="3.5" />
          <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" strokeLinecap="round" />
        </svg>
      ),
      action: () => {},
    },
  ]

  const handleClick = (key: string) => {
    // Sidebar panels (file change history / agent tasks / usage / skills / MCP /
    // 办公室视图切换 / 浏览器): switch tab, revealing the sidebar if hidden.
    const ui = useUIStore.getState()
    if (!ui.isSidebarVisible) ui.toggleSidebar()
    ui.setActiveSidebarTab(key as SidebarTab)
  }

  return (
    <div
      className="shrink-0 flex flex-col select-none rounded-xl glass-chrome"
      style={{
        width: 44,
        background: 'color-mix(in srgb, var(--card, rgba(255,255,255,0.75)) 55%, transparent)',
      }}
    >
      {/* Top icons */}
      <div className="flex flex-col items-center flex-1 py-1 gap-px">
        {topIcons.map((item) => {
          const isActive = isSidebarVisible && activeSidebarTab === item.key
          return (
            <button
              key={item.key}
              aria-label={t(item.titleKey)} title={t(item.titleKey)}
              onClick={() => handleClick(item.key)}
              className="relative flex items-center justify-center rounded-full transition-all"
              style={{
                width: 38,
                height: 38,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                background: isActive ? 'var(--bg-selected)' : 'transparent',
                margin: '1px 0',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.color = 'var(--text-secondary)'
                  e.currentTarget.style.background = 'var(--hover)'
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.color = 'var(--text-muted)'
                  e.currentTarget.style.background = 'transparent'
                }
              }}
            >
              {/* Active indicator bar (Stitch: left primary rounded bar) */}
              {isActive && (
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 7,
                    bottom: 7,
                    width: 3,
                    background: 'var(--accent)',
                    borderRadius: '0 3px 3px 0',
                  }}
                />
              )}
              {item.icon}
            </button>
          )
        })}
      </div>

      {/* Bottom icons */}
      <div className="flex flex-col items-center pb-1 gap-px">
        {bottomIcons.map((item) => (
          <button
            key={item.key}
            aria-label={t(item.titleKey)} title={t(item.titleKey)}
            onClick={item.action}
            style={{
              width: 38,
              height: 38,
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.15s, background 0.15s',
              borderRadius: 9999,
              margin: '1px 0',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--text-secondary)'
              e.currentTarget.style.background = 'var(--hover)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-muted)'
              e.currentTarget.style.background = 'transparent'
            }}
          >
            {item.icon}
          </button>
        ))}
      </div>
    </div>
  )
}
