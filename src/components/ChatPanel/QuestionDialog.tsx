import { useEffect, useId, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { useI18n } from '@/i18n/useI18n'
import MSIcon from '@/components/Common/icons/MSIcon'

const QUESTION_AUTO_CONTINUE_MS = 5 * 60_000

/** mm:ss 格式化（倒计时显示用）。 */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Ask-user-question —— 内嵌于对话面板决策区（极简纯净版 V1 落地方案）：
 * 白卡 + 发丝线边框，头部 ❓ +「AI 需要确认」+「可多选」徽标，吸底显示在消息
 * 区最底部、模式栏（目标模式按钮）上方，不再弹窗。单选选项点击即提交（向后
 * 兼容）；多选问题用复选框 + 提交按钮，勾选项以「；」拼接回喂给 agent。
 * 可选的每选项预览文本（如 ASCII mockup）渲染在选项下方便于并排比较。
 *
 * 折叠（v2）：表头整行是折叠开关（aria-expanded），收起后只剩一条表头 + 问题
 * 首行预览，把高度还给消息区——之前问题卡最高能吃掉半个面板，用户想往上翻
 * 历史消息时几乎看不到内容。正文另有 max-h-[40vh] 内部滚动兜底，选项再多也不会
 * 把消息区挤没。新问题到达时自动展开（不能让用户漏看问题）。
 *
 * 提问自动继续（ZCode 风格）：默认 5 分钟倒计时（右上角实时显示），超时后
 * agent 自动继续并在工具结果里标记「未回答，已自动继续」；鼠标悬停卡片或任何
 * 交互会永久停止计时；设置 → 常规 → 提问自动继续 可整体关闭。
 */
export default function QuestionDialog() {
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const answerQuestion = useChatStore((s) => s.answerQuestion)
  const pauseQuestionTimeout = useChatStore((s) => s.pauseQuestionTimeout)
  // Parallel conversations: only the active session's question is shown —
  // switching to the owning session reveals it again.
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // The confirm gate (questionGate === 'confirm'/'dismissed') keeps the card
  // hidden until the user arms it via the QuestionConfirmBar — questions that
  // fired while the user was on another session must not pop up unannounced.
  const questionGate = useChatStore((s) => s.questionGate)
  const questionAutoContinue = useEditorStore((s) => s.preferences.questionAutoContinue)
  const [customAnswer, setCustomAnswer] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // 本地倒计时显示（真正的超时在 store 的 armQuestionTimeout 里）；暂停后归零。
  const [paused, setPaused] = useState(false)
  const [remainingMs, setRemainingMs] = useState(QUESTION_AUTO_CONTINUE_MS)
  // 折叠状态：只影响这张卡自身，不写进 store（新问题到达即复位为展开）。
  const [collapsed, setCollapsed] = useState(false)
  const bodyId = useId()
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const t = useI18n()

  // Reset per-question state whenever a new question arrives
  useEffect(() => {
    setSelected(new Set())
    setCustomAnswer('')
    setPaused(false)
    setRemainingMs(QUESTION_AUTO_CONTINUE_MS)
    setCollapsed(false)
  }, [pendingQuestion?.id])

  const askedAt = pendingQuestion?.askedAt
  const showCountdown = !!askedAt && questionAutoContinue !== false

  // 从提问时刻起算的剩余时间（每秒刷新；悬停暂停后停止刷新）
  useEffect(() => {
    if (!showCountdown || paused) {
      if (tickRef.current) clearInterval(tickRef.current)
      tickRef.current = null
      return
    }
    const update = () => setRemainingMs(Math.max(0, QUESTION_AUTO_CONTINUE_MS - (Date.now() - (askedAt || 0))))
    update()
    tickRef.current = setInterval(update, 1000)
    return () => {
      if (tickRef.current) clearInterval(tickRef.current)
      tickRef.current = null
    }
  }, [showCountdown, paused, askedAt])

  if (!pendingQuestion || pendingQuestion.sessionId !== activeSessionId) return null
  // Only explicit 'confirm'/'dismissed' block the card (until the user arms it
  // via the QuestionConfirmBar) — any other value, including undefined from a
  // question set without a gate, must still show or the loop would hang.
  const gate = questionGate[pendingQuestion.sessionId]
  if (gate === 'confirm' || gate === 'dismissed') return null

  const options = pendingQuestion.options || []
  const previews = pendingQuestion.preview || []
  // 模型可能只发 multiSelect=true 却漏了 options（真实发生：卡出永久禁用的
  // 「提交选择」、无选项可勾的死局）。没有选项就按单选渲染——底部出现自定义
  // 回答输入框，用户至少可以打字回答，不会卡死。
  const multiSelect = pendingQuestion.multiSelect === true && options.length > 0
  const countdownLabel = formatCountdown(remainingMs)

  const submit = (answer: string) => {
    setCustomAnswer('')
    answerQuestion(answer)
  }

  /** 悬停/任何交互 = 永久停止计时（ZCode 行为）。 */
  const stopCountdown = () => {
    if (showCountdown && !paused && pendingQuestion) {
      setPaused(true)
      pauseQuestionTimeout(pendingQuestion.sessionId)
    }
  }

  /** 折叠/展开：算一次用户交互，顺手停表（键盘触发也覆盖）。 */
  const toggleCollapsed = () => {
    stopCountdown()
    setCollapsed((v) => !v)
  }

  const toggleSelected = (i: number) => {
    stopCountdown()
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const submitSelection = () => {
    const picked = options.filter((_, i) => selected.has(i))
    if (picked.length === 0) return
    submit(picked.join('；'))
  }

  return (
    <div
      role="region"
      aria-label={t('chat.askUserTitle')}
      onMouseEnter={stopCountdown}
      className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border rounded-xl overflow-hidden shadow-sm"
    >
      {/* 头部：❓ + 标题 + 折叠开关。整行可点（button + aria-expanded），
          收起时用问题首行预览代替正文，用户仍然知道 AI 在问什么。 */}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-controls={collapsed ? undefined : bodyId}
        aria-describedby={collapsed ? `${bodyId}-preview` : undefined}
        aria-label={collapsed ? t('chat.askExpand') : t('chat.askCollapse')}
        title={collapsed ? t('chat.askExpand') : t('chat.askCollapse')}
        className="w-full px-4 py-3 flex items-center gap-2 text-left select-none bg-nova-hover/50 hover:bg-nova-hover transition-colors border-b border-nova-border"
      >
        <MSIcon name="help" className="text-[18px] leading-none text-nova-accent shrink-0" />
        <span className="text-[13px] font-semibold text-nova-text-primary shrink-0">{t('chat.askUserTitle')}</span>
        {collapsed && (
          <>
            <span aria-hidden className="shrink-0 text-[12px] text-nova-text-muted">·</span>
            <span id={`${bodyId}-preview`} className="flex-1 min-w-0 truncate text-[12px] text-nova-text-muted" title={pendingQuestion.question}>
              {pendingQuestion.question}
            </span>
          </>
        )}
        <span className="ml-auto shrink-0 flex items-center gap-1.5">
          {showCountdown && !paused && (
            <span className="flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 rounded bg-warning-10 text-warning border border-warning-30">
              <MSIcon name="timer" className="text-[12px] leading-none" />
              {countdownLabel}
            </span>
          )}
          {multiSelect && options.length > 0 && !showCountdown && (
            <span className="text-[11px] px-2 py-0.5 rounded bg-nova-accent/5 text-nova-accent border border-nova-accent/10">
              {t('chat.askMultiSelectHint')}
            </span>
          )}
          {showCountdown && paused && (
            <span className="flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 rounded bg-nova-hover text-nova-text-muted border border-nova-border">
              <MSIcon name="timer" className="text-[12px] leading-none" />
              {t('question.timerPaused')}
            </span>
          )}
          <MSIcon
            name="expand_more"
            className={`text-[16px] leading-none text-nova-text-muted transition-transform duration-200 ${collapsed ? '' : 'rotate-180'}`}
          />
        </span>
      </button>

      {/* 正文：问题 + 选项列表。收起时整块不渲染（把高度还给消息区）。
          max-h-[40vh] + overflow-y-auto：选项再多也只在卡内滚动，不会把上方
          的消息区挤到看不见。 */}
      {!collapsed && (
        <div id={bodyId} className="px-4 py-3 flex flex-col gap-3 max-h-[40vh] overflow-y-auto">
          <p className="text-[13px] text-nova-text-primary leading-relaxed whitespace-pre-wrap">
            {pendingQuestion.question}
          </p>

          {options.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {options.map((opt, i) =>
                multiSelect ? (
                  <label
                    key={i}
                    className={`block rounded-lg border border-nova-border transition-colors cursor-pointer overflow-hidden ${
                      selected.has(i) ? 'bg-nova-accent/5 border-nova-accent/40' : 'bg-nova-hover/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={() => toggleSelected(i)}
                        className="accent-nova-accent w-4 h-4 shrink-0"
                      />
                      <span className="text-[13px] text-nova-text-secondary">{opt}</span>
                    </div>
                    {previews[i] && (
                      <pre className="mx-3 mb-2 px-2 py-1.5 text-[11px] leading-relaxed text-nova-text-muted bg-nova-bg/60 rounded max-h-32 overflow-auto whitespace-pre">
                        {previews[i]}
                      </pre>
                    )}
                  </label>
                ) : (
                  <div key={i} className="rounded-lg bg-nova-hover/50 border border-nova-border overflow-hidden">
                    <button
                      onClick={() => submit(opt)}
                      className="w-full px-3 py-2 text-left text-[13px] hover:bg-nova-accent/10 hover:text-nova-accent transition-colors text-nova-text-secondary"
                    >
                      {opt}
                    </button>
                    {previews[i] && (
                      <pre className="mx-3 mb-2 px-2 py-1.5 text-[11px] leading-relaxed text-nova-text-muted bg-nova-bg/60 rounded max-h-32 overflow-auto whitespace-pre">
                        {previews[i]}
                      </pre>
                    )}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* 操作条：自定义回答输入 + 跳过 / 发送 + 停止计时。收起时一并隐藏。 */}
      {!collapsed && (
        <div className="px-4 py-3 border-t border-nova-border flex items-center gap-2 bg-nova-surface">
          {multiSelect ? (
            <button
              onClick={submitSelection}
              disabled={selected.size === 0}
              className="ml-auto px-4 py-2 text-[13px] text-white rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity bg-nova-accent"
            >
              {t('chat.askSubmitSelection')}
            </button>
          ) : (
            <>
              <input
                autoFocus
                value={customAnswer}
                onChange={(e) => { stopCountdown(); setCustomAnswer(e.target.value) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customAnswer.trim()) submit(customAnswer.trim())
                }}
                placeholder={options.length > 0 ? t('chat.askCustomAnswerPlaceholder') : t('chat.askAnswerPlaceholder')}
                className="flex-1 px-3 py-2 text-[13px] bg-nova-bg border border-nova-border rounded-lg outline-none focus:border-nova-accent/60 text-nova-text-primary placeholder:text-nova-text-muted"
              />
              <button
                onClick={() => customAnswer.trim() ? submit(customAnswer.trim()) : submit(t('chat.askNoInput'))}
                className="px-4 py-2 text-[13px] text-white rounded-lg hover:opacity-90 transition-opacity bg-nova-accent"
              >
                {t('chat.send')}
              </button>
            </>
          )}
          <button
            onClick={() => submit(t('chat.askSkipped'))}
            className="px-3 py-2 text-[13px] text-nova-text-muted hover:text-nova-text-primary rounded-lg transition-colors"
          >
            {t('chat.skip')}
          </button>
        </div>
      )}

      {/* 倒计时说明行：悬停暂停 + 停止计时 + 设置开关位置 */}
      {!collapsed && showCountdown && (
        <div className="px-4 pb-3 -mt-1 flex items-center gap-2 text-[11px] text-nova-text-muted">
          <span>{t('question.countdownHint')}</span>
          {!paused && (
            <button onClick={stopCountdown} className="text-warning hover:underline">
              {t('question.stopTimer')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
