import { formatStepDuration, type SubAgentRow } from './runModel'
import { CheckGlyph, CrossGlyph, StopGlyph } from './glyphs'

function SubAgentGlyph({ state }: { state: SubAgentRow['state'] }) {
  if (state === 'running') {
    return <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-[var(--pure-ink)] animate-pulse" aria-hidden />
  }
  if (state === 'done') return <CheckGlyph className="w-3 h-3 text-[var(--pure-muted)]" />
  if (state === 'error') return <CrossGlyph className="w-3 h-3 text-[var(--pure-danger)]" />
  return <StopGlyph className="w-3 h-3 text-[var(--pure-muted)]" />
}

const STATE_WORD: Record<SubAgentRow['state'], string> = {
  running: '运行中',
  done: '完成',
  error: '失败',
  stopped: '已停止',
}

/**
 * 子任务行（并发子智能体）。
 *
 * 缩进比步骤行再深 16px，整体比步骤更轻（12px muted）：用户扫一眼知道
 * 「这几步是子智能体干的」，而不是又一层要读的正文。
 * 没有实时进度数据的子智能体不出现（不靠参数编状态）。
 */
export default function SubAgentRows({ rows }: { rows: readonly SubAgentRow[] }) {
  if (rows.length === 0) return null

  return (
    <div className="mt-1 pl-8 flex flex-col gap-1 text-[12px] text-[var(--pure-muted)]" data-testid="run-subagents">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2 min-w-0" data-state={row.state}>
          <SubAgentGlyph state={row.state} />
          <span className="shrink-0 max-w-[40%] truncate">{`子任务 · ${row.name}`}</span>
          {row.task ? (
            <span className="min-w-0 truncate" title={row.task}>
              {row.task}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 pl-2 tabular-nums">
            {row.durationMs !== undefined ? formatStepDuration(row.durationMs) : STATE_WORD[row.state]}
          </span>
        </div>
      ))}
    </div>
  )
}
