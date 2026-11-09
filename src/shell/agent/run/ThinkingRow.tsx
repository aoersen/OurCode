import { Chevron } from './glyphs'

/**
 * 思考块：一行 muted 的「推理 6 s」+ 箭头，展开是同样的 muted 正文。
 *
 * 设计约束：它必须比 run 摘要更轻（12px muted，不抢标题），收起来只占一行，
 * 展开也不画边框/底色 —— 纯风里思考就是「被压低声量的正文」。
 */
export default function ThinkingRow({
  label,
  thinking,
  expanded,
  onToggle,
}: {
  label: string
  thinking: string
  expanded: boolean
  onToggle: () => void
}) {
  const body = thinking.trim()
  if (!body) return null

  return (
    <div className="mb-1" data-testid="run-thinking">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 text-[12px] text-[var(--pure-muted)] hover:text-[var(--pure-secondary)] transition-colors"
      >
        <span className="tabular-nums">{label}</span>
        <Chevron up={expanded} className="w-3 h-3" />
      </button>

      {expanded ? (
        <div
          className="mt-1 max-h-[260px] overflow-y-auto pure-scroll whitespace-pre-wrap break-words text-[12.5px] leading-[20px] text-[var(--pure-muted)]"
          data-testid="run-thinking-body"
        >
          {body}
        </div>
      ) : null}
    </div>
  )
}
