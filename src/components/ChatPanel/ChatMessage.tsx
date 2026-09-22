import { useState, useEffect, useRef, useMemo, memo } from 'react'
import { ChatMessage as ChatMessageType, AgentRun, MessageAttachment } from '@/types'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { useMemoryStore } from '@/stores/memoryStore'
import { useUIStore } from '@/stores/uiStore'
import { EXHAUSTED_MARKER } from '@shared/constants'
import MarkdownRenderer from '../Common/MarkdownRenderer'
import ThinkingSection from './ThinkingSection'
import ToolStepRow from './ToolStepRow'
import AgentProcessBlock from './AgentProcessBlock'
import { PlanCard } from './AgentPanel'
import ErrorCard from './ErrorCard'
import MemoryPreviewModal from './MemoryPreviewModal'
import FileChangesSummary from './FileChangesSummary'
import FileChip from './FileChip'
import { splitFileLinks } from '@/utils/fileRefs'
import { imageAttachmentDataUrl } from '@/utils/imageAttach'
import { useI18n } from '@/i18n/useI18n'
import MSIcon from '@/components/Common/icons/MSIcon'

interface ChatMessageProps {
  message: ChatMessageType
  sessionId: string
  isSelectMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (id: string) => void
  /** Continuation of a grouped assistant turn — hide the avatar + meta header so
   *  the whole turn reads as ONE assistant bubble (hard requirement). */
  hideMeta?: boolean
  /** Hide the hover actions toolbar — only the last message of a turn shows it. */
  hideActions?: boolean
  /** 会话文件改动汇总（「本次对话修改了 N 个文件」+ 回退全部改动）—— 仅会话
   *  最后一条 assistant 消息在动作工具栏上方渲染（由 ChatMessages 传入）。 */
  renderFileChanges?: boolean
  /** 聚合模式：同一气泡（turn）内全部 assistant 消息。传入时 `message` 约定为
   *  turn 的最后一条（最终回答 / run 徽章 / 编辑 / 操作均作用于它），思考与
   *  工具调用合并进单个「思考与执行过程」折叠块渲染。 */
  turnMessages?: ChatMessageType[]
}

/**
 * User bubble content: plain text with attached files rendered as chips and
 * attached images rendered inline.
 * Only links that resolve to the message's own contextFiles become chips —
 * pasted text that merely looks like `[name](path)` stays plain text.
 */
function UserMessageContent({
  content,
  contextFiles,
  attachments,
  rootPath,
}: {
  content: string
  contextFiles: string[]
  attachments?: MessageAttachment[]
  rootPath: string
}) {
  const segments = useMemo(
    () => splitFileLinks(content, contextFiles, rootPath),
    [content, contextFiles, rootPath],
  )
  const openFile = (p: string) => useEditorStore.getState().openFile(p)
  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
      {attachments?.length ? (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((att) => (
            <img
              key={att.id}
              src={imageAttachmentDataUrl(att)}
              alt={att.name}
              title={att.name}
              className="max-h-44 max-w-[260px] rounded border border-nova-border object-contain"
            />
          ))}
        </div>
      ) : null}
      {segments.map((seg, i) =>
        seg.kind === 'file' && seg.path ? (
          <FileChip key={i} path={seg.path} rootPath={rootPath} onOpen={openFile} />
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </div>
  )
}

/** Compact token count for the agent header badge (1.2K / 3.4M / 512) */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/** Ghost icon/label button (hover action toolbar) — flat minimal variant:
 *  no gradient glow layer, no springy scale, no glass pill. Just a quiet
 *  text/icon button that tints on hover (mainstream hover-toolbar feel). */
function GhostButton({
  onClick,
  title,
  danger,
  accent,
  children,
}: {
  onClick: () => void
  title: string
  danger?: boolean
  accent?: boolean
  children: React.ReactNode
}) {
  const base =
    'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border border-transparent transition-colors'
  const tone = danger
    ? 'text-error hover:bg-error/10 hover:border-error/20'
    : accent
      ? 'text-nova-accent hover:bg-nova-accent/10 hover:border-nova-accent/20'
      : 'text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover'
  return (
    <button onClick={onClick} title={title} className={`${base} ${tone}`}>
      <span className="inline-flex items-center gap-1">{children}</span>
    </button>
  )
}

/** 44s / 1m 5s — compact run duration for the usage popover. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

/** One label/value row inside the usage popover (hairline divider between rows). */
function UsageDetailRow({
  icon,
  label,
  value,
  last,
}: {
  icon: React.ReactNode
  label: string
  value: string
  last?: boolean
}) {
  return (
    <div
      className={`flex justify-between items-center text-[12px] text-nova-text-muted ${
        last ? 'pb-1' : 'pb-1.5 border-b border-nova-border/60'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="opacity-70 inline-flex">{icon}</span>
        <span>{label}</span>
      </div>
      <span className="font-mono text-nova-text-primary">{value}</span>
    </div>
  )
}

/** Token badge detail popover — Stitch「现代玻璃态」: floating glass card with a
 *  gradient hero number, cache-hit pill and mono detail rows. Anchored below the
 *  badge with a small arrow; closes on outside click or Escape. */
function TokenUsagePopover({ run, model, placement = 'below' }: { run: AgentRun; model?: string; placement?: 'below' | 'above' }) {
  const t = useI18n()
  const tokensIn = run.tokensIn || 0
  const tokensOut = run.tokensOut || 0
  const cacheHits = run.cacheHits || 0
  const cacheSaved = run.cacheTokensSaved || 0
  // Server-side prompt-cache tokens (DeepSeek prompt_cache_hit_tokens / Anthropic
  // cache_read_input_tokens) — already inside tokensIn, billed at cache-read rate.
  const cacheRead = run.cacheReadTokens || 0
  const elapsed = run.finishedAt ? Math.max(0, Math.floor((run.finishedAt - run.startedAt) / 1000)) : 0

  return (
    <div className={`absolute left-1/2 -translate-x-1/2 z-50 w-[320px] ${placement === 'above' ? 'bottom-full mb-3' : 'top-full mt-3'}`}>
      {/* Arrow pointing at the token badge (flips with placement — the hover
          toolbar button sits at the message bottom, so it opens upward) */}
      <div className={`absolute left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-r-[6px] ${
        placement === 'above'
          ? '-bottom-[5px] border-t-[6px] border-t-white/90 dark:border-t-[#1b2130] border-b-transparent'
          : '-top-[5px] border-b-[6px] border-b-white/90 dark:border-b-[#1b2130] border-t-transparent'
      }`} />
      <div className="bg-white/90 dark:bg-[#1b2130]/95 backdrop-blur-xl border border-glass-border dark:border-white/10 rounded-xl shadow-[0_8px_40px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_40px_rgba(0,0,0,0.4)] p-5 flex flex-col gap-4">
        {/* Title row */}
        <div className="flex justify-between items-center">
          <span className="text-[13px] font-extrabold text-nova-text-primary">{t('chat.usage.title')}</span>
          {model && <span className="font-mono text-[11px] text-nova-text-muted">{model}</span>}
        </div>

        {/* Hero metric */}
        <div className="flex flex-col items-center py-2">
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-3xl font-extrabold bg-gradient-to-r from-nova-accent to-[#3b82f6] bg-clip-text text-transparent">
              {formatTokens(tokensIn + tokensOut)}
            </span>
            <span className="font-mono text-xs text-nova-text-muted">{t('statusBar.tokens').toLowerCase()}</span>
          </div>
          <div className="font-mono text-[11px] text-nova-text-muted mt-1">
            <span className="text-nova-accent font-bold">↑</span> {t('chat.usage.input')} {formatTokens(tokensIn)} ·{' '}
            <span className="text-nova-accent font-bold">↓</span> {t('chat.usage.output')} {formatTokens(tokensOut)}
          </div>
        </div>

        {/* Local replay highlight — the run's request was replayed from the
            client-side response cache (no API call made). Provider prompt-cache
            hits are reported separately as a "cache read" detail row below. */}
        {cacheHits > 0 && (
          <div className="bg-success-10 border border-success-20 rounded-full py-1.5 px-4 flex items-center justify-center gap-1.5">
            <span className="text-[11px] font-bold text-success">
              ⚡ {t('chat.usage.localReplay', { count: cacheHits, saved: formatTokens(cacheSaved) })}
            </span>
          </div>
        )}

        {/* Detail rows */}
        <div className="flex flex-col gap-2 mt-1">
          {cacheRead > 0 && (
            <UsageDetailRow
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
              }
              label={t('chat.usage.cacheRead')}
              value={`${formatTokens(cacheRead)} ${t('statusBar.tokens').toLowerCase()}`}
            />
          )}
          <UsageDetailRow
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17V7m0 0L3 11m4-4 4 4" />
                <path d="M17 7v10m0 0-4-4m4 4 4-4" />
              </svg>
            }
            label={t('chat.usage.requests')}
            value={
              run.requestCount !== undefined
                ? t('chat.usage.requestCount', { count: run.requestCount })
                : '—'
            }
          />
          <UsageDetailRow
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            }
            label={t('chat.usage.toolCalls')}
            value={t('chat.usage.toolCallCount', { count: run.toolCallCount })}
          />
          <UsageDetailRow
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
            }
            label={t('chat.usage.fileChanges')}
            value={t('chat.usage.fileChangeCount', { count: run.fileChangeCount })}
          />
          <UsageDetailRow
            last
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" />
              </svg>
            }
            label={t('chat.usage.duration')}
            value={elapsed > 0 ? formatDuration(elapsed) : '—'}
          />
        </div>
      </div>
    </div>
  )
}

function ChatMessageInner({ message, sessionId, isSelectMode, isSelected, onToggleSelect, hideMeta, hideActions, renderFileChanges, turnMessages }: ChatMessageProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)
  const [remembered, setRemembered] = useState(false)
  const [isRemembering, setIsRemembering] = useState(false)
  const [previewMemory, setPreviewMemory] = useState<{ content: string; projectPath: string } | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usagePlacement, setUsagePlacement] = useState<'above' | 'below'>('above')
  const usageRef = useRef<HTMLSpanElement>(null)
  // Close the token-usage popover on outside click or Escape (badge click toggles it).
  useEffect(() => {
    if (!usageOpen) return
    const onDocDown = (e: MouseEvent) => {
      if (usageRef.current && !usageRef.current.contains(e.target as Node)) setUsageOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUsageOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [usageOpen])
  const t = useI18n()

  // Inline editing and batch selection only apply in history-edit mode.
  const editEnabled = useEditorStore((s) => s.preferences.chatHistoryEditMode)

  // Individual selectors — subscribing to the whole store would re-render every
  // message in the conversation on ANY chatStore change (e.g. each streaming
  // chunk of an unrelated/streaming session).
  const editMessage = useChatStore((s) => s.editMessage)
  const regenerateFromMessage = useChatStore((s) => s.regenerateFromMessage)
  const requestRegenerateConfirm = useChatStore((s) => s.requestRegenerateConfirm)
  const createBranchFromMessage = useChatStore((s) => s.createBranchFromMessage)
  const continueGeneration = useChatStore((s) => s.continueGeneration)
  const checkpoints = useChatStore((s) => s.checkpoints)
  const revertCheckpoint = useChatStore((s) => s.revertCheckpoint)
  const condenseMemory = useMemoryStore((s) => s.condenseMemory)

  // ── Agent status for assistant header ──
  // Prefer the run that PRODUCED this message: its status/tokens are frozen
  // once that run finishes, so a later request in the same conversation can
  // never re-badge a completed reply (it used to fall back to the session's
  // newest run, so every old message flipped to the new run's ⏳/✗ + tokens).
  // Messages without a runId (chat mode, restored older sessions) keep the
  // previous fallback: the session's active run, else its newest record.
  const activeRun = useChatStore((s) => s.activeRuns[sessionId])
  const session = useChatStore((s) => s.sessions.find((x) => x.id === sessionId))
  // Session actively running? Pending tool calls without a result only keep a
  // spinner while the loop may still execute them; once the run ends (stopped /
  // done / legacy sessions) they flip to a muted "未执行" state instead of an
  // eternal spinner.
  const isSessionRunning = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  // agentRuns is newest-first (startAgentRun prepends); when no run is live
  // (restored sessions start with an empty activeRuns) fall back to the NEWEST
  // record — the oldest one would show stale status/tokens.
  const lastRun = session?.agentRuns?.[0]
  const run = message.runId
    ? session?.agentRuns?.find((r) => r.id === message.runId)
    : activeRun
      ? session?.agentRuns?.find((r) => r.id === activeRun.runId)
      : lastRun
  // A run paused for plan approval is NOT actively running — lumping it into
  // isLive rendered a forever-ticking "⏳ 运行中" after submit_plan, which read
  // as stuck/failed (and hid the fact that the plan was actually submitted).
  // waiting_plan gets its own label and no elapsed counter.
  const isLive = run && (run.status === 'running' || run.status === 'creating_plan' || run.status === 'approved_running')
  const isWaitingPlan = run?.status === 'waiting_plan'
  // Token total for the hover-toolbar badge (kept out of the message header —
  // mainstream keeps the transcript clean and reveals power details on hover).
  const runTokens = (run?.tokensIn || 0) + (run?.tokensOut || 0)
  // The live elapsed counter lives in a self-ticking child component
  // (LiveElapsedBadge) — a per-message 1s interval here would re-render the
  // WHOLE message (tool rows, AgentProcessBlock) every second while live.

  const handleSaveEdit = () => {
    editMessage(sessionId, message.id, editContent)
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setEditContent(message.content)
    setIsEditing(false)
  }

  const handleRegenerate = () => {
    // 这条回复改动过文件时改为内嵌确认（回退 / 保留）—— 确认卡吸底展示在
    // 消息区最底部、模式栏（目标模式按钮）上方，不再弹窗；未改动文件则直接
    // 重新生成。确认与执行（回退 / 保留并重新生成）由 RegenerateConfirmDialog
    // 读取 chatStore.inlineConfirm 完成。
    if (msgCheckpoints.length > 0) {
      requestRegenerateConfirm(
        sessionId,
        message.id,
        msgCheckpoints.map((cp) => cp.id),
        msgCheckpoints.flatMap((cp) => (cp.files || []).map((f) => f.path)),
      )
    } else {
      regenerateFromMessage(sessionId, message.id)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
  }

  const handleRemember = async () => {
    // Memories are project-scoped — a project must be open to remember.
    const projectPath = useUIStore.getState().rootPath || session?.projectPath
    if (!projectPath) {
      useUIStore.getState().showNotification(t('chat.rememberNoProject'), 'warning')
      return
    }
    if (isRemembering) return

    // Build a compact conversation context (last ~10 messages up to this one),
    // so the AI can condense the *context* rather than pasting the raw reply.
    const allMessages = session?.messages || []
    const selfIndex = allMessages.findIndex((m) => m.id === message.id)
    const contextMessages = (selfIndex === -1 ? allMessages : allMessages.slice(0, selfIndex + 1)).slice(-10)
    let conversation = contextMessages
      .map((m) => `${m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '工具'}: ${m.content}`)
      .join('\n\n')
    if (conversation.length > 6000) conversation = conversation.slice(-6000)

    setIsRemembering(true)
    try {
      // Condense first, then let the user review/edit before writing to memory.
      const condensed = await condenseMemory(conversation, projectPath, session?.model, session?.configGroupId)
      setPreviewMemory({ content: condensed, projectPath })
    } catch (error) {
      useUIStore.getState().showNotification(
        `${t('chat.rememberError')}: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    } finally {
      setIsRemembering(false)
    }
  }

  const handlePreviewSaved = (scope: 'project' | 'global') => {
    setPreviewMemory(null)
    setRemembered(true)
    useUIStore.getState().showNotification(
      scope === 'project' ? t('chat.rememberedProject') : t('chat.rememberedGlobal'),
      'success',
    )
    setTimeout(() => setRemembered(false), 2000)
  }

  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isTool = message.role === 'tool'
  const isExhausted = isAssistant && message.content.startsWith(EXHAUSTED_MARKER)
  // submit_plan renders its PlanCard inline after the tool rows (see below)。
  // 聚合模式下 turn 内任意一轮提交过计划都会渲染计划卡——计划批准是用户操作，
  // 不放进「思考与执行过程」折叠块内。
  const hasSubmittedPlan = isAssistant && (message.toolCalls || []).some((tc) => tc.name === 'submit_plan')
  const turnHasSubmittedPlan =
    !!turnMessages && turnMessages.some((m) => (m.toolCalls || []).some((tc) => tc.name === 'submit_plan'))

  // Checkpoints tied to this assistant message → "回滚修改".
  // The store's checkpoint list is per active session — scope defensively by
  // session so parallel sessions can't show each other's checkpoints.
  // 聚合模式下按 turn 内全部消息汇总，多轮各自产生的回滚点都保留。
  const msgCheckpoints = checkpoints.filter((c) =>
    c.sessionId === sessionId &&
    (turnMessages ? turnMessages.some((m) => m.id === c.messageId) : c.messageId === message.id))

  const handleRevertMessage = async () => {
    for (const cp of msgCheckpoints) {
      await revertCheckpoint(cp.id)
    }
  }

  // Tool result messages — no longer rendered as separate messages.
  // Tool results are now displayed inline within the corresponding assistant
  // message's ToolStepRow (via the toolResults prop).
  // Legacy tool messages from older sessions are filtered out in ChatMessages.tsx.
  if (isTool) return null

  // 已编辑指示 + 正文/编辑态 —— 聚合模式与逐条模式共用，但顺序不同：
  // 聚合模式下最终回答位于「思考与执行过程」折叠块下方。
  const editedIndicator = message.editedAt && (
    <div className="text-[10px] text-nova-text-muted italic">{t('chat.edited')}</div>
  )
  const contentBlock = isEditing ? (
    <div>
      <textarea
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        className="w-full p-2 bg-nova-bg text-text-primary rounded-lg border border-nova-border focus:border-nova-accent focus:outline-none min-h-[80px] font-mono text-sm resize-none"
        rows={3}
      />
      <div className="flex justify-end gap-2 mt-2">
        <button
          onClick={handleCancelEdit}
          className="px-3 py-1 text-xs bg-nova-hover rounded-lg hover:bg-nova-border transition-colors text-nova-text-secondary"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={handleSaveEdit}
          className="px-3 py-1 text-xs bg-nova-accent rounded-lg hover:opacity-90 transition-opacity text-white"
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  ) : (
    /* 最终回答 —— 极简纯净版：正文浮空渲染在画布上（无卡片包裹），对齐设计稿
       「AI Markdown Content」；内容为空时渲染空容器，避免占位框。 */
    <div className="text-sm leading-relaxed">
      <MarkdownRenderer content={message.content} />
    </div>
  )

  return (
    <div className={`group animate-fade-in ${isUser ? 'flex justify-end' : ''}`}>
      {/* Memory review/edit preview — shown after the AI condenses the chat */}
      {previewMemory && (
        <MemoryPreviewModal
          content={previewMemory.content}
          projectPath={previewMemory.projectPath}
          onCancel={() => setPreviewMemory(null)}
          onSaved={handlePreviewSaved}
        />
      )}

      {/* 重新生成确认 —— 已改为内嵌决策区（InlineDecisionArea）吸底展示在
          消息区最底部、模式栏上方，不再弹窗；此处由 requestRegenerateConfirm
          把请求写入 chatStore.inlineConfirm。 */}

      {/* Batch select checkbox — only in history-edit mode */}
      {isSelectMode && editEnabled && (
        <label className="flex items-start pt-2 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={isSelected || false}
            onChange={() => onToggleSelect?.(message.id)}
            className="w-3.5 h-3.5 accent-nova-accent rounded"
          />
        </label>
      )}

      {/* Content column */}
      <div className={`min-w-0 ${isUser ? 'max-w-[85%]' : 'flex-1'}`}>
        {/* Assistant meta header — mockup「极简纯净版」: 名字 semibold + 脉冲点
            + 实时运行时长（mono，每秒跳动）；完成后的 run 尾部追加 token 用量
            （细竖线分隔，mono 小字）；tokens 也可在 hover 工具栏查看明细。 */}
        {!isUser && !hideMeta && (
          <div className="flex items-center gap-1.5 text-xs text-nova-text-muted font-medium mb-1.5 pl-0.5">
            <span className="font-semibold text-[13px] text-nova-text-primary">OurCode AI</span>
            {isLive && (
              <span className="flex items-center gap-1 text-nova-accent">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse-soft inline-block" />
                {t('agent.runStatus.running')}
                {run && <LiveElapsedBadge startedAt={run.startedAt} />}
              </span>
            )}
            {isWaitingPlan && (
              <span className="flex items-center gap-1 text-warning">
                <span className="w-1.5 h-1.5 rounded-full bg-warning inline-block" />
                {t('agent.runStatus.waitingPlan')}
              </span>
            )}
            {run?.status === 'error' && (
              <span className="flex items-center gap-1 text-error">
                <MSIcon name="error" className="text-[13px] leading-none" />
                {t('agent.runStatus.error')}
              </span>
            )}
            {/* 完成的 run：头部行展示 token 用量（细竖线分隔，mono 小字）——
                运行中/等待批准时不显示，避免跳动 */}
            {run && !isLive && !isWaitingPlan && runTokens > 0 && (
              <span className="flex items-center gap-1.5 font-mono text-[10px] text-nova-text-muted">
                <span className="w-px h-3 bg-nova-border/60 shrink-0" aria-hidden />
                {formatTokens(runTokens)} {t('statusBar.tokens')}
              </span>
            )}
          </div>
        )}
        {/* Structured LLM error → friendly error card (never raw JSON text) */}
        {message.error ? (
          <ErrorCard error={message.error} onRetry={handleRegenerate} />
        ) : (
          <>
            {isUser ? (
              /* User bubble — Stitch: white glass + electric-blue edge.
                  Attached files render as chips (from message.contextFiles);
                  pasted markdown links stay plain text. */
              <div className="px-4 py-3 bubble-user" style={{ color: 'var(--text-primary)' }}>
                <UserMessageContent
                  content={message.content}
                  contextFiles={message.contextFiles || []}
                  attachments={message.attachments}
                  rootPath={session?.projectPath || useUIStore.getState().rootPath || ''}
                />
              </div>
            ) : (
              /* Assistant — linear transcript (极简纯净版): content floats on
                  the canvas as individual rows — 可折叠「思考与执行过程」区块 →
                  markdown 正文/结论 → plan card, no aggregated card. */
              <div className="flex flex-col gap-2">
                {turnMessages ? (
                  /* 聚合模式：turn 内所有轮次的思考与工具调用合并进单个
                     「思考与执行过程」折叠块，最终回答渲染在块下方 */
                  <>
                    <AgentProcessBlock
                      messages={turnMessages}
                      sessionId={sessionId}
                      defaultExpanded={isSessionRunning}
                    />
                    {editedIndicator}
                    {contentBlock}
                    {/* Submitted plan — rendered OUTSIDE the 思考与执行过程
                        block: plan approval is a user decision, not part of
                        the model's thinking/tool-execution process. */}
                    {turnHasSubmittedPlan && <PlanCard sessionId={sessionId} />}
                  </>
                ) : (
                  /* 逐条模式（单消息）：思考 → 正文 → 工具行 → 计划卡 */
                  <>
                    {/* 单轮思考块 —— 最小化可折叠行，按真实调用顺序交错在正文流中
                        （思考 → 文字 → 工具），一眼看出每轮思考与工具的关系。
                        默认折叠：思考独白不自动展开刷屏，点击才查看。 */}
                    {message.thinking && (
                      <ThinkingSection thinking={message.thinking} />
                    )}

                    {editedIndicator}
                    {contentBlock}

                    {/* Tool step rows — 本轮正文之后的工具调用，按时间顺序交错在流中；
                        多个调用并排换行（内容宽度 chip，对齐 code.html） */}
                    {(message.toolCalls || []).length > 0 && (
                      <div className="flex flex-wrap items-start gap-1.5">
                        {(message.toolCalls || []).map((tc) => {
                          const result = message.toolResults?.find((r) => r.toolCallId === tc.id)
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

                    {/* Submitted plan — rendered inline after the submit_plan tool
                        row (approve/cancel, or the kept record) */}
                    {hasSubmittedPlan && <PlanCard sessionId={sessionId} />}
                  </>
                )}

                {/* Actions — hover-reveal ghost toolbar (only on the last
                    message of a grouped assistant turn)。流式生成期间整条工具栏
                    隐藏（重新生成/记住/分支/复制/Token 都不出现）；会话无论以
                    何种方式结束（完成/停止/出错/轮数耗尽/等待批准）都会恢复显示。 */}
                {!isEditing && !hideActions && !isSessionRunning && (
                  <>
                    {/* 会话文件改动汇总 —— 仅最后一条 assistant 消息，挂在动作
                        工具栏上方。常显但不抢眼（卡片透明、回退按钮灰色），
                        hover 时才浮现卡片底色与按钮的红色。 */}
                    {renderFileChanges && isAssistant && (
                      <div className="max-w-[600px] pr-4 mt-4">
                        <FileChangesSummary sessionId={sessionId} checkpoints={checkpoints} />
                      </div>
                    )}
                    {/* mockup「Action Bar」：hairline 顶部分隔线 + ghost 按钮，
                       与正文隔开；hover 显现避免每屏 7 个动作的噪音。 */}
                    <div className={`flex flex-wrap items-center gap-1 mt-4 pt-3 border-t border-nova-border opacity-0 group-hover:opacity-100 transition-opacity ${isUser ? 'justify-end' : 'justify-start'}`}>
                    {isExhausted && (
                      <GhostButton onClick={() => continueGeneration(sessionId)} title={t('chat.continueRun')} accent>
                        ▶ {t('chat.continueRun')}
                      </GhostButton>
                    )}
                    {isAssistant && msgCheckpoints.length > 0 && (
                      <GhostButton onClick={handleRevertMessage} title={t('chat.rollbackHint')} danger>
                        {t('chat.rollback')}
                      </GhostButton>
                    )}
                    {editEnabled && (
                      <GhostButton onClick={() => setIsEditing(true)} title={t('chat.editMessage')}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                        {t('chat.edit')}
                      </GhostButton>
                    )}
                    {isAssistant && (
                      <GhostButton onClick={handleRegenerate} title={t('chat.regenerate')}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="23 4 23 10 17 10" />
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                        {t('chat.regenerate')}
                      </GhostButton>
                    )}
                    {isAssistant && !isExhausted && (
                      <GhostButton onClick={handleRemember} title={t('chat.rememberHint')}>
                        {isRemembering ? (
                          <>
                            <span className="w-3 h-3 border-2 border-nova-accent/30 border-t-nova-accent rounded-full animate-spin inline-block align-[-2px]" />
                            {t('chat.remembering')}
                          </>
                        ) : remembered ? t('chat.remembered') : t('chat.remember')}
                      </GhostButton>
                    )}
                    <GhostButton
                      onClick={() => createBranchFromMessage(sessionId, message.id)}
                      title={t('chat.branchFromMessage')}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="6" y1="3" x2="6" y2="15" />
                        <circle cx="18" cy="6" r="3" />
                        <circle cx="6" cy="18" r="3" />
                        <path d="M18 9a9 9 0 0 1-9 9" />
                      </svg>
                      {t('chat.branch')}
                    </GhostButton>
                    <GhostButton onClick={handleCopy} title={t('common.copy')}>
                      {t('common.copy')}
                    </GhostButton>
                    {/* Token badge — 会话运行期间不显示；结束后（无论完成/停止/
                        出错）只要有 run 记录就展示，token 为 0 也保留（早退错误
                        场景仍能看到用量信息）。 */}
                    {isAssistant && run && !isSessionRunning && (
                      <span className="relative inline-flex" ref={usageRef}>
                        <button
                          onClick={() => {
                            const nextOpen = !usageOpen
                            // Auto-flip: the popover lives inside the scroll
                            // container; when the badge sits near the top of the
                            // viewport the "above" popover would be clipped, so
                            // open downward instead.
                            if (nextOpen && usageRef.current) {
                              setUsagePlacement(usageRef.current.getBoundingClientRect().top < 340 ? 'below' : 'above')
                            }
                            setUsageOpen(nextOpen)
                          }}
                          title={usageOpen ? t('chat.usage.hint') : t('chat.usage.viewHint')}
                          className="flex items-center gap-1 font-mono text-[10px] px-2 py-1 rounded-md bg-nova-hover border border-nova-border text-nova-text-muted hover:border-nova-accent/40 hover:text-nova-text-primary transition-colors cursor-pointer"
                        >
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 7v5l3 3" />
                          </svg>
                          {formatTokens(runTokens)} {t('statusBar.tokens')}
                        </button>
                        {usageOpen && run && <TokenUsagePopover run={run} model={session?.model} placement={usagePlacement} />}
                      </span>
                    )}
                  </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// memo: `message` (and the merged display message in ChatMessages) keeps a
// stable reference between renders unless the message itself changes, so during
// streaming only the newly-added message re-renders — not the whole history.
// 聚合模式下 turnMessages 数组会随会话消息变化而重建，这里按成员消息引用逐个
// 比较：成员对象未变（例如其它轮次收到工具结果）时该轮不无谓重渲染。
// onToggleSelect 为 ChatMessages 里新建的 turn 级包装函数（切换同一组消息 id，
// 语义稳定），其身份变化不触发重渲染。
function chatMessagePropsEqual(prev: ChatMessageProps, next: ChatMessageProps): boolean {
  if (prev.message !== next.message) return false
  if (prev.sessionId !== next.sessionId) return false
  if (prev.isSelectMode !== next.isSelectMode) return false
  if (prev.isSelected !== next.isSelected) return false
  if (prev.hideMeta !== next.hideMeta) return false
  if (prev.hideActions !== next.hideActions) return false
  if (prev.renderFileChanges !== next.renderFileChanges) return false
  const a = prev.turnMessages
  const b = next.turnMessages
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export default memo(ChatMessageInner, chatMessagePropsEqual)

/** Self-ticking "运行中 12s" elapsed counter. Standalone component so the 1 s
 *  tick re-renders ONLY this tiny span — a parent-level interval used to
 *  re-render the whole message (all tool rows + AgentProcessBlock) every
 *  second while any run in the conversation was live. */
function LiveElapsedBadge({ startedAt }: { startedAt: number }) {
  const t = useI18n()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    // Re-sync immediately on mount (new run), then tick each second.
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  return (
    <span className="font-mono text-[10px] text-nova-text-muted" title={t('agent.elapsed', { seconds: elapsed })}>
      {formatDuration(elapsed)}
    </span>
  )
}