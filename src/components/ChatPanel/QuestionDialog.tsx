import { useEffect, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import MSIcon from '@/components/Common/icons/MSIcon'

/**
 * Ask-user-question —— 内嵌于对话面板决策区（极简纯净版 V1 落地方案）：
 * 白卡 + 发丝线边框，头部 ❓ +「AI 需要确认」+「可多选」徽标，吸底显示在消息
 * 区最底部、模式栏（目标模式按钮）上方，不再弹窗。单选选项点击即提交（向后
 * 兼容）；多选问题用复选框 + 提交按钮，勾选项以「；」拼接回喂给 agent。
 * 可选的每选项预览文本（如 ASCII mockup）渲染在选项下方便于并排比较。
 */
export default function QuestionDialog() {
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const answerQuestion = useChatStore((s) => s.answerQuestion)
  // Parallel conversations: only the active session's question is shown —
  // switching to the owning session reveals it again.
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // The confirm gate (questionGate === 'confirm'/'dismissed') keeps the card
  // hidden until the user arms it via the QuestionConfirmBar — questions that
  // fired while the user was on another session must not pop up unannounced.
  const questionGate = useChatStore((s) => s.questionGate)
  const [customAnswer, setCustomAnswer] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const t = useI18n()

  // Reset per-question state whenever a new question arrives
  useEffect(() => {
    setSelected(new Set())
    setCustomAnswer('')
  }, [pendingQuestion?.id])

  if (!pendingQuestion || pendingQuestion.sessionId !== activeSessionId) return null
  // Only explicit 'confirm'/'dismissed' block the card (until the user arms it
  // via the QuestionConfirmBar) — any other value, including undefined from a
  // question set without a gate, must still show or the loop would hang.
  const gate = questionGate[pendingQuestion.sessionId]
  if (gate === 'confirm' || gate === 'dismissed') return null

  const options = pendingQuestion.options || []
  const previews = pendingQuestion.preview || []
  const multiSelect = pendingQuestion.multiSelect === true

  const submit = (answer: string) => {
    setCustomAnswer('')
    answerQuestion(answer)
  }

  const toggleSelected = (i: number) => {
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
      className="shrink-0 animate-fade-in bg-nova-surface border border-nova-border rounded-xl overflow-hidden shadow-sm"
    >
      {/* 头部：❓ + 标题 + 可多选徽标 */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-nova-border bg-nova-hover/50">
        <MSIcon name="help" className="text-[18px] leading-none text-nova-accent shrink-0" />
        <span className="text-[13px] font-semibold text-nova-text-primary">{t('chat.askUserTitle')}</span>
        {multiSelect && options.length > 0 && (
          <span className="ml-auto text-[11px] px-2 py-0.5 rounded bg-nova-accent/5 text-nova-accent border border-nova-accent/10">
            {t('chat.askMultiSelectHint')}
          </span>
        )}
      </div>

      {/* 正文：问题 + 选项列表 */}
      <div className="px-4 py-3 flex flex-col gap-3">
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

      {/* 操作条：自定义回答输入 + 跳过 / 发送 */}
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
              onChange={(e) => setCustomAnswer(e.target.value)}
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
    </div>
  )
}
