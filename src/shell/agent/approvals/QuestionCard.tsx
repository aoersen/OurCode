/**
 * 澄清提问卡（ask_user_question）。
 *
 * 解剖：标题行 → 问题正文 → 选项行（单选：点即答；多选：勾选 + 提交）→
 * 自由文本行 → 跳过。选中态只用 ink：文字变墨色 + 一个小 ink 对勾 + 边框转墨色，
 * 不引入任何强调色（纯风不允许彩色 chip）。
 *
 * 门控（questionGate）：问题在别的会话里产生时先进 'confirm' 门，这里改由
 * `QuestionConfirmBar` 那一条确认门槛条呈现（查看问题 / 稍后），用户点开后才
 * 放出这张卡；'dismissed' = 用户选了稍后。
 */
import { useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import DecisionCard from './DecisionCard'
import { CheckGlyph } from '../run/glyphs'
import {
  QUESTION_ACTION,
  SKIP_ANSWER,
  composeAnswer,
  questionView,
} from './approvalModel'

interface QuestionUiState {
  key: string
  selected: number[]
  freeText: string
}

const EMPTY_STATE: QuestionUiState = { key: '', selected: [], freeText: '' }

export default function QuestionCard() {
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const answerQuestion = useChatStore((s) => s.answerQuestion)
  const pauseQuestionTimeout = useChatStore((s) => s.pauseQuestionTimeout)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const questionGate = useChatStore((s) => s.questionGate)
  const [ui, setUi] = useState<QuestionUiState>(EMPTY_STATE)

  // 新问题到达时清空上一题的勾选与草稿
  const current = pendingQuestion && ui.key === pendingQuestion.id ? ui : EMPTY_STATE

  if (!pendingQuestion || pendingQuestion.sessionId !== activeSessionId) return null
  const gate = questionGate[pendingQuestion.sessionId]
  if (gate === 'confirm' || gate === 'dismissed') return null

  const view = questionView(pendingQuestion)
  const question = pendingQuestion

  const patch = (next: Partial<Omit<QuestionUiState, 'key'>>) => {
    setUi((prev) => {
      const base = prev.key === question.id ? prev : EMPTY_STATE
      return { ...base, ...next, key: question.id }
    })
  }

  const submit = (answer: string) => {
    setUi(EMPTY_STATE)
    answerQuestion(answer)
  }

  /** 悬停/任何交互：停掉 store 的提问自动继续计时（ZCode 行为）。 */
  const stopCountdown = () => pauseQuestionTimeout(question.sessionId)

  const toggleOption = (index: number) => {
    stopCountdown()
    const has = current.selected.includes(index)
    patch({ selected: has ? current.selected.filter((i) => i !== index) : [...current.selected, index] })
  }

  const pickOption = (index: number) => {
    stopCountdown()
    submit(composeAnswer(question, [index], ''))
  }

  const submitSelection = () => {
    // 多选提交只提交勾中的选项；自由文本走旁边的「发送」（免得两种输入互相吞）
    const answer = composeAnswer(question, current.selected, '')
    submit(answer || current.freeText.trim() || SKIP_ANSWER)
  }

  const submitFreeText = () => {
    const text = current.freeText.trim()
    if (!text) return
    submit(text)
  }

  const handleAction = (actionId: string) => {
    switch (actionId) {
      case QUESTION_ACTION.submit:
        submitSelection()
        return
      case QUESTION_ACTION.skip:
        submit(SKIP_ANSWER)
        return
      default:
        return
    }
  }

  const canSubmitSelection = current.selected.length > 0 || current.freeText.trim().length > 0
  const actions = view.actions.map((action) =>
    action.id === QUESTION_ACTION.submit ? { ...action, disabled: !canSubmitSelection } : action,
  )

  return (
    <div onMouseEnter={stopCountdown}>
      <DecisionCard
        testId="question-card"
        ariaLabel={view.ariaLabel}
        title="AI 需要你确认一件事"
        meta={
          view.multiSelect ? (
            <span className="text-[var(--pure-muted)]">可多选</span>
          ) : undefined
        }
        actions={actions}
        onAction={handleAction}
        primaryActionId={view.multiSelect ? QUESTION_ACTION.submit : undefined}
        rejectActionId={QUESTION_ACTION.skip}
      >
        <div className="flex flex-col gap-2">
          <p className="text-[13px] leading-[21px] whitespace-pre-wrap text-[var(--pure-ink)]">
            {view.question}
          </p>

          {view.options.length > 0 ? (
            <div className="flex flex-col gap-1" role={view.multiSelect ? 'group' : undefined}>
              {view.options.map((option) => {
                const selected = current.selected.includes(option.index)
                return (
                  <div key={option.index} className="flex flex-col">
                    <button
                      type="button"
                      aria-pressed={view.multiSelect ? selected : undefined}
                      aria-label={
                        view.multiSelect ? `选择「${option.label}」` : `用「${option.label}」回答`
                      }
                      onClick={() => (view.multiSelect ? toggleOption(option.index) : pickOption(option.index))}
                      className={`pure-focus flex w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-[12.5px] leading-[20px] transition-colors ${
                        selected
                          ? 'border-[var(--pure-ink)] bg-[var(--pure-canvas)] text-[var(--pure-ink)]'
                          : 'border-[var(--pure-border)] bg-[var(--pure-code)] text-[var(--pure-secondary)] hover:text-[var(--pure-ink)]'
                      }`}
                    >
                      {view.multiSelect ? (
                        <span aria-hidden className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                          {selected ? <CheckGlyph className="h-3 w-3" /> : null}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate" title={option.label}>
                        {option.label}
                      </span>
                    </button>
                    {option.preview ? (
                      <pre className="mx-3 mt-1 mb-0.5 max-h-24 overflow-auto pure-scroll rounded bg-[var(--pure-code)] px-2 py-1 font-mono text-[11px] leading-[17px] text-[var(--pure-muted)]">
                        {option.preview}
                      </pre>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}

          {/* 自由文本行：给单选也留着（模型给的选项常常不合适） */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={current.freeText}
              aria-label="自定义回答"
              placeholder={view.freeTextPlaceholder}
              onChange={(e) => {
                stopCountdown()
                patch({ freeText: e.target.value })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submitFreeText()
                }
              }}
              className="min-w-0 flex-1 rounded-lg border border-[var(--pure-border)] bg-[var(--pure-canvas)] px-2.5 py-1.5 text-[12.5px] leading-[18px] text-[var(--pure-ink)] outline-none placeholder:text-[var(--pure-muted)] focus:border-[var(--pure-ink)]"
            />
            <button
              type="button"
              aria-label="发送自定义回答"
              onClick={submitFreeText}
              disabled={!current.freeText.trim()}
              className="pure-focus shrink-0 rounded-lg bg-[var(--pure-ink)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--pure-canvas)] transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              发送
            </button>
          </div>
        </div>
      </DecisionCard>
    </div>
  )
}

/**
 * 确认门槛条：问题是在别的会话里产生的 → 不直接弹卡，先在当前会话给一条
 * 「AI 有不确定的地方」的窄条；点「立即处理」才放出真正的提问卡。
 * 复用同一套卡片解剖（无独立弹窗）。
 */
export function QuestionConfirmBar() {
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const questionGate = useChatStore((s) => s.questionGate)
  const setQuestionGate = useChatStore((s) => s.setQuestionGate)

  if (!activeSessionId || pendingQuestion?.sessionId !== activeSessionId) return null
  if (questionGate[activeSessionId] !== 'confirm') return null

  return (
    <DecisionCard
      testId="question-gate-bar"
      ariaLabel="待确认的提问"
      title="AI 有不确定的地方，是否立即处理？"
      description={pendingQuestion.question}
      actions={[
        {
          id: 'question-gate:open',
          label: '查看问题',
          ariaLabel: '查看并回答这个问题',
          tone: 'primary',
        },
        {
          id: 'question-gate:later',
          label: '稍后',
          ariaLabel: '稍后再处理这个问题',
          tone: 'plain',
        },
      ]}
      onAction={(actionId) => {
        if (actionId === 'question-gate:open') setQuestionGate(activeSessionId, 'auto')
        else if (actionId === 'question-gate:later') setQuestionGate(activeSessionId, 'dismissed')
      }}
      primaryActionId="question-gate:open"
      rejectActionId="question-gate:later"
    />
  )
}
