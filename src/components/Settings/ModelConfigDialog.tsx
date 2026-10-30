import { useEffect, useRef, useState } from 'react'
import type { ApiConfigGroup, CustomModel } from '@/types'
import {
  getCatalogModel, type ModelCapability, type ModelModality, type ReasoningLevel,
} from '@shared/modelCatalog'

/**
 * Model config editor — the per-model counterpart of a provider config.
 *
 * Values saved here take precedence over the generated vendor catalog and the
 * curated table: context window drives trimming/compaction, max output becomes
 * the default cap, reasoning levels filter the chat thinking menu, and the
 * reasoning mapping is merged into the request body per level.
 */

const MODALITY_OPTIONS: Array<{ value: ModelModality; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'video', label: '视频' },
  { value: 'pdf', label: 'PDF' },
]

const OUTPUT_OPTIONS: Array<{ value: ModelModality; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'video', label: '视频' },
]

const CAPABILITY_OPTIONS: Array<{ value: ModelCapability; label: string; hint: string }> = [
  { value: 'structured_output', label: '结构化输出', hint: '支持 JSON Schema / JSON mode' },
  { value: 'web_search', label: '原生联网搜索', hint: '由厂商侧执行联网检索' },
  { value: 'system_messages', label: '对话中系统消息', hint: '允许在对话中途插入 system 角色' },
  { value: 'tool_call', label: '工具调用', hint: 'Function calling / tool use' },
  { value: 'streaming', label: '流式输出', hint: 'SSE 流式返回' },
]

const REASONING_OPTIONS: Array<{ value: ReasoningLevel; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' },
]

const ALL_LEVELS: ReasoningLevel[] = REASONING_OPTIONS.map((o) => o.value)

const MAP_PLACEHOLDER = `{
  "off":  {},
  "low":  { "reasoning_effort": "low" },
  "high": { "reasoning_effort": "high" }
}`

const MODALITY_LABELS: Record<ModelModality, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  pdf: 'PDF',
}

function formatTokens(value?: number): string {
  if (!value || value <= 0) return '—'
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** Empty string is valid (no mapping); anything else must be level → object. */
function validateReasoningMap(text: string): string | null {
  const raw = text.trim()
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return '推理参数映射不是合法 JSON'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '推理参数映射必须是 JSON 对象'
  for (const [level, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (level !== 'disabled' && !ALL_LEVELS.includes(level as ReasoningLevel)) {
      return `未知的推理等级「${level}」，可用值：${ALL_LEVELS.join(' / ')}（或 disabled）`
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return `等级「${level}」的映射值必须是 JSON 对象`
    }
  }
  return null
}

export interface ModelConfigDialogProps {
  provider: ApiConfigGroup['provider']
  /** Existing custom model config; omitted when adding a new model. */
  initial?: CustomModel | null
  /** Pre-filled id when adding from the quick-add input. */
  seedModelId?: string
  /** Ids already saved as custom models (for the overwrite warning). */
  existingCustomIds?: string[]
  onSave: (model: CustomModel, originalId?: string) => void
  onClose: () => void
}

export default function ModelConfigDialog({ provider, initial, seedModelId, existingCustomIds = [], onSave, onClose }: ModelConfigDialogProps) {
  const [smart, setSmart] = useState(!initial)
  const [modelId, setModelId] = useState(initial?.id ?? seedModelId ?? '')
  const [displayName, setDisplayName] = useState(initial?.name ?? '')
  const [contextWindow, setContextWindow] = useState(initial?.contextWindow ? String(initial.contextWindow) : '')
  const [maxOutputTokens, setMaxOutputTokens] = useState(initial?.maxOutputTokens ? String(initial.maxOutputTokens) : '')
  const [inputModalities, setInputModalities] = useState<ModelModality[]>(
    initial?.inputModalities ?? ['text'],
  )
  const [outputModalities, setOutputModalities] = useState<ModelModality[]>(
    initial?.outputModalities ?? ['text'],
  )
  const [capabilities, setCapabilities] = useState<ModelCapability[]>(
    (initial?.capabilities ?? []).filter((c) => CAPABILITY_OPTIONS.some((o) => o.value === c)),
  )
  const [reasoningLevels, setReasoningLevels] = useState<ReasoningLevel[]>(
    initial?.reasoningLevels ?? ['off'],
  )
  const [reasoningMap, setReasoningMap] = useState(initial?.reasoningParamMap ?? '')
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef<HTMLInputElement>(null)

  const matched = getCatalogModel(modelId)
  const mapError = reasoningMap.trim() ? validateReasoningMap(reasoningMap) : null

  // Renaming an existing config leaves a stale entry unless the caller drops
  // the original id; saving over another custom model replaces it silently.
  const isRename = Boolean(initial && initial.id !== modelId.trim())
  const isDuplicate = existingCustomIds.some((id) => id === modelId.trim() && id !== initial?.id)

  useEffect(() => {
    idRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // A new config opened from an API model id starts from the catalog spec.
  useEffect(() => {
    if (!initial && seedModelId?.trim()) applyCatalog(seedModelId)
    // Mount only: later id edits run applyCatalog through handleIdChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Fill the form from the catalog for `id` (only when smart config is on). */
  function applyCatalog(id: string) {
    const spec = getCatalogModel(id.trim())
    if (!spec) return
    setContextWindow(spec.contextWindow ? String(spec.contextWindow) : '')
    setMaxOutputTokens(spec.maxOutputTokens ? String(spec.maxOutputTokens) : '')
    setInputModalities(spec.inputModalities.length > 0 ? spec.inputModalities : ['text'])
    setOutputModalities(spec.outputModalities.length > 0 ? spec.outputModalities : ['text'])
    setCapabilities(spec.capabilities.filter((c) => CAPABILITY_OPTIONS.some((o) => o.value === c)))
    setReasoningLevels(spec.reasoningLevels.length > 0 ? spec.reasoningLevels : ['off'])
    setDisplayName(spec.name)
  }

  function handleIdChange(next: string) {
    setModelId(next)
    setError(null)
    if (smart) applyCatalog(next)
  }

  function handleSmartToggle(next: boolean) {
    setSmart(next)
    if (next) applyCatalog(modelId)
  }

  function handleLevelToggle(level: ReasoningLevel) {
    const next = toggle(reasoningLevels, level)
    // A model always has an "off" state; keep at least that one selectable.
    setReasoningLevels(next.length > 0 ? next : ['off'])
  }

  function handleReset() {
    setSmart(!initial)
    setModelId(initial?.id ?? seedModelId ?? '')
    setDisplayName(initial?.name ?? '')
    setContextWindow(initial?.contextWindow ? String(initial.contextWindow) : '')
    setMaxOutputTokens(initial?.maxOutputTokens ? String(initial.maxOutputTokens) : '')
    setInputModalities(initial?.inputModalities ?? ['text'])
    setOutputModalities(initial?.outputModalities ?? ['text'])
    setCapabilities((initial?.capabilities ?? []).filter((c) => CAPABILITY_OPTIONS.some((o) => o.value === c)))
    setReasoningLevels(initial?.reasoningLevels ?? ['off'])
    setReasoningMap(initial?.reasoningParamMap ?? '')
    setError(null)
    if (!initial) applyCatalog(seedModelId ?? '')
  }

  function handleSave() {
    const id = modelId.trim()
    if (!id) {
      setError('请填写模型 ID')
      idRef.current?.focus()
      return
    }
    if (mapError) {
      setError(mapError)
      return
    }
    const ctx = Number(contextWindow)
    const out = Number(maxOutputTokens)
    const checkedLevels = ALL_LEVELS.filter((l) => reasoningLevels.includes(l))
    const levels: ReasoningLevel[] = checkedLevels.length > 0 ? checkedLevels : ['off']
    const inputs = MODALITY_OPTIONS.map((o) => o.value).filter((m) => inputModalities.includes(m))
    const outputs = OUTPUT_OPTIONS.map((o) => o.value).filter((m) => outputModalities.includes(m))
    // Derive the catalog-only capability bits from the fields the user sees.
    const derived: ModelCapability[] = []
    if (levels.some((l) => l !== 'off')) derived.push('reasoning')
    if (inputs.some((m) => m !== 'text')) derived.push('attachment')
    const mergedCaps: ModelCapability[] = [
      ...CAPABILITY_OPTIONS.map((o) => o.value).filter((c) => capabilities.includes(c)),
      ...derived.filter((c) => !capabilities.includes(c)),
    ]
    onSave({
      id,
      name: displayName.trim() || matched?.name || id,
      provider,
      contextWindow: Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : undefined,
      maxOutputTokens: Number.isFinite(out) && out > 0 ? Math.floor(out) : undefined,
      inputModalities: inputs.length > 0 ? inputs : ['text'],
      outputModalities: outputs.length > 0 ? outputs : ['text'],
      capabilities: mergedCaps,
      reasoningLevels: levels,
      reasoningParamMap: reasoningMap.trim() || undefined,
      vision: inputs.includes('image'),
      functionCall: mergedCaps.includes('tool_call'),
      createdAt: initial?.createdAt ?? Date.now(),
    }, initial?.id)
  }

  const fieldClass = 'px-3 py-2 bg-nova-input-bg border border-nova-border rounded-md text-[13px] leading-[18px] text-nova-text-primary outline-none focus:border-accent-60 transition-colors font-mono'
  const chipClass = (on: boolean) => `px-2.5 py-1 rounded-md border text-[12px] leading-[18px] transition-colors ${
    on
      ? 'border-nova-accent bg-accent-10 text-accent-text'
      : 'border-nova-border bg-nova-card text-nova-text-secondary hover:border-nova-border-strong hover:text-nova-text-primary'
  }`

  return (
    <div
      className="fixed inset-0 z-[160] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-config-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="glass-modal rounded-xl shadow-2xl w-[640px] max-w-[94vw] max-h-[88vh] flex flex-col overflow-hidden" style={{ animation: 'fadeIn 0.2s ease-out' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-nova-border shrink-0">
          <div className="flex items-center gap-2.5">
            <h2 id="model-config-title" className="text-[15px] font-semibold text-nova-text-primary">编辑模型配置</h2>
            {matched && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/25">
                目录已收录
              </span>
            )}
          </div>
          <button onClick={onClose} aria-label="关闭" className="w-8 h-8 flex items-center justify-center rounded-md text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 flex flex-col gap-4">
          {/* Smart config */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] leading-[18px] font-medium text-nova-text-primary">智能配置</span>
              <span className="text-[11px] text-nova-text-muted">按模型 ID 自动填入厂商目录的上下文、输出与多模态参数</span>
            </div>
            <button
              role="switch"
              aria-checked={smart}
              aria-label="智能配置"
              onClick={() => handleSmartToggle(!smart)}
              className="w-10 h-[22px] rounded-full transition-colors relative shrink-0 border-none cursor-pointer"
              style={{ background: smart ? 'var(--accent)' : 'var(--border)' }}
            >
              <span className="w-[18px] h-[18px] rounded-full bg-white absolute top-[1px] transition-all" style={{ left: smart ? '20px' : '1px' }} />
            </button>
          </div>

          {/* Model id */}
          <div className="flex flex-col gap-1">
            <label htmlFor="model-config-id" className="text-[11px] font-medium text-nova-text-secondary">模型 ID</label>
            <input
              id="model-config-id"
              ref={idRef}
              type="text"
              value={modelId}
              onChange={(e) => handleIdChange(e.target.value)}
              placeholder="如 deepseek-flash / claude-sonnet-4-5"
              spellCheck={false}
              autoComplete="off"
              className={fieldClass}
            />
            <span className="text-[11px] text-nova-text-muted">
              {matched
                ? `${matched.name}${matched.releaseDate ? ` · ${matched.releaseDate}` : ''} · 输入 ${matched.inputModalities.map((m) => MODALITY_LABELS[m]).join('/')} · 最大输出 ${formatTokens(matched.maxOutputTokens)}`
                : modelId.trim()
                  ? '目录未收录该模型，可直接手动填写下方参数'
                  : '填写后将按目录自动匹配参数'}
            </span>
            {isRename && (
              <span className="text-[11px] text-yellow-400/90">模型 ID 已修改：保存后旧 ID 的配置将被替换</span>
            )}
            {isDuplicate && (
              <span className="text-[11px] text-yellow-400/90">已存在同名模型配置，保存将覆盖它</span>
            )}
          </div>

          {/* Context + output */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="model-config-context" className="text-[11px] font-medium text-nova-text-secondary">上下文窗口</label>
              <input
                id="model-config-context"
                type="number"
                min={0}
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder={matched?.contextWindow ? String(matched.contextWindow) : '128000'}
                className={fieldClass}
              />
              <span className="text-[11px] text-nova-text-muted">留空或 0 = 跟随目录 / 默认 128K</span>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="model-config-output" className="text-[11px] font-medium text-nova-text-secondary">最大输出 Token</label>
              <input
                id="model-config-output"
                type="number"
                min={0}
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(e.target.value)}
                placeholder={matched?.maxOutputTokens ? String(matched.maxOutputTokens) : '留空 = 厂商默认'}
                className={fieldClass}
              />
              <span className="text-[11px] text-nova-text-muted">保存后作为该模型单次回复的默认上限</span>
            </div>
          </div>

          {/* Advanced */}
          <div className="rounded-lg border border-nova-border bg-nova-card">
            <button
              onClick={() => setAdvanced(!advanced)}
              aria-expanded={advanced}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] leading-[18px] font-medium text-nova-text-secondary hover:text-nova-text-primary transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`transition-transform ${advanced ? 'rotate-90' : ''}`}><polyline points="9 18 15 12 9 6" /></svg>
              高级配置
            </button>
            {advanced && (
              <div className="flex flex-col gap-4 px-3 pb-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-nova-text-secondary">输入类型</span>
                  <div className="flex flex-wrap gap-1.5">
                    {MODALITY_OPTIONS.map((m) => (
                      <button key={m.value} onClick={() => setInputModalities(toggle(inputModalities, m.value))}
                        aria-pressed={inputModalities.includes(m.value)} className={chipClass(inputModalities.includes(m.value))}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-nova-text-secondary">输出类型</span>
                  <div className="flex flex-wrap gap-1.5">
                    {OUTPUT_OPTIONS.map((m) => (
                      <button key={m.value} onClick={() => setOutputModalities(toggle(outputModalities, m.value))}
                        aria-pressed={outputModalities.includes(m.value)} className={chipClass(outputModalities.includes(m.value))}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-nova-text-secondary">模型能力</span>
                  <div className="flex flex-wrap gap-1.5">
                    {CAPABILITY_OPTIONS.map((c) => (
                      <button key={c.value} title={c.hint} onClick={() => setCapabilities(toggle(capabilities, c.value))}
                        aria-pressed={capabilities.includes(c.value)} className={chipClass(capabilities.includes(c.value))}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-nova-text-secondary">推理等级（从低到高）</span>
                  <div className="flex flex-wrap gap-1.5">
                    {REASONING_OPTIONS.map((r) => (
                      <button key={r.value} onClick={() => handleLevelToggle(r.value)}
                        aria-pressed={reasoningLevels.includes(r.value)} className={chipClass(reasoningLevels.includes(r.value))}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[11px] text-nova-text-muted">勾选的档位会出现在聊天区的思考档位菜单；「关闭」始终保留</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="model-config-map" className="text-[11px] font-medium text-nova-text-secondary">推理参数映射（JSON）</label>
                  <textarea
                    id="model-config-map"
                    value={reasoningMap}
                    onChange={(e) => { setReasoningMap(e.target.value); setError(null) }}
                    placeholder={MAP_PLACEHOLDER}
                    spellCheck={false}
                    className="h-32 px-3 py-2 bg-nova-input-bg border border-nova-border rounded-md text-[12px] text-nova-text-primary outline-none focus:border-accent-60 transition-colors font-mono resize-y"
                  />
                  <span className={`text-[11px] ${mapError ? 'text-red-400' : 'text-nova-text-muted'}`}>
                    {mapError ?? '按思考档位追加到请求体；留空不追加。键可用 off/low/medium/high/max（也可写 disabled）'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="text-[11px] text-red-400 px-2.5 py-1.5 bg-red-500/10 border border-red-500/25 rounded-md">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-3 border-t border-nova-border shrink-0">
          <button onClick={handleReset} className="px-2 py-1 text-[11px] text-nova-text-muted hover:text-nova-text-primary transition-colors underline underline-offset-2">
            重置表单
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3.5 py-1.5 text-[12px] leading-[18px] bg-nova-hover text-nova-text-secondary rounded-md hover:text-nova-text-primary transition-colors">
              取消
            </button>
            <button onClick={handleSave} className="px-4 py-1.5 text-[12px] leading-[18px] font-medium bg-nova-accent text-white rounded-md hover:opacity-90 transition-opacity">
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
