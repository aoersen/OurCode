/**
 * 管理面共用的小排版件（不是设计系统组件库，只是把「纯白 + 单一无衬线 +
 * 文字动作」这套规则抽成几个可复用的壳）。
 *
 * 约定：
 *  - 没有 bordered chip、没有底色卡片、没有彩色徽章；
 *  - 容器圆角只有 12px（rounded-xl），胶囊只给输入条；
 *  - 动作一律是文字，hover 才从 muted 变 ink；
 *  - 行 hover / 键盘聚焦才出现极浅灰底，分隔靠留白。
 */
import type {
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { useCallback } from 'react'

/** 管理面里所有文字动作的公共类（hover 从 muted → ink）。
 *  whitespace-nowrap：动作被放在输入框旁边时不再被压成竖排（「安/装」「新增/记忆」）。 */
export const TEXT_ACTION =
  'pure-focus whitespace-nowrap text-[12px] leading-[18px] text-[var(--pure-muted)] hover:text-[var(--pure-ink)] transition-colors disabled:opacity-40 disabled:hover:text-[var(--pure-muted)]'

export const TEXT_ACTION_DANGER =
  'pure-focus whitespace-nowrap text-[12px] leading-[18px] text-[var(--pure-muted)] hover:text-[var(--pure-danger)] transition-colors'

interface TextActionProps {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
  label?: string
  danger?: boolean
  autoFocus?: boolean
}

export function TextAction({ children, onClick, disabled, title, label, danger, autoFocus }: TextActionProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        // 行内动作不能冒泡成「整行激活」，否则点击/回车会触发两次
        event.stopPropagation()
        onClick()
      }}
      disabled={disabled}
      title={title}
      aria-label={label ?? title}
      autoFocus={autoFocus}
      className={danger ? TEXT_ACTION_DANGER : TEXT_ACTION}
    >
      {children}
    </button>
  )
}

export function SectionLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 pt-4 pb-1 first:pt-1">
      <span className="text-[12px] leading-[18px] text-[var(--pure-muted)]">{children}</span>
      {trailing ? <span className="ml-auto text-[11.5px] leading-[18px] text-[var(--pure-muted)]">{trailing}</span> : null}
    </div>
  )
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="py-5 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">{children}</div>
}

/** 行内表单/信息块：浅灰底、12px 圆角、无描边。 */
export function FormShell({ children }: { children: ReactNode }) {
  return <div className="rounded-xl bg-[var(--pure-code)] px-3 py-2.5 my-1.5">{children}</div>
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="block pb-1 text-[11.5px] leading-[16px] text-[var(--pure-muted)]">{children}</span>
}

export function PlainInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return (
    <input
      spellCheck={false}
      {...rest}
      className={`w-full h-8 px-3 rounded-full bg-[var(--pure-canvas)] text-[12.5px] leading-[18px] text-[var(--pure-ink)] outline-none border-0 placeholder:text-[var(--pure-muted)] ${className}`}
    />
  )
}

export function PlainTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return (
    <textarea
      spellCheck={false}
      {...rest}
      className={`w-full px-3 py-2 rounded-xl bg-[var(--pure-canvas)] text-[12.5px] leading-[19px] text-[var(--pure-ink)] outline-none border-0 resize-none placeholder:text-[var(--pure-muted)] ${className}`}
    />
  )
}

interface PlainSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
}

export function PlainSelect({ options, className = '', ...rest }: PlainSelectProps) {
  return (
    <select
      {...rest}
      className={`h-7 pl-2.5 pr-1.5 rounded-full bg-[var(--pure-canvas)] text-[12px] leading-[18px] text-[var(--pure-ink)] outline-none border-0 cursor-pointer ${className}`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** 浅灰等宽信息块：命令 / URL / env / headers 这类机器串。 */
export function MonoWell({ lines }: { lines: ReadonlyArray<{ label: string; value: string }> }) {
  const visible = lines.filter((line) => line.value.length > 0)
  if (visible.length === 0) return null
  return (
    <div className="pure-mono-well mt-1.5">
      {visible.map((line) => (
        <div key={line.label}>
          <span className="text-[var(--pure-muted)]">{line.label} </span>
          <span>{line.value}</span>
        </div>
      ))}
    </div>
  )
}

interface SurfaceRowProps {
  children: ReactNode
  /** Enter / Space 的默认动作（展开、编辑等）；不传则行只是可聚焦容器。 */
  onActivate?: () => void
  /** 读屏用的行摘要 */
  label: string
  className?: string
}

/**
 * 一行。可聚焦（↑/↓ 用 roving，见 useListKeyboard），Enter 触发主动作；
 * 行内真正的按钮各自 stopPropagation，避免误触主动作。
 */
export function SurfaceRow({ children, onActivate, label, className = '' }: SurfaceRowProps) {
  return (
    <div
      data-surface-row=""
      tabIndex={0}
      role="group"
      aria-label={label}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (!onActivate) return
        // 焦点在行内按钮/输入上时，回车属于那个控件，不再激活整行
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onActivate()
      }}
      className={`pure-surface-row px-2 py-2 -mx-2 ${
        onActivate ? 'cursor-default' : ''
      } ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * 列表的 ↑/↓/Home/End 导航：在容器里找 `[data-surface-row]` 的行，
 * 把焦点搬过去。焦点在输入框/文本域/下拉里时不抢键。
 */
export function useListKeyboard() {
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const { key } = event
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-surface-row]'))
    if (rows.length === 0) return

    const index = target ? rows.indexOf(target) : -1
    let next = index
    if (key === 'ArrowDown') next = index < 0 ? 0 : Math.min(rows.length - 1, index + 1)
    else if (key === 'ArrowUp') next = index < 0 ? rows.length - 1 : Math.max(0, index - 1)
    else if (key === 'Home') next = 0
    else next = rows.length - 1

    event.preventDefault()
    rows[Math.max(0, next)]?.focus()
  }, [])
}
