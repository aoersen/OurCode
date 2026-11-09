/**
 * 模型浮层（设计稿 `detail-03-model-picker`）。
 *
 * 结构（宽 420px、12px 圆角、12px 内边距、向上展开）：
 *   搜索胶囊（无描边、`--pure-hover` 底）→ 收藏行（纯文字）→ 模型行 44px
 *   （14px 名字 + 12px muted 能力行；当前模型右侧 ink 勾 + 本次已用 N%）
 *   → 思考档位分段控件（关 · 低 · 中 · 高 · 最高，当前项 ink + 细下划线）
 *
 * 数字口径不另起一套：能力行的上下文容量用 `formatTokenCount`，本次已用
 * 直接用 `useComposer` 已经算好的 `ContextUsage`（和胶囊右下角的细环同源）。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore, setLastModelForGroup } from '@/stores/configStore'
import { useI18n } from '@/i18n/useI18n'
import { resolveThinkingLevel, type ThinkingLevel } from '@/types'
import type { ContextUsage } from '@/services/llm/contextUsage'
import { copyFor, usedThisChatText } from './copy'
import { useMenuLocale } from './locale'
import { useMenuKeyboard } from './menuNav'
import {
  capabilityTags,
  effectiveThinkingLevel,
  favoriteNames,
  filterModels,
  modelName,
  stepThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelsFor,
} from './modelMenu'
import { Check, Chevron, Popover, useOutsideClose } from './primitives'

export interface ModelPickerProps {
  /** 与 ContextMeter 同源的用量；只用于「当前模型行」的本次已用 N% */
  contextUsage?: ContextUsage | null
}

export function ModelPicker({ contextUsage = null }: ModelPickerProps) {
  const t = useI18n()
  const locale = useMenuLocale()
  const copy = copyFor(locale)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const models = useConfigStore((s) => s.models)
  const groups = useConfigStore((s) => s.configGroups)
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const customModels = useConfigStore((s) => s.customModels)
  const favoriteModelIds = useConfigStore((s) => s.favoriteModelIds)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const session = useChatStore((s) =>
    s.activeSessionId ? (s.sessions.find((x) => x.id === s.activeSessionId) ?? null) : null,
  )
  const updateSessionModel = useChatStore((s) => s.updateSessionModel)
  const updateSessionParams = useChatStore((s) => s.updateSessionParams)

  const sessionGroup = groups.find((g) => g.id === session?.configGroupId)
  const currentModel =
    session?.model ||
    sessionGroup?.defaultModel ||
    groups.find((g) => g.id === activeConfigGroupId)?.defaultModel ||
    ''
  const label =
    models.find((m) => m.id === currentModel)?.alias ||
    (currentModel ? modelName({ id: currentModel }) : t('chat.modelFallback'))

  const filtered = useMemo(() => filterModels(models, query), [models, query])
  const favorites = useMemo(
    () => favoriteNames(models, favoriteModelIds),
    [favoriteModelIds, models],
  )
  const currentIndex = Math.max(
    0,
    filtered.findIndex((m) => m.id === currentModel),
  )

  const levels = useMemo(
    () => thinkingLevelsFor(currentModel, customModels),
    [currentModel, customModels],
  )
  const thinking = effectiveThinkingLevel(
    levels,
    session ? resolveThinkingLevel(session.modelParams) : 'off',
  )

  const usagePercent =
    contextUsage && contextUsage.used > 0 && contextUsage.percent > 0 ? contextUsage.percent : null

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const ref = useOutsideClose(open, close)

  const pick = useCallback(
    (modelId: string) => {
      close()
      if (activeConfigGroupId) setLastModelForGroup(activeConfigGroupId, modelId)
      if (activeSessionId) updateSessionModel(activeSessionId, modelId, activeConfigGroupId || undefined)
    },
    [activeConfigGroupId, activeSessionId, close, updateSessionModel],
  )

  const setLevel = useCallback(
    (level: ThinkingLevel) => {
      if (activeSessionId) updateSessionParams(activeSessionId, { thinkingLevel: level })
    },
    [activeSessionId, updateSessionParams],
  )

  const onLevelStep = useCallback(
    (direction: 1 | -1) => setLevel(stepThinkingLevel(levels, thinking, direction)),
    [levels, setLevel, thinking],
  )

  const kb = useMenuKeyboard({
    count: filtered.length,
    initialIndex: currentIndex,
    resetKey: `${open}:${query}`,
    onSelect: (index) => {
      const target = filtered[index]
      if (target) pick(target.id)
    },
    onClose: close,
    onLevelStep: activeSessionId && levels.length > 0 ? onLevelStep : undefined,
  })

  // 每次打开都从干净搜索开始，并把焦点放进搜索框：直接打字过滤，↑/↓ 接管移动
  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          // 重新打开时不带上一次的搜索词，避免「明明有模型却看到空结果」
          if (!open) setQuery('')
          setOpen((v) => !v)
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={currentModel || t('chat.modelFallback')}
        className="h-7 max-w-[220px] px-1.5 rounded-lg flex items-center gap-1 text-[13px] text-[var(--pure-secondary)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] transition-colors"
      >
        <span className="truncate">{label}</span>
        <Chevron open={open} />
      </button>

      {open && (
        <Popover
          width="w-[420px] max-w-[calc(100vw-24px)]"
          label={copy.modelDialog}
          padded
          maxHeightClass="max-h-[420px]"
        >
          <div tabIndex={-1} onKeyDown={kb.onKeyDown} className="outline-none">
            {/* 搜索胶囊：无描边，靠 --pure-hover 底表示可输入 */}
            <div className="flex items-center gap-1.5 h-8 rounded-full bg-[var(--pure-hover)] px-3">
              <svg
                className="w-3.5 h-3.5 shrink-0 text-[var(--pure-muted)]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={copy.searchModels}
                aria-label={copy.searchModels}
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent border-0 outline-none text-[12.5px] text-[var(--pure-ink)] placeholder:text-[var(--pure-muted)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={copy.clearSearch}
                  className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)]"
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              )}
            </div>

            {/* 收藏行：纯文字，当前模型用 ink，其余 muted */}
            {favorites.length > 0 && (
              <div className="mt-2 flex items-baseline gap-1.5 text-[12px] leading-[16px]">
                <span className="shrink-0 text-[var(--pure-muted)]">{copy.favoritesLabel}</span>
                {favorites.map((name, index) => (
                  <span key={name} className="min-w-0 flex items-center gap-1.5 truncate">
                    <span
                      className={
                        name === label
                          ? 'text-[var(--pure-ink)]'
                          : 'text-[var(--pure-secondary)]'
                      }
                    >
                      {name}
                    </span>
                    {index < favorites.length - 1 && (
                      <span aria-hidden className="text-[11px] text-[var(--pure-muted)]">
                        ·
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-1.5">
              {models.length === 0 ? (
                <div className="px-2 py-2 text-[12px] leading-[18px] text-[var(--pure-muted)]">
                  {currentModel ? (
                    <>
                      当前会话模型 · <span className="text-[var(--pure-ink)]">{label}</span>
                      <span className="block">设置里还没有拉到模型列表，去「设置 → API」刷新一次。</span>
                    </>
                  ) : (
                    copy.noModels
                  )}
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-2 py-2 text-[12px] leading-[18px] text-[var(--pure-muted)]">
                  {copy.emptySearch}
                </div>
              ) : (
                <ul>
                  {filtered.map((m, index) => {
                    const isCurrent = m.id === currentModel
                    const highlighted = index === kb.index
                    const tags = capabilityTags(m, locale)
                    return (
                      <li key={m.id}>
                        <button
                          ref={kb.rowRef(index)}
                          type="button"
                          onClick={() => pick(m.id)}
                          onMouseEnter={() => kb.setIndex(index)}
                          aria-current={isCurrent ? 'true' : undefined}
                          title={m.id}
                          className={`w-full h-[44px] px-2 rounded-[10px] flex items-center gap-2 text-left transition-colors ${
                            highlighted ? 'bg-[var(--pure-hover)]' : 'hover:bg-[var(--pure-hover)]'
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] leading-[19px] text-[var(--pure-ink)]">
                              {modelName(m)}
                            </span>
                            {tags.length > 0 && (
                              <span className="block truncate text-[12px] leading-[16px] text-[var(--pure-muted)]">
                                {tags.join(' · ')}
                              </span>
                            )}
                          </span>
                          {isCurrent && usagePercent !== null && (
                            <span className="shrink-0 text-[11px] tabular-nums text-[var(--pure-muted)]">
                              {usedThisChatText(locale, usagePercent)}
                            </span>
                          )}
                          {isCurrent && <Check />}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            {/* 思考档位：只列当前模型真正支持的档 */}
            {activeSessionId && levels.length > 0 && (
              <div className="mt-3">
                <div className="px-2 text-[12px] leading-[16px] text-[var(--pure-muted)]">
                  {copy.thinkingLabel}
                </div>
                <div
                  role="group"
                  aria-label={copy.thinkingLabel}
                  className="mt-1 px-2 flex items-center gap-1.5"
                >
                  {levels.map((level, index) => {
                    const active = level === thinking
                    return (
                      <Fragment key={level}>
                        {index > 0 && (
                          <span aria-hidden className="text-[11px] text-[var(--pure-muted)]">
                            ·
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setLevel(level)}
                          aria-pressed={active}
                          className={`text-[12px] leading-[18px] transition-colors ${
                            active
                              ? 'text-[var(--pure-ink)] underline decoration-[var(--pure-ink)] decoration-1 underline-offset-[5px]'
                              : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
                          }`}
                        >
                          {thinkingLevelLabel(level, locale)}
                        </button>
                      </Fragment>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </Popover>
      )}
    </div>
  )
}

export default ModelPicker
