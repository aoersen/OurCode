import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage as ChatMessageType } from '@/types'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import ToolStepRow from './ToolStepRow'
import MSIcon from '@/components/Common/icons/MSIcon'
import {
  buildProcessRounds,
  describeProcessStatus,
  elapsedSinceStart,
  pendingToolsOf,
  summarizeProcess,
} from './processView'

interface AgentProcessBlockProps {
  /** 同一气泡（turn）内全部 assistant 消息，按真实轮次顺序排列 */
  messages: ChatMessageType[]
  sessionId: string
  /** 运行/流式期间自动展开，输出结束后自动收起；用户手动点过折叠头/收起按钮
   *  后一切以用户为准（不再自动开合）。默认收起 */
  defaultExpanded?: boolean
}

/**
 * 用户对某一轮折叠块的手势选择。放在模块级而不是组件 state 里：流式提交、
 * 列表重排、会话切换都会让这个组件重挂载，纯组件 state 会把手势丢掉，用户
 * 刚收起的块又自己张开（或反过来）。按 turn 首条消息 id 记账，最多留 500 条。
 */
const foldChoiceByTurn = new Map<string, boolean>()

function rememberFoldChoice(turnKey: string, expanded: boolean): void {
  if (!turnKey) return
  if (foldChoiceByTurn.size >= 500) {
    const oldest = foldChoiceByTurn.keys().next()
    if (!oldest.done) foldChoiceByTurn.delete(oldest.value)
  }
  foldChoiceByTurn.set(turnKey, expanded)
}

/**
 * 统一「思考与执行过程」折叠块 —— 一个气泡（turn）内所有轮次的思考文本与
 * 工具调用按真实顺序交错渲染（思考 → 正文 → 工具 → 思考 → 正文 → 工具）。
 *
 * 折叠的只有「思考 + 工具调用」：
 *   - 中间轮次的正文永远显示在折叠区外，AI 还在输出时点「收起」也不会把
 *     正在写的内容一起吞掉（曾经整块收进去，用户看到的就是「全都折叠了」）；
 *   - 折叠状态下表头带实时状态（正在执行某个工具 / 思考中 / 阶段耗时）与
 *     「N 轮 · M 步」摘要，收起后仍能看出它还活着。
 */
export default function AgentProcessBlock({ messages, sessionId, defaultExpanded = false }: AgentProcessBlockProps) {
  const t = useI18n()
  const isSessionRunning = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  const runPhase = useChatStore((s) => s.runPhaseBySession[sessionId])

  const turnKey = messages[0]?.id ?? ''
  // 用户手势优先于自动开合；否则按 defaultExpanded 初始化。
  const chosen = foldChoiceByTurn.get(turnKey)
  const [isExpanded, setIsExpanded] = useState<boolean>(chosen ?? defaultExpanded)
  // 用户是否手动点过折叠头/收起按钮 —— 点过之后一切以用户为准，不再自动开合。
  const userToggledRef = useRef(chosen !== undefined)
  // 是否已经历过一次「运行结束」：结束后自动收起，且之后的运行不再自动展开
  // （用户不主动点击就不要展开）。
  const settledRef = useRef(chosen === undefined && !defaultExpanded)

  // 输出期间自动展开展示执行过程；输出结束后自动收起。用户手动点过后（或该块
  // 已收场过一次）以用户为准，不再自动开合。
  useEffect(() => {
    if (userToggledRef.current || settledRef.current) return
    if (defaultExpanded) {
      setIsExpanded(true)
    } else {
      settledRef.current = true
      setIsExpanded(false)
    }
  }, [defaultExpanded])

  const rounds = useMemo(() => buildProcessRounds(messages), [messages])
  const summary = useMemo(() => summarizeProcess(rounds), [rounds])
  const pendingTools = useMemo(() => pendingToolsOf(messages), [messages])
  const hasProcess = rounds.length > 0
  const hasProse = rounds.some((r) => r.prose.trim().length > 0)

  // 折叠状态下表头要能说明「现在在干什么」，所以运行中每秒走一次秒表。
  const [now, setNow] = useState(() => Date.now())
  const foldedWhileRunning = isSessionRunning && !isExpanded
  useEffect(() => {
    if (!foldedWhileRunning) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [foldedWhileRunning])

  if (!hasProcess) return null

  const status = describeProcessStatus({
    running: isSessionRunning,
    phase: runPhase?.phase,
    pendingTools,
    summary,
  })
  const toolElapsed = foldedWhileRunning ? elapsedSinceStart(pendingTools, now) : 0

  const setExpanded = (next: boolean) => {
    userToggledRef.current = true
    rememberFoldChoice(turnKey, next)
    setIsExpanded(next)
  }
  const toggle = () => setExpanded(!isExpanded)
  const collapse = () => setExpanded(false)

  return (
    <div className="text-sm">
      <button
        onClick={toggle}
        aria-expanded={isExpanded}
        className="w-full flex items-center justify-between gap-2 px-1.5 py-1 text-left cursor-pointer select-none group rounded-md hover:bg-nova-hover/60 transition-colors"
      >
        <span className="flex items-center gap-1.5 min-w-0 text-nova-text-muted">
          <MSIcon name="psychology" className="text-[15px] leading-none shrink-0" />
          <span className="text-[11px] uppercase tracking-[0.05em] font-semibold shrink-0">
            {summary.tools > 0 ? t('chat.thinkingProcess') : t('chat.thinkingTitle')}
          </span>
          {/* 折叠时的实时状态 / 摘要 —— 收起后不是一片空白，用户知道模型在做什么 */}
          {!isExpanded && status && (
            <span className="flex items-center gap-1 min-w-0 truncate text-[11px] font-normal normal-case tracking-normal text-nova-text-muted">
              {isSessionRunning && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse-soft shrink-0" />
              )}
              <span className="truncate">
                {t(status.key, status.vars)}
                {toolElapsed > 0 ? ` ${toolElapsed}s` : ''}
              </span>
            </span>
          )}
        </span>
        <MSIcon name="expand_more" className={`text-[15px] leading-none text-nova-text-muted shrink-0 transition-transform duration-300 group-hover:text-nova-text-secondary ${isExpanded ? 'rotate-180' : ''}`} />
      </button>

      {(isExpanded || hasProse) && (
        <div className="px-1.5 pt-0.5">
          {(isExpanded ? rounds : rounds.filter((r) => r.prose.trim())).map((round, ri) => {
            const showThinking = isExpanded && !!round.thinking
            const showTools = isExpanded && round.toolCalls.length > 0
            return (
              <Fragment key={round.id}>
                {ri > 0 && <div className="my-2 h-px bg-nova-border/40" aria-hidden />}
                <div className="flex flex-col gap-1.5">
                  {/* 思考独白 —— 折叠区内容 */}
                  {showThinking && (
                    <div className="text-[12px] leading-[1.65] text-nova-text-muted whitespace-pre-wrap">
                      {round.thinking}
                    </div>
                  )}
                  {/* 正文 —— 永不折叠：AI 正在写的内容不能因为收思考而消失 */}
                  {!!round.prose.trim() && (
                    <div className="text-[12px] leading-[1.65] text-nova-text-secondary whitespace-pre-wrap">
                      {round.prose}
                    </div>
                  )}
                  {/* 同一轮的多个工具调用并排换行（内容宽度 chip），对齐
                      code.html 的「Tool Calls」区 */}
                  {showTools && (
                    <div className="flex flex-wrap items-start gap-1.5">
                      {round.toolCalls.map((tc) => {
                        const result = round.toolResults.find((r) => r.toolCallId === tc.id)
                        const rejected = !!result?.isError && /用户拒绝/.test(result.result)
                        return (
                          <ToolStepRow
                            key={tc.id}
                            toolCall={tc}
                            result={result}
                            rejected={rejected}
                            suspended={!result && !rejected && !isSessionRunning}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              </Fragment>
            )
          })}
          {/* 底部 hairline + 收起按钮 —— 让用户知道上面是思考与执行过程 */}
          {isExpanded && (
            <>
              <div className="mt-2 border-t border-nova-border" />
              <div className="flex justify-center">
                <button
                  onClick={collapse}
                  className="mt-1.5 flex items-center gap-1 px-2.5 py-1 text-[11px] text-nova-text-muted hover:text-nova-text-secondary hover:bg-nova-hover rounded-md transition-colors select-none"
                >
                  <MSIcon name="expand_less" className="text-[13px] leading-none" />
                  {t('chat.collapseProcess')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
