/**
 * 决策卡的唯一解剖（纯白、无阴影、12px 容器圆角）。
 *
 * 结构：
 *   标题行（13.5px ink）+ 右侧风险词
 *   一行为说明（12.5px muted，单行截断）
 *   正文（可滚动；超高只在卡内滚，绝不吃掉上方消息区）
 *   操作条（常驻底部，不随正文滚动：滚动时永远点得到按钮）
 *
 * 这张卡是 in-flow 的：它排在 composer 之上、720px 阅读列之内，不遮任何内容。
 * 视觉规则来自 `.stitch/designs` 的 OurCode Pure：纯白底、只有 --pure-* 令牌、
 * 不用彩色 chip / 徽章 / 卡片阴影；操作条三类语气 = ink 实心主操作、纯文字次要
 * 操作、红色危险操作。
 */
import { useCallback, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import {
  isTextEntry,
  resolveApprovalKey,
  type CardAction,
  type RiskWord,
} from './approvalModel'
import { Chevron } from '../run/glyphs'

/** 按钮的三种语气 —— 全站唯一一套（决策区里没有第四种按钮）。 */
const TONE_CLASS: Record<CardAction['tone'], string> = {
  primary:
    'rounded-lg bg-[var(--pure-ink)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--pure-canvas)] transition-opacity hover:opacity-90 disabled:opacity-40',
  plain:
    'rounded-lg px-1.5 py-1 text-[12.5px] text-[var(--pure-secondary)] transition-colors hover:text-[var(--pure-ink)] disabled:opacity-40',
  danger:
    'rounded-lg px-1.5 py-1 text-[12.5px] text-[var(--pure-danger)] transition-colors hover:underline disabled:opacity-40',
}

/** 风险词颜色：只有 danger 用红，其余都用灰阶。 */
export function riskTone(risk: RiskWord): string {
  return risk.level === 'danger' ? 'text-[var(--pure-danger)]' : 'text-[var(--pure-muted)]'
}

export interface DecisionCardProps {
  ariaLabel: string
  title: string
  /** 一行目标描述 */
  description?: string
  /** 右侧风险词 / 计数 */
  meta?: ReactNode
  /** danger：整卡标题前加一条红点（危险命令 / 不可逆操作） */
  tone?: 'default' | 'danger'
  children?: ReactNode
  actions: CardAction[]
  onAction: (actionId: string) => void
  /**
   * 键盘映射用：哪几个操作接受 Enter / ⌘⇧Enter / Esc。
   * 不给就整卡不接管键盘（例如纯记录卡）。
   */
  primaryActionId?: string
  alwaysAllowActionId?: string
  rejectActionId?: string
  /** 操作条右侧的常驻说明（如「权限请求不会超时」）。 */
  note?: string
  testId?: string
  /** 正文区域多加的 class（例如居中/紧凑）。 */
  bodyClassName?: string
}

export default function DecisionCard({
  ariaLabel,
  title,
  description,
  meta,
  tone = 'default',
  children,
  actions,
  onAction,
  primaryActionId,
  alwaysAllowActionId,
  rejectActionId,
  note,
  testId,
  bodyClassName,
}: DecisionCardProps) {
  const bodyId = useId()
  const rejectRef = useRef<HTMLButtonElement | null>(null)

  const runAction = useCallback(
    (id: string | undefined, disabled?: boolean) => {
      if (!id || disabled) return
      onAction(id)
    },
    [onAction],
  )

  /** Enter / ⌘⇧Enter / Esc；输入框里的 Enter 让开（否则打字会顺手批准）。 */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!primaryActionId && !alwaysAllowActionId && !rejectActionId) return
    const target = event.target as HTMLElement | null
    if (isTextEntry(target?.tagName, target?.isContentEditable === true)) {
      if (event.key !== 'Escape') return
    }
    const mapped = resolveApprovalKey(event)
    if (!mapped) return
    const primary = actions.find((a) => a.id === primaryActionId)
    const always = actions.find((a) => a.id === alwaysAllowActionId)
    const reject = actions.find((a) => a.id === rejectActionId)
    if (mapped === 'primary') {
      if (!primary || primary.disabled) return
      event.preventDefault()
      runAction(primary.id, primary.disabled)
      return
    }
    if (mapped === 'always-allow') {
      if (!always || always.disabled) return
      event.preventDefault()
      runAction(always.id, always.disabled)
      return
    }
    // Esc：先把焦点送到「拒绝」，再按一次才真的拒绝（防误触）
    if (!reject || reject.disabled) return
    event.preventDefault()
    rejectRef.current?.focus()
  }

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      data-testid={testId}
      className="flex max-h-[46vh] w-full shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--pure-border)] bg-[var(--pure-canvas)]"
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-baseline gap-2 px-4 pt-3">
        {tone === 'danger' ? (
          <span aria-hidden className="mb-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pure-danger)]" />
        ) : null}
        <h3 className="min-w-0 truncate text-[13.5px] font-medium leading-[20px] text-[var(--pure-ink)]">
          {title}
        </h3>
        {meta ? <span className="ml-auto shrink-0 text-[11.5px] leading-[18px]">{meta}</span> : null}
      </div>

      {description ? (
        <p
          className="truncate px-4 pt-1 text-[12.5px] leading-[18px] text-[var(--pure-muted)]"
          title={description}
        >
          {description}
        </p>
      ) : null}

      {children ? (
        <div
          id={bodyId}
          className={`min-h-0 flex-1 overflow-y-auto pure-scroll px-4 pb-3 pt-2 ${bodyClassName ?? ''}`}
        >
          {children}
        </div>
      ) : (
        <div className="pb-1" />
      )}

      {/* 操作条常驻：正文再长也只在上面滚，按钮永远在这里 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--pure-border)] px-4 py-2.5">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            ref={action.id === rejectActionId ? rejectRef : undefined}
            aria-label={action.ariaLabel}
            disabled={action.disabled}
            onClick={() => onAction(action.id)}
            className={`${TONE_CLASS[action.tone]} pure-focus`}
          >
            {action.label}
            {action.kbd ? (
              <span aria-hidden className="ml-1.5 text-[11px] opacity-60">
                {action.kbd}
              </span>
            ) : null}
          </button>
        ))}
        {note ? (
          <span className="ml-auto shrink-0 text-[11px] leading-[16px] text-[var(--pure-muted)]">{note}</span>
        ) : null}
      </div>
    </div>
  )
}

/** 折叠「参数」开关：全站同款（12px muted → hover ink）。 */
export function Disclosure({
  open,
  onToggle,
  label,
  children,
  count,
}: {
  open: boolean
  onToggle: () => void
  label: string
  children: ReactNode
  count?: string
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        aria-label={open ? `收起${label}` : `展开${label}`}
        className="pure-focus inline-flex w-fit items-center gap-1 rounded text-[12px] text-[var(--pure-muted)] transition-colors hover:text-[var(--pure-ink)]"
      >
        <Chevron up={open} className="h-3 w-3" />
        {label}
        {count ? <span className="text-[11px] text-[var(--pure-muted)]">{count}</span> : null}
      </button>
      {open ? (
        <div id={id} className="min-w-0">
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** 浅灰等宽井：参数 JSON、diff、文件清单都用它（纯风唯一允许的「块」）。 */
export function MonoWell({
  children,
  maxHeightClass = 'max-h-[22vh]',
  title,
  testId,
}: {
  children: ReactNode
  maxHeightClass?: string
  title?: string
  testId?: string
}) {
  return (
    <div
      data-testid={testId}
      title={title}
      className={`overflow-auto pure-scroll rounded-lg border border-[var(--pure-border)] bg-[var(--pure-code)] px-3 py-2 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap break-all text-[var(--pure-secondary)] ${maxHeightClass}`}
    >
      {children}
    </div>
  )
}
