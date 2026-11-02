import { useState, useEffect, useMemo } from 'react'

import { useUIStore } from '@/stores/uiStore'
import { useConfigStore, ConnectionStep, ConnectionTestResult } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { useShortcutStore, ShortcutPreset } from '@/stores/shortcutStore'
import { useUpdateStore } from '@/stores/updateStore'
import { ApiConfigGroup, ModelInfo, CustomModel, UserPreferences } from '@/types'
import {
  resolveFormat, FORMAT_META, PROVIDER_REGISTRY, getProviderMeta,
  EndpointFormat,
} from '@/services/llm/endpoints'
import { toFullConfigGroup } from '@/services/llm/configDraft'
import { resolveWebToolsConfig } from '@/services/web/config'
import { listCatalogProviders, getCatalogProvider, getCatalogModel, MODEL_CATALOG_META, type CatalogWireFormat } from '@shared/modelCatalog'
import ModelConfigDialog from './ModelConfigDialog'
import McpConfigSection from './McpConfigSection'
import ClawSettingsSection from './ClawSettingsSection'
import { askText } from '@/components/Common/PromptDialog'
import PluginSection from '../Plugin/PluginSection'
import NoLimitsSettingsSection from './NoLimitsSettingsSection'
import ComputerUseSection from './ComputerUseSection'
import SettingsLayout, { type SettingsNavGroup, type SettingsTabKey } from './SettingsLayout'
import {
  T_BODY,
  T_LABEL,
  T_META,
  SettingsBadge,
  SettingsButton,
  SettingsEmpty,
  SettingsGroupLabel,
  SettingsInput,
  SettingsQueryContext,
  SettingsSection,
  SettingsSegmented,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextarea,
  SettingRow,
  KeyCap,
} from './settings-ui'

// Accent color presets
const THEME_COLOR_PRESETS = ['#2563eb', '#7c5cbf', '#059669', '#e11d48', '#f59e0b', '#0891b2']

const CONFIG_COLORS = [
  '#6C9EFF', '#B77CFF', '#4ADE80', '#FB923C', '#F87171', '#FACC15', '#2DD4BF', '#F472B6',
]

/** Only these wire formats are offered as explicit overrides. */
const FORMAT_ORDER: EndpointFormat[] = ['openai', 'responses', 'anthropic']

/** Catalog provider ids that map onto the app's built-in provider values. */
const CATALOG_BUILTIN_PROVIDER: Record<string, ApiConfigGroup['provider']> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gemini',
  deepseek: 'deepseek',
  groq: 'groq',
  ollama: 'ollama',
  azure: 'azure',
}

/** Catalog wire format → explicit apiFormat for custom (non-built-in) vendors. */
const CATALOG_FORMAT: Record<CatalogWireFormat, NonNullable<ApiConfigGroup['apiFormat']>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  ollama: 'ollama',
  azure: 'azure',
  unsupported: 'openai',
}

function formatTokenCount(value?: number): string {
  if (!value || value <= 0) return '—'
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

const MODALITY_LABELS: Record<string, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  pdf: 'PDF',
}

/** Icon size used in the navigation rail. */
const ICON = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const }

const NAV_GROUPS: SettingsNavGroup[] = [
  {
    title: '连接',
    items: [
      {
        key: 'api',
        label: 'API 配置',
        hint: '接入点、密钥、默认模型与连接测试',
        icon: <svg {...ICON}><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>,
      },
    ],
  },
  {
    title: '工作区',
    items: [
      {
        key: 'appearance',
        label: '外观偏好',
        hint: '主题、强调色、界面语言与字号',
        icon: <svg {...ICON}><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>,
      },
      {
        key: 'editor',
        label: '编辑器',
        hint: '编辑器行为、AI 助手、语言服务与数据重置',
        icon: <svg {...ICON}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>,
      },
      {
        key: 'shortcuts',
        label: '快捷键',
        hint: '按分类查看与调整键位绑定',
        icon: <svg {...ICON}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M6 16h.001M10 16h.001M14 16h.001" /></svg>,
      },
    ],
  },
  {
    title: '扩展与系统',
    items: [
      {
        key: 'features',
        label: '功能',
        hint: '软件更新、渠道接入、插件、MCP 与项目设置',
        icon: <svg {...ICON}><path d="M12 2l2.4 7.2H22l-6 4.6 2.3 7.2-6.3-4.5-6.3 4.5L8 13.8 2 9.2h7.6z" /></svg>,
      },
    ],
  },
]

export default function SettingsModal() {
  const {
    configGroups, activeConfigGroupId, models,
    loadConfigGroups, createConfigGroup, updateConfigGroup,
    deleteConfigGroup, fetchModelsForGroup, testConnectionGroup,
    upsertCustomModel, removeCustomModel, customModels,
  } = useConfigStore()

  const { preferences, savePreferences } = useEditorStore()
  const { isSettingsOpen, closeSettings, setTheme, setThemeColor } = useUIStore()
  const themeColor = useUIStore((s) => s.themeColor)
  const shortcutStore = useShortcutStore()
  // The "current project" follows the ACTIVE SESSION — opening a folder only
  // browses it, so project settings (当前项目 label, MCP servers) use the
  // active conversation's bound project.
  const currentProjectPath = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.projectPath ?? null)

  const [activeTab, setActiveTab] = useState<SettingsTabKey>('api')
  // Search narrows the visible rows of every tab (label + hint matching).
  const [query, setQuery] = useState('')
  // 打开目标：Claw 面板点「去设置」时要直接落到「功能」tab 的对应渠道上，
  // 而不是把用户丢在默认 tab 自己找。
  const settingsTarget = useUIStore((s) => s.settingsTarget)
  useEffect(() => {
    if (settingsTarget) setActiveTab(settingsTarget.tab)
  }, [settingsTarget])
  const [editingGroup, setEditingGroup] = useState<Partial<ApiConfigGroup> | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  // Connection test state (per editor session)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testSteps, setTestSteps] = useState<ConnectionStep[]>([])
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [webTest, setWebTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; message: string }>({
    state: 'idle',
    message: '',
  })
  // Text fields are drafts saved on blur: saving on every keystroke races the
  // async preference write and can drop a neighbouring field's edit.
  const [webDraft, setWebDraft] = useState({ apiKey: '', baseUrl: '', searxngUrl: '' })

  useEffect(() => {
    if (!isSettingsOpen) return
    setWebDraft({
      apiKey: preferences.webSearchDeepseekApiKey || '',
      baseUrl: preferences.webSearchDeepseekBaseUrl || '',
      searxngUrl: preferences.webSearchSearxngUrl || '',
    })
    setWebTest({ state: 'idle', message: '' })
    // Refresh the drafts when the modal opens; preference changes are made by
    // these same fields, so re-syncing on every preference write would fight
    // the user's cursor position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettingsOpen])

  // Model management state (per editor session)
  const [editorModels, setEditorModels] = useState<ModelInfo[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelFetchError, setModelFetchError] = useState<string | null>(null)
  const [newModelName, setNewModelName] = useState('')
  // Model config editor: null = closed. `initial` edits an existing custom
  // config; otherwise saving creates an override for `seedModelId`.
  const [modelEditor, setModelEditor] = useState<{ initial?: CustomModel | null; seedModelId?: string } | null>(null)
  // Selected vendor preset in the editor ('' = manual / keep current).
  const [presetId, setPresetId] = useState('')

  const [showEditKey, setShowEditKey] = useState(false)
  const [headersText, setHeadersText] = useState('')
  const [lspServersText, setLspServersText] = useState(
    Object.entries(preferences.lspServers ?? {})
      .map(([lang, cmd]) => `${lang}: ${cmd}`)
      .join('\n'),
  )

  // 243 catalog providers, but only those with a usable endpoint can prefill a
  // config (Bedrock/Vertex need proprietary auth and are excluded).
  const providerPresets = useMemo(
    () => listCatalogProviders().filter((p) => p.api && p.format !== 'unsupported'),
    [],
  )

  // 软件更新：检查按钮状态 + 自定义更新源草稿
  const appVersion = useUpdateStore((s) => s.appVersion)
  const updateUiState = useUpdateStore((s) => s.uiState)
  const checkForUpdate = useUpdateStore((s) => s.check)
  const [updateFeedUrl, setUpdateFeedUrl] = useState('')

  useEffect(() => {
    if (isSettingsOpen) {
      loadConfigGroups()
      useShortcutStore.getState().loadShortcuts()
      setEditingGroup(null)
      setIsCreating(false)
      // 带定位目标时（Claw 面板的「去设置」）落到目标 tab，否则回到默认的 API 配置
      setActiveTab(settingsTarget?.tab ?? 'api')
      setQuery('')
      setShowEditKey(false)
      resetEditorState()
      setUpdateFeedUrl(useEditorStore.getState().preferences.updateFeedUrl ?? '')
    }
  }, [isSettingsOpen, loadConfigGroups, settingsTarget])

  const handleSaveFeedUrl = async () => {
    const url = updateFeedUrl.trim()
    await savePreferences({ updateFeedUrl: url })
    await window.electronAPI.setUpdateFeedUrl(url)
  }

  const testWebSearch = async () => {
    setWebTest({ state: 'running', message: '正在测试…' })
    try {
      // Flush the text drafts first: reading preferences before the async write
      // lands would test the previous key/URL.
      await savePreferences({
        webSearchDeepseekApiKey: webDraft.apiKey,
        webSearchDeepseekBaseUrl: webDraft.baseUrl,
        webSearchSearxngUrl: webDraft.searxngUrl,
      })
      const cfg = resolveWebToolsConfig()
      const res = await window.electronAPI.webSearch({
        query: 'DeepSeek Search API',
        count: 3,
        provider: cfg.searchProvider,
        deepseek: cfg.deepseek,
        searxng: cfg.searxng,
      })
      if (res.ok && res.results.length > 0) {
        const via = res.merged && res.providers?.length
          ? `multi (${res.providers.join(' + ')})`
          : res.provider
        setWebTest({ state: 'ok', message: `${via} · ${res.results.length} 条结果` })
      } else {
        setWebTest({ state: 'error', message: (res.error || '没有结果').slice(0, 300) })
      }
    } catch (error: any) {
      setWebTest({ state: 'error', message: (error?.message || '测试失败').slice(0, 300) })
    }
  }

  if (!isSettingsOpen) return null

  /** Reset all transient editor state (test results, fetched models, ...). */
  function resetEditorState() {
    setTesting(false)
    setTestError(null)
    setTestSteps([])
    setTestResult(null)
    setEditorModels([])
    setFetchingModels(false)
    setModelFetchError(null)
    setNewModelName('')
    setPresetId('')
    setModelEditor(null)
    setHeadersText('')
  }

  /** Open the editor for a brand-new config of the given provider. */
  function startNewForProvider(provider: string) {
    const meta = getProviderMeta(provider)
    resetEditorState()
    setIsCreating(true)
    setEditingGroup({
      name: `${meta?.label || provider} 配置`,
      baseUrl: meta?.defaultBaseUrl || '',
      apiKey: '',
      systemPrompt: '',
      defaultModel: '',
      provider: provider as ApiConfigGroup['provider'],
      apiFormat: 'auto',
      customHeaders: {},
      color: meta?.color || '#6C9EFF',
    })
  }

  /** Open the editor for an existing saved config. */
  function openSavedGroup(group: ApiConfigGroup) {
    resetEditorState()
    setIsCreating(false)
    setEditingGroup({ ...group })
    setHeadersText(Object.entries(group.customHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))
    // Seed models: reuse the store's fetched list when editing the active group,
    // otherwise just the custom models the user added for this provider.
    if (group.id === activeConfigGroupId && models.length > 0) {
      setEditorModels(models)
    } else {
      setEditorModels(customModels.filter((c) => c.provider === group.provider).map((c) => ({
        id: c.id,
        name: c.name,
        isFree: false,
        isFavorite: false,
        contextWindow: c.contextWindow,
        vision: c.vision,
        functionCall: c.functionCall,
      })))
    }
  }

  /** Build a full ApiConfigGroup from the editor draft (for testing / model fetch).
   *  Single source of truth lives in services/llm/configDraft so no field (notably
   *  skipTlsVerify) can be dropped on the way to the request path. */
  const toFullGroup = toFullConfigGroup

  const handleSaveGroup = async () => {
    if (!editingGroup) return
    if (!(editingGroup.name || '').trim()) { setTestError('请填写配置名称'); return }
    if (!(editingGroup.baseUrl || '').trim()) { setTestError('请填写 API 基础 URL'); return }
    const nameExists = configGroups.some((g) => g.name === editingGroup.name && g.id !== editingGroup.id)
    if (nameExists) { setTestError('配置名称已存在'); return }
    if (isCreating) { await createConfigGroup(editingGroup) }
    else if (editingGroup.id) { await updateConfigGroup(editingGroup.id, editingGroup) }
    setEditingGroup(null)
    setIsCreating(false)
    resetEditorState()
  }

  /** Test the in-progress (possibly unsaved) config from the edit form. */
  const handleTest = async () => {
    if (!editingGroup) return
    const baseUrl = (editingGroup.baseUrl || '').trim()
    const apiKey = (editingGroup.apiKey || '').trim()
    if (!baseUrl) { setTestError('请先填写 API 基础 URL'); return }
    // Local Ollama and custom relays may not need a key.
    const provider = editingGroup.provider || 'openai'
    const requiresKey = provider !== 'ollama' && provider !== 'custom'
    if (requiresKey && !apiKey) { setTestError('请先填写 API 密钥'); return }
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    setTestSteps([])
    try {
      const group = toFullGroup(editingGroup)
      const result = await testConnectionGroup(group, (step) => {
        setTestSteps((prev) => [...prev, step])
      })
      setTestResult(result)
    } catch (error: any) {
      setTestError(error?.message || '测试连接失败，请稍后重试')
    } finally {
      setTesting(false)
    }
  }

  const handleDeleteGroup = async () => {
    if (!editingGroup?.id) return
    if (confirm('确定要删除此配置吗？')) {
      await deleteConfigGroup(editingGroup.id)
      setEditingGroup(null)
      setIsCreating(false)
      resetEditorState()
    }
  }

  const handleFetchModels = async () => {
    if (!editingGroup) return
    const baseUrl = (editingGroup.baseUrl || '').trim()
    if (!baseUrl) { setModelFetchError('请先填写 API 基础 URL'); return }
    setFetchingModels(true)
    setModelFetchError(null)
    try {
      const list = await fetchModelsForGroup(toFullGroup(editingGroup))
      setEditorModels(list)
      if (list.length === 0) setModelFetchError('接口未返回任何模型，可手动添加')
    } catch (error: any) {
      setModelFetchError(error?.message || '获取模型列表失败')
    } finally {
      setFetchingModels(false)
    }
  }

  const handleAddModel = () => {
    if (!editingGroup) return
    // Open the config editor (prefilled with the typed id) instead of saving
    // immediately — the editor is where context/output/modalities are set.
    setModelEditor({ seedModelId: newModelName.trim() || undefined })
  }

  const handleSaveModelConfig = (model: CustomModel, originalId?: string) => {
    if (originalId && originalId !== model.id) removeCustomModel(originalId)
    upsertCustomModel(model)
    setEditorModels((prev) => {
      const withoutOld = originalId ? prev.filter((m) => m.id !== originalId) : prev
      const entry: ModelInfo = {
        id: model.id,
        name: model.name,
        isFree: false,
        isFavorite: false,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        inputModalities: model.inputModalities,
        outputModalities: model.outputModalities,
        capabilities: model.capabilities,
        reasoningLevels: model.reasoningLevels,
        vision: model.vision,
        functionCall: model.functionCall,
      }
      const idx = withoutOld.findIndex((m) => m.id === model.id)
      return idx >= 0
        ? withoutOld.map((m, i) => (i === idx ? { ...m, ...entry } : m))
        : [...withoutOld, entry]
    })
    if (editingGroup && (!editingGroup.defaultModel || editingGroup.defaultModel === originalId)) {
      setEditingGroup({ ...editingGroup, defaultModel: model.id })
    }
    setModelEditor(null)
    setNewModelName('')
  }

  const handleRemoveModel = (id: string) => {
    if (customModels.some((c) => c.id === id)) removeCustomModel(id)
    setEditorModels((prev) => prev.filter((m) => m.id !== id))
  }

  /** Fill the provider/base URL from the generated vendor catalog preset. */
  const applyProviderPreset = (catalogId: string) => {
    setPresetId(catalogId)
    if (!editingGroup || !catalogId) return
    const preset = getCatalogProvider(catalogId)
    if (!preset || !preset.api) return
    const builtin = CATALOG_BUILTIN_PROVIDER[preset.id]
    // Keep a user-typed name; replace the auto-generated "<provider> 配置".
    const autoName = `${getProviderMeta(editingGroup.provider || '')?.label || ''} 配置`
    const keepName = !isCreating
      || (editingGroup.name?.trim() && editingGroup.name !== autoName && editingGroup.name !== '自定义 配置')
    setEditingGroup({
      ...editingGroup,
      name: keepName ? editingGroup.name : `${preset.name} 配置`,
      provider: builtin || 'custom',
      apiFormat: builtin ? 'auto' : CATALOG_FORMAT[preset.format],
      baseUrl: preset.api,
      defaultModel: editingGroup.defaultModel || preset.suggestedModels[0] || '',
    })
  }

  const handleImport = async () => {
    const { importConfigGroups } = useConfigStore.getState()
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const text = await file.text()
      const password = await askText({ title: '输入导入密码（无密码请留空）', allowEmpty: true })
      await importConfigGroups(text, password || undefined)
      loadConfigGroups()
    }
    input.click()
  }

  const handleExport = async () => {
    const { exportConfigGroups } = useConfigStore.getState()
    const password = await askText({ title: '设置导出密码（无密码请留空）', allowEmpty: true })
    const data = await exportConfigGroups(password || undefined)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `ourcode-configs-${Date.now()}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const fmt = resolveFormat(editingGroup?.provider || 'custom', editingGroup?.apiFormat)
  const providerMeta = getProviderMeta(editingGroup?.provider || '')
  const nativeFormat = providerMeta?.nativeFormat || 'openai'
  // Spec of the current default model, shown as a reference under the list.
  // Falls back to the catalog when the list has not been fetched yet.
  const defaultModelInfo = editorModels.find((m) => m.id === editingGroup?.defaultModel)
    ?? (editingGroup?.defaultModel ? getCatalogModel(editingGroup.defaultModel) : undefined)
  const formatOverrideWarning = !!editingGroup?.apiFormat
    && editingGroup.apiFormat !== 'auto'
    && editingGroup.apiFormat !== nativeFormat
  // Number of valid "Header: Value" lines currently in the custom-headers editor.
  const parsedHeaderCount = headersText.split('\n').reduce((n, line) => {
    const idx = line.indexOf(':')
    return idx > 0 && line.slice(idx + 1).trim() ? n + 1 : n
  }, 0)
  // Valid "language: command" lines in the LSP editor.
  const lspServerCount = Object.keys(preferences.lspServers ?? {}).length

  // ───────────── RENDER ─────────────

  const applyHeaders = (raw: string) => {
    const map: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0 && line.slice(idx + 1).trim()) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    if (editingGroup) setEditingGroup({ ...editingGroup, customHeaders: map })
  }

  const apiTab = (
    <div className="grid grid-cols-[252px_minmax(0,1fr)] items-start gap-5">
      {/* ── Left rail: saved configs + provider picker ── */}
      <aside className="sticky top-0 flex flex-col gap-4">
        <SettingsButton variant="primary" className="w-full" onClick={() => startNewForProvider('openai')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          新建配置
        </SettingsButton>

        <div className="flex flex-col gap-1">
          <SettingsGroupLabel>已保存配置（{configGroups.length}）</SettingsGroupLabel>
          {configGroups.length === 0 ? (
            <p className={`${T_META} px-1 py-1`}>还没有配置，从下方选择一个提供商开始创建。</p>
          ) : (
            configGroups.map((group) => {
              const active = group.id === activeConfigGroupId
              const selected = !isCreating && editingGroup?.id === group.id
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => openSavedGroup(group)}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                    selected
                      ? 'border-accent-40 bg-accent-10'
                      : 'border-transparent hover:border-nova-border hover:bg-nova-hover'
                  }`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: group.color || '#6C9EFF' }} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] leading-[18px] font-medium text-nova-text-primary">{group.name}</span>
                    <span className={`${T_META} truncate font-mono`}>{group.baseUrl}</span>
                  </span>
                  {active && <SettingsBadge tone="accent">使用中</SettingsBadge>}
                </button>
              )
            })
          )}
        </div>

        <div className="flex flex-col gap-1">
          <SettingsGroupLabel>选择提供商</SettingsGroupLabel>
          {PROVIDER_REGISTRY.map((p) => {
            const selected = isCreating && editingGroup?.provider === p.value
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => startNewForProvider(p.value)}
                className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                  selected
                    ? 'border-accent-40 bg-accent-10'
                    : 'border-transparent hover:border-nova-border hover:bg-nova-hover'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[12px] leading-[18px] font-semibold"
                  style={{ background: `${p.color}24`, color: p.color }}
                >
                  {p.icon}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] leading-[18px] font-medium text-nova-text-primary">{p.label}</span>
                  <span className={`${T_META} truncate`}>{p.description}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex gap-2">
          <SettingsButton className="flex-1" onClick={handleImport}>导入</SettingsButton>
          <SettingsButton className="flex-1" onClick={handleExport}>导出</SettingsButton>
        </div>
      </aside>

      {/* ── Right: editor ── */}
      <div className="flex min-w-0 flex-col gap-4">
        {editingGroup ? (
          <>
            {/* Provider banner */}
            <div className="flex items-center gap-3 rounded-xl border border-nova-border bg-nova-card px-4 py-3">
              {providerMeta && (
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[13px] leading-[18px] font-semibold"
                  style={{ background: `${providerMeta.color}1f`, color: providerMeta.color }}
                >
                  {providerMeta.icon}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={T_LABEL}>{providerMeta?.label || editingGroup.provider}</span>
                <span className={`${T_META} truncate`}>{providerMeta?.description}</span>
              </div>
              <SettingsBadge>请求格式：{FORMAT_META[fmt]?.label || fmt}</SettingsBadge>
            </div>

            <SettingsSection title="基础信息" description="配置名称用于在侧栏区分不同的接入点。">
              <SettingRow
                label="配置名称"
                desc="必填，同名配置会被拒绝保存"
                right={
                  <SettingsInput
                    label="配置名称"
                    value={editingGroup.name || ''}
                    onChange={(e) => setEditingGroup({ ...editingGroup, name: e.target.value })}
                    className="w-[220px]"
                    placeholder="例如：主力模型"
                  />
                }
              />
              <SettingRow
                label="默认模型"
                desc="新建会话默认使用的模型，可从已获取的列表中选"
                right={
                  <>
                    <SettingsInput
                      label="默认模型"
                      list="settings-model-options"
                      value={editingGroup.defaultModel || ''}
                      onChange={(e) => setEditingGroup({ ...editingGroup, defaultModel: e.target.value })}
                      placeholder="可输入或从列表选择"
                      className="w-[220px] font-mono"
                    />
                    <datalist id="settings-model-options">
                      {editorModels.map((m) => <option key={m.id} value={m.id} />)}
                    </datalist>
                  </>
                }
              />
              <SettingRow
                label="厂商预设"
                desc={`已收录 ${providerPresets.length} 个接入点，可直接套用官方地址`}
                stacked
                right={
                  <SettingsSelect
                    label="厂商预设"
                    value={presetId}
                    onChange={(e) => applyProviderPreset(e.target.value)}
                    className="w-full"
                  >
                    <option value="">手动填写 / 保持当前接入点</option>
                    {providerPresets.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} — {p.api}</option>
                    ))}
                  </SettingsSelect>
                }
              />
              <SettingRow
                label="API 基础 URL"
                desc="必填，通常以 /v1 结尾"
                stacked
                right={
                  <SettingsInput
                    label="API 基础 URL"
                    value={editingGroup.baseUrl || ''}
                    onChange={(e) => setEditingGroup({ ...editingGroup, baseUrl: e.target.value })}
                    placeholder={providerMeta?.defaultBaseUrl || 'https://api.example.com/v1'}
                    className="w-full font-mono"
                  />
                }
              />
              <SettingRow
                label="跳过证书校验"
                desc="仅用于内网自签名证书，生产环境请保持关闭"
                right={
                  <SettingsSwitch
                    label="跳过证书校验"
                    checked={!!editingGroup.skipTlsVerify}
                    onChange={(next) => setEditingGroup({ ...editingGroup, skipTlsVerify: next })}
                  />
                }
              />
            </SettingsSection>

            <SettingsSection title="请求格式" description="跟随提供商默认即可，只有自建网关才需要覆盖。">
              <div className="grid grid-cols-4 gap-2 py-1">
                <button
                  type="button"
                  onClick={() => setEditingGroup({ ...editingGroup, apiFormat: 'auto' })}
                  aria-pressed={(editingGroup.apiFormat || 'auto') === 'auto'}
                  className={`flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    (editingGroup.apiFormat || 'auto') === 'auto'
                      ? 'border-accent-50 bg-accent-10'
                      : 'border-nova-border bg-nova-card hover:border-accent-30'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[13px] leading-[18px] font-medium text-nova-text-primary">
                    跟随默认
                    <SettingsBadge tone="accent">推荐</SettingsBadge>
                  </span>
                  <span className={T_META}>{FORMAT_META[nativeFormat].label} · {FORMAT_META[nativeFormat].desc}</span>
                </button>
                {FORMAT_ORDER.map((f) => {
                  const isNative = f === nativeFormat
                  const selected = editingGroup.apiFormat === f
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setEditingGroup({ ...editingGroup, apiFormat: f })}
                      aria-pressed={selected}
                      className={`flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                        selected
                          ? 'border-accent-50 bg-accent-10'
                          : 'border-nova-border bg-nova-card hover:border-accent-30'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-[13px] leading-[18px] font-medium text-nova-text-primary">
                        {FORMAT_META[f].label}
                        {isNative && <SettingsBadge tone="success">推荐</SettingsBadge>}
                      </span>
                      <span className={T_META}>{FORMAT_META[f].desc}</span>
                    </button>
                  )
                })}
              </div>
              {formatOverrideWarning && (
                <p className="mt-2 rounded-lg border border-warning-30 bg-warning-5 px-2.5 py-1.5 text-[12px] leading-[18px] text-warning">
                  该格式与提供商默认（{FORMAT_META[nativeFormat].label}）不同，请确认网关确实支持。
                </p>
              )}
            </SettingsSection>

            <SettingsSection title="认证与标识" description="密钥只保存在本地；也可填环境变量名在运行时读取。">
              <SettingRow
                label="API 密钥"
                desc="必填（Ollama / 自建中继可留空）"
                stacked
                right={
                  <div className="flex w-full items-center gap-2">
                    <SettingsInput
                      label="API 密钥"
                      type={showEditKey ? 'text' : 'password'}
                      value={editingGroup.apiKey || ''}
                      onChange={(e) => setEditingGroup({ ...editingGroup, apiKey: e.target.value })}
                      className="flex-1 font-mono"
                    />
                    <SettingsButton
                      onClick={() => setShowEditKey(!showEditKey)}
                      aria-label={showEditKey ? '隐藏密钥' : '显示密钥'}
                      title={showEditKey ? '隐藏密钥' : '显示密钥'}
                    >
                      {showEditKey ? '隐藏' : '显示'}
                    </SettingsButton>
                  </div>
                }
              />
              <SettingRow
                label="标识颜色"
                desc="用于在列表和侧栏区分该配置"
                right={
                  <div className="flex flex-wrap items-center gap-1.5">
                    {CONFIG_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`使用颜色 ${c}`}
                        onClick={() => setEditingGroup({ ...editingGroup, color: c })}
                        className={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 ${
                          editingGroup.color === c ? 'border-white shadow-[0_0_0_2px_var(--accent)]' : 'border-transparent'
                        }`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                }
              />
              <SettingRow
                label="自定义请求头"
                desc={parsedHeaderCount > 0 ? `已填写 ${parsedHeaderCount} 条，格式 Header: Value` : '每行一条，格式 Header: Value'}
                stacked
                right={
                  <SettingsTextarea
                    label="自定义请求头"
                    value={headersText}
                    onChange={(e) => setHeadersText(e.target.value)}
                    onBlur={() => applyHeaders(headersText)}
                    placeholder={'Authorization: Bearer sk-xxx\nX-API-Key: xxx'}
                    className="min-h-[72px]"
                  />
                }
              />
            </SettingsSection>

            <SettingsSection
              title="模型"
              description={`模型目录收录 ${MODEL_CATALOG_META.modelCount} 个模型 · 更新于 ${MODEL_CATALOG_META.generatedAt}`}
              actions={
                <SettingsButton onClick={handleFetchModels} disabled={fetchingModels || testing}>
                  {fetchingModels ? '获取中…' : '获取模型列表'}
                </SettingsButton>
              }
            >
              <div className="flex flex-col gap-2 py-1">
                {modelFetchError && (
                  <p className="rounded-lg border border-error-20 bg-error-10 px-2.5 py-1.5 text-[12px] leading-[18px] text-error">{modelFetchError}</p>
                )}
                {editorModels.length > 0 ? (
                  <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                    {editorModels.map((m) => {
                      const isDefault = m.id === editingGroup.defaultModel
                      const isCustom = customModels.some((c) => c.id === m.id)
                      const customEntry = customModels.find((c) => c.id === m.id)
                      const specTitle = [
                        m.contextWindow ? `上下文 ${formatTokenCount(m.contextWindow)}` : '',
                        m.maxOutputTokens ? `输出 ${formatTokenCount(m.maxOutputTokens)}` : '',
                        m.inputModalities?.length ? `输入 ${m.inputModalities.map((x) => MODALITY_LABELS[x] ?? x).join('/')}` : '',
                      ].filter(Boolean).join(' · ')
                      return (
                        <span
                          key={m.id}
                          className={`group inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[12px] leading-[18px] transition-colors ${
                            isDefault
                              ? 'border-accent-50 bg-accent-10 text-accent-text'
                              : 'border-nova-border bg-nova-card text-nova-text-secondary hover:border-accent-50'
                          }`}
                          title={[isDefault ? '当前默认模型' : '点击设为默认模型', specTitle].filter(Boolean).join(' · ')}
                        >
                          <button
                            type="button"
                            onClick={() => setEditingGroup({ ...editingGroup, defaultModel: m.id })}
                            className="cursor-pointer"
                          >
                            {m.id}
                          </button>
                          <button
                            type="button"
                            aria-label={`编辑模型 ${m.id}`}
                            title="编辑模型配置"
                            onClick={() => setModelEditor({ initial: customEntry || null, seedModelId: m.id })}
                            className="text-nova-text-muted opacity-0 transition-opacity hover:text-accent-text focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            </svg>
                          </button>
                          {isCustom && (
                            <button
                              type="button"
                              aria-label={`移除模型 ${m.id}`}
                              title="移除自定义模型"
                              onClick={() => handleRemoveModel(m.id)}
                              className="text-nova-text-muted transition-colors hover:text-error"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                              </svg>
                            </button>
                          )}
                        </span>
                      )
                    })}
                  </div>
                ) : (
                  !fetchingModels && (
                    <p className="rounded-lg border border-dashed border-nova-border px-2.5 py-2 text-[12px] leading-[18px] text-nova-text-muted">
                      暂无模型：点「获取模型列表」拉取，或在下方手动添加。
                    </p>
                  )
                )}

                {defaultModelInfo && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[18px] text-nova-text-muted">
                    <span className="font-medium text-nova-text-secondary">默认模型规格</span>
                    <span>上下文 {formatTokenCount(defaultModelInfo.contextWindow)}</span>
                    <span>输出 {formatTokenCount(defaultModelInfo.maxOutputTokens)}</span>
                    {defaultModelInfo.inputModalities?.length ? (
                      <span>输入 {defaultModelInfo.inputModalities.map((m) => MODALITY_LABELS[m] ?? m).join('/')}</span>
                    ) : null}
                    {defaultModelInfo.capabilities?.includes('tool_call') ? <span>工具调用</span> : null}
                    <button
                      type="button"
                      onClick={() => {
                        const custom = customModels.find((c) => c.id === defaultModelInfo.id)
                        setModelEditor({ initial: custom || null, seedModelId: defaultModelInfo.id })
                      }}
                      className="text-accent-text hover:underline"
                    >
                      调整
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <SettingsInput
                    label="手动添加模型"
                    value={newModelName}
                    onChange={(e) => setNewModelName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddModel() }}
                    placeholder="手动添加模型名，如 deepseek-reasoner"
                    className="flex-1 font-mono"
                  />
                  <SettingsButton onClick={handleAddModel}>添加</SettingsButton>
                </div>
              </div>
            </SettingsSection>

            {/* Connection test */}
            {(testing || testSteps.length > 0 || testError) && (
              <section className="flex flex-col gap-2 rounded-xl border border-nova-border bg-nova-card px-5 py-4">
                <h3 className="text-[14px] leading-[20px] font-semibold text-nova-text-primary">连接测试</h3>
                {testError && !testing && (
                  <p className="rounded-lg border border-error-20 bg-error-10 px-2.5 py-1.5 text-[12px] leading-[18px] text-error">{testError}</p>
                )}
                {testing && <p className={T_BODY}>正在测试连接…</p>}
                {testSteps.length > 0 && <TestResultPanel steps={testSteps} success={testResult?.success} />}
              </section>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between gap-2 pb-1">
              <div>
                {!isCreating && editingGroup.id && (
                  <SettingsButton variant="danger" onClick={handleDeleteGroup}>删除此配置</SettingsButton>
                )}
              </div>
              <div className="flex items-center gap-2">
                <SettingsButton onClick={() => { setEditingGroup(null); setIsCreating(false); resetEditorState() }}>取消</SettingsButton>
                <SettingsButton onClick={handleTest} disabled={testing}>测试连接</SettingsButton>
                <SettingsButton variant="primary" onClick={handleSaveGroup}>保存配置</SettingsButton>
              </div>
            </div>
          </>
        ) : (
          <SettingsEmpty
            title="选择一个接入点"
            desc="从左侧选择一个已保存的配置进行编辑，或选择提供商新建配置。"
          />
        )}
      </div>
    </div>
  )

  const appearanceTab = (
    <>
      <SettingsSection title="主题" description="界面主题与强调色即时生效。">
        <SettingRow
          label="界面主题"
          desc="选择深色、浅色或跟随系统"
          right={
            <SettingsSegmented
              label="界面主题"
              value={preferences.theme}
              onChange={(next) => { savePreferences({ theme: next as typeof preferences.theme }); setTheme(next as typeof preferences.theme) }}
              options={[
                { value: 'dark', label: '深色' },
                { value: 'light', label: '浅色' },
                { value: 'system', label: '跟随系统' },
              ]}
            />
          }
        />
        <SettingRow
          label="强调色"
          desc="用于按钮、选中态和焦点环"
          right={
            <div className="flex items-center gap-1.5">
              {THEME_COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`使用强调色 ${c}`}
                  onClick={() => setThemeColor(c)}
                  className={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 ${
                    themeColor.toLowerCase() === c ? 'border-white shadow-[0_0_0_2px_var(--accent)]' : 'border-transparent'
                  }`}
                  style={{ background: c }}
                />
              ))}
              <label className="ml-1 flex items-center gap-1.5">
                <span className="sr-only">自定义强调色</span>
                <input
                  type="color"
                  aria-label="自定义强调色"
                  value={themeColor}
                  onChange={(e) => setThemeColor(e.target.value)}
                  className="h-6 w-6 cursor-pointer rounded-full border-2 border-nova-border bg-transparent p-0"
                />
              </label>
            </div>
          }
        />
        <SettingRow
          label="界面语言"
          desc="切换中文或英文界面，重启后完全生效"
          right={
            <SettingsSegmented
              label="界面语言"
              value={preferences.language}
              onChange={(next) => savePreferences({ language: next as typeof preferences.language })}
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en-US', label: 'English' },
                { value: 'system', label: '跟随系统' },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="字体" description="只影响代码编辑器，不影响界面字号。">
        <SettingRow
          label="编辑器字号"
          desc="代码编辑器的字体大小"
          right={
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={10}
                max={24}
                aria-label="编辑器字号"
                value={preferences.fontSize}
                onChange={(e) => savePreferences({ fontSize: Number(e.target.value) })}
                className="w-[132px] accent-nova-accent"
              />
              <span className="w-9 text-right text-[12px] leading-[18px] font-mono text-nova-text-muted">{preferences.fontSize}px</span>
            </div>
          }
        />
        <SettingRow
          label="制表符大小"
          desc="Tab 键对应的空格数"
          right={
            <SettingsSegmented
              label="制表符大小"
              value={String(preferences.tabSize)}
              onChange={(next) => savePreferences({ tabSize: Number(next) })}
              options={[
                { value: '2', label: '2' },
                { value: '4', label: '4' },
                { value: '8', label: '8' },
              ]}
            />
          }
        />
      </SettingsSection>
    </>
  )

  const editorTab = (
    <>
      <SettingsSection title="编辑器行为" description="日常编码时最常用的两项开关。">
        <SettingRow
          label="显示缩略图"
          desc="在编辑器右侧显示代码缩略导航图"
          right={<SettingsSwitch label="显示缩略图" checked={preferences.showMinimap} onChange={(v) => savePreferences({ showMinimap: v })} />}
        />
        <SettingRow
          label="对话历史编辑"
          desc="开启后支持编辑消息、拖动排序和批量删除"
          right={<SettingsSwitch label="对话历史编辑" checked={preferences.chatHistoryEditMode} onChange={(v) => savePreferences({ chatHistoryEditMode: v })} />}
        />
      </SettingsSection>

      <SettingsSection title="AI 助手" description="记忆、缓存、重试与上下文压缩策略。">
        <SettingRow
          label="允许 AI 自动记忆"
          desc="开启后 AI 可在对话中自动把重要信息保存到长期记忆"
          right={<SettingsSwitch label="允许 AI 自动记忆" checked={preferences.aiAutoMemory} onChange={(v) => savePreferences({ aiAutoMemory: v })} />}
        />
        <SettingRow
          label="提问自动继续"
          desc="Agent 提问默认 5 分钟倒计时，超时未回答时自动选择方向继续；悬停或任意操作会永久停止计时。关闭后提问一直等待（权限审批与计划审批始终等待，不受影响）"
          right={<SettingsSwitch label="提问自动继续" checked={preferences.questionAutoContinue !== false} onChange={(v) => savePreferences({ questionAutoContinue: v })} />}
        />
        <SettingRow
          label="LLM 响应缓存"
          desc="相同请求直接复用上次结果，不再调用 API"
          right={<SettingsSwitch label="LLM 响应缓存" checked={preferences.llmResponseCache} onChange={(v) => savePreferences({ llmResponseCache: v })} />}
        />
        <SettingRow
          label="Anthropic 提示词缓存"
          desc="重复的历史内容按缓存价计费（约 1/10）"
          right={<SettingsSwitch label="Anthropic 提示词缓存" checked={preferences.anthropicPromptCache} onChange={(v) => savePreferences({ anthropicPromptCache: v })} />}
        />
        <SettingRow
          label="Anthropic 缓存延长到 1 小时"
          desc="需模型支持，不支持时请求会失败"
          right={<SettingsSwitch label="Anthropic 缓存延长到 1 小时" checked={!!preferences.anthropicPromptCache1h} onChange={(v) => savePreferences({ anthropicPromptCache1h: v })} />}
        />
        <SettingRow
          label="接收会话间消息"
          desc="其他会话发来的消息如何处理"
          right={
            <SettingsSelect
              label="接收会话间消息"
              value={preferences.crossSessionInbound ?? 'accept'}
              onChange={(e) => savePreferences({ crossSessionInbound: e.target.value as 'accept' | 'hold' | 'refuse' })}
            >
              <option value="accept">接受并自动处理</option>
              <option value="hold">暂存（仅投递）</option>
              <option value="refuse">拒绝接收</option>
            </SettingsSelect>
          }
        />
        <SettingRow
          label="Agent 工具调用轮数上限"
          desc="Agent 循环中连续调用工具的轮数上限，防止一次运行过久"
          right={
            <SettingsSelect
              label="Agent 工具调用轮数上限"
              value={String(preferences.agentMaxIterations ?? 0)}
              onChange={(e) => savePreferences({ agentMaxIterations: Number(e.target.value) })}
            >
              <option value="0">无限（默认）</option>
              <option value="50">50 轮</option>
              <option value="100">100 轮</option>
              <option value="200">200 轮</option>
              <option value="500">500 轮</option>
            </SettingsSelect>
          }
        />
        <SettingRow
          label="LLM 请求自动重试"
          desc="自动重试瞬时性失败（超时 / 网络 / 限流）"
          right={<SettingsSwitch label="LLM 请求自动重试" checked={preferences.llmRetryEnabled !== false} onChange={(v) => savePreferences({ llmRetryEnabled: v })} />}
        />
        <SettingRow
          label="重试次数上限"
          desc="每次请求失败后最多自动重试的次数"
          right={
            <SettingsSelect
              label="重试次数上限"
              value={String(preferences.llmRetryMaxRetries ?? 2)}
              onChange={(e) => savePreferences({ llmRetryMaxRetries: Number(e.target.value) })}
            >
              <option value="0">0 次（关闭重试）</option>
              <option value="1">1 次</option>
              <option value="2">2 次（默认）</option>
              <option value="3">3 次</option>
            </SettingsSelect>
          }
        />
        <SettingRow
          label="模型请求日志"
          desc="把每次模型请求（脱敏）记录到本地日志文件；内容是明文，排查完建议关闭"
          right={
            <div className="flex items-center gap-2">
              <SettingsSwitch label="模型请求日志" checked={preferences.wireLogEnabled !== false} onChange={(v) => savePreferences({ wireLogEnabled: v })} />
              <SettingsButton onClick={() => { void window.electronAPI.wireLogOpenDir().catch(() => {}) }}>打开日志目录</SettingsButton>
            </div>
          }
        />
        <SettingRow
          label="工具输出截断上限"
          desc="工具结果超过该字符数时截断，保留首尾"
          right={
            <SettingsSelect
              label="工具输出截断上限"
              value={String(preferences.toolOutputMaxChars ?? 150000)}
              onChange={(e) => savePreferences({ toolOutputMaxChars: Number(e.target.value) })}
            >
              <option value="50000">50K 字符</option>
              <option value="100000">100K 字符</option>
              <option value="150000">150K 字符（默认）</option>
              <option value="200000">200K 字符</option>
              <option value="500000">500K 字符</option>
            </SettingsSelect>
          }
        />
        <SettingRow
          label="上下文压缩"
          desc="上下文接近窗口上限时，把较早的历史压缩为摘要（原始消息不删除）"
          right={<SettingsSwitch label="上下文压缩" checked={preferences.contextCompaction !== false} onChange={(v) => savePreferences({ contextCompaction: v })} />}
        />
        <SettingRow
          label="压缩触发阈值"
          desc="估算上下文占模型窗口的比例，超过即压缩"
          right={
            <SettingsSelect
              label="压缩触发阈值"
              value={String(preferences.contextCompactionRatio ?? 0.8)}
              onChange={(e) => savePreferences({ contextCompactionRatio: Number(e.target.value) })}
            >
              <option value="0.7">70%</option>
              <option value="0.8">80%（默认）</option>
              <option value="0.9">90%</option>
            </SettingsSelect>
          }
        />
        <SettingRow
          label="压缩使用模型"
          desc="生成压缩摘要的模型，可指定更便宜的模型省 token"
          right={
            <SettingsSelect
              label="压缩使用模型"
              value={preferences.contextCompactionModel ?? ''}
              onChange={(e) => savePreferences({ contextCompactionModel: e.target.value || undefined })}
            >
              <option value="">跟随会话模型（默认）</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
            </SettingsSelect>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="联网工具"
        description="web_search / read_url 的检索与抓取后端。DeepSeek Search/Fetch 按成功请求计费（约 5 元/1000 次）；DuckDuckGo 兜底无需 Key。"
      >
        <SettingRow
          label="搜索后端"
          desc="自动：无 Key 时并行聚合 Bing + Brave + DuckDuckGo；有 DeepSeek Key 时优先 DeepSeek"
          right={
            <SettingsSelect
              label="搜索后端"
              value={preferences.webSearchProvider || 'auto'}
              onChange={(e) => savePreferences({
                webSearchProvider: e.target.value as NonNullable<UserPreferences['webSearchProvider']>,
              })}
            >
              <option value="auto">自动（推荐）</option>
              <option value="multi">多源聚合</option>
              <option value="deepseek">DeepSeek</option>
              <option value="searxng">SearXNG</option>
              <option value="bing">Bing（无 Key）</option>
              <option value="brave">Brave（无 Key）</option>
              <option value="duckduckgo">DuckDuckGo</option>
            </SettingsSelect>
          }
        />
        <SettingRow
          label="DeepSeek API Key"
          desc="留空则复用官方 DeepSeek 配置组的 Key；仅保存在本机"
          right={
            <SettingsInput
              label="DeepSeek API Key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="w-[260px]"
              placeholder="sk-…"
              value={webDraft.apiKey}
              onChange={(e) => setWebDraft((draft) => ({ ...draft, apiKey: e.target.value }))}
              onBlur={() => savePreferences({ webSearchDeepseekApiKey: webDraft.apiKey })}
            />
          }
        />
        <SettingRow
          label="DeepSeek Base URL"
          desc="默认 https://api.deepseek.com；使用代理时填写代理地址（可带 /v1）"
          right={
            <SettingsInput
              label="DeepSeek Base URL"
              className="w-[260px]"
              spellCheck={false}
              placeholder="https://api.deepseek.com"
              value={webDraft.baseUrl}
              onChange={(e) => setWebDraft((draft) => ({ ...draft, baseUrl: e.target.value }))}
              onBlur={() => savePreferences({ webSearchDeepseekBaseUrl: webDraft.baseUrl })}
            />
          }
        />
        <SettingRow
          label="SearXNG 地址"
          desc="自建实例地址；需在 settings.yml 的 search.formats 中开启 json"
          right={
            <SettingsInput
              label="SearXNG 地址"
              className="w-[260px]"
              spellCheck={false}
              placeholder="http://127.0.0.1:8080"
              value={webDraft.searxngUrl}
              onChange={(e) => setWebDraft((draft) => ({ ...draft, searxngUrl: e.target.value }))}
              onBlur={() => savePreferences({ webSearchSearxngUrl: webDraft.searxngUrl })}
            />
          }
        />
        <SettingRow
          label="网页抓取后端"
          desc="自动：本地正文抽取优先，失败或正文过短时回退 DeepSeek Fetch"
          right={
            <SettingsSelect
              label="网页抓取后端"
              value={preferences.webFetchProvider || 'auto'}
              onChange={(e) => savePreferences({
                webFetchProvider: e.target.value as NonNullable<UserPreferences['webFetchProvider']>,
              })}
            >
              <option value="auto">自动（推荐）</option>
              <option value="local">仅本地抽取</option>
              <option value="deepseek">仅 DeepSeek Fetch</option>
            </SettingsSelect>
          }
        />
        <SettingRow
          label="允许访问内网地址"
          desc="仅影响 read_url 的本地抓取；开启后存在 SSRF 风险，默认关闭"
          right={
            <SettingsSwitch
              label="允许访问内网地址"
              checked={preferences.webFetchAllowPrivate === true}
              onChange={(v) => savePreferences({ webFetchAllowPrivate: v })}
            />
          }
        />
        <SettingRow
          label="连接测试"
          desc="用当前配置搜索一次，验证 Key 或地址是否可用"
          right={
            <SettingsButton onClick={() => void testWebSearch()} disabled={webTest.state === 'running'}>
              {webTest.state === 'running' ? '测试中…' : '测试搜索'}
            </SettingsButton>
          }
        />
        {webTest.state !== 'idle' ? (
          <p className={`${T_META} py-2 ${webTest.state === 'ok' ? 'text-success' : webTest.state === 'error' ? 'text-error' : ''}`}>
            {webTest.message}
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection title="文件浏览器" description="文件树的可见范围。">
        <SettingRow
          label="显示隐藏文件"
          desc="在文件树中显示 . 开头的隐藏文件和文件夹"
          right={<SettingsSwitch label="显示隐藏文件" checked={preferences.showHiddenFiles} onChange={(v) => savePreferences({ showHiddenFiles: v })} />}
        />
      </SettingsSection>

      <SettingsSection
        title="语言服务"
        description={`为不同语言配置启动命令，每行一条，格式「语言ID: 命令」${lspServerCount > 0 ? ` · 已配置 ${lspServerCount} 个` : ''}`}
      >
        <SettingRow
          label="LSP 服务器"
          desc="失焦即保存；留空则关闭该语言的语言服务"
          stacked
          right={
            <SettingsTextarea
              label="LSP 服务器"
              value={lspServersText}
              onChange={(e) => setLspServersText(e.target.value)}
              onBlur={() => {
                const map: Record<string, string> = {}
                for (const line of lspServersText.split('\n')) {
                  const idx = line.indexOf(':')
                  if (idx > 0 && line.slice(idx + 1).trim()) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
                }
                savePreferences({ lspServers: map })
              }}
              placeholder={'python: pylsp\ngo: gopls -mode stdio\nrust: rust-analyzer'}
              className="h-24"
              spellCheck={false}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="危险操作" tone="danger" description="重置所有设置、配置和聊天记录，此操作不可撤销。">
        <div className="flex items-center justify-between gap-4 py-2">
          <p className={T_META}>包括 API 配置、聊天记录和偏好设置，都会被清空。</p>
          <SettingsButton
            variant="danger"
            onClick={() => {
              if (confirm('确定要重置所有设置吗？此操作不可撤销！')) {
                if (confirm('再次确认：所有数据将被清空，包括 API 配置、聊天记录和偏好设置。')) {
                  window.electronAPI.resetAll().then(() => {
                    useConfigStore.getState().resetStore()
                    useChatStore.getState().resetStore()
                    localStorage.clear()
                    window.location.reload()
                  })
                }
              }
            }}
          >
            重置所有设置
          </SettingsButton>
        </div>
      </SettingsSection>
    </>
  )

  const shortcutLabels: Record<string, string> = {
    file: '文件操作',
    edit: '编辑',
    view: '视图',
    chat: 'AI 助手',
    ai: 'AI 内联',
  }

  const shortcutsTab = (
    <>
      <SettingsSection
        title="键位方案"
        description="切换预设会覆盖当前自定义键位，可随时重置回 VS Code 方案。"
        actions={
          <>
            <SettingsSelect
              label="键位方案"
              value={shortcutStore.preset}
              onChange={(e) => shortcutStore.setPreset(e.target.value as ShortcutPreset)}
              className="min-w-[160px]"
            >
              <option value="vscode">VS Code 预设</option>
              <option value="jetbrains">JetBrains 预设</option>
              <option value="custom">自定义</option>
            </SettingsSelect>
            {shortcutStore.preset === 'custom' && (
              <SettingsButton onClick={() => shortcutStore.resetToPreset('vscode')}>重置</SettingsButton>
            )}
          </>
        }
      >
        <SettingRow
          label="自定义键位"
          desc={
            shortcutStore.preset === 'custom'
              ? '点击右侧键位可重新录入'
              : '切换到「自定义」后即可点击键位录入新的组合'
          }
          right={<SettingsBadge tone={shortcutStore.preset === 'custom' ? 'accent' : 'neutral'}>{shortcutStore.shortcuts.length} 个快捷键</SettingsBadge>}
        />
      </SettingsSection>

      {(['file', 'edit', 'view', 'chat', 'ai'] as const).map((category) => {
        const items = shortcutStore.shortcuts.filter((s) => s.category === category)
        if (items.length === 0) return null
        return (
          <SettingsSection key={category} title={shortcutLabels[category]} description={`${items.length} 个操作`}>
            {items.map((s) => (
              <SettingRow
                key={s.id}
                label={s.description}
                right={
                  <KeyCap
                    editable={shortcutStore.preset === 'custom'}
                    onClick={async () => {
                      if (shortcutStore.preset !== 'custom') return
                      const k = await askText({ title: '输入新快捷键', defaultValue: s.keys })
                      if (k) shortcutStore.updateShortcut(s.id, k)
                    }}
                  >
                    {s.keys}
                  </KeyCap>
                }
              />
            ))}
          </SettingsSection>
        )
      })}
    </>
  )

  /** In-page index for the (long) features tab. */
  const FEATURE_SECTIONS = [
    { id: 'settings-feature-update', label: '软件更新' },
    { id: 'settings-feature-claw', label: '渠道接入' },
    { id: 'settings-feature-entry', label: '功能入口' },
    { id: 'settings-feature-nolimits', label: '无限制模式' },
  { id: 'settings-feature-computer', label: '电脑操控' },
    { id: 'settings-feature-plugins', label: '插件' },
    { id: 'settings-feature-project', label: '项目设置' },
    { id: 'settings-feature-mcp', label: 'MCP 服务器' },
  ]

  const jumpToSection = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
  }

  const featuresTab = (
    <>
      <nav aria-label="功能分区" className="flex flex-wrap items-center gap-1.5">
        {FEATURE_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => jumpToSection(s.id)}
            className="h-7 rounded-full border border-nova-border px-2.5 text-[12px] leading-[18px] text-nova-text-secondary transition-colors hover:border-accent-40 hover:text-nova-text-primary"
          >
            {s.label}
          </button>
        ))}
      </nav>

      <SettingsSection id="settings-feature-update" title="软件更新" description="更新来源、自动检查与安装时机。">
        <SettingRow
          label="自动检查更新"
          desc="启动后自动检查新版本（后台静默检查，发现新版本时提示）"
          right={<SettingsSwitch label="自动检查更新" checked={preferences.autoUpdateCheck !== false} onChange={(v) => savePreferences({ autoUpdateCheck: v })} />}
        />
        <SettingRow
          label="自动下载更新"
          desc="发现新版本后自动后台下载，重启应用时安装"
          right={<SettingsSwitch label="自动下载更新" checked={!!preferences.autoUpdateDownload} onChange={(v) => savePreferences({ autoUpdateDownload: v })} />}
        />
        <SettingRow
          label="更新服务器"
          desc="留空使用默认源（GitHub Releases）；可填写自建服务器或镜像的 base URL，目录下需放 latest.yml 与安装包"
          stacked
          right={
            <div className="flex w-full items-center gap-2">
              <SettingsInput
                label="更新服务器"
                value={updateFeedUrl}
                onChange={(e) => setUpdateFeedUrl(e.target.value)}
                placeholder="https://example.com/updates"
                className="flex-1 font-mono"
              />
              <SettingsButton onClick={() => void handleSaveFeedUrl()} disabled={updateFeedUrl.trim() === (preferences.updateFeedUrl ?? '')}>
                保存
              </SettingsButton>
            </div>
          }
        />
        <SettingRow
          label="检查更新"
          desc={appVersion ? `当前版本 ${appVersion}` : '点击立即检查新版本'}
          right={
            <SettingsButton onClick={() => void checkForUpdate()} disabled={updateUiState === 'checking'}>
              {updateUiState === 'checking' ? '检查中…' : '立即检查'}
            </SettingsButton>
          }
        />
      </SettingsSection>

      {/* 微信通道（官方 ilink 协议，网关子进程 + 桥接层） */}
      <div id="settings-feature-claw"><ClawSettingsSection /></div>

      <SettingsSection id="settings-feature-entry" title="功能入口" description="进入独立的技能与记忆管理面板。">
        <SettingRow
          label="技能管理"
          desc="查看和启用 AI 技能（Slash 命令）"
          right={<SettingsButton onClick={() => { closeSettings(); useUIStore.getState().openSkillRegistry() }}>打开</SettingsButton>}
        />
        <SettingRow
          label="记忆管理"
          desc="查看、搜索和删除长期记忆"
          right={<SettingsButton onClick={() => { closeSettings(); useUIStore.getState().openMemoryManager() }}>打开</SettingsButton>}
        />
      </SettingsSection>

      {/* 无限制模式（no-limits）：破甲能力取自 dsh-purge，默认关闭 */}
      <div id="settings-feature-nolimits"><NoLimitsSettingsSection /></div>

      {/* 电脑操控（Computer Use）：桌面应用观察/操作，默认关闭 */}
      <ComputerUseSection />

      <SettingsSection id="settings-feature-plugins" title="插件（扩展）" description="安装、启用与卸载第三方扩展。">
        <PluginSection />
      </SettingsSection>

      <SettingsSection id="settings-feature-project" title="项目设置" description="项目跟随当前会话，切换项目请先打开文件夹。">
        <SettingRow
          label="当前项目"
          desc={currentProjectPath || '尚未打开项目（打开文件夹后开始一个对话即绑定）'}
          right={
            <SettingsButton
              onClick={async () => {
                const path = await window.electronAPI.openFolder()
                if (!path) return
                const ui = useUIStore.getState()
                ui.setRootPath(path)
                ui.enterProject(path)
                // Opening a folder only browses it — the current project
                // follows the active session, so switching projects means
                // starting a conversation in the opened folder.
                const configId = useConfigStore.getState().activeConfigGroupId
                if (configId) useChatStore.getState().createSession(configId, path)
              }}
            >
              {currentProjectPath ? '切换项目' : '打开文件夹'}
            </SettingsButton>
          }
        />
      </SettingsSection>

      <SettingsSection id="settings-feature-mcp" title="MCP 服务器" description="当前项目的 MCP 连接，保存后需重启对应会话。">
        <div className="py-1">
          <McpConfigSection rootPath={currentProjectPath} />
        </div>
      </SettingsSection>
    </>
  )

  return (
    <SettingsQueryContext.Provider value={query}>
      <SettingsLayout
        groups={NAV_GROUPS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        query={query}
        onQueryChange={setQuery}
        onClose={closeSettings}
        footer={
          <div className="flex items-center justify-between gap-2">
            <span className={T_META}>{appVersion ? `版本 ${appVersion}` : 'OurCode IDE'}</span>
            <SettingsBadge tone="accent">Esc 关闭</SettingsBadge>
          </div>
        }
      >
        {activeTab === 'api' && apiTab}
        {activeTab === 'appearance' && appearanceTab}
        {activeTab === 'editor' && editorTab}
        {activeTab === 'shortcuts' && shortcutsTab}
        {activeTab === 'features' && featuresTab}
      </SettingsLayout>

      {/* Model config editor sits above the settings dialog (z-160). */}
      {modelEditor && editingGroup && (
        <ModelConfigDialog
          provider={editingGroup.provider || 'custom'}
          initial={modelEditor.initial}
          seedModelId={modelEditor.seedModelId}
          existingCustomIds={customModels.map((c) => c.id)}
          onSave={handleSaveModelConfig}
          onClose={() => setModelEditor(null)}
        />
      )}
    </SettingsQueryContext.Provider>
  )
}

// ───────────── Small reusable components ─────────────

/** Per-step connection test report. */
function TestResultPanel({ steps, success }: { steps: ConnectionStep[]; success?: boolean }) {
  const tone = success === undefined ? 'neutral' : success ? 'success' : 'danger'
  const label = success === undefined ? '测试中' : success ? '连接成功' : '连接失败'
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-nova-border bg-nova-input-bg p-2.5">
      <SettingsBadge tone={tone}>{label}</SettingsBadge>
      {steps.map((step) => (
        <div key={step.name} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 text-[12px] leading-[18px]">
            <span className={step.ok ? 'text-success' : 'text-error'} aria-hidden="true">{step.ok ? '✓' : '✗'}</span>
            <span className="shrink-0 text-nova-text-primary">{step.name}</span>
            <span className="flex-1 truncate text-nova-text-muted">{step.detail}</span>
            {step.ms !== undefined && <span className="shrink-0 font-mono text-nova-text-muted">{step.ms}ms</span>}
          </div>
          {step.url && <div className="break-all pl-4 font-mono text-[12px] leading-[18px] text-nova-text-muted">{step.url}</div>}
        </div>
      ))}
    </div>
  )
}
