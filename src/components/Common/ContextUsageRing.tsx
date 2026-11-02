import type { ContextUsageLevel } from '@/services/llm/contextUsage'

/**
 * Circular context-window gauge — the always-visible "how full is my context"
 * mark (design: 16px / 2px stroke, clockwise from 12 o'clock, track = idle
 * remainder).
 *
 * Purely visual: it is `aria-hidden` on purpose. It always sits inside a
 * clickable button whose `aria-label` carries the same numbers as text, so
 * assistive tech reads one coherent sentence instead of a bare percentage.
 *
 * No transition on `stroke-dasharray`: the ring must never animate layout-adjacent
 * properties (AGENTS.md motion rule allows transform/opacity only), and an
 * instant repaint is honest — the number next to it jumps at the same moment.
 */
export default function ContextUsageRing({
  percent,
  level,
  size = 16,
  stroke = 2,
  className = '',
}: {
  percent: number
  level: ContextUsageLevel
  size?: number
  stroke?: number
  className?: string
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const filled = (clamped / 100) * circumference
  // Warning uses the TEXT-safe amber: the vivid --warning sits at 2.98:1 on the
  // page background (a hair under the 3:1 control threshold) and the ring is
  // only 2px wide. In dark mode --warning-text === --warning, so no visual
  // change there. Error/accent already clear 3:1, so they keep the vivid token.
  const color =
    level === 'critical'
      ? 'var(--error)'
      : level === 'warning'
        ? 'var(--warning-text)'
        : 'var(--accent)'

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      aria-hidden
      focusable="false"
    >
      {/* Track — idle remainder of the window */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth={stroke}
        opacity={0.55}
      />
      {/* Filled arc — clockwise from 12 o'clock */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}
