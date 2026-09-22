import { useEffect, useRef, useState } from 'react'
import ChatMessages from './ChatMessages'
import AgentStatusMiniPanel from './AgentStatusMiniPanel'
import AgentTraceView from './AgentTraceView'
import ChatInput from './ChatInput'
import ChatSidebar from './ChatSidebar'
import QuestionConfirmBar from './QuestionConfirmBar'
import InlineDecisionArea from './InlineDecisionArea'
import ModeMenu from './ModeMenu'
import ArenaModal from './ArenaModal'
import WorkflowModal from './WorkflowModal'
import ModelSelector from './ModelSelector'
import WaveLogo from './WaveLogo'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n/useI18n'
import type { ChatSession } from '@/types'
import { resolveThinkingLevel } from '@/types'
import MSIcon from '@/components/Common/icons/MSIcon'
import Button from '@/components/Common/Button'
import { isComposingEvent } from '@/utils/composition'

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-7 h-7 flex items-center justify-center rounded-md text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors"
      title={title}
    >
      {children}
    </button>
  )
}

/** Inline-editable conversation title in the chat header — click to rename;
 *  Enter/blur commits, Esc cancels. Persists via renameSession. */
function SessionTitleEditor({ session }: { session: ChatSession }) {
  const renameSession = useChatStore((s) => s.renameSession)
  const t = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  // Switching sessions mid-edit must abandon the draft — otherwise the blur
  // commit (with the stale draft) would rename the NEW session to the old one.
  const sessionId = session.id
  useEffect(() => {
    setEditing(false)
  }, [sessionId])

  const startEdit = () => {
    setDraft(session.title)
    setEditing(true)
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== session.title) renameSession(session.id, trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isComposingEvent(e)) commit()
          else if (e.key === 'Escape') setEditing(false)
        }}
        className="w-[180px] text-[11px] px-1.5 py-0.5 rounded border border-nova-accent/50 bg-nova-input-bg text-nova-text-primary outline-none"
        placeholder={t('chat.renameSessionPrompt')}
        title={t('chat.renameSessionPrompt')}
      />
    )
  }

  return (
    <button
      onClick={startEdit}
      className="group/title flex items-center gap-1 min-w-0 max-w-[220px] text-[11px] text-nova-text-secondary hover:text-nova-text-primary transition-colors"
      title={t('chat.renameTitleHint')}
    >
      {/* min-w-0 is required for truncate to work inside a flex row */}
      <span className="min-w-0 truncate">{session.title || t('chat.untitled')}</span>
      <svg
        className="w-3 h-3 shrink-0 opacity-0 group-hover/title:opacity-60 transition-opacity"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      >
        <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    </button>
  )
}

export default function ChatPanel() {
  // Derived session selector (stable object reference unless THIS session
  // changes) — the old getActiveSession() function selector never re-renders.
  const activeSession = useChatStore((s) => (s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) ?? null : null))
  const createSession = useChatStore((s) => s.createSession)
  const requestEditModeChange = useChatStore((s) => s.requestEditModeChange)
  const updateSessionParams = useChatStore((s) => s.updateSessionParams)
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const models = useConfigStore((s) => s.models)
  const activeConfigGroup = useConfigStore((s) => s.configGroups.find((g) => g.id === s.activeConfigGroupId))
  // The session's OWN config group — the chat loop resolves the runtime model
  // from session.configGroupId, so the pill must follow it, not the globally
  // active group (they can diverge right after startup / group switching).
  const sessionConfigGroup = useConfigStore((s) =>
    activeSession ? s.configGroups.find((g) => g.id === activeSession.configGroupId) : undefined
  )
  const openSettings = useUIStore((s) => s.openSettings)
  const openMemoryManager = useUIStore((s) => s.openMemoryManager)
  const t = useI18n()
  const isChatSessionListOpen = useUIStore((s) => s.isChatSessionListOpen)
  const setChatSessionListOpen = useUIStore((s) => s.setChatSessionListOpen)
  const [showArena, setShowArena] = useState(false)
  const [showWorkflows, setShowWorkflows] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [view, setView] = useState<'chat' | 'trace'>('chat')

  const projectEditMode = activeSession?.projectEditMode || 'confirm_before_change'
  // 目标模式开关已迁至「一人公司」（左侧 3D 办公室视图）；此处保留只读状态，
  // 用于模式栏在目标模式运行期间隐藏 auto_edit/plan 审批选项。
  const targetMode = activeSession?.targetMode === true
  // Same resolution as the agent loop (`session.model || group.defaultModel`) —
  // previously the pill fell back to nothing when session.model was empty,
  // showing "选择模型" while the conversation actually ran on the default model.
  const activeModel = activeSession?.model || sessionConfigGroup?.defaultModel || ''

  const handleNewSession = () => {
    if (activeConfigGroupId) {
      createSession(activeConfigGroupId)
    } else {
      openSettings()
    }
  }

  // Mode switch is where the session-wide READ policy follows the edit mode:
  // entering 完全访问 arms it behind one native confirmation; leaving it
  // disarms (a safe direction, no dialog), so 手动确认 really asks again.
  // 逻辑已收敛到 store 的 requestEditModeChange（Shift+Tab 循环复用同一路径）。
  const handleEditModeChange = (mode: 'confirm_before_change' | 'auto_edit' | 'plan' | 'full_access') => {
    if (!activeSession) return
    void requestEditModeChange(activeSession.id, mode)
  }

  return (
    <div className="h-full flex bg-transparent chat-accent">
      {/* Session sidebar (collapsible) */}
      {isChatSessionListOpen && (
        <ChatSidebar onClose={() => setChatSessionListOpen(false)} />
      )}

      {/* Arena (parallel model comparison) */}
      {showArena && <ArenaModal onClose={() => setShowArena(false)} />}

      {/* Workflows */}
      {showWorkflows && <WorkflowModal onClose={() => setShowWorkflows(false)} />}

      <div className="flex-1 flex flex-col min-w-0 bg-nova-surface">
        {/* Chat header */}
        <div className="px-3 py-2 shrink-0">
          <div className="flex items-center justify-between gap-2">
            {/* Brand */}
            <div className="flex items-center gap-2 min-w-0">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-nova-accent bg-nova-surface border border-nova-border"
              >
                <WaveLogo color="currentColor" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <strong className="text-sm block truncate leading-tight text-nova-text-primary">
                    OurCode AI
                  </strong>
                  {activeConfigGroup ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-green-500 shrink-0">
                      <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse-dot" />
                      {t('chat.connected')}
                    </span>
                  ) : (
                    <button
                      onClick={openSettings}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] text-nova-text-muted bg-nova-hover hover:text-nova-text-primary border border-nova-border shrink-0 transition-colors"
                      title={t('chat.notConfigured')}
                    >
                      <span className="w-1 h-1 rounded-full bg-gray-500" />
                      {t('chat.notConfigured')}
                    </button>
                  )}
                  {/* Current conversation title — inline editable (design:
                      logo + connected + title + model + ⋮) */}
                  {activeSession && (
                    <>
                      <span className="w-px h-3 bg-nova-border shrink-0" />
                      <SessionTitleEditor session={activeSession} />
                    </>
                  )}
                </div>
                <span className="text-[10px] text-nova-text-muted block truncate">
                  {activeConfigGroup ? activeConfigGroup.name : t('chat.selectModelHint')}
                </span>
              </div>
            </div>

            {/* Model pill + mode toggle + actions */}
            <div className="flex items-center gap-1.5 shrink-0">
              {/* History (timeline) — opens the session list (design: header toolbar entry) */}
              <IconButton title={t('chat.historyHint')} onClick={() => setChatSessionListOpen(true)}>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <polyline points="3 3 3 8 8 8" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </IconButton>
              {activeSession && (
                <div className="relative">
                  <button
                    onClick={() => setShowModelPicker(!showModelPicker)}
                    className="pill-btn flex items-center gap-1 max-w-[200px] text-[11px] border border-nova-border bg-nova-hover/50"
                    title={t('chat.selectModel')}
                  >
                    <span className="truncate">
                      {models.find((m) => m.id === activeModel)?.alias || activeModel || t('chat.selectModel')}
                    </span>
                    <span className="text-nova-text-muted shrink-0">▾</span>
                  </button>
                  {showModelPicker && (
                    <>
                      {/* Backdrop: click anywhere to close the picker */}
                      <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} />
                      <div
                        className="absolute right-0 top-full mt-1 z-50 w-[380px] max-h-[70vh] overflow-y-auto p-3 rounded-xl border shadow-2xl"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border-strong)' }}
                      >
                        <ModelSelector />
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* 新建对话 now lives in the LEFT sidebar (per-project item / tree
                  header) — the right panel no longer carries its own button. */}
              <div className="flex items-center gap-0.5">
                {/* ⋮ overflow menu — keeps the header clean (design: logo + connected + model + ⋮) */}
                <div className="relative">
                  <IconButton title={t('chat.more')} onClick={() => setShowMoreMenu(!showMoreMenu)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="1.7" />
                      <circle cx="12" cy="12" r="1.7" />
                      <circle cx="12" cy="19" r="1.7" />
                    </svg>
                  </IconButton>
                  {showMoreMenu && (
                    <>
                      {/* Backdrop: click anywhere to close */}
                      <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
                      <div
                        className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg border shadow-2xl py-1 animate-fade-in"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border-strong)' }}
                      >
                        <button
                          onClick={() => { setShowArena(true); setShowMoreMenu(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-nova-text-secondary hover:bg-nova-accent/15 hover:text-white flex items-center gap-2 transition-colors"
                        >
                          <MSIcon name="compare_arrows" className="text-[15px] leading-none text-nova-text-muted" />
                          {t('chat.arenaCompare')}
                        </button>
                        <button
                          onClick={() => { setShowWorkflows(true); setShowMoreMenu(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-nova-text-secondary hover:bg-nova-accent/15 hover:text-white flex items-center gap-2 transition-colors"
                        >
                          <MSIcon name="sync" className="text-[15px] leading-none text-nova-text-muted" />
                          {t('chat.workflows')}
                        </button>
                        <button
                          onClick={() => { openMemoryManager(); setShowMoreMenu(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-nova-text-secondary hover:bg-nova-accent/15 hover:text-white flex items-center gap-2 transition-colors"
                        >
                          <MSIcon name="memory" className="text-[15px] leading-none text-nova-text-muted" />
                          {t('chat.memory')}
                        </button>
                        <div className="h-px bg-nova-border my-1" />
                        <button
                          onClick={() => { openSettings(); setShowMoreMenu(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-nova-text-secondary hover:bg-nova-accent/15 hover:text-white flex items-center gap-2 transition-colors"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                          </svg>
                          {t('chat.settings')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Chat Content */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {activeSession ? (
            <>
              {/* Agent 执行状态胶囊 —— 占一行自己的空间，不再浮在消息之上。
                  （之前 absolute 浮层会盖住首条消息的文字，窄面板尤其明显。）
                  展开后的详情卡仍是浮层：那是用户主动点开的气泡。 */}
              {view === 'chat' && <AgentStatusMiniPanel sessionId={activeSession.id} />}

              {view === 'trace' ? (
                <div className="flex-1 min-h-0">
                  <AgentTraceView />
                </div>
              ) : (
                <ChatMessages />
              )}

              {/* 内嵌决策区 —— 询问选择 / 工具审批 / 重新生成 / 回退全部等框
                  全部在对话面板内完成（不再弹窗），吸底展示在消息区最底部、
                  模式栏上方。 */}
              <InlineDecisionArea />

              {/* Mode bar —— 左对齐单行：思考等级 / 审批模式 / 轨迹。
                  对话与轨迹视图都常驻（轨迹视图靠「轨迹」按钮切回对话）。
                  轨迹按钮原在消息区上方的独立行，现并入本行最右侧。
                  目标模式开关已迁至「一人公司」视图（左侧活动栏入口）。 */}
              <div className="shrink-0 px-3 py-2 border-t border-nova-border flex items-center justify-start gap-1.5 bg-transparent">
                {/* 思考档位 — 关闭/低/中/高/最高。关闭即不请求思考（reasoning
                    模型仍可能自行输出）；最高档在支持预算的 provider
                    （Anthropic/Gemini）上调满 16384 token。 */}
                <select
                  value={resolveThinkingLevel(activeSession.modelParams)}
                  onChange={(e) =>
                    updateSessionParams(activeSession.id, { thinkingLevel: e.target.value as 'off' | 'low' | 'medium' | 'high' | 'max' })
                  }
                  className="text-xs rounded-md px-2 py-1 border outline-none cursor-pointer transition-colors border-nova-border bg-nova-input-bg text-nova-text-primary hover:border-nova-accent focus:border-nova-accent"
                  title={t('chat.thinkingLevelLabel')}
                  style={{ backgroundImage: 'none' }}
                >
                  <option value="off" title={t('chat.thinkingLevelOffHint')}>{t('chat.thinkingLevelOff')}</option>
                  <option value="low" title={t('chat.thinkingLevelLowHint')}>{t('chat.thinkingLevelLow')}</option>
                  <option value="medium" title={t('chat.thinkingLevelMediumHint')}>{t('chat.thinkingLevelMedium')}</option>
                  <option value="high" title={t('chat.thinkingLevelHighHint')}>{t('chat.thinkingLevelHigh')}</option>
                  <option value="max" title={t('chat.thinkingLevelMaxHint')}>{t('chat.thinkingLevelMax')}</option>
                </select>
                {/* 编辑方式 —— 四档权限模式（手动确认/自动编辑/计划/完全访问）。
                    弹出菜单展示图标 + 一句话说明；Shift+Tab 可循环切换。
                    目标模式开启时其自身流程取代 auto_edit/plan，只保留两档。 */}
                <ModeMenu
                  value={projectEditMode}
                  targetMode={targetMode}
                  onChange={handleEditModeChange}
                />
                {/* 轨迹视图切换 —— 本行最右侧；点击在对话与 agent 执行日志之间切换。 */}
                <button
                  onClick={() => setView(view === 'trace' ? 'chat' : 'trace')}
                  className={`ml-auto px-3 py-1 text-xs rounded-full transition-all ${view === 'trace' ? 'bg-nova-accent/10 text-nova-accent font-medium' : 'text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover'}`}
                >
                  {t('agent.traceTab')}
                </button>
              </div>

              {view !== 'trace' && (
                <>
                  <ChatInput />
                  <QuestionConfirmBar />
                </>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="text-center max-w-[320px]">
                <div
                  className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center text-nova-accent bg-nova-surface border border-nova-border"
                >
                  <WaveLogo size={24} color="currentColor" />
                </div>
                <div className="text-xl font-semibold text-nova-text-primary mb-1">
                  OurCode AI
                </div>
                <div className="text-sm text-nova-text-muted mb-2">
                  {t('chat.emptyTitle')}
                </div>
                <div className="text-xs text-nova-text-muted mb-6 max-w-xs mx-auto leading-relaxed">
                  {t('chat.emptyDesc')}
                </div>
                <Button onClick={handleNewSession} className="px-5 shadow-sm">
                  {t('chat.startNewChat')}
                </Button>
                {!activeConfigGroupId && (
                  <button
                    onClick={openSettings}
                    className="block mx-auto mt-3 text-xs text-nova-accent hover:underline"
                  >
                    {t('chat.configureApiKey')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
