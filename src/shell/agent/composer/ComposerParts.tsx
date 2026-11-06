/**
 * composer 胶囊里的三个小控件：附件菜单、模型选择、权限模式选择、上下文计量。
 *
 * 视觉契约（`.stitch/designs/pure-01b-empty-2.png` / `pure-02b-running.png`）：
 * 全是「纯文字 + chevron」或图标按钮，没有描边胶囊、没有彩色 chip；浮层是唯一
 * 允许阴影的地方之一。所有颜色走 `var(--pure-*)`，不出现任何 hex，也不写内联 style。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ContextUsageRing from '@/components/Common/ContextUsageRing'
import ContextBreakdownPopover from '@/components/ChatPanel/ContextBreakdownPopover'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore, setLastModelForGroup } from '@/stores/configStore'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'
import type { EditMode } from '@/services/permissions/modePolicy'
import type { ContextUsage } from '@/services/llm/contextUsage'
import { formatTokenCount } from '@/services/llm/contextUsage'

/** 点击外部 / Esc 关闭浮层：ref 同时包住触发器和面板，避免 toggle 与 outside 打架 */
function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [close, open])
  return ref
}

function Chevron({ open }: { open?: boolean }) {
  return (
    <svg
      className={`w-3 h-3 shrink-0 text-[var(--pure-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function Check() {
  return (
    <svg
      className="w-3.5 h-3.5 shrink-0 text-[var(--pure-ink)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 13l5 5L20 6" />
    </svg>
  )
}

/** 浮层外壳：唯一阴影 + 12px 圆角，向上展开（composer 永远贴底） */
export function Popover({ children, width }: { children: ReactNode; width: string }) {
  return (
    <div
      role="menu"
      className={`absolute bottom-full left-0 mb-2 z-50 ${width} rounded-xl border border-[var(--pure-border)] bg-[var(--surface)] pure-card-shadow py-1 overflow-y-auto pure-scroll max-h-[320px]`}
    >
      {children}
    </div>
  )
}

function MenuRow({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean
  onClick: () => void
  children: ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors ${
        active
          ? 'text-[var(--pure-ink)] bg-[var(--pure-hover)]'
          : 'text-[var(--pure-secondary)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]'
      }`}
    >
      {children}
    </button>
  )
}

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
  const ref = useOutsideClose(open, () => setOpen(false))

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
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
        <Popover width="w-[224px]">
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

/** 没有 alias 时把模型 id 变回可读名：claude-sonnet-4-5 → Claude Sonnet 4.5 */
export function prettyModelId(id: string): string {
  const parts = id.split(/[-_/]+/).filter(Boolean)
  const words: string[] = []
  for (const raw of parts) {
    if (/^\d+$/.test(raw) && words.length > 0 && /(^|\.)\d+$/.test(words[words.length - 1])) {
      words[words.length - 1] += '.' + raw
      continue
    }
    words.push(/^\d/.test(raw) ? raw : raw.charAt(0).toUpperCase() + raw.slice(1))
  }
  return words.join(' ') || id
}

// ── 模型选择（纯文字 + chevron）────────────────────────────────
export function ModelPicker() {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(open, () => setOpen(false))
  const t = useI18n()

  const models = useConfigStore((s) => s.models)
  const groups = useConfigStore((s) => s.configGroups)
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const session = useChatStore((s) =>
    s.activeSessionId ? (s.sessions.find((x) => x.id === s.activeSessionId) ?? null) : null,
  )
  const updateSessionModel = useChatStore((s) => s.updateSessionModel)

  const sessionGroup = groups.find((g) => g.id === session?.configGroupId)
  const currentModel =
    session?.model ||
    sessionGroup?.defaultModel ||
    groups.find((g) => g.id === activeConfigGroupId)?.defaultModel ||
    ''
  const label = models.find((m) => m.id === currentModel)?.alias
    || (currentModel ? prettyModelId(currentModel) : t('chat.modelFallback'))

  const pick = (modelId: string) => {
    setOpen(false)
    if (activeConfigGroupId) setLastModelForGroup(activeConfigGroupId, modelId)
    if (activeSessionId) updateSessionModel(activeSessionId, modelId, activeConfigGroupId || undefined)
  }

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={currentModel || t('chat.modelFallback')}
        className="h-7 max-w-[220px] px-1.5 rounded-lg flex items-center gap-1 text-[13px] text-[var(--pure-secondary)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
      >
        <span className="truncate">{label}</span>
        <Chevron open={open} />
      </button>

      {open && (
        <Popover width="w-[296px]">
          {models.length === 0 ? (
            <div className="px-3 py-2 text-[12px] leading-[18px] text-[var(--pure-muted)]">
              {t('chat.modelPickerEmpty')}
            </div>
          ) : (
            models.map((m) => (
              <MenuRow
                key={m.id}
                active={m.id === currentModel}
                onClick={() => pick(m.id)}
                title={m.id}
              >
                <span className="min-w-0 flex-1 truncate">{m.alias || m.id}</span>
                {m.id === currentModel && <Check />}
              </MenuRow>
            ))
          )}
        </Popover>
      )}
    </div>
  )
}

// ── 权限模式（纯文字 + chevron）────────────────────────────────
const MODE_ITEMS: Array<{ mode: EditMode; labelKey: TranslationKey; hintKey: TranslationKey }> = [
  { mode: 'confirm_before_change', labelKey: 'chat.projectEditModeConfirm', hintKey: 'chat.projectEditModeConfirmHint' },
  { mode: 'auto_edit', labelKey: 'chat.projectEditModeAuto', hintKey: 'chat.projectEditModeAutoHint' },
  { mode: 'plan', labelKey: 'chat.projectEditModePlan', hintKey: 'chat.projectEditModePlanHint' },
  { mode: 'guarded', labelKey: 'chat.projectEditModeGuarded', hintKey: 'chat.projectEditModeGuardedHint' },
  { mode: 'yolo', labelKey: 'chat.projectEditModeFull', hintKey: 'chat.projectEditModeFullHint' },
]

export function ModePicker() {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(open, () => setOpen(false))
  const t = useI18n()

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const session = useChatStore((s) =>
    s.activeSessionId ? (s.sessions.find((x) => x.id === s.activeSessionId) ?? null) : null,
  )
  const setProjectEditMode = useChatStore((s) => s.setProjectEditMode)

  const current = (session?.projectEditMode ?? 'confirm_before_change') as EditMode
  const targetMode = session?.targetMode === true
  const items = targetMode
    ? MODE_ITEMS.filter((i) => i.mode === 'confirm_before_change' || i.mode === 'guarded')
    : MODE_ITEMS
  const currentItem = items.find((i) => i.mode === current) ?? items[0]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('chat.projectEditModeLabel')}
        className="h-7 px-1.5 rounded-lg flex items-center gap-1 text-[13px] text-[var(--pure-secondary)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
      >
        <span className="truncate max-w-[120px]">{t(currentItem.labelKey)}</span>
        <Chevron open={open} />
      </button>

      {open && (
        <Popover width="w-[300px]">
          {items.map((item) => (
            <MenuRow
              key={item.mode}
              active={item.mode === current}
              onClick={() => {
                setOpen(false)
                if (activeSessionId) setProjectEditMode(activeSessionId, item.mode)
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{t(item.labelKey)}</span>
                <span className="block text-[11px] leading-[16px] text-[var(--pure-muted)] truncate">
                  {t(item.hintKey)}
                </span>
              </span>
              {item.mode === current && <Check />}
            </MenuRow>
          ))}
          <div className="px-3 pt-1.5 pb-1 text-[11px] text-[var(--pure-muted)]">
            {t('chat.modeSwitchHint')}
          </div>
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
