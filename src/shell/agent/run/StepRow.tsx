import { formatStepDuration, type RunStep } from './runModel'
import { StatusDot } from './glyphs'

/**
 * 一步工具调用。
 *
 * 结构（设计稿 pure-02b 的第 3 屏）：`● Read  src/...  +28 −15       120ms`
 * —— 点是 6px 状态点，工具名是正文级 sans，目标路径是等宽（只有路径/命令
 * 这类「机器串」用等宽），耗时右对齐灰色，编辑步骤带 +/- 计数。
 * 失败时同一行变红，并在下方补一行 muted 红错误 + 纯文字「重试」。
 */
export default function StepRow({
  step,
  onRetry,
}: {
  step: RunStep
  /** 提供时失败行才出现「重试」（无 store 可用时不画这个入口） */
  onRetry?: () => void
}) {
  const failed = step.state === 'failed'
  const muted = step.state === 'pending'

  const labelTone = failed
    ? 'text-[var(--pure-danger)]'
    : muted
      ? 'text-[var(--pure-muted)]'
      : 'text-[var(--pure-ink)]'

  const trailing = (() => {
    if (failed) return null
    if (step.durationMs !== undefined) return formatStepDuration(step.durationMs)
    if (step.state === 'running') return '运行中'
    if (step.state === 'done') return '完成'
    return ''
  })()

  return (
    <div className="py-0.5" data-testid="run-step" data-state={step.state} data-tool={step.tool}>
      <div className="flex items-center gap-2 min-w-0 text-[12.5px] leading-[22px]">
        <StatusDot state={step.state} />

        <span className={`shrink-0 ${labelTone}`}>{step.label}</span>

        {step.target ? (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--pure-muted)]" title={step.target}>
            {step.target}
          </span>
        ) : null}

        {step.added !== undefined || step.removed !== undefined ? (
          <span className="shrink-0 tabular-nums text-[11.5px] text-[var(--pure-secondary)]">
            {step.added ? `+${step.added}` : null}
            {step.added && step.removed ? ' ' : null}
            {step.removed ? `−${step.removed}` : null}
          </span>
        ) : null}

        {failed && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="ml-auto shrink-0 text-[12px] text-[var(--pure-danger)] hover:underline"
            title="重新执行这次请求"
          >
            重试
          </button>
        ) : (
          <span className="ml-auto shrink-0 pl-3 tabular-nums text-[12px] text-[var(--pure-muted)]">
            {trailing}
          </span>
        )}
      </div>

      {failed ? (
        <div className="pl-4" data-testid="run-step-error">
          <span
            className="block truncate text-[12px] leading-[18px] text-[var(--pure-danger)]"
            title={step.error ?? '执行失败'}
          >
            {step.error ?? '执行失败'}
          </span>
        </div>
      ) : null}
    </div>
  )
}
