/**
 * The welcome composer.
 *
 * Deliberately narrower than the chat panel's composer: it only carries what
 * matters before a session exists — the goal itself, which model will answer,
 * and the two input tokens (@ / /). Attachments, mode switching and queueing
 * all live in the real composer once the conversation starts, so repeating them
 * here would be a second, weaker control for the same thing.
 */
import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n/useI18n'
import { isComposingEvent } from '@/utils/composition'
import { ArrowUpIcon } from './WelcomeIcons'

interface WelcomeComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** Model label ("DeepSeek · deepseek-chat") or '' when nothing is configured. */
  modelLabel: string
  modelConfigured: boolean
  onConfigureModel: () => void
  autoFocus?: boolean
}

const MAX_HEIGHT = 160

export default function WelcomeComposer({
  value,
  onChange,
  onSubmit,
  modelLabel,
  modelConfigured,
  onConfigureModel,
  autoFocus = false,
}: WelcomeComposerProps) {
  const t = useI18n()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Grow with content, then scroll. Runs on every value change so a sent
  // message collapses the box back to one line.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (pinyin candidates) must never be treated as "send".
    if (isComposingEvent(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  const insertToken = (token: string) => {
    onChange(value ? `${value}${value.endsWith(' ') ? '' : ' '}${token}` : token)
    textareaRef.current?.focus()
  }

  const canSend = value.trim().length > 0 && modelConfigured

  return (
    <div className="chat-input-box rounded-2xl">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        data-ai-input
        placeholder={t('welcome.composer.placeholder')}
        aria-label={t('welcome.composer.placeholder')}
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[13.5px] leading-relaxed text-nova-text-primary placeholder:text-nova-text-muted outline-none"
        style={{ maxHeight: MAX_HEIGHT }}
      />

      <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
        <button
          type="button"
          onClick={onConfigureModel}
          title={modelConfigured ? t('welcome.env.settings') : t('welcome.notice.configure')}
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11.5px] transition-colors ${
            modelConfigured
              ? 'border-nova-border text-nova-text-secondary hover:border-nova-accent/50 hover:text-nova-text-primary'
              : 'border-orange-500/40 text-orange-500 hover:border-orange-500/70'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${modelConfigured ? 'bg-emerald-500' : 'bg-orange-500'}`}
            aria-hidden
          />
          <span className="max-w-[220px] truncate">
            {modelConfigured ? modelLabel : t('welcome.env.modelMissing')}
          </span>
          <svg viewBox="0 0 16 16" className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M4 6.5L8 10.5l4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => insertToken('@')}
          className="h-7 w-7 rounded-md border border-nova-border text-[11.5px] font-mono text-nova-text-muted hover:text-nova-text-primary hover:border-nova-accent/50 transition-colors"
          title={t('welcome.composer.atHint')}
        >
          @
        </button>
        <button
          type="button"
          onClick={() => insertToken('/')}
          className="h-7 w-7 rounded-md border border-nova-border text-[11.5px] font-mono text-nova-text-muted hover:text-nova-text-primary hover:border-nova-accent/50 transition-colors"
          title={t('welcome.composer.slashHint')}
        >
          /
        </button>

        <span className="flex-1" />

        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label={t('welcome.composer.send')}
          className="w-8 h-8 rounded-full grid place-items-center text-white transition-all bg-nova-accent hover:brightness-110 disabled:bg-nova-hover disabled:text-nova-text-muted disabled:cursor-not-allowed"
        >
          <ArrowUpIcon />
        </button>
      </div>
    </div>
  )
}
