import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import MarkdownRenderer from '@/components/Common/MarkdownRenderer'
import MessageActions, { RunSummary } from './MessageActions'
import StatusBubble from './StatusBubble'
import Composer from './composer/Composer'
import { useIsEmptyConversation } from './composer/useComposer'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'

const STARTERS: Array<{ title: string; hint: string }> = [
  { title: '把对话输入框改成吸底胶囊并加上下文环', hint: 'ChatComposer.tsx' },
  { title: '定位 agent 轮询会话状态时的内存泄漏', hint: 'pollSession.ts · leak warning' },
  { title: '为 Git 工作区 diff 解析模块补端到端测试', hint: 'vitest · 14 cases planned' },
  { title: '依据 OpenAPI 规范生成 REST 接口类型守卫', hint: 'schema/v2.yaml' },
]

function Greeting() {
  const hour = new Date().getHours()
  const word = hour < 6 ? '凌晨好' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  return <div className="text-[30px] leading-[38px] tracking-[-0.02em]">{word}，YG</div>
}

/**
 * 对话主列：720px 阅读宽度、居中，纯排版不画框。
 * 用户消息是浅灰胶囊；assistant 是整段正文（无气泡、无头像）。
 */
export default function ConversationView() {
  const session = useChatStore((s) =>
    s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null,
  )
  const streaming = useChatStore((s) =>
    s.activeSessionId ? s.streamingBySession[s.activeSessionId] : undefined,
  )
  const createSession = useChatStore((s) => s.createSession)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const runningSessionIds = useChatStore((s) => s.runningSessionIds)
  const isRunning = session ? runningSessionIds.includes(session.id) : false
  const configGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const rootPath = useUIStore((s) => s.rootPath)
  const openSettings = useUIStore((s) => s.openSettings)
  // 状态气泡是浮层：展开时必须给正文让出高度，否则首条消息永远被它压住
  const bubbleExpanded = useUIStore((s) =>
    session?.id ? s.statusBubbleExpanded[session.id] === true : false,
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinnedToBottom, setPinnedToBottom] = useState(true)
  /** 空会话（无任何消息、也没有在流式输出）：composer 用 hero 位 */
  const empty = useIsEmptyConversation()

  const messages = useMemo(
    () => (session?.messages ?? []).filter((m) => m.role !== 'tool'),
    [session?.messages],
  )
  const streamText = streaming?.content ?? ''
  const streamThinking = streaming?.thinking ?? ''

  // 只有用户还在底部时才自动跟随新内容，避免读历史时被拽下去
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedToBottom) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, streamText.length, pinnedToBottom, session?.id])

  useEffect(() => {
    setPinnedToBottom(true)
  }, [session?.id])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  const startNewSession = (prompt?: string) => {
    if (!configGroupId) {
      openSettings()
      return
    }
    const id = createSession(configGroupId, rootPath ?? undefined)
    if (prompt) void sendMessage(id, prompt)
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 min-h-0 overflow-y-auto pure-scroll px-6"
    >
      <div
        data-testid="conversation-column"
        className="w-full max-w-[720px] mx-auto pb-8"
      >
        {session && !empty && <StatusBubble sessionId={session.id} />}
        {empty && (
          <div className="pt-[10vh]">
            <Greeting />
            <p className="mt-2 text-[15px] leading-[26px] text-[var(--pure-muted)]">
              今天想改哪一块？描述任务，我会读代码、改文件、跑测试。
            </p>

            {/* 空态 composer：居中偏上、和阅读列同宽；发第一条消息后它落到 dock 变 inline */}
            <Composer variant="hero" className="mt-8" />

            <div className="mt-9 grid grid-cols-2 gap-x-8 gap-y-6">
              {STARTERS.map((s) => (
                <button
                  key={s.title}
                  type="button"
                  onClick={() => startNewSession(s.title)}
                  className="text-left group"
                >
                  <div className="text-[14px] leading-[22px] text-[var(--pure-ink)] group-hover:underline underline-offset-4">
                    {s.title}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--pure-muted)]">{s.hint}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, index) => {
          const isUser = m.role === 'user'
          const isLast = index === messages.length - 1
          if (isUser) {
            return (
              <div key={m.id} className="mt-8 first:mt-6 flex justify-end">
                <div className="max-w-[520px] rounded-2xl bg-[var(--bubble-user)] px-4 py-2.5 text-[14px] leading-[22px] whitespace-pre-wrap break-words">
                  {m.content}
                </div>
              </div>
            )
          }
          return (
            <div key={m.id} className="mt-8">
              {m.thinking ? (
                <details className="mb-3 text-[12.5px] text-[var(--pure-muted)]">
                  <summary className="cursor-pointer select-none">推理过程</summary>
                  <div className="mt-2 whitespace-pre-wrap leading-[20px]">{m.thinking}</div>
                </details>
              ) : null}
              <RunSummary message={m} session={session} />
              <div className="pure-prose text-[15px] leading-[28px] break-words">
                <MarkdownRenderer content={m.content} />
              </div>
              {m.error ? (
                <div className="mt-2 text-[12.5px] text-[var(--pure-danger)]">
                  {m.error.message || '请求失败'}
                </div>
              ) : null}
              {/* 每条 assistant 回复都带操作行 + token 消耗；流式输出中的最后一条不显示，
                  避免在还在生成时出现「重新生成」 */}
              {!(isLast && streamText) && (
                <MessageActions
                  sessionId={session?.id ?? ''}
                  session={session}
                  message={m}
                  isRunning={isRunning}
                />
              )}
            </div>
          )
        })}

        {streamThinking && !streamText ? (
          <div className="mt-8 text-[12.5px] text-[var(--pure-muted)] animate-pulse">正在思考…</div>
        ) : null}

        {streamText ? (
          <div className="mt-8 pure-prose text-[15px] leading-[28px] break-words">
            <MarkdownRenderer content={streamText} />
            <span className="inline-block w-[2px] h-[16px] align-[-2px] bg-[var(--pure-ink)] animate-pulse ml-0.5" />
          </div>
        ) : null}
      </div>
    </div>
  )
}
