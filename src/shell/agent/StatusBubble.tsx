import { useMemo } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { Chevron, AgentGlyph, CheckGlyph, StatusDot } from './run/glyphs'
import {
  countStepStates,
  deriveRunSteps,
  pickCurrentTurnMessages,
  runProgressPercent,
} from './run/runModel'

/**
 * 运行状态气泡：左上角悬浮、不占满宽度、可折叠。
 *  - 收起：约 100–120px 的胶囊「Agent 8/8 ⌄」
 *  - 展开：固定 340px 小卡（任务清单 + 3px 进度线）
 *
 * 数据来自本轮的工具调用：call = 待办/进行中，有 result = 完成，
 * isError = 失败。没有工具调用时只显示状态词。
 * 展开/收起按会话持久化（uiStore.statusBubbleExpanded，别在这里再存一份）。
 */
export default function StatusBubble({ sessionId }: { sessionId: string }) {
  const session = useChatStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null)
  const isRunning = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  const streaming = useChatStore((s) => s.streamingBySession[sessionId])
  const expanded = useUIStore((s) => s.statusBubbleExpanded[sessionId] === true)
  const toggleBubble = useUIStore((s) => s.toggleStatusBubble)

  const steps = useMemo(() => {
    const messages = session?.messages ?? []
    if (messages.length === 0) return []
    return deriveRunSteps(pickCurrentTurnMessages(messages), { running: isRunning })
  }, [session, isRunning])

  const counts = countStepStates(steps)
  const hasFailure = counts.failed > 0
  const progress = runProgressPercent(counts, isRunning)
  const statusWord = hasFailure ? '失败' : isRunning ? '执行中' : '已完成'
  const metaText = counts.total > 0 ? `${counts.done}/${counts.total}` : isRunning ? '运行中' : '就绪'

  return (
    <div className="pure-sticky-surface sticky top-0 z-20 mb-3 pt-2 pb-2" data-testid="agent-status-bubble">
      {expanded ? (
        <div
          className="w-[340px] max-w-[340px] rounded-xl bg-[var(--pure-canvas)] border border-[var(--pure-border)] pure-card-shadow p-3"
          data-state={statusWord}
        >
          <button
            type="button"
            onClick={() => toggleBubble(sessionId)}
            className="w-full flex items-center gap-2 text-left"
            title="收起"
            aria-expanded
          >
            <AgentGlyph />
            <span className="text-[13px] font-medium">Agent</span>
            <span className="ml-auto text-[12px] text-[var(--pure-muted)] tabular-nums">{metaText}</span>
            <Chevron up className="text-[var(--pure-muted)]" />
          </button>

          <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-[var(--pure-muted)]">
            <span className="shrink-0">任务</span>
            <span className="flex items-center gap-1.5 min-w-0 tabular-nums">
              <span className="truncate">
                {counts.total > 0 ? `${counts.done}/${counts.total} · ${progress}%` : statusWord}
              </span>
              {hasFailure ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-[var(--pure-danger)]"
                  data-testid="status-bubble-failures"
                >
                  <StatusDot state="failed" className="w-1.5 h-1.5" />
                  {`· ${counts.failed} 失败`}
                </span>
              ) : null}
            </span>
          </div>

          <div className="mt-1.5 pure-progress-track">
            <div
              className={`pure-progress-fill ${hasFailure ? 'pure-progress-fill--failed' : ''}`}
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>

          <div className="mt-2 max-h-[145px] overflow-y-auto pure-scroll pr-1">
            {steps.length === 0 ? (
              <div className="py-1 text-[12.5px] text-[var(--pure-muted)]">
                {streaming?.thinking ? '正在思考…' : '暂无步骤'}
              </div>
            ) : (
              steps.map((step) => (
                <div
                  key={step.id}
                  className="h-[22px] flex items-center gap-2 text-[12.5px]"
                  data-state={step.state}
                >
                  <span className="w-3 shrink-0 flex items-center justify-center">
                    {step.state === 'done' ? (
                      <CheckGlyph className="w-3 h-3 text-[var(--pure-muted)]" />
                    ) : (
                      <StatusDot state={step.state} />
                    )}
                  </span>
                  <span
                    className={`shrink-0 ${
                      step.state === 'failed'
                        ? 'text-[var(--pure-danger)]'
                        : step.state === 'pending'
                          ? 'text-[var(--pure-muted)]'
                          : 'text-[var(--pure-ink)]'
                    }`}
                  >
                    {step.label}
                  </span>
                  {step.target ? (
                    <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--pure-muted)]">
                      {step.target}
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => toggleBubble(sessionId)}
          className="inline-flex h-8 px-2 gap-1.5 rounded-xl bg-[var(--pure-canvas)] border border-[var(--pure-border)] pure-card-shadow items-center text-[12.5px]"
          title={hasFailure ? `展开运行状态 · ${counts.failed} 失败` : '展开运行状态'}
          aria-label={hasFailure ? `Agent 运行状态，${counts.failed} 步失败` : 'Agent 运行状态'}
          aria-expanded={false}
        >
          {hasFailure ? (
            <StatusDot state="failed" />
          ) : (
            <AgentGlyph className="w-3.5 h-3.5 text-[var(--pure-secondary)]" />
          )}
          <span className="text-[var(--pure-ink)]">Agent</span>
          <span className={`tabular-nums ${hasFailure ? 'text-[var(--pure-danger)]' : 'text-[var(--pure-muted)]'}`}>
            {metaText}
          </span>
          <Chevron up={false} className="w-3.5 h-3.5 text-[var(--pure-muted)]" />
        </button>
      )}
    </div>
  )
}
