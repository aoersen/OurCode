import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import AboutSection from './sections/AboutSection'
import ApiModelsSection from './sections/ApiModelsSection'
import AppearanceSection from './sections/AppearanceSection'
import EditorAiSection from './sections/EditorAiSection'
import FeaturesSection from './sections/FeaturesSection'
import McpSettingsSection from './sections/McpSettingsSection'
import ShortcutsSection from './sections/ShortcutsSection'
import {
  SETTINGS_TABS,
  nextSettingsTab,
  resolveSettingsTab,
  type SettingsTabId,
} from './settingsNav'
import { TextAction } from './settingsParts'

export interface SettingsSurfaceProps {
  onClose: () => void
  /** 打开目标：'api' | 'appearance' | 'editor' | 'shortcuts' | 'features' | 'mcp' | 'about' 及常见别名 */
  initialTab?: string
}

/**
 * 设置面：全窗口两栏（左 200px 纯文字导航 / 右 760px 内容列）。
 *
 * 由壳层挂载（`useUIStore.isSettingsOpen`），不自己监听 store —— 与旧
 * `SettingsModal` 的区别只有外观：没有弹窗框、没有卡片、没有彩色徽章，
 * 分行只靠留白，动作一律是文字。
 *
 * 键盘：↑/↓/Home/End 在导航里移动并切换；Esc 关闭；⌘/Ctrl+Enter 交给当前栏
 * 注册的保存钩子（目前只有「API 与模型」在表单有改动时才真的写盘）。
 */
export default function SettingsSurface({ onClose, initialTab }: SettingsSurfaceProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() => resolveSettingsTab(initialTab))
  const saveHandlerRef = useRef<(() => void) | null>(null)
  const navRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (initialTab === undefined) return
    setActiveTab(resolveSettingsTab(initialTab))
  }, [initialTab])

  // Esc 关闭；⌘/Ctrl+Enter 保存。子控件（如快捷键重绑输入框）先 preventDefault
  // 的按键不再冒到这里 —— 这样在输入框里按 Esc 只取消录入，不会把设置关掉。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        event.preventDefault()
        onClose()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        const save = saveHandlerRef.current
        if (!save) return
        event.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // 切栏回到顶部，避免长表单停在半截
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [activeTab])

  // 打开时把焦点搬进设置面（否则 Tab 焦点还停在被盖住的壳里）
  useEffect(() => {
    const button = navRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    button?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectTab = (id: SettingsTabId, focus = false) => {
    setActiveTab(id)
    if (!focus) return
    requestAnimationFrame(() => {
      navRef.current?.querySelector<HTMLButtonElement>(`[data-settings-tab="${id}"]`)?.focus()
    })
  }

  const onNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const next = nextSettingsTab(activeTab, event.key)
    if (!next) return
    event.preventDefault()
    selectTab(next, true)
  }

  return (
    <div
      className="pure-shell fixed inset-0 z-[150] flex bg-[var(--pure-canvas)]"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <nav
        ref={navRef}
        aria-label="设置分区"
        onKeyDown={onNavKeyDown}
        className="flex h-full w-[200px] shrink-0 flex-col border-r border-[var(--pure-border)] px-3 py-7"
      >
        <div className="px-2 pb-4 text-[13px] leading-[20px] text-[var(--pure-muted)]">设置</div>
        <div role="tablist" aria-label="设置分区列表" className="flex flex-col gap-0.5">
          {SETTINGS_TABS.map((tab) => {
            const active = tab.id === activeTab
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                data-settings-tab={tab.id}
                aria-selected={active}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={active ? 0 : -1}
                title={tab.title}
                onClick={() => selectTab(tab.id)}
                className={`pure-focus w-full rounded-xl px-2 py-1.5 text-left text-[13px] leading-[20px] transition-colors ${
                  active
                    ? 'bg-[var(--pure-hover)] text-[var(--pure-ink)]'
                    : 'text-[var(--pure-secondary)] hover:text-[var(--pure-ink)]'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        <div className="mt-auto px-2 pt-6 text-[11px] leading-[16px] text-[var(--pure-muted)]">
          Esc 关闭 · ⌘/Ctrl+Enter 保存
        </div>
      </nav>

      <div className="min-w-0 flex-1 flex flex-col">
        {/* 固定的一行顶部留白 + 关闭：关闭按钮不再和分区标题挤在同一块，
            内容从上到下滚动时它始终留在右上角。 */}
        <div className="shrink-0 h-12 px-10 flex items-center justify-end">
          <TextAction onClick={onClose} label="关闭设置">
            关闭
          </TextAction>
        </div>

        <div
          ref={contentRef}
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
          className="min-w-0 flex-1 overflow-y-auto pure-scroll"
        >
          {/* 内容列左对齐贴着导航分隔线（不再居中）：1440 宽窗口里居中会留出
              两百多像素的空洞，读起来像「内容没对齐」。 */}
          <div className="w-full max-w-[780px] px-10 pb-24">
            {activeTab === 'api' ? <ApiModelsSection saveHandlerRef={saveHandlerRef} /> : null}
            {activeTab === 'appearance' ? <AppearanceSection /> : null}
            {activeTab === 'editor' ? <EditorAiSection /> : null}
            {activeTab === 'shortcuts' ? <ShortcutsSection /> : null}
            {activeTab === 'features' ? <FeaturesSection onClose={onClose} /> : null}
            {activeTab === 'mcp' ? <McpSettingsSection /> : null}
            {activeTab === 'about' ? <AboutSection /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
