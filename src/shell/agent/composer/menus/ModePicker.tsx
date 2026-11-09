/**
 * 权限模式浮层（设计稿 `detail-01-permission-modes`）。
 *
 * 结构：
 *   顶部 12px muted 一行「当前：<模式> · <一句后果>」
 *   五档 52px 行（图标 / 14px ink 名称 / 12px muted 描述 / 当前档 ink 勾）
 *   底部 11px muted 提示「Shift+Tab 循环切换 · 当前会话内生效」
 *
 * 选档不写 store 细节：一律走 `chatStore.requestEditModeChange`（自主/完全两档
 * 会在那里过一次原生读授权确认，拒绝则留在原档）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import { copyFor, currentModeLine } from './copy'
import { useMenuLocale } from './locale'
import { useMenuKeyboard } from './menuNav'
import {
  displayMode,
  modeCopy,
  modeItems,
  modeLabel,
  normalizeMode,
  type ModeMenuItem,
} from './modeMenu'
import { Check, Chevron, Popover, useOutsideClose } from './primitives'
import type { EditMode } from '@/services/permissions/modePolicy'

/** 每档一个线性图标：语义靠图形提示，不靠彩色 chip */
const MODE_ICONS: Record<EditMode, ReactNode> = {
  confirm_before_change: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M8.5 12.2l2.4 2.4 4.6-5" />
    </>
  ),
  auto_edit: (
    <>
      <path d="M4 20h4l10.5-10.5a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5V20z" />
      <path d="M13.5 7.5l3 3" />
    </>
  ),
  plan: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2.5" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  guarded: (
    <>
      <path d="M4 6l7 6-7 6z" />
      <path d="M12 6l7 6-7 6z" />
    </>
  ),
  yolo: (
    <>
      <path d="M12 3.5l9 15.5H3z" />
      <path d="M12 9.5v4M12 16.4h.01" />
    </>
  ),
}

function ModeIcon({ mode }: { mode: EditMode }) {
  return (
    <svg
      className="w-4 h-4 shrink-0 text-[var(--pure-secondary)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {MODE_ICONS[mode]}
    </svg>
  )
}

export function ModePicker() {
  const t = useI18n()
  const locale = useMenuLocale()
  const copy = copyFor(locale)

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const session = useChatStore((s) =>
    s.activeSessionId ? (s.sessions.find((x) => x.id === s.activeSessionId) ?? null) : null,
  )
  const requestEditModeChange = useChatStore((s) => s.requestEditModeChange)

  const targetMode = session?.targetMode === true
  const current = displayMode(normalizeMode(session?.projectEditMode), targetMode)
  const items = useMemo(() => modeItems(locale, targetMode), [locale, targetMode])
  const currentIndex = Math.max(
    0,
    items.findIndex((item) => item.mode === current),
  )

  const close = useCallback(() => {
    setOpen(false)
    // 键盘关闭后焦点回到触发器，否则 Tab 会从文档开头继续
    triggerRef.current?.focus()
  }, [])

  const ref = useOutsideClose(open, close)

  const pick = useCallback(
    (index: number) => {
      const item = items[index]
      if (!item) return
      close()
      if (activeSessionId) void requestEditModeChange(activeSessionId, item.mode)
    },
    [activeSessionId, close, items, requestEditModeChange],
  )

  const kb = useMenuKeyboard({
    count: items.length,
    initialIndex: currentIndex,
    resetKey: `${open}:${current}:${targetMode}`,
    onSelect: pick,
    onClose: close,
  })

  // 打开即把焦点放进面板：↑/↓/Enter 不必先用鼠标点一下
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('chat.projectEditModeLabel')}
        className="h-7 px-1.5 rounded-lg flex items-center gap-1 text-[13px] text-[var(--pure-secondary)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
      >
        <span className="truncate max-w-[120px]">{modeLabel(current, locale)}</span>
        <Chevron open={open} />
      </button>

      {open && (
        <Popover
          width="w-[360px] max-w-[calc(100vw-24px)]"
          label={copy.modeDialog}
          padded
          maxHeightClass="max-h-[380px]"
        >
          <div ref={panelRef} tabIndex={-1} onKeyDown={kb.onKeyDown} className="outline-none">
            <p className="text-[12px] leading-[16px] text-[var(--pure-muted)]">
              {currentModeLine(locale, modeLabel(current, locale), modeCopy(current, locale).consequence)}
            </p>

            <ul className="mt-1.5">
              {items.map((item: ModeMenuItem, index) => {
                const active = item.mode === current
                const highlighted = index === kb.index
                return (
                  <li key={item.mode}>
                    <button
                      ref={kb.rowRef(index)}
                      type="button"
                      onClick={() => pick(index)}
                      onMouseEnter={() => kb.setIndex(index)}
                      aria-current={active ? 'true' : undefined}
                      className={`w-full h-[52px] px-2 rounded-[10px] flex items-center gap-2.5 text-left transition-colors ${
                        highlighted ? 'bg-[var(--pure-hover)]' : 'hover:bg-[var(--pure-hover)]'
                      }`}
                    >
                      <ModeIcon mode={item.mode} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] leading-[20px] text-[var(--pure-ink)]">
                          {item.label}
                        </span>
                        <span className="block truncate text-[12px] leading-[16px] text-[var(--pure-muted)]">
                          {item.description}
                        </span>
                      </span>
                      {active && <Check />}
                    </button>
                  </li>
                )
              })}
            </ul>

            <p className="mt-1.5 px-2 text-[11px] leading-[15px] text-[var(--pure-muted)]">{copy.modeHint}</p>
          </div>
        </Popover>
      )}
    </div>
  )
}

export default ModePicker
