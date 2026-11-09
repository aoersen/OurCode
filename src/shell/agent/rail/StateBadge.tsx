import type { RailStateCounts, SessionState } from './railModel'

/**
 * 会话状态标记（会话行 / 项目行共用）。
 *
 * 只有「形状 + 一个状态点」，没有彩色胶囊：
 *  - 进行中：ink 实心点 + 呼吸动画（prefers-reduced-motion 下自动降级）；
 *  - 待处理：warning 实心点；
 *  - 异常：danger 实心点 + danger 文字；
 *  - 结束：muted 空心环（安静但可辨，不会让每一条旧会话都在喊）；
 *  - 未开始：不画。
 *
 * 状态词在 hover / 读屏里有完整文本，行内只在 running/waiting/error 显示文字，
 * 免得长列表里满屏「结束」。
 */

const DOT_CLASS: Record<SessionState, string> = {
  running: 'bg-[var(--pure-ink)] animate-pulse',
  waiting: 'bg-[var(--pure-warn)]',
  error: 'bg-[var(--pure-danger)]',
  // 结束态用一个安静的灰点：空心环在小尺寸下会被读成「0」
  done: 'bg-[var(--pure-border)]',
  idle: '',
}

const LABEL_CLASS: Record<SessionState, string> = {
  running: 'text-[var(--pure-secondary)]',
  waiting: 'text-[var(--pure-warn)]',
  error: 'text-[var(--pure-danger)]',
  done: 'text-[var(--pure-muted)]',
  idle: 'text-[var(--pure-muted)]',
}

export function StateDot({ state, className = '' }: { state: SessionState; className?: string }) {
  if (state === 'idle') return null
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 w-1.5 h-1.5 rounded-full ${DOT_CLASS[state]} ${className}`}
    />
  )
}

export function StateBadge({ state, label }: { state: SessionState; label: string }) {
  if (state === 'idle') return null
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] leading-[14px] ${LABEL_CLASS[state]}`}>
      <StateDot state={state} />
      {state === 'done' ? null : <span>{label}</span>}
    </span>
  )
}

/**
 * 项目行上的状态摘要：正在跑 / 待处理 / 异常 各一个小点 + 数字。
 * 全部安静时返回 null（项目行只显示对话数），不占位置。
 */
export function StateSummary({ states }: { states: RailStateCounts }) {
  const items: Array<{ state: SessionState; count: number }> = (
    [
      { state: 'running', count: states.running },
      { state: 'waiting', count: states.waiting },
      { state: 'error', count: states.error },
    ] as Array<{ state: SessionState; count: number }>
  ).filter((item) => item.count > 0)

  if (items.length === 0) return null

  return (
    <span className="shrink-0 inline-flex items-center gap-1.5">
      {items.map((item) => (
        <span key={item.state} className={`inline-flex items-center gap-0.5 text-[10.5px] tabular-nums ${LABEL_CLASS[item.state]}`}>
          <StateDot state={item.state} />
          {item.count}
        </span>
      ))}
    </span>
  )
}
