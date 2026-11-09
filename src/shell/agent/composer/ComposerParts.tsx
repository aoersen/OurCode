/**
 * composer 胶囊里的控件：附件菜单、上下文计量。
 *
 * 模型选择器与权限模式选择器已经升级成完整浮层，各自独立在 `menus/` 下；
 * 这里保留同名导出（`ModelPicker` / `ModePicker` / `Popover` / `prettyModelId`），
 * 既有 import 路径不变。
 *
 * 视觉契约：全是「纯文字 + chevron」或图标按钮，没有描边胶囊、没有彩色 chip；
 * 浮层是唯一允许阴影的地方之一。所有颜色走 `var(--pure-*)`，不出现任何 hex，
 * 也不写内联 style。
 */
import { useState } from 'react'
import ContextUsageRing from '@/components/Common/ContextUsageRing'
import ContextBreakdownPopover from '@/components/ChatPanel/ContextBreakdownPopover'
import { useI18n } from '@/i18n/useI18n'
import type { ContextUsage } from '@/services/llm/contextUsage'
import { formatTokenCount } from '@/services/llm/contextUsage'
import { copyFor } from './menus/copy'
import { useMenuLocale } from './menus/locale'
import { MenuRow, Popover, useOutsideClose } from './menus/primitives'

// 稳定的公开出口（其他文件/后续改动按这些名字取用）
export { Popover } from './menus/primitives'
export { ModelPicker } from './menus/ModelPicker'
export { ModePicker } from './menus/ModePicker'
export { prettyModelId } from './menus/modelMenu'

// ── 附件菜单（+）──────────────────────────────────────────────
export interface AttachmentMenuProps {
  onPickFile: () => void
  onPickImages: () => void
  onVoice: () => void
  listening: boolean
  voiceBusy: boolean
}

export function AttachmentMenu({
  onPickFile,
  onPickImages,
  onVoice,
  listening,
  voiceBusy,
}: AttachmentMenuProps) {
  const [open, setOpen] = useState(false)
  const t = useI18n()
  const copy = copyFor(useMenuLocale())
  const ref = useOutsideClose(open, () => setOpen(false))

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('chat.addAttachment')}
        title={t('chat.addAttachment')}
        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
          listening
            ? 'text-[var(--pure-danger)]'
            : 'text-[var(--pure-secondary)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]'
        }`}
      >
        {listening ? (
          <svg className="w-3.5 h-3.5 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
          </svg>
        ) : (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
      </button>

      {open && (
        <Popover width="w-[224px]" label={copy.attachmentDialog}>
          <MenuRow
            onClick={() => {
              setOpen(false)
              onPickFile()
            }}
          >
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            {t('chat.addFile')}
          </MenuRow>
          <MenuRow
            onClick={() => {
              setOpen(false)
              onPickImages()
            }}
          >
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            {t('chat.attachImage')}
          </MenuRow>
          <MenuRow
            onClick={() => {
              setOpen(false)
              onVoice()
            }}
            title={listening ? t('chat.voiceRecording') : t('chat.voiceInput')}
          >
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
            </svg>
            {listening
              ? t('chat.voiceRecording')
              : voiceBusy
                ? t('chat.voiceTranscribing')
                : t('chat.voiceInput')}
          </MenuRow>
        </Popover>
      )}
    </div>
  )
}

// ── 上下文计量（细环 + 11px 灰字）──────────────────────────────
export function ContextMeter({ usage }: { usage: ContextUsage | null }) {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(open, () => setOpen(false))
  const t = useI18n()

  if (!usage || usage.used <= 0 || usage.percent <= 0) return null

  const tone =
    usage.level === 'critical'
      ? 'text-[var(--pure-danger)]'
      : usage.level === 'warning'
        ? 'text-[var(--warning)]'
        : 'text-[var(--pure-muted)]'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('context.usage.aria', {
          percent: usage.percent,
          used: usage.used.toLocaleString(),
          window: usage.window.toLocaleString(),
        })}
        title={`${t('context.usage.tip')} · ${formatTokenCount(usage.used)} / ${formatTokenCount(usage.window)}`}
        className={`h-7 px-1.5 rounded-full flex items-center gap-1 text-[11px] tabular-nums transition-colors hover:bg-[var(--pure-hover)] ${tone}`}
      >
        <ContextUsageRing percent={usage.percent} level={usage.level} size={12} stroke={1.5} />
        <span>{usage.percent}%</span>
      </button>
      {open && (
        <ContextBreakdownPopover
          usage={usage}
          placement="above"
          align="right"
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
