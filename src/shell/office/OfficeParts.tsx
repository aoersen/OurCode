/**
 * Office 面共用的小排版件（不是组件库，只把「纯白 + 单一无衬线 + 文字动作」
 * 这套规则抽成几个壳）。
 *
 * 约定（与 OurCode Pure 设计系统一致）：
 *  - 没有描边卡片、没有彩色 chip、没有徽章；分隔靠留白与字色；
 *  - 圆角只用 12px（rounded-xl），胶囊只给输入条（本面没有输入条）；
 *  - 动作一律是文字，hover 才从 muted 变 ink / danger；
 *  - 颜色全走 `--pure-*` token，不写十六进制。
 */
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useRef } from 'react'

import { isSelectionKey, moveSelection } from './officeModel'

export const TEXT_ACTION =
  'pure-focus text-[12px] leading-[18px] text-[var(--pure-muted)] hover:text-[var(--pure-ink)] transition-colors disabled:opacity-40 disabled:hover:text-[var(--pure-muted)]'

export const TEXT_ACTION_DANGER =
  'pure-focus text-[12px] leading-[18px] text-[var(--pure-muted)] hover:text-[var(--pure-danger)] transition-colors'

interface TextActionProps {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
  label?: string
  danger?: boolean
  className?: string
}

/** 文字动作。行内动作 stopPropagation，避免同时触发「整行激活」。 */
export function TextAction({
  children,
  onClick,
  disabled,
  title,
  label,
  danger,
  className = '',
}: TextActionProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      disabled={disabled}
      title={title}
      aria-label={label ?? title}
      className={`${danger ? TEXT_ACTION_DANGER : TEXT_ACTION} ${className}`}
    >
      {children}
    </button>
  )
}

export type DotState = 'running' | 'failed' | 'pending' | 'idle'

/**
 * 6px 状态点：
 *  - running = 实心 ink（唯一的「动」的记号）；
 *  - failed  = 实心 danger；
 *  - pending = 空心 ink 环（有待处理，但没在跑）；
 *  - idle    = 极浅灰实心。
 */
export function OfficeDot({ state, title }: { state: DotState; title?: string }) {
  const tone =
    state === 'running'
      ? 'bg-[var(--pure-ink)] animate-pulse'
      : state === 'failed'
        ? 'bg-[var(--pure-danger)]'
        : state === 'pending'
          ? 'border border-[var(--pure-ink)] bg-transparent'
          : 'bg-[var(--pure-border)]'
  return <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${tone}`} aria-hidden title={title} />
}

/** 分区小标题（12px muted，无大写、无 letter-spacing）。 */
export function PanelLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 pb-1.5">
      <span className="text-[12px] leading-[18px] text-[var(--pure-muted)]">{children}</span>
      {trailing ? (
        <span className="ml-auto text-[11.5px] leading-[18px] text-[var(--pure-muted)] tabular-nums">{trailing}</span>
      ) : null}
    </div>
  )
}

/** 安静的一行说明（空态 / 未接入）。 */
export function QuietLine({ children }: { children: ReactNode }) {
  return <div className="py-2 text-[12px] leading-[19px] text-[var(--pure-muted)]">{children}</div>
}

interface OfficeRowProps {
  children: ReactNode
  /** 读屏用的行摘要（角色 + 状态 + 任务）。 */
  label: string
  selected: boolean
  onSelect: () => void
  onActivate: () => void
  className?: string
}

/**
 * 一行。列表里的行：`role="listitem"` + roving tabIndex（选中项 0，其余 -1），
 * ↑/↓ 由列表容器的 onKeyDown 接管，Enter 触发本行主动作。
 */
export function OfficeRow({ children, label, selected, onSelect, onActivate, className = '' }: OfficeRowProps) {
  return (
    <div
      data-office-row=""
      role="listitem"
      tabIndex={selected ? 0 : -1}
      aria-current={selected ? 'true' : undefined}
      aria-label={label}
      onClick={onActivate}
      onFocus={onSelect}
      onKeyDown={(event) => {
        // 焦点在行内按钮上时，回车属于那个按钮
        if (event.key !== 'Enter') return
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        // 容器也监听 Enter（键盘导航）：拦住冒泡，避免同一次回车激活两次
        event.stopPropagation()
        onActivate()
      }}
      className={`pure-row pure-surface-row px-2 -mx-2 cursor-default ${
        selected ? 'bg-[var(--pure-active)]' : ''
      } ${className}`}
    >
      {children}
    </div>
  )
}

interface RovingListOptions {
  length: number
  index: number
  setIndex: (index: number) => void
  /** Enter / Space 激活当前选中行。 */
  onActivate: (index: number) => void
}

/**
 * 列表键盘导航：↑/↓/Home/End 移动选择位并把焦点搬到那一行，Enter 激活。
 * 焦点在输入控件里时不抢键；焦点在行内按钮上时 Enter 属于那个按钮。
 */
export function useRovingList({ length, index, setIndex, onActivate }: RovingListOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const focusRow = (next: number) => {
    const rows = containerRef.current?.querySelectorAll<HTMLElement>('[data-office-row]')
    rows?.[next]?.focus()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    if (isSelectionKey(event.key)) {
      event.preventDefault()
      const next = moveSelection(index, event.key, length)
      if (next < 0) return
      setIndex(next)
      focusRow(next)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      const row = target?.closest('[data-office-row]')
      // 行内按钮自己处理回车/空格
      if (row && target !== row) return
      event.preventDefault()
      onActivate(index)
    }
  }

  return { containerRef, onKeyDown }
}
