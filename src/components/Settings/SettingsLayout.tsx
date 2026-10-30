/**
 * Settings shell — vertical navigation on the left, one scrolling content pane
 * on the right. This replaces the old five-across tab strip: the strip widened
 * with every new tab, gave no room for a hint, and left each tab to invent its
 * own padding and heading style.
 *
 * A11y: real `tablist`/`tab`/`tabpanel` wiring, arrow-key navigation, Escape to
 * close, and a focus trap so Tab never escapes the dialog.
 */
import { useEffect, useRef, type ReactNode } from 'react'

import { T_GROUP, T_META, T_PAGE, T_PANEL } from './settings-ui'

export type SettingsTabKey = 'api' | 'appearance' | 'editor' | 'shortcuts' | 'features'

export interface SettingsTabItem {
  key: SettingsTabKey
  /** Visible label — kept identical to the old tab labels (e2e matches on them). */
  label: string
  /** One-line description shown under the page title. */
  hint: string
  icon: ReactNode
}

export interface SettingsNavGroup {
  title: string
  items: SettingsTabItem[]
}

interface SettingsLayoutProps {
  groups: SettingsNavGroup[]
  activeTab: SettingsTabKey
  onTabChange: (key: SettingsTabKey) => void
  query: string
  onQueryChange: (next: string) => void
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

export default function SettingsLayout({
  groups,
  activeTab,
  onTabChange,
  query,
  onQueryChange,
  onClose,
  footer,
  children,
}: SettingsLayoutProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<SettingsTabKey, HTMLButtonElement>())
  const flatTabs = groups.flatMap((g) => g.items)
  const current = flatTabs.find((t) => t.key === activeTab) ?? flatTabs[0]

  // Escape closes; Tab is trapped inside the dialog.
  useEffect(() => {
    const node = dialogRef.current
    if (!node) return undefined
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault()
        last.focus()
      }
    }
    node.addEventListener('keydown', onKeyDown)
    return () => node.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // A new tab starts at the top — the old layout kept the previous scroll offset.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [activeTab])

  const focusTab = (key: SettingsTabKey) => {
    onTabChange(key)
    tabRefs.current.get(key)?.focus()
  }

  const onTablistKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = flatTabs.findIndex((t) => t.key === activeTab)
    if (index < 0) return
    const last = flatTabs.length - 1
    const next = (i: number) => flatTabs[(i + last + 1) % (last + 1)].key
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      focusTab(next(index + 1))
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      focusTab(next(index - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusTab(flatTabs[0].key)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusTab(flatTabs[last].key)
    }
  }

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        className="glass-modal flex h-[min(860px,90vh)] w-[1120px] max-w-[96vw] overflow-hidden rounded-xl shadow-2xl outline-none"
        style={{ animation: 'fadeIn 0.2s ease-out' }}
      >
        {/* ── Navigation rail ── */}
        <nav
          aria-label="设置分类"
          className="flex w-[232px] shrink-0 flex-col border-r border-nova-border bg-nova-surface"
        >
          <div className="flex flex-col gap-1 px-4 pb-3 pt-5">
            <h2 id="settings-dialog-title" className={T_PAGE}>
              设置
            </h2>
            <p className={T_META}>按分类调整应用行为，修改即时生效</p>
          </div>

          <div className="px-3 pb-3">
            <div className="relative">
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-nova-text-muted"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                aria-label="搜索设置项"
                placeholder="搜索设置项"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                className="h-8 w-full rounded-lg border border-nova-border bg-nova-input-bg pl-8 pr-2 text-[13px] leading-[18px] text-nova-text-primary outline-none transition-colors focus:border-accent-60"
              />
            </div>
          </div>

          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label="设置分类"
            onKeyDown={onTablistKeyDown}
            className="flex-1 overflow-y-auto px-2 pb-3"
          >
            {groups.map((group) => (
              <div key={group.title} className="mb-3 flex flex-col gap-0.5">
                <p className={`${T_GROUP} px-2 pb-1 pt-2`}>{group.title}</p>
                {group.items.map((tab) => {
                  const active = tab.key === activeTab
                  const matches = !query.trim() || tab.label.toLowerCase().includes(query.trim().toLowerCase())
                  return (
                    <button
                      key={tab.key}
                      ref={(el) => {
                        if (el) tabRefs.current.set(tab.key, el)
                        else tabRefs.current.delete(tab.key)
                      }}
                      role="tab"
                      id={`settings-tab-${tab.key}`}
                      aria-selected={active}
                      aria-controls={`settings-panel-${tab.key}`}
                      tabIndex={active ? 0 : -1}
                      onClick={() => onTabChange(tab.key)}
                      className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] leading-[18px] font-medium transition-colors ${
                        active
                          ? 'bg-accent-10 text-accent-text'
                          : matches
                            ? 'text-nova-text-secondary hover:bg-nova-hover hover:text-nova-text-primary'
                            : 'text-nova-text-muted hover:bg-nova-hover'
                      }`}
                    >
                      <span aria-hidden="true" className="flex w-4 shrink-0 items-center justify-center">
                        {tab.icon}
                      </span>
                      <span className="truncate">{tab.label}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          {footer ? <div className="border-t border-nova-border px-4 py-3">{footer}</div> : null}
        </nav>

        {/* ── Content pane ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-nova-border px-6 pb-4 pt-5">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className={T_PANEL}>{current.label}</h2>
              <p className={T_META}>{current.hint}</p>
            </div>
            <button
              type="button"
              aria-label="关闭设置"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-nova-text-muted transition-colors hover:bg-nova-hover hover:text-nova-text-primary"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </header>

          <div
            ref={scrollRef}
            role="tabpanel"
            id={`settings-panel-${current.key}`}
            aria-labelledby={`settings-tab-${current.key}`}
            tabIndex={0}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5 outline-none"
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
