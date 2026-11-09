import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, ChatSession } from '@/types'
import { useChatStore } from '@/stores/chatStore'
import { useMemoryStore } from '@/stores/memoryStore'
import { useUIStore } from '@/stores/uiStore'
import { RUN_EXPANSION_KEY, RUN_THINKING_KEY } from './run/runExpansion'
import { usePersistedExpansion } from './run/usePersistedExpansion'
import ThinkingRow from './run/ThinkingRow'
import RunDetails from './run/RunDetails'
import { Chevron, StatusDot } from './run/glyphs'
import {
  countStepStates,
  deriveRunSteps,
  deriveSubAgentRows,
  pickRunMessages,
  runSummaryState,
  summarizeRunLine,
  thinkingLabel,
  type RunMetaLike,
} from './run/runModel'

/** 1.2k / 512 / 3.4M —— 与旧界面的 token 格式化保持一致 */
export { formatTokens } from './run/runModel'

/** 这条消息所属 run 的 token 合计（优先 run 记录，回退消息自带的 tokenCount） */
export function messageTokens(message: ChatMessage, session: ChatSession | null): number {
  const run = session?.agentRuns?.find((r) => r.id === message.runId)
  const fromRun = (run?.tokensIn ?? 0) + (run?.tokensOut ?? 0)
  return fromRun > 0 ? fromRun : message.tokenCount ?? 0
}

function Icon({ path, className = 'w-3.5 h-3.5' }: { path: string; className?: string }) {
  return (
    <svg
      className={`${className} shrink-0`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={path} />
    </svg>
  )
}

const ICONS = {
  copy: 'M9 9h9v12H9zM6 15H4V3h11v2',
  regenerate: 'M21 12a9 9 0 11-3-6.7M21 3v6h-6',
  edit: 'M4 20h4L20 8l-4-4L4 16v4zM14 6l4 4',
  revert: 'M3 10h11a5 5 0 010 10h-6M3 10l4-4M3 10l4 4',
  remember: 'M12 4a4 4 0 00-4 4c0 1.5-.6 2.2-1.4 3.1A4.2 4.2 0 009 18h.5M12 4a4 4 0 014 4c0 1.5.6 2.2 1.4 3.1A4.2 4.2 0 0115 18h-.5M12 4v14',
}

interface MessageActionsProps {
  sessionId: string
  session: ChatSession | null
  message: ChatMessage
  /** 会话正在生成时禁用「重新生成」，避免并发重排 */
  isRunning: boolean
}

/** 12px muted 的纯文字按钮：无描边、无底色，hover 才转墨色（纯风规则）。 */
const ACTION_BTN =
  'inline-flex items-center gap-1 text-[12px] text-[var(--pure-muted)] hover:text-[var(--pure-ink)] transition-colors disabled:opacity-40 disabled:hover:text-[var(--pure-muted)]'

/**
 * assistant 消息下方的操作行：复制 / 重新生成 / 编辑 / 回退到此 / 记住。
 *
 * 纯风规格：12px、muted、无边框按钮，hover 才转墨色；整行默认不可见，
 * 只有鼠标在消息上或键盘焦点进来时才出现（opacity 不占位、不产生重排）。
 * 编辑走行内 textarea（不弹模态框）；行为全部复用既有 store，不在这里
 * 重写任何 agent 逻辑。
 */
export default function MessageActions({ sessionId, session, message, isRunning }: MessageActionsProps) {
  const regenerateFromMessage = useChatStore((s) => s.regenerateFromMessage)
  const retryFailedRequest = useChatStore((s) => s.retryFailedRequest)
  const requestRegenerateConfirm = useChatStore((s) => s.requestRegenerateConfirm)
  const editMessage = useChatStore((s) => s.editMessage)
  const revertCheckpoint = useChatStore((s) => s.revertCheckpoint)
  const checkpoints = useChatStore((s) => s.checkpoints)
  const condenseMemory = useMemoryStore((s) => s.condenseMemory)
  const addMemory = useMemoryStore((s) => s.addMemory)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [remembering, setRemembering] = useState(false)
  const [remembered, setRemembered] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  const messageCheckpoints = useMemo(
    () => checkpoints.filter((c) => c.sessionId === sessionId && c.messageId === message.id),
    [checkpoints, sessionId, message.id],
  )

  const handleRegenerate = () => {
    if (isRunning) return
    if (message.error) {
      void retryFailedRequest(sessionId, message.id)
      return
    }
    if (messageCheckpoints.length > 0) {
      // 改动过文件 → 走内嵌确认（回退 / 保留并重新生成）
      requestRegenerateConfirm(
        sessionId,
        message.id,
        messageCheckpoints.map((cp) => cp.id),
        messageCheckpoints.flatMap((cp) => (cp.files || []).map((f) => f.path)),
      )
      return
    }
    void regenerateFromMessage(sessionId, message.id)
  }

  const handleCopy = () => {
    void navigator.clipboard?.writeText(message.content)
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1400)
  }

  const openEditor = () => {
    setDraft(message.content)
    setEditing(true)
  }

  const commitEdit = useCallback(() => {
    const next = draft.trim()
    if (!next) return
    editMessage(sessionId, message.id, next)
    setEditing(false)
  }, [draft, editMessage, sessionId, message.id])

  /* 回退到此：这条消息下的所有 checkpoint 从新到旧逐个回滚（store 每调用一次
     消费一条），这样「回退到此」= 撤销这条回复带来的全部文件改动。 */
  const handleRevert = async () => {
    if (messageCheckpoints.length === 0) return
    const ordered = [...messageCheckpoints].sort((a, b) => b.createdAt - a.createdAt)
    let restored = 0
    for (const checkpoint of ordered) {
      const res = await revertCheckpoint(checkpoint.id)
      if (res && res.ok) restored += res.restored ?? 0
    }
    useUIStore
      .getState()
      .showNotification(
        restored > 0 ? `已回退 ${restored} 个文件` : '没有需要回退的文件',
        restored > 0 ? 'success' : 'info',
      )
  }

  const handleRemember = async () => {
    if (remembering || remembered) return
    const projectPath = useUIStore.getState().rootPath || session?.projectPath
    if (!projectPath) {
      useUIStore.getState().showNotification('先打开一个项目，记忆是按项目存的', 'warning')
      return
    }
    setRemembering(true)
    try {
      const messages = session?.messages ?? []
      const upto = messages.slice(0, messages.findIndex((m) => m.id === message.id) + 1)
      const context = upto
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-10)
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 800)}`)
        .join('\n\n')
      const condensed = await condenseMemory(context, projectPath, session?.model, session?.configGroupId)
      const text = (condensed || '').trim()
      if (!text) {
        useUIStore.getState().showNotification('这段对话没有值得沉淀的内容', 'info')
        return
      }
      await addMemory(text, 'project', projectPath)
      setRemembered(true)
      useUIStore.getState().showNotification('已记住这段对话', 'success')
    } catch (err) {
      useUIStore.getState().showNotification(
        `记忆失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setRemembering(false)
    }
  }

  const revertCount = messageCheckpoints.length

  return (
    <>
      <div
        data-testid="message-actions"
        data-message-id={message.id}
        className={`mt-2 flex flex-wrap items-center gap-4 text-[12px] text-[var(--pure-muted)] transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [.pure-prose:hover~&]:opacity-100 ${
          editing ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <button type="button" onClick={handleCopy} className={ACTION_BTN} title="复制这条回复">
          <Icon path={ICONS.copy} />
          <span className="w-[42px] text-left">{copied ? '已复制' : '复制'}</span>
        </button>

        <button
          type="button"
          onClick={handleRegenerate}
          disabled={isRunning}
          className={ACTION_BTN}
          title={message.error ? '重试这次失败的请求' : '重新生成这条回复'}
        >
          <Icon path={ICONS.regenerate} />
          重新生成
        </button>

        <button
          type="button"
          onClick={() => (editing ? setEditing(false) : openEditor())}
          className={ACTION_BTN}
          title="就地编辑这条回复"
          aria-expanded={editing}
        >
          <Icon path={ICONS.edit} />
          编辑
        </button>

        <button
          type="button"
          onClick={() => void handleRevert()}
          disabled={revertCount === 0}
          className={ACTION_BTN}
          title={
            revertCount === 0
              ? '这条回复没有产生文件变更'
              : `回退这条回复改动的 ${revertCount} 笔文件变更`
          }
        >
          <Icon path={ICONS.revert} />
          回退到此
        </button>

        <button
          type="button"
          onClick={() => void handleRemember()}
          disabled={remembering || remembered}
          className={ACTION_BTN}
          title={remembered ? '已记住' : '把这段对话沉淀为项目记忆'}
        >
          <Icon path={ICONS.remember} />
          {remembering ? '记住中…' : remembered ? '已记住' : '记住'}
        </button>
      </div>

      {editing ? (
        <div className="mt-2" data-testid="message-edit">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                commitEdit()
              }
            }}
            rows={Math.min(12, Math.max(3, draft.split('\n').length))}
            aria-label="编辑这条回复"
            className="w-full resize-y rounded-xl bg-[var(--pure-code)] px-3 py-2 text-[13.5px] leading-[22px] text-[var(--pure-ink)] outline-none focus:ring-1 focus:ring-[var(--pure-border)]"
          />
          <div className="mt-1.5 flex items-center gap-4 text-[12px]">
            <button
              type="button"
              onClick={commitEdit}
              disabled={!draft.trim()}
              className={`${ACTION_BTN} !text-[var(--pure-ink)]`}
            >
              保存
            </button>
            <button type="button" onClick={() => setEditing(false)} className={ACTION_BTN}>
              取消
            </button>
            <span className="text-[var(--pure-muted)]">⌘↵ 保存 · Esc 取消</span>
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * run 摘要行：这条回复背后干了多少活。
 *
 * 一行到底：`● 已处理 18 步 · 1m42s · 12k tok  ⌃`（纯文字 + 6px 状态点，
 * 不做卡片）。展开后是缩进的步骤列表 + 嵌套子任务；展开状态按 message id
 * 持久化在 localStorage（前缀 ourcode.shell.run.）。
 */
export function RunSummary({
  message,
  session,
}: {
  message: ChatMessage
  session: ChatSession | null
}) {
  const sessionId = session?.id ?? ''
  const isRunning = useChatStore((s) => (sessionId ? s.runningSessionIds.includes(sessionId) : false))
  const streamingThinking = useChatStore((s) =>
    sessionId ? s.streamingBySession[sessionId]?.thinking ?? '' : '',
  )
  const subagentProgress = useChatStore((s) => s.subagentProgress)
  const retryFailedRequest = useChatStore((s) => s.retryFailedRequest)

  const messages = useMemo(() => session?.messages ?? [], [session?.messages])
  const isLastMessage = messages.length > 0 && messages[messages.length - 1].id === message.id
  const streaming = isRunning && isLastMessage

  const runMessages = useMemo(() => pickRunMessages(messages, message), [messages, message])
  const steps = useMemo(() => deriveRunSteps(runMessages, { running: isRunning }), [runMessages, isRunning])
  const counts = countStepStates(steps)
  const subAgents = useMemo(
    () => deriveSubAgentRows(runMessages, subagentProgress),
    [runMessages, subagentProgress],
  )

  const run = (session?.agentRuns?.find((r) => r.id === message.runId) ?? null) as RunMetaLike | null
  const line = summarizeRunLine({ run, steps, message })
  const tone = runSummaryState({ run, steps, running: isRunning })

  /* 一次 run 可能落在多条 assistant 消息上（多轮工具循环）。摘要行与步骤列表
     只画在这一 run 的最后一条消息下 —— 否则同一份步骤列表会在每轮下面重复。
     思考块是「每轮各自的独白」，仍然每条消息都留。 */
  const isLastOfRun = runMessages.length === 0 || runMessages[runMessages.length - 1].id === message.id

  const thinkingText = message.thinking?.trim() ? message.thinking : streaming ? streamingThinking : ''
  const thinkingStreaming = streaming && !message.thinking?.trim() && !!streamingThinking

  const [detailsExpanded, toggleDetails] = usePersistedExpansion(RUN_EXPANSION_KEY, message.id, false)
  const [thinkingExpanded, toggleThinking] = usePersistedExpansion(
    RUN_THINKING_KEY,
    message.id,
    thinkingStreaming,
  )

  const onRetry = useCallback(() => {
    if (!sessionId) return
    void retryFailedRequest(sessionId, message.id)
  }, [retryFailedRequest, sessionId, message.id])

  if (!line && !thinkingText) return null

  return (
    <div className="mb-2" data-testid="run-summary" data-message-id={message.id}>
      {thinkingText ? (
        <ThinkingRow
          label={thinkingLabel({ streaming: thinkingStreaming, ttftMs: message.ttftMs })}
          thinking={thinkingText}
          expanded={thinkingExpanded}
          onToggle={toggleThinking}
        />
      ) : null}

      {line && isLastOfRun ? (
        <button
          type="button"
          onClick={toggleDetails}
          aria-expanded={detailsExpanded}
          className="w-full flex items-center gap-2 py-0.5 text-left text-[14px] font-medium text-[var(--pure-ink)]"
          data-testid="run-summary-line"
        >
          <StatusDot state={tone === 'running' ? 'running' : tone === 'failed' ? 'failed' : 'done'} />
          <span className="tabular-nums">{line}</span>
          {tone === 'failed' && counts.failed === 0 && run?.lastError ? (
            <span
              className="min-w-0 max-w-[320px] truncate text-[12px] font-normal text-[var(--pure-danger)]"
              title={run.lastError}
            >
              {run.lastError}
            </span>
          ) : null}
          <Chevron up={detailsExpanded} className="ml-auto w-4 h-4 text-[var(--pure-muted)]" />
        </button>
      ) : null}

      {line && isLastOfRun && detailsExpanded ? (
        <RunDetails steps={steps} subAgents={subAgents} onRetry={onRetry} />
      ) : null}
    </div>
  )
}
