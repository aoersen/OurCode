/**
 * 运行可视化里用到的极简 glyph。
 *
 * 全部 currentColor + 1.6 描边，尺寸由调用方给 —— 纯风只允许一种线宽语言，
 * 不做填充图标、不用图标字体。
 *
 * 尺寸兜底：调用方常常只想改颜色（只传 text-[...]），如果这时候把默认的
 * w-3.5 h-3.5 覆盖掉，SVG 会撑满整行（曾经让状态气泡里出现一个 200px 的
 * 大箭头）。所以「没给尺寸」时统一补默认尺寸。
 */

function withSize(className: string | undefined, base: string): string {
  const extra = className ?? ''
  if (/\b[wh]-/.test(extra)) return extra
  return `${base} ${extra}`.trim()
}

export function Chevron({ up, className }: { up: boolean; className?: string }) {
  return (
    <svg
      className={`${withSize(className, 'w-3.5 h-3.5')} shrink-0 transition-transform`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  )
}

export function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={`${withSize(className, 'w-3 h-3')} shrink-0`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 13l5 5L20 6" />
    </svg>
  )
}

export function CrossGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={`${withSize(className, 'w-3 h-3')} shrink-0`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function StopGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={`${withSize(className, 'w-3 h-3')} shrink-0`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 12h10" />
    </svg>
  )
}

export function AgentGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={`${withSize(className, 'w-3.5 h-3.5')} shrink-0`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 13h.01M15 13h.01" />
    </svg>
  )
}

/** 6px 状态点。颜色全部走 pure token：彩色只出现在「运行点」与「失败红」。 */
export function StatusDot({
  state,
  className,
}: {
  state: 'done' | 'failed' | 'running' | 'pending'
  className?: string
}) {
  const tone =
    state === 'failed'
      ? 'bg-[var(--pure-danger)]'
      : state === 'running'
        ? 'bg-[var(--pure-ink)] animate-pulse'
        : state === 'done'
          ? 'bg-[var(--pure-muted)]'
          : 'bg-[var(--pure-border)]'
  return <span className={`${withSize(className, 'w-1.5 h-1.5')} shrink-0 rounded-full ${tone}`} aria-hidden />
}
