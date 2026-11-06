import { useMemo } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'

interface StepRow {
  callId: string
  title: string
  target: string
  done: boolean
  failed: boolean
}

const TOOL_TITLES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'Edit',
  apply_patch: 'Edit',
  list_dir: 'List',
  list_directory: 'List',
  glob: 'Glob',
  grep: 'Grep',
  search_files: 'Search',
  run_command: 'Bash',
  execute_command: 'Bash',
  web_search: 'Search',
  fetch_url: 'Fetch',
  ask_user_question: 'Ask',
  update_plan: 'Plan',
  todo_write: 'Plan',
}

function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? name.replace(/_/g, ' ')
}

const TARGET_KEYS = ['path', 'file_path', 'filePath', 'target', 'command', 'pattern', 'query', 'url', 'description']

function shortTarget(args?: Record<string, any>): string {
  if (!args) return ''
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      const text = value.trim().replace(/\s+/g, ' ')
      return text.length > 48 ? `${text.slice(0, 47)}…` : text
    }
  }
  return ''
}

function AgentGlyph({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 13h.01M15 13h.01" />
    </svg>
  )
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 shrink-0 text-[var(--pure-muted)] transition-transform ${up ? '' : 'rotate-180'}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M6 15l6-6 6 6" />
    </svg>
  )
}

/**
 * 运行状态气泡：左上角悬浮、不占满宽度、可折叠。
 *  - 收起：约 100–120px 的胶囊「Agent 8/8 ⌄」
 *  - 展开：固定 340px 小卡（任务清单 + 3px 进度线）
 *
 * 数据来自本次 run 的工具调用：call = 待办/进行中，有 result = 完成，
 * isError = 失败。没有工具调用时只显示状态词。
 */
export default function StatusBubble({ sessionId }: { sessionId: string }) {
  const session = useChatStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null)
  const isRunning = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  const streaming = useChatStore((s) => s.streamingBySession[sessionId])
  const expanded = useUIStore((s) => s.statusBubbleExpanded[sessionId] === true)
  const toggleBubble = useUIStore((s) => s.toggleStatusBubble)

  const steps = useMemo<StepRow[]>(() => {
    const messages = session?.messages ?? []
    if (messages.length === 0) return []
    let start = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        start = i
        break
      }
    }

    const completed = new Set<string>()
    const failed = new Set<string>()
    const rows: StepRow[] = []

    for (let i = start; i < messages.length; i++) {
      const message = messages[i]
      for (const call of message.toolCalls ?? []) {
        rows.push({
          callId: call.id,
          title: toolTitle(call.name),
          target: shortTarget(call.arguments),
          done: false,
          failed: false,
        })
      }
      for (const result of message.toolResults ?? []) {
        completed.add(result.toolCallId)
        if (result.isError) failed.add(result.toolCallId)
      }
      if (message.toolCallId) {
        completed.add(message.toolCallId)
      }
    }

    return rows.map((row) => ({
      ...row,
      done: completed.has(row.callId),
      failed: failed.has(row.callId),
    }))
  }, [session])

  const doneCount = steps.filter((s) => s.done && !s.failed).length
  const failedCount = steps.filter((s) => s.failed).length
  const total = steps.length
  const hasFailure = failedCount > 0
  const progress = total > 0 ? Math.round((doneCount / total) * 100) : isRunning ? 8 : 100

  const statusWord = hasFailure ? '失败' : isRunning ? '执行中' : '已完成'
  const metaText = total > 0 ? `${doneCount}/${total}` : isRunning ? '运行中' : '就绪'

  return (
    <div className="sticky top-0 z-20 mb-4 pt-2" data-testid="agent-status-bubble">
      {expanded ? (
        <div className="w-[340px] rounded-xl bg-white border border-[var(--pure-border)] pure-card-shadow p-3">
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
            <Chevron up />
          </button>

          <div className="mt-2 flex items-center justify-between text-[12px] text-[var(--pure-muted)]">
            <span>任务</span>
            <span className="tabular-nums">
              {total > 0 ? `${doneCount}/${total} · ${progress}%` : statusWord}
              {hasFailure ? ` · ${failedCount} 失败` : ''}
            </span>
          </div>

          <div className="mt-1.5 pure-progress-track">
            <div
              className={`pure-progress-fill ${hasFailure ? 'pure-progress-fill--failed' : ''}`}
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>

          <div className="mt-2 max-h-[150px] overflow-y-auto pure-scroll pr-1">
            {steps.length === 0 ? (
              <div className="py-1 text-[12.5px] text-[var(--pure-muted)]">
                {streaming?.thinking ? '正在思考…' : '暂无步骤'}
              </div>
            ) : (
              steps.map((step, index) => {
                const isActive = !step.done && !step.failed && index === steps.findIndex((s) => !s.done && !s.failed)
                return (
                  <div key={step.callId} className="h-[22px] flex items-center gap-2 text-[12.5px]">
                    <span className="w-3 shrink-0 flex items-center justify-center">
                      {step.failed ? (
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--pure-danger)]" />
                      ) : step.done ? (
                        <svg className="w-3 h-3 text-[#b3b3b3]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 13l5 5L20 6" />
                        </svg>
                      ) : (
                        <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-[var(--pure-ink)]' : 'bg-[#d9d9d9]'}`} />
                      )}
                    </span>
                    <span className={`shrink-0 ${step.done ? 'text-[var(--pure-muted)]' : 'text-[var(--pure-ink)]'}`}>
                      {step.title}
                    </span>
                    {step.target ? (
                      <span className="min-w-0 truncate text-[var(--pure-muted)]">{step.target}</span>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => toggleBubble(sessionId)}
          className="h-8 px-2.5 rounded-xl bg-white border border-[var(--pure-border)] pure-card-shadow flex items-center gap-2 text-[12.5px]"
          title="展开运行状态"
          aria-expanded={false}
        >
          <AgentGlyph className="w-3.5 h-3.5 text-[var(--pure-secondary)]" />
          <span className="text-[var(--pure-ink)]">Agent</span>
          <span className={`tabular-nums ${hasFailure ? 'text-[var(--pure-danger)]' : 'text-[var(--pure-muted)]'}`}>
            {metaText}
          </span>
          <Chevron up={false} />
        </button>
      )}
    </div>
  )
}
