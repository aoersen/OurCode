import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useChatStore, estimateContextTokens } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import ChatMessage from './ChatMessage'
import ThinkingSection from './ThinkingSection'
import { StreamingMarkdown } from '../Common/MarkdownRenderer'
import projectLogo from '@/assets/ourcode-logo.png'
import { useI18n } from '@/i18n/useI18n'
import { lookupModelMetadata } from '@/types'
import type { ChatMessage as ChatMessageType } from '@/types'
import MSIcon from '@/components/Common/icons/MSIcon'

/** Drag handle for history reorder. ONLY the handle is draggable — making the
 *  whole message row `draggable` in history-edit mode broke mouse text
 *  selection (mousedown+move started a drag instead of selecting), so the text
 *  couldn't be copied. Hover-revealed next to each row in edit mode. */
function MessageDragHandle({
  onDragStart,
  onDragEnd,
}: {
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: (e: React.DragEvent) => void
}) {
  return (
    <span
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="absolute left-0.5 top-2 z-10 flex items-center justify-center w-5 h-6 cursor-grab active:cursor-grabbing text-nova-text-muted opacity-0 group-hover/row:opacity-70 hover:opacity-100 transition-opacity select-none"
      title="拖动排序"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="9" cy="5" r="1.7" />
        <circle cx="15" cy="5" r="1.7" />
        <circle cx="9" cy="12" r="1.7" />
        <circle cx="15" cy="12" r="1.7" />
        <circle cx="9" cy="19" r="1.7" />
        <circle cx="15" cy="19" r="1.7" />
      </svg>
    </span>
  )
}

export default function ChatMessages() {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  // Derive the active session via id + find: the selector returns the session
  // OBJECT (stable reference unless that session itself changes), so unrelated
  // store churn — other sessions streaming, checkpoints loading, queue updates —
  // never re-renders the whole conversation. (The old getActiveSession()
  // function selector returns a stable function reference and never re-renders
  // at all; it only worked because of whole-store subscriptions elsewhere.)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = useChatStore((s) => (s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null))
  const reorderMessages = useChatStore((s) => s.reorderMessages)
  const undoStack = useChatStore((s) => s.undoStack)
  const undoDelete = useChatStore((s) => s.undoDelete)
  // Loading / streaming state is per session — only the conversation the user
  // is viewing reacts to its own run; parallel sessions stream independently.
  const isThisSessionLoading = useChatStore((s) => !!activeSessionId && s.runningSessionIds.includes(activeSessionId))
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [showUndoToast, setShowUndoToast] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isSelectMode, setIsSelectMode] = useState(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const t = useI18n()

  // History is read-only by default; editing (drag reorder / inline edit /
  // batch delete) requires the "对话历史编辑" toggle in Settings.
  const editEnabled = useEditorStore((s) => s.preferences.chatHistoryEditMode)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragLockTopRef = useRef<number | null>(null)
  // True while the user is looking at the newest messages (near the bottom).
  // While the model streams a reply we only auto-scroll when this is true —
  // reading an earlier message must never get yanked down by new output.
  const isNearBottomRef = useRef(true)

  // Context truncation warning — real API usage from the last response as the
  // baseline + a rough estimate for messages added since (Claude Code-style),
  // so the percentage tracks what the model actually receives.
  const tokenWarning = useMemo(() => {
    if (!activeSession) return null
    const totalTokens = estimateContextTokens(activeSession)
    // 权威的上下文窗口来自 shared/constants 的 MODEL_METADATA（内部做前缀匹配），
    // 去掉 provider 前缀（a/b 形式）后查询；未收录的模型回退 128K。
    const modelId = (activeSession.model || '').split('/').pop() || ''
    const contextWindow = lookupModelMetadata(modelId)?.contextWindow || 128000
    const usage = totalTokens / contextWindow
    if (usage > 0.9) return { level: 'critical' as const, percent: Math.round(usage * 100), totalTokens, contextWindow }
    if (usage > 0.7) return { level: 'warning' as const, percent: Math.round(usage * 100), totalTokens, contextWindow }
    return null
  }, [activeSession])

  // Auto-scroll to the latest message when entering a session, when the
  // conversation grows, or while streaming. Crucially NOT when the user
  // reorders/edits history — that used to yank the whole view to the bottom
  // right after dropping a dragged message. We scroll ONLY the messages
  // container (never scrollIntoView, which would also scroll outer layout
  // containers if they ever overflow). New output only follows along while
  // the user is at the bottom — scrolling up to read an earlier message
  // pauses the auto-scroll until they return to the bottom.
  const prevLenRef = useRef(0)
  const prevSessionRef = useRef('')
  const scrollToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el || !isNearBottomRef.current) return
    // Instant jump (not smooth): during streaming this fires on every store
    // flush (~20/s), and a smooth-scroll animation per flush fights the
    // content growth and janks the main thread. The floating "back to latest"
    // button keeps the smooth behavior for the one-off user action.
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    // chat-msg-row uses content-visibility, so rows resolve their real
    // height one frame after layout; nudge again if the first pass landed
    // short so long histories still end up at the true bottom.
    requestAnimationFrame(() => {
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      }
    })
  }, [])
  useEffect(() => {
    if (!activeSession) return
    const sid = activeSession.id
    const len = activeSession.messages.length
    const sessionChanged = sid !== prevSessionRef.current
    const grew = len > prevLenRef.current
    prevSessionRef.current = sid
    prevLenRef.current = len
    // Entering a session resets the reading position — always follow the new
    // content; growth respects the user's scroll position.
    if (sessionChanged) {
      isNearBottomRef.current = true
      setShowScrollToBottom(false)
    }
    if (sessionChanged || grew) scrollToLatest()
  }, [activeSession, scrollToLatest])
  // While the model streams, the live block grows at up to 20 Hz. The scroll
  // must follow WITHOUT re-rendering the whole list, so this drives it through
  // the store's raw subscribe (filtered to this session's stream content)
  // instead of subscribing to the stream field — no React render is triggered.
  // The actual scroll is deferred to the next animation frame: the subscription
  // fires synchronously inside the store's set, BEFORE React commits the new
  // DOM, so scrolling immediately would read a stale scrollHeight and miss the
  // growth; by rAF time the DOM is updated and scrollToLatest lands on the true
  // bottom. Deferring also coalesces multiple flushes per frame into one scroll.
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

  // Leaving history-edit mode resets any active batch selection.
  useEffect(() => {
    if (!editEnabled) {
      setIsSelectMode(false)
      setSelectedIds(new Set())
    }
  }, [editEnabled])

  // Jump back to the newest message — used by the floating down-arrow button
  // shown while the user is scrolled up reading earlier messages.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottomRef.current = true
    setShowScrollToBottom(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  const handleDragStart = useCallback((index: number, e: React.DragEvent) => {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    // Lock the list's scroll position while dragging so the browser's
    // edge auto-scroll can't slide the whole conversation around.
    if (scrollRef.current) dragLockTopRef.current = scrollRef.current.scrollTop
  }, [])

  const handleDragOver = useCallback((index: number, e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIndex(index)
  }, [])

  const handleDrop = useCallback((toIndex: number, e: React.DragEvent) => {
    e.preventDefault()
    if (dragIndex !== null && dragIndex !== toIndex && activeSession) {
      reorderMessages(activeSession.id, dragIndex, toIndex)
    }
    setDragIndex(null)
    setOverIndex(null)
    dragLockTopRef.current = null
  }, [dragIndex, activeSession, reorderMessages])

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
    setOverIndex(null)
    dragLockTopRef.current = null
  }, [])

  // Show undo toast when undo stack changes
  useEffect(() => {
    if (undoStack.length > 0) {
      setShowUndoToast(true)
      const timer = setTimeout(() => setShowUndoToast(false), 5000)
      return () => clearTimeout(timer)
    }
  }, [undoStack.length])

  // ── Linear transcript with turn grouping ──
  // HARD REQUIREMENT: one user message → ONE assistant bubble. Consecutive
  // assistant messages (multi-round agent runs) group into a single display
  // turn sharing one avatar/header; the events INSIDE merge into ONE
  // 「思考与执行过程」collapse block (thinking → text → tool rows per round,
  // interleaved in real order), with the final answer below the block.
  // Tool pairing messages (role='tool') are skipped — their results already
  // render inline inside the assistant message's ToolStepRow.
  const messages = useMemo(() => activeSession?.messages || [], [activeSession?.messages])
  const visibleMessages = useMemo(() => messages.filter((m) => m.role !== 'tool'), [messages])
  // Message id → index in the unfiltered array, for O(1) drag-drop lookups in
  // the turn map below. findIndex per turn was O(turns×messages) recomputed on
  // every streaming flush (~20/s); a Map is built once per messages change.
  const messageIndex = useMemo(() => {
    const idx = new Map<string, number>()
    for (let i = 0; i < messages.length; i++) idx.set(messages[i].id, i)
    return idx
  }, [messages])
  const turns = useMemo(() => {
    // 连续 assistant 消息合并为一个气泡（turn），多轮思考与工具调用按真实
    // 顺序渲染进单个「思考与执行过程」折叠块（思考 → 文字 → 工具 → …），
    // 最终回答的 markdown 正文显示在折叠块下方。
    const result: Array<{ kind: 'user'; message: ChatMessageType } | { kind: 'assistant'; messages: ChatMessageType[] }> = []
    for (const m of messages) {
      if (m.role === 'tool') continue
      if (m.role === 'assistant') {
        const last = result[result.length - 1]
        if (last && last.kind === 'assistant') last.messages.push(m)
        else result.push({ kind: 'assistant', messages: [m] })
      } else {
        result.push({ kind: 'user', message: m })
      }
    }
    return result
  }, [messages])
  // True while the last committed assistant message still has tool calls awaiting
  // results — their ToolStepRows render above (spinner → ✓/✗ in place), so the
  // live turn below must stay hidden during that execution phase. NOTE: pairing
  // tool messages (role='tool') are appended AFTER the assistant message as each
  // tool finishes, so scan back past them to find the real last assistant message.
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

  // True when the conversation already ends with a committed assistant turn
  // (earlier rounds of the current agent run). The live streaming round then
  // continues that bubble instead of opening a second avatar/header, so the
  // whole run reads as ONE conversation bubble.
  const lastTurnIsAssistant = turns.length > 0 && turns[turns.length - 1].kind === 'assistant'

  // Defined BEFORE the early return — React hooks must run unconditionally
  // (useCallback would otherwise be called conditionally when no session is open).
  const handleBatchDelete = () => {
    if (!activeSession || selectedIds.size === 0) return
    // Single batched operation: one undo entry, one save, no cascade side-effects
    useChatStore.getState().deleteMessages(activeSession.id, Array.from(selectedIds))
    setSelectedIds(new Set())
    setIsSelectMode(false)
  }

  const toggleSelect = useCallback((msgId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(msgId)) next.delete(msgId)
      else next.add(msgId)
      return next
    })
  }, [])

  // 聚合模式：assistant turn 的复选框切换整个 turn 的全部消息 id ——
  // 批量删除时整轮一起删除，避免只删掉最后一条留下残缺轮次。
  const toggleTurnSelection = useCallback((members: ChatMessageType[], _id: string) => {
    setSelectedIds((prev) => {
      const ids = members.map((m) => m.id)
      const anySelected = ids.some((id) => prev.has(id))
      const next = new Set(prev)
      if (anySelected) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }, [])

  if (!activeSession) return null

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        // While a drag is active, hold the list in place so edge auto-scroll
        // doesn't slide the conversation up/down mid-drag.
        const lock = dragLockTopRef.current
        const el = scrollRef.current
        if (lock !== null && el && Math.abs(el.scrollTop - lock) > 1) el.scrollTop = lock
        // Track whether the user is near the bottom — auto-scroll during
        // streaming only follows along while they are. The state mirrors the
        // ref so the floating "back to latest" button shows/hides reactively.
        if (el) {
          isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
          setShowScrollToBottom(!isNearBottomRef.current)
        }
      }}
      className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4 relative"
    >
      {/* Batch select toolbar — only in history-edit mode */}
      {editEnabled && visibleMessages.length > 0 && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setIsSelectMode(!isSelectMode); setSelectedIds(new Set()) }}
            className={`px-2 py-1 text-[10px] rounded transition-colors ${isSelectMode ? 'bg-nova-accent/20 text-nova-accent' : 'bg-nova-hover text-nova-text-muted hover:text-nova-text-secondary'}`}
          >
            {isSelectMode ? t('chat.cancelSelect') : t('chat.multiSelect')}
          </button>
          {isSelectMode && selectedIds.size > 0 && (
            <>
              <span className="text-[10px] text-nova-text-muted">{t('chat.selectedCount', { count: selectedIds.size })}</span>
              <button
                onClick={handleBatchDelete}
                className="px-2 py-1 text-[10px] bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors"
              >
                {t('chat.deleteSelected')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Context truncation warning — amber gradient banner (critical stays red) */}
      {tokenWarning && (
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs shrink-0 ${
          tokenWarning.level === 'critical'
            ? 'bg-red-500/10 border border-red-500/30 text-red-400'
            : 'banner-warning'
        }`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span className="font-medium">{t('chat.tokenWarning', {
            percent: tokenWarning.percent,
            used: (tokenWarning.totalTokens / 1000).toFixed(1),
            total: (tokenWarning.contextWindow / 1000).toFixed(0),
          })}</span>
        </div>
      )}

      {messages.length === 0 && !isThisSessionLoading && (
        <div className="flex-1 flex flex-col">
          {/* Welcome card (design: centered icon + title + description) */}
          <div className="flex-1 flex flex-col items-center justify-center text-center px-4 min-h-0">
            <div className="w-14 h-14 rounded-2xl overflow-hidden mb-4 border border-nova-border bg-nova-surface">
              <img src={projectLogo} alt="OurCode AI" className="w-full h-full object-cover" />
            </div>
            <div className="text-base font-semibold text-nova-text-primary">OurCode AI</div>
            <div className="text-xs text-nova-text-muted mt-1.5 max-w-[280px] leading-relaxed">
              {t('chat.welcomeDesc')}
            </div>
          </div>
        </div>
      )}

      {turns.map((turn, index) => {
        if (turn.kind === 'user') {
          // Find the real index in the unfiltered messages array for drag-drop
          const originalIndex = messageIndex.get(turn.message.id) ?? -1
          return (
            <div
              key={turn.message.id}
              onDragOver={editEnabled ? (e) => handleDragOver(originalIndex, e) : undefined}
              onDrop={editEnabled ? (e) => handleDrop(originalIndex, e) : undefined}
              className={`chat-msg-row relative group/row transition-all ${
                dragIndex === originalIndex ? 'opacity-40' : ''
              } ${
                overIndex === originalIndex && dragIndex !== null && dragIndex !== originalIndex
                  ? 'border-t-2 border-nova-accent'
                  : ''
              }`}
            >
              {editEnabled && (
                <MessageDragHandle
                  onDragStart={(e) => handleDragStart(originalIndex, e)}
                  onDragEnd={handleDragEnd}
                />
              )}
              <ChatMessage
                message={turn.message}
                sessionId={activeSession.id}
                isSelectMode={isSelectMode}
                isSelected={selectedIds.has(turn.message.id)}
                onToggleSelect={toggleSelect}
              />
            </div>
          )
        }

        // Assistant turn — ONE bubble: one avatar/header, all rounds' thinking
        // and tool calls merged into ONE 「思考与执行过程」collapse block, with
        // the final answer rendered below it.
        const firstId = turn.messages[0].id
        const originalIndex = messageIndex.get(firstId) ?? -1
        // 会话文件改动汇总只挂最后一条 assistant 消息（动作工具栏上方）。
        const isLastTurn = index === turns.length - 1
        return (
          <div
            key={`turn-${firstId}`}
            onDragOver={editEnabled ? (e) => handleDragOver(originalIndex, e) : undefined}
            onDrop={editEnabled ? (e) => handleDrop(originalIndex, e) : undefined}
            className={`chat-msg-row relative group/row transition-all ${
              dragIndex === originalIndex ? 'opacity-40' : ''
            } ${
              overIndex === originalIndex && dragIndex !== null && dragIndex !== originalIndex
                ? 'border-t-2 border-nova-accent'
                : ''
            }`}
          >
            {editEnabled && (
              <MessageDragHandle
                onDragStart={(e) => handleDragStart(originalIndex, e)}
                onDragEnd={handleDragEnd}
              />
            )}
            <div className="flex flex-col gap-1.5">
              {/* 聚合模式：整个 turn 渲染为一个 ChatMessage —— 多轮思考与
                  工具调用合并进单个「思考与执行过程」折叠块，最终回答在块下方。
                  key 必须用 turn 的首条消息 id（稳定身份）而非末条：agent 多轮
                  运行时每提交一轮就会往 turn 末尾追加一条 assistant 消息，若用
                  末条 id 作 key，整轮会重挂载，用户正展开查看的历史工具调用
                  详情（params/result）会被强行收起。 */}
              <ChatMessage
                key={turn.messages[0].id}
                message={turn.messages[turn.messages.length - 1]}
                turnMessages={turn.messages}
                sessionId={activeSession.id}
                isSelectMode={isSelectMode}
                isSelected={turn.messages.some((m) => selectedIds.has(m.id))}
                onToggleSelect={(id) => toggleTurnSelection(turn.messages, id)}
                renderFileChanges={isLastTurn}
              />
            </div>
          </div>
        )
      })}

      {/* 会话文件改动汇总已移入最后一条 assistant 消息内（动作工具栏上方）——
          ChatMessage 的 renderFileChanges 负责渲染，此处不再单独挂框。 */}

      {/* Live turn — only while the CURRENT LLM round is still streaming. Once
          the round commits (addMessage + clearStream in the agent loop) its
          thinking/text/tool rows render above from the committed message, so
          this block must NOT also appear. During tool execution the committed
          message's ToolStepRow shows the live spinner → ✓/✗ via appendToolResult.
          When an assistant turn is already committed (earlier rounds of the same
          run), this round continues THAT bubble — avatar/header hidden and the
          streaming answer rendered in the same card, so a multi-round agent run
          reads as ONE bubble instead of two. Rendered as its own component so
          the per-session stream fields (which churn ~20 Hz while streaming) and
          the 1 s elapsed clock re-render only this subtree, never the list. */}
      {activeSession && (
        <LiveStreamBlock
          sessionId={activeSession.id}
          isToolsExecuting={isToolsExecuting}
          lastTurnIsAssistant={lastTurnIsAssistant}
        />
      )}

      <div ref={messagesEndRef} />

      {/* Floating "back to latest" pill — appears at the left of the message
          bubbles only while the user is scrolled up reading earlier messages.
          Sticky inside the scroll container so it hovers at the bottom of the
          visible viewport instead of scrolling away with the content. */}
      {showScrollToBottom && (
        <button
          onClick={scrollToBottom}
          title={t('chat.scrollToBottom')}
          className="sticky bottom-3 self-start shrink-0 flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-full bg-nova-card border border-nova-border shadow-lg text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover transition-colors animate-fade-in z-10"
        >
          <MSIcon name="arrow_downward" className="text-[14px] leading-none" />
          <span className="text-[11px]">{t('chat.scrollToBottom')}</span>
        </button>
      )}

      {/* Undo toast */}
      {showUndoToast && undoStack.length > 0 && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
          <div className="flex items-center gap-3 px-4 py-2 bg-nova-surface border border-nova-border rounded-lg shadow-xl">
            <span className="text-xs text-nova-text-secondary">{t('chat.deletedCount', { count: undoStack[undoStack.length - 1].messages.length })}</span>
            <button
              onClick={() => { undoDelete(); setShowUndoToast(false) }}
              className="px-3 py-1 text-xs bg-nova-accent text-white rounded hover:opacity-90 transition-opacity"
            >
              {t('chat.undo')}
            </button>
            <button
              onClick={() => setShowUndoToast(false)}
              className="text-nova-text-muted hover:text-nova-text-primary"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The in-flight LLM turn while the current round streams. Kept as its own
 *  component so ONLY this small subtree subscribes to the per-session stream
 *  fields (which change up to 20 Hz while streaming) and drives its own 1 s
 *  elapsed clock — the historical message list must not re-render on every
 *  flush. Renders null whenever the session isn't actively loading or tools
 *  are still executing (their live rows live in the committed message). */
function LiveStreamBlock({
  sessionId,
  isToolsExecuting,
  lastTurnIsAssistant,
}: {
  sessionId: string
  isToolsExecuting: boolean
  lastTurnIsAssistant: boolean
}) {
  const isThisSessionLoading = useChatStore((s) => s.runningSessionIds.includes(sessionId))
  const stream = useChatStore((s) => s.streamingBySession[sessionId])
  // Current agent-loop stage of this session (preparing / compacting / waiting
  // / streaming) + when it started — the "正在…" placeholder below shows the
  // real stage instead of a generic codebase-analysis label.
  const runPhase = useChatStore((s) => s.runPhaseBySession[sessionId])
  // The live agent run of this session — used to show how many seconds the
  // session has been running next to the "思考中…" pulse while it streams.
  const activeRun = useChatStore((s) => s.activeRuns[sessionId])
  const activeSession = useChatStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null)
  // Idle clock: last time this session's agent produced any activity (chunk /
  // tool step / dialog). When it stays silent for > 1 min a warning badge
  // counts up the silence so the user knows the model is still "thinking".
  const lastActivityAt = useChatStore((s) => s.streamLastActivityBySession[sessionId])
  const t = useI18n()

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isThisSessionLoading) return
    // Re-sync immediately on entering a run, then tick every second while the
    // session runs. Deliberately NOT keyed on `lastActivityAt` — the stream's
    // per-chunk activity updates (~20/s) would tear down and recreate this
    // interval on every flush; the idleSeconds badge just reads the latest
    // activity timestamp against the ticking clock.
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isThisSessionLoading])

  const idleSeconds = lastActivityAt ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : 0
  // Elapsed seconds of the live run (0 until the run record exists) — the same
  // `now` ticker above drives it, so the counter updates every second.
  const liveRun = activeRun ? activeSession?.agentRuns?.find((r) => r.id === activeRun.runId) : undefined
  const runElapsed = liveRun ? Math.max(0, Math.floor((now - liveRun.startedAt) / 1000)) : 0
  // Seconds the session has spent in its CURRENT stage (resets on each phase
  // transition). For 'waiting' this is the model's time-to-first-token.
  const phaseElapsed = runPhase ? Math.max(0, Math.floor((now - runPhase.since) / 1000)) : 0

  if (!isThisSessionLoading || isToolsExecuting) return null

  return (
    <div className="animate-fade-in">
      <div className="min-w-0">
        {!lastTurnIsAssistant && (
          <div className="flex items-center gap-2 text-xs text-nova-text-muted font-medium mb-1.5 pl-0.5">
            <span className="font-semibold text-[13px] text-nova-text-primary">OurCode AI</span>
            <span className="flex items-center gap-1 text-nova-accent">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse-soft inline-block" />
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-nova-hover border border-nova-border">
                {t('chat.thinking')}…{runElapsed > 0 ? ` ${runElapsed}s` : ''}
              </span>
            </span>
          </div>
        )}
        {/* Idle warning — no data for > 1 min, keep counting up (the
            stream's 10-min idle timeout aborts if nothing arrives) */}
        {idleSeconds >= 60 && (
          <div
            className="flex items-center gap-1 text-nova-text-muted font-mono text-[10px] px-1.5 py-0.5 rounded bg-nova-hover border border-nova-border mb-1.5 w-fit"
            title={t('chat.idleWarning')}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            {t('chat.idleCount', { minutes: Math.floor(idleSeconds / 60), seconds: idleSeconds % 60 })}
          </div>
        )}
        {/* Thinking streams collapsed — the "思考中…" pulse line shows the
            model is working without flooding the transcript with its raw
            monologue; click to peek. Committed turns collapse into the
            AgentProcessBlock below. */}
        {stream?.thinking && <ThinkingSection thinking={stream.thinking} streaming />}
        {stream?.content ? (
          <div className="text-sm text-nova-text-primary leading-relaxed">
            <StreamingMarkdown content={stream.content} />
            <span className="animate-pulse-dot text-nova-accent">▋</span>
          </div>
        ) : !stream?.thinking ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-nova-text-muted text-sm">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full animate-think-bounce" style={{ background: '#838485' }} />
                <span className="w-1.5 h-1.5 rounded-full animate-think-bounce" style={{ background: '#838485', animationDelay: '0.2s' }} />
                <span className="w-1.5 h-1.5 rounded-full animate-think-bounce" style={{ background: '#838485', animationDelay: '0.4s' }} />
              </div>
              <span>{t('chat.thinking')}</span>
            </div>
            {/* 动作期状态反馈：真实阶段（准备上下文 / 压缩历史 / 等待模型首
                token）+ 该阶段已耗时，而非笼统的「正在根据代码库分析…」。
                无阶段时（理论上只有 loading 标记刚置位的瞬间）回落旧文案。 */}
            <div className="pl-0.5 text-[11px] text-nova-text-muted/70">
              {runPhase?.phase === 'preparing' && t('chat.phasePreparing')}
              {runPhase?.phase === 'compacting' && t('chat.phaseCompacting')}
              {runPhase?.phase === 'waiting' && t('chat.phaseWaiting')}
              {(!runPhase || runPhase.phase === 'streaming') && t('chat.analyzing')}
              {phaseElapsed > 0 ? ` ${phaseElapsed}s` : ''}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
