import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import { StreamingMarkdown } from '../Common/MarkdownRenderer'
import ToolStepRow, { extractKey } from '../ChatPanel/ToolStepRow'
import ErrorCard from '../ChatPanel/ErrorCard'
import { MONO, GRADIENT, roleAvatar } from './officeTheme'
import { roleLabel } from '@/services/office/mapping'
import type { ChatMessage } from '@/types'

/**
 * 「一人公司」专用对话流（区别于 agent 模式的全量对话）：
 *
 * agent 模式侧重点是「过程透明」——每轮思考、每次工具调用、文件改动汇总全部
 * 平铺在时间线上。一人公司的侧重点是「经营结果」——用户下达指令、公司汇报结果，
 * 过程收进可展开的「执行过程」里，默认只看结论：
 *
 *   指令  用户消息 → 右对齐的浅灰气泡，等宽时间戳
 *   汇报  连续 assistant 轮合并为一张汇报卡：只渲染最终答复正文，
 *         卡尾一行等宽统计（N 轮 · N 次工具调用），点开才见逐步工具行
 *   实时  监管循环流式输出以最小状态行呈现（阶段 + 耗时 + 正文），
 *         工具执行期显示当前动作脉冲行；思考原文不再刷屏
 */

/** HH:MM 紧凑时间戳（指令/汇报的等宽前缀）。 */
function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

type Turn =
  | { kind: 'user'; id: string; message: ChatMessage }
  | { kind: 'assistant'; id: string; messages: ChatMessage[] }

/** 配对的工具结果条目（assistant 消息的 toolResults 元素）。 */
type ToolResultEntry = NonNullable<ChatMessage['toolResults']>[number]

/**
 * 一轮 assistant 消息中由 run_subagent 派发的子 Agent 汇报。
 * 一人公司的对话不是「AI 笼统回答」，而是每个工位角色向老板汇报自己的结论。
 * 角色身份直接从 toolCall 参数推导（run_subagent 的 task 即信封文本、name 为
 * 角色名）——不订阅高频更新的 subagentProgress 进度表：该表每个思考节流
 * （150ms）/工具步骤都会换引用，订阅它会让整条对话流每秒重渲染好几次。
 */
interface SubagentReport {
  /** 角色中文标签（如「研发」「需求分析」） */
  role: string
  /** 子 Agent 自身名字（如 tm-developer），兜底展示用 */
  name: string
  /** 子 Agent 最终报告文本（run_subagent 的 tool result） */
  report: string
  isError?: boolean
}

/** 从一轮 assistant 消息的 run_subagent 调用中提取每个子 Agent 的汇报。 */
function collectSubagentReports(messages: ChatMessage[]): SubagentReport[] {
  const out: SubagentReport[] = []
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.name !== 'run_subagent') continue
      const args = (tc.arguments ?? {}) as { task?: unknown; name?: unknown }
      const task = typeof args.task === 'string' ? args.task : ''
      const agentName = typeof args.name === 'string' ? args.name : ''
      let result: ToolResultEntry | undefined
      for (const msg of messages) {
        const r = msg.toolResults?.find((x) => x.toolCallId === tc.id)
        if (r) {
          result = r
          break
        }
      }
      out.push({
        role: task || agentName ? roleLabel(task, agentName) : '子任务',
        name: agentName || tc.id.slice(0, 8),
        report: result?.result ?? '',
        isError: result?.isError,
      })
    }
  }
  return out
}

/** 子 Agent 报告首行通常是「状态: 完成 | 部分完成 | 阻塞 | 失败」——单独摘出。 */
function extractStatusLine(report: string): string {
  const first = report.split('\n')[0] ?? ''
  return /^状态\s*:/.test(first) ? first : ''
}

/**
 * 汇报正文压成一行可读摘要（老板视角：只看结论，不看过程）。
 * 取「摘要/完成情况」等段落的第一句，剥掉 markdown 标记与表格行，
 * 截断到 ~120 字。完整工作内容在团队状态的角色悬浮窗里看。
 */
function summarizeReportBody(report: string): string {
  const lines = report.split('\n').map((l) => l.trim()).filter(Boolean)
  // 1) 信封格式：**摘要** 段落直接就是结论
  const summaryLine = lines.find((l) => /^\*\*摘要\*\*[:：]/.test(l) || /^摘要[:：]/.test(l))
  if (summaryLine) {
    const text = summaryLine.replace(/^\*\*摘要\*\*[:：]\s*/, '').replace(/^摘要[:：]\s*/, '').replace(/\s+/g, ' ').trim()
    return text.length > 120 ? text.slice(0, 120) + '…' : text
  }
  // 2) 普通格式：**结果** 段后的第一行是最终答复
  const resultIdx = lines.findIndex((l) => /^\*\*结果\*\*\s*[:：]?$/.test(l))
  if (resultIdx >= 0) {
    const next = lines.slice(resultIdx + 1).find((l) => !/^\**$/.test(l))
    const text = (next ?? '').replace(/^[#*>\-`]+\s*/, '').replace(/\s+/g, ' ').trim()
    return text.length > 120 ? text.slice(0, 120) + '…' : text
  }
  // 3) 兜底：第一条非标题/非状态/非表格行
  const fallback = lines.find((l) => !/^(#|\||状态[:：]|[-*]{2,})/.test(l)) ?? lines[0] ?? ''
  const text = fallback.replace(/^[#*>\-`]+\s*/, '').replace(/\s+/g, ' ').trim()
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

/** 连续 assistant 消息合并为一个汇报轮（与 ChatMessages 的 turn 分组同规则）。 */
function buildTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'tool') continue
    if (m.role === 'assistant') {
      const last = turns[turns.length - 1]
      if (last && last.kind === 'assistant') last.messages.push(m)
      else turns.push({ kind: 'assistant', id: m.id, messages: [m] })
    } else {
      turns.push({ kind: 'user', id: m.id, message: m })
    }
  }
  return turns
}

// ── 指令行 ──────────────────────────────────────────────────────────────────

function OrderRow({ message }: { message: ChatMessage }) {
  const t = useI18n()
  return (
    <div className="flex flex-col items-end gap-1">
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
          fontSize: 10, letterSpacing: '0.08em', color: MONO.t3,
        }}
      >
        {t('office.orderLabel')} · {fmtTime(message.createdAt)}
      </span>
      <div
        className="max-w-[85%]"
        style={{
          background: MONO.hover, borderRadius: 10, borderTopRightRadius: 2,
          padding: '8px 12px', fontSize: 13, lineHeight: 1.6, color: MONO.t1,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        {message.content}
      </div>
    </div>
  )
}

// ── 汇报卡 ──────────────────────────────────────────────────────────────────

const REJECT_RE = /用户拒绝/

function ReportCard({
  messages,
  sessionRunning,
  subagentReports,
}: {
  messages: ChatMessage[]
  sessionRunning: boolean
  subagentReports: SubagentReport[]
}) {
  const t = useI18n()
  const [processOpen, setProcessOpen] = useState(false)
  // 最终答复 = 本轮最后一条非空正文（中间轮次的正文属于过程，收进折叠区计数）
  const finalContent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].content?.trim()) return messages[i].content
    }
    return ''
  }, [messages])
  const toolCalls = useMemo(() => messages.flatMap((m) => m.toolCalls ?? []), [messages])
  const errorMsg = useMemo(() => messages.find((m) => m.error)?.error ?? null, [messages])

  return (
    <div className="flex flex-col gap-1.5">
      {/* K 版：汇报轮头部只留等宽时间戳（角色身份由各消息的头像+标签表达） */}
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
          fontSize: 10, color: MONO.t3,
        }}
      >
        {t('office.reportLabel')} · {fmtTime(messages[messages.length - 1]?.createdAt ?? Date.now())}
      </span>

      <div
        style={{
          border: `1px solid ${MONO.hairline}`, borderRadius: 10, borderTopLeftRadius: 2,
          background: '#ffffff', padding: '10px 14px',
        }}
      >
        {/* 各子 Agent 向老板的汇报 —— K 版角色消息:渐变头像 + 角色标签 + 白气泡 */}
        {subagentReports.length > 0 && (
          <div className="flex flex-col gap-3 mb-2" style={{ borderBottom: `1px solid ${MONO.hairline}`, paddingBottom: 12 }}>
            {subagentReports.map((r, i) => {
              const statusLine = extractStatusLine(r.report)
              const summary = summarizeReportBody(r.report)
              const avatar = roleAvatar(r.role)
              const isError = r.isError || /失败|阻塞/.test(statusLine)
              return (
                <div key={`${r.name}-${i}`} className="flex gap-2.5 min-w-0">
                  {/* 渐变角色头像(首字) */}
                  <div
                    className="shrink-0 rounded-full flex items-center justify-center relative"
                    style={{ width: 28, height: 28, background: avatar.bg, color: '#fff', fontSize: 11, fontWeight: 700, boxShadow: '0 1px 3px rgba(15,23,42,0.12)' }}
                  >
                    {avatar.char}
                    {isError && (
                      <span className="absolute -bottom-0.5 -right-0.5" style={{ width: 9, height: 9, borderRadius: '50%', background: '#DC2626', border: '2px solid #fff' }} />
                    )}
                  </div>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span
                      className="shrink-0 mb-1"
                      style={{
                        fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
                        fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
                        color: isError ? '#DC2626' : '#0058BC',
                      }}
                    >
                      {r.role.toUpperCase()}
                      {statusLine && (
                        <span style={{ color: MONO.t3, fontWeight: 400, marginLeft: 6 }}>{statusLine}</span>
                      )}
                    </span>
                    <div
                      className="rounded-[14px] rounded-tl-sm px-3.5 py-2.5"
                      style={{
                        background: '#fff', border: `1px solid ${MONO.hairline}`, boxShadow: '0 1px 3px rgba(15,23,42,0.04)',
                      }}
                    >
                      {/* 老板视角：只给一句结论，完整工作内容在团队状态悬浮窗 */}
                      {summary ? (
                        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: MONO.t2 }}>
                          <span style={{ color: MONO.t1 }}>{summary}</span>
                          <span style={{ color: MONO.t3, fontSize: 11 }}> · {t('office.reportDetailHint')}</span>
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: MONO.t3 }}>{t('office.reportEmpty')}</div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* 最终答复正文 —— 监管(架构总监)汇总消息 */}
        {finalContent ? (
          <div className="flex gap-2.5 min-w-0">
            <div
              className="shrink-0 rounded-full flex items-center justify-center relative"
              style={{ width: 28, height: 28, background: GRADIENT.blueViolet, color: '#fff', fontSize: 11, fontWeight: 700, boxShadow: '0 1px 3px rgba(15,23,42,0.12)' }}
            >
              监
              {sessionRunning && (
                <span className="absolute -bottom-0.5 -right-0.5 animate-pulse-soft" style={{ width: 9, height: 9, borderRadius: '50%', background: '#22C55E', border: '2px solid #fff' }} />
              )}
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span
                className="shrink-0 mb-1"
                style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
                  fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: MONO.t2,
                }}
              >
                {t('office.supervisorLabel')}
                {sessionRunning && (
                  <span style={{ color: '#0058BC', fontWeight: 600, marginLeft: 6 }}>RUNNING</span>
                )}
              </span>
              <div className="text-[13px] leading-relaxed" style={{ color: MONO.t1 }}>
                <StreamingMarkdown content={finalContent} />
              </div>
            </div>
          </div>
        ) : (
          !sessionRunning && (
            <div style={{ fontSize: 12, color: MONO.t3 }}>{t('office.reportEmpty')}</div>
          )
        )}

        {/* 错误卡（沿用 agent 侧 ErrorCard 的友好解析） */}
        {errorMsg && (
          <div className="mt-2">
            <ErrorCard error={errorMsg} />
          </div>
        )}

        {/* 卡尾统计 + 执行过程开关 */}
        {(toolCalls.length > 0 || messages.length > 1) && (
          <div className="flex items-center gap-3 mt-2 pt-2" style={{ borderTop: `1px solid ${MONO.hairline}` }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
                fontSize: 10.5, color: MONO.t3,
              }}
            >
              {t('office.reportMeta', { rounds: messages.length, calls: toolCalls.length })}
            </span>
            {toolCalls.length > 0 && (
              <button
                onClick={() => setProcessOpen((v) => !v)}
                className="transition-colors hover:text-[#111827]"
                style={{
                  fontSize: 11, color: MONO.t2, background: 'transparent',
                  border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                {t('office.processLabel')} {processOpen ? '▾' : '▸'}
              </button>
            )}
          </div>
        )}

        {/* 执行过程：真实工具行复用 agent 侧 ToolStepRow（含子 Agent 进度块） */}
        {processOpen && toolCalls.length > 0 && (
          <div className="flex flex-col gap-1 mt-2 pt-2" style={{ borderTop: `1px solid ${MONO.hairline}` }}>
            {toolCalls.map((tc) => {
              let result: ToolResultEntry | undefined
              for (const m of messages) {
                const r = m.toolResults?.find((x) => x.toolCallId === tc.id)
                if (r) {
                  result = r
                  break
                }
              }
              const rejected = !!result?.isError && REJECT_RE.test(result.result)
              const suspended = !result && !rejected && !sessionRunning
              return (
                <ToolStepRow
                  key={tc.id}
                  toolCall={tc}
                  result={result ? { result: result.result, isError: result.isError } : undefined}
                  rejected={rejected}
                  suspended={suspended}
                  durationMs={result?.durationMs}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 实时状态行（监管循环流式输出）────────────────────────────────────────────

function LiveStatusLine({ sessionId }: { sessionId: string }) {
  const t = useI18n()
  const loading = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  const stream = useChatStore((s) => s.streamingBySession[sessionId])
  const runPhase = useChatStore((s) => s.runPhaseBySession[sessionId])
  const runStartedAt = useChatStore((s) => {
    const sess = s.sessions.find((x) => x.id === sessionId)
    const run = sess?.agentRuns?.find((r) => r.id === s.activeRuns[sessionId]?.runId)
    return run?.startedAt ?? null
  })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!loading) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [loading])

  if (!loading) return null

  const elapsed = runStartedAt ? Math.max(0, Math.floor((now - runStartedAt) / 1000)) : 0
  const phaseElapsed = runPhase ? Math.max(0, Math.floor((now - runPhase.since) / 1000)) : 0

  return (
    <div className="flex flex-col gap-1.5" style={{ minWidth: 0 }}>
      <div className="flex items-center gap-2">
        <span
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
            fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', color: MONO.t3,
          }}
        >
          {t('office.workingLabel')}
        </span>
        <span className="flex items-center gap-1.5" style={{ fontSize: 11, color: MONO.t2 }}>
          <span className="inline-block rounded-full animate-pulse-soft" style={{ width: 6, height: 6, background: '#22C55E' }} />
          {runPhase?.phase === 'preparing' && t('chat.phasePreparing')}
          {runPhase?.phase === 'compacting' && t('chat.phaseCompacting')}
          {runPhase?.phase === 'waiting' && t('chat.phaseWaiting')}
          {(!runPhase || runPhase.phase === 'streaming') && t('office.supervising')}
          {(phaseElapsed > 0 || elapsed > 0) && ` · ${elapsed}s`}
        </span>
      </div>
      {/* 流式正文最小化呈现；思考原文不刷屏 */}
      {stream?.content && (
        <div
          className="text-sm leading-relaxed"
          style={{ color: MONO.t1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          <StreamingMarkdown content={stream.content} />
          <span className="animate-pulse-dot" style={{ color: MONO.ink }}>▋</span>
        </div>
      )}
    </div>
  )
}

// ── 主组件 ──────────────────────────────────────────────────────────────────

export default function OfficeStream() {
  const t = useI18n()

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null,
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession?.messages])
  const sessionRunning = useChatStore(
    (s) => !!activeSessionId && s.runningSessionIds.includes(activeSessionId),
  )

  const turns = useMemo(() => buildTurns(messages), [messages])
  const subagentReportsByTurn = useMemo(() => {
    const map = new Map<string, SubagentReport[]>()
    for (const turn of turns) {
      if (turn.kind === 'assistant') {
        map.set(turn.id, collectSubagentReports(turn.messages))
      }
    }
    return map
  }, [turns])

  // 与 ChatMessages 同规则：最后一条已提交 assistant 消息还有未回填的工具调用
  // 时处于工具执行期——此时实时轮保持隐藏（其活动由下方「当前动作」行表达）。
  const isToolsExecuting = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'tool') continue
      return (
        m.role === 'assistant' &&
        (m.toolCalls?.length || 0) > 0 &&
        m.toolCalls!.some((tc) => !m.toolResults?.some((r) => r.toolCallId === tc.id))
      )
    }
    return false
  }, [messages])

  // 工具执行期的「当前动作」一行：最后一条 assistant 消息里第一个未回填的调用
  const currentAction = useMemo(() => {
    if (!sessionRunning || !isToolsExecuting) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      const pending = m.toolCalls?.find((tc) => !m.toolResults?.some((r) => r.toolCallId === tc.id))
      if (!pending) continue
      const key = extractKey(pending as { id: string; name: string; arguments: Record<string, any> })
      return `${pending.name}${key ? ` · ${key}` : ''}`
    }
    return null
  }, [messages, sessionRunning, isToolsExecuting])

  // 自动滚动：进入会话/内容增长时跟随底部（用户上翻阅读时暂停），流式期间经
  // store 订阅驱动，不触发整列表重渲染。与 ChatMessages 相同的成熟模式。
  const scrollToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el || !isNearBottomRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    requestAnimationFrame(() => {
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      }
    })
  }, [])
  const prevSessionRef = useRef('')
  useEffect(() => {
    const sid = activeSessionId ?? ''
    const sessionChanged = sid !== prevSessionRef.current
    prevSessionRef.current = sid
    if (sessionChanged) {
      isNearBottomRef.current = true
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      })
    } else {
      scrollToLatest()
    }
  }, [activeSessionId, messages.length, scrollToLatest])
  useEffect(() => {
    if (!activeSessionId) return
    let lastContent = useChatStore.getState().streamingBySession[activeSessionId]?.content
    let rafId: number | null = null
    const scheduleScroll = () => {
      if (rafId !== null) return
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        scrollToLatest()
      })
    }
    const unsub = useChatStore.subscribe((state) => {
      const content = state.streamingBySession[activeSessionId]?.content
      if (content === lastContent) return
      lastContent = content
      scheduleScroll()
    })
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      unsub()
    }
  }, [activeSessionId, scrollToLatest])

  if (!activeSession) return null

  const empty = messages.length === 0 && !sessionRunning

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current
        if (el) isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
      }}
      className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 min-h-0"
    >
      {/* 空会话引导：输入最终目标即可开工 */}
      {empty && (
        <div className="flex-1 flex flex-col items-center justify-center text-center min-h-0">
          <div
            className="mx-auto flex items-center justify-center"
            style={{
              width: 48, height: 48, marginBottom: 14,
              border: `1px solid ${MONO.hairline}`, borderRadius: 12,
              color: MONO.t3, fontSize: 18, fontWeight: 600,
            }}
          >
            人
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: MONO.t1, marginBottom: 5 }}>
            {t('office.streamWelcomeTitle')}
          </div>
          <div style={{ fontSize: 12, color: MONO.t3, maxWidth: 300, lineHeight: 1.7 }}>
            {t('office.streamWelcomeDesc')}
          </div>
        </div>
      )}

      {turns.map((turn) =>
        turn.kind === 'user' ? (
          <OrderRow key={turn.id} message={turn.message} />
        ) : (
          <ReportCard
            key={`turn-${turn.id}`}
            messages={turn.messages}
            sessionRunning={sessionRunning}
            subagentReports={subagentReportsByTurn.get(turn.id) ?? []}
          />
        ),
      )}

      {/* 实时监管状态行（本轮 LLM 流式输出期） */}
      {!isToolsExecuting && <LiveStatusLine sessionId={activeSession.id} />}

      {/* 工具执行期当前动作脉冲行（过程细节收在各汇报卡的「执行过程」里） */}
      {currentAction && (
        <div className="flex items-center gap-2">
          <span className="inline-block rounded-full animate-pulse-soft" style={{ width: 6, height: 6, background: '#22C55E' }} />
          <span style={{ fontSize: 11, color: MONO.t2 }}>{t('office.executing')}</span>
          <span
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
              fontSize: 10.5, color: MONO.t1,
              border: `1px solid ${MONO.hairline}`, borderRadius: 999, padding: '2px 9px', lineHeight: 1.4,
            }}
          >
            {currentAction}
          </span>
        </div>
      )}
    </div>
  )
}
