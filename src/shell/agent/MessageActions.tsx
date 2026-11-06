import { useState } from 'react'
import type { ChatMessage, ChatSession } from '@/types'
import { useChatStore } from '@/stores/chatStore'
import { useMemoryStore } from '@/stores/memoryStore'
import { useUIStore } from '@/stores/uiStore'

/** 1.2k / 512 / 3.4M —— 与旧界面的 token 格式化保持一致 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** 这条消息所属 run 的 token 合计（优先 run 记录，回退消息自带的 tokenCount） */
export function messageTokens(message: ChatMessage, session: ChatSession | null): number {
  const run = session?.agentRuns?.find((r) => r.id === message.runId)
  const fromRun = (run?.tokensIn ?? 0) + (run?.tokensOut ?? 0)
  return fromRun > 0 ? fromRun : message.tokenCount ?? 0
}

function Icon({ path, className = 'w-3.5 h-3.5' }: { path: string; className?: string }) {
  return (
    <svg
      className={className}
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
  regenerate: 'M21 12a9 9 0 11-3-6.7M21 3v6h-6',
  remember: 'M12 4a4 4 0 00-4 4c0 1.5-.6 2.2-1.4 3.1A4.2 4.2 0 009 18h.5M12 4a4 4 0 014 4c0 1.5.6 2.2 1.4 3.1A4.2 4.2 0 0115 18h-.5M12 4v14',
  branch: 'M6 4v9a4 4 0 004 4h4M6 4h.01M18 17h.01M18 17a3 3 0 100-6 3 3 0 000 6z',
  copy: 'M9 9h9v12H9zM6 15H4V3h11v2',
  clock: 'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
}

interface MessageActionsProps {
  sessionId: string
  session: ChatSession | null
  message: ChatMessage
  /** 会话正在生成时禁用「重新生成」，避免并发重排 */
  isRunning: boolean
}

/**
 * assistant 消息下方的操作行：重新生成 / 记住 / 新开对话 / 复制 + token 消耗。
 *
 * 纯风规格：12px、muted、无边框按钮，hover 才转墨色；token 是唯一有描边的胶囊。
 * 行为全部复用既有 store（regenerate / condenseMemory / createBranchFromMessage），
 * 不在这里重写任何 agent 逻辑。
 */
export default function MessageActions({ sessionId, session, message, isRunning }: MessageActionsProps) {
  const regenerateFromMessage = useChatStore((s) => s.regenerateFromMessage)
  const retryFailedRequest = useChatStore((s) => s.retryFailedRequest)
  const requestRegenerateConfirm = useChatStore((s) => s.requestRegenerateConfirm)
  const createBranchFromMessage = useChatStore((s) => s.createBranchFromMessage)
  const checkpoints = useChatStore((s) => s.checkpoints)
  const condenseMemory = useMemoryStore((s) => s.condenseMemory)
  const addMemory = useMemoryStore((s) => s.addMemory)

  const [remembering, setRemembering] = useState(false)
  const [remembered, setRemembered] = useState(false)

  const tokens = messageTokens(message, session)

  const handleRegenerate = () => {
    if (isRunning) return
    if (message.error) {
      void retryFailedRequest(sessionId, message.id)
      return
    }
    const messageCheckpoints = checkpoints.filter(
      (c) => c.sessionId === sessionId && c.messageId === message.id,
    )
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

  const handleBranch = () => createBranchFromMessage(sessionId, message.id)

  const handleCopy = () => {
    void navigator.clipboard?.writeText(message.content)
  }

  const btn = 'inline-flex items-center gap-1 hover:text-[var(--pure-ink)] transition-colors disabled:opacity-40 disabled:hover:text-[var(--pure-muted)]'

  return (
    <div className="mt-2 flex items-center gap-4 text-[12px] text-[var(--pure-muted)]" data-testid="message-actions">
      <button type="button" onClick={handleRegenerate} disabled={isRunning} className={btn} title="重新生成">
        <Icon path={ICONS.regenerate} />
        重新生成
      </button>

      <button
        type="button"
        onClick={() => void handleRemember()}
        disabled={remembering || remembered}
        className={btn}
        title={remembered ? '已记住' : '把这段对话沉淀为项目记忆'}
      >
        <Icon path={ICONS.remember} />
        {remembering ? '记住中…' : remembered ? '已记住' : '记住'}
      </button>

      <button type="button" onClick={handleBranch} className={btn} title="把这条消息作为新对话的起点">
        <Icon path={ICONS.branch} />
        新开对话
      </button>

      <button type="button" onClick={handleCopy} className={btn} title="复制这条回复">
        <Icon path={ICONS.copy} />
        复制
      </button>

      <span
        className="ml-1 inline-flex items-center gap-1 h-6 px-2 rounded-full border border-[var(--pure-border)] text-[11.5px] tabular-nums text-[var(--pure-secondary)]"
        title={runTokenTitle(message, session)}
      >
        <Icon path={ICONS.clock} className="w-3 h-3" />
        {formatTokens(tokens)} Token
      </span>
    </div>
  )
}

function runTokenTitle(message: ChatMessage, session: ChatSession | null): string {
  const run = session?.agentRuns?.find((r) => r.id === message.runId)
  if (!run) return `本条消息 token：${messageTokens(message, session)}`
  const parts = [`输入 ${formatTokens(run.tokensIn ?? 0)}`, `输出 ${formatTokens(run.tokensOut ?? 0)}`]
  if (run.cacheReadTokens) parts.push(`缓存命中 ${formatTokens(run.cacheReadTokens)}`)
  if (run.requestCount) parts.push(`${run.requestCount} 次请求`)
  return parts.join(' · ')
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`
}

/**
 * run 摘要行：这条回复背后干了多少活。
 * `● 已改 2 个文件 · 18 步 · 1m42s`，纯文字 + 一个状态点，不做卡片（设计稿要求）。
 */
export function RunSummary({
  message,
  session,
}: {
  message: ChatMessage
  session: ChatSession | null
}) {
  const run = session?.agentRuns?.find((r) => r.id === message.runId)
  if (!run) return null

  const parts: string[] = []
  if (run.fileChangeCount > 0) parts.push(`已改 ${run.fileChangeCount} 个文件`)
  if (run.stepCount > 0) parts.push(`${run.stepCount} 步`)
  if (run.finishedAt) parts.push(formatDuration(run.finishedAt - run.startedAt))
  if (parts.length === 0) return null

  const failed = run.status === 'error' || run.status === 'rejected'
  const running = run.status === 'running' || run.status === 'approved_running' || run.status === 'creating_plan'

  return (
    <div className="mb-2 flex items-center gap-2 text-[12px] text-[var(--pure-muted)]">
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          failed ? 'bg-[var(--pure-danger)]' : running ? 'bg-[var(--pure-ink)] animate-pulse' : 'bg-[#c9c9c9]'
        }`}
      />
      <span className="tabular-nums">{parts.join(' · ')}</span>
      {run.lastError ? (
        <span className="text-[var(--pure-danger)] truncate max-w-[320px]">{run.lastError}</span>
      ) : null}
    </div>
  )
}
