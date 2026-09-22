import { Fragment, useEffect, useRef, useState } from 'react'
import type { ChatMessage as ChatMessageType } from '@/types'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import ToolStepRow from './ToolStepRow'
import MSIcon from '@/components/Common/icons/MSIcon'

interface AgentProcessBlockProps {
  /** 同一气泡（turn）内全部 assistant 消息，按真实轮次顺序排列 */
  messages: ChatMessageType[]
  sessionId: string
  /** 运行/流式期间自动展开，输出结束后自动收起；用户手动点过折叠头/收起按钮
   *  后一切以用户为准（不再自动展开）。默认收起 */
  defaultExpanded?: boolean
}

/**
 * 统一「思考与执行过程」折叠块 —— 一个气泡（turn）内所有轮次的思考文本与
 * 工具调用按真实顺序交错渲染（思考 → 文字 → 工具 → 思考 → 文字 → 工具），
 * 最终回答的 markdown 正文由调用方渲染在块下方。
 * 无大框：折叠时思考全部收进去；展开时正文 → 底部 hairline → 「收起」按钮。
 * 工具调用为内容宽度的白色 chip，同一轮多个调用并排换行（对齐 code.html）。
 */
export default function AgentProcessBlock({ messages, sessionId, defaultExpanded = false }: AgentProcessBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const t = useI18n()
  const isSessionRunning = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  // 用户是否手动点过折叠头/收起按钮 —— 点过之后一切以用户为准，不再自动开合。
  const userToggledRef = useRef(false)
  // 是否已经历过一次「运行结束」：结束后自动收起，且之后的运行不再自动展开
  // （用户不主动点击就不要展开）。
  const settledRef = useRef(false)

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

  const toggle = () => {
    userToggledRef.current = true
    setIsExpanded((v) => !v)
  }

  const collapse = () => {
    userToggledRef.current = true
    setIsExpanded(false)
  }

  const hasToolCalls = messages.some((m) => (m.toolCalls?.length || 0) > 0)
  const hasProcess = messages.some((m) => m.thinking || (m.toolCalls?.length || 0) > 0)
  if (!hasProcess) return null

  // 需要显示在块内的轮次（最后一条消息的正文是最终回答，由调用方渲染在块下方）
  const rounds = messages
    .map((m, i) => ({
      id: m.id,
      thinking: m.thinking,
      // 中间轮次写出的正文也属于执行过程，保留在块内（弱化显示，不丢失）
      midContent: i < messages.length - 1 ? m.content : '',
      toolCalls: m.toolCalls || [],
      toolResults: m.toolResults || [],
    }))
    .filter((r) => r.thinking || r.midContent || r.toolCalls.length > 0)

  return (
    /* 思考与执行过程 —— 无大框：一行「图标 + 标题 + 箭头」折叠头；展开后
       思考/正文/工具调用交错输出，底部 hairline + 收起按钮。 */
    <div className="text-sm">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between gap-2 px-1.5 py-1 text-left cursor-pointer select-none group rounded-md hover:bg-nova-hover/60 transition-colors"
      >
        <span className="flex items-center gap-1.5 min-w-0 text-nova-text-muted">
          <MSIcon name="psychology" className="text-[15px] leading-none shrink-0" />
          <span className="text-[11px] uppercase tracking-[0.05em] font-semibold shrink-0">
            {hasToolCalls ? t('chat.thinkingProcess') : t('chat.thinkingTitle')}
          </span>
        </span>
        <MSIcon name="expand_more" className={`text-[15px] leading-none text-nova-text-muted shrink-0 transition-transform duration-300 group-hover:text-nova-text-secondary ${isExpanded ? 'rotate-180' : ''}`} />
      </button>

      {isExpanded && (
        <div className="px-1.5 pt-0.5">
          {rounds.map((round, ri) => (
            <Fragment key={round.id}>
              {ri > 0 && <div className="my-2 h-px bg-nova-border/40" aria-hidden />}
              <div className="flex flex-col gap-1.5">
                {round.thinking && (
                  <div className="text-[12px] leading-[1.65] text-nova-text-muted whitespace-pre-wrap">
                    {round.thinking}
                  </div>
                )}
                {round.midContent && (
                  <div className="text-[12px] leading-[1.65] text-nova-text-secondary whitespace-pre-wrap">
                    {round.midContent}
                  </div>
                )}
                {/* 同一轮的多个工具调用并排换行（内容宽度 chip），对齐
                    code.html 的「Tool Calls」区 */}
                {round.toolCalls.length > 0 && (
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
          ))}
          {/* 底部 hairline + 收起按钮 —— 让用户知道上面是思考与执行过程 */}
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
        </div>
      )}
    </div>
  )
}
