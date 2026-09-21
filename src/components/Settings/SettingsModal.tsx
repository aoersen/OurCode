import { useState, useEffect, useRef } from 'react'
import { useConfigStore, ConnectionStep, ConnectionTestResult } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useShortcutStore, ShortcutPreset } from '@/stores/shortcutStore'
import { ApiConfigGroup, ModelInfo } from '@/types'
import {
  resolveFormat, FORMAT_META, PROVIDER_REGISTRY, getProviderMeta,
  EndpointFormat,
} from '@/services/llm/endpoints'
import McpConfigSection from './McpConfigSection'
import PluginSection from '../Plugin/PluginSection'

// Accent color presets
const THEME_COLOR_PRESETS = ['#2563eb', '#7c5cbf', '#059669', '#e11d48', '#f59e0b', '#0891b2']

const CONFIG_COLORS = [
  '#6C9EFF', '#B77CFF', '#4ADE80', '#FB923C', '#F87171', '#FACC15', '#2DD4BF', '#F472B6',
]

/** Only these wire formats are offered as explicit overrides. */
const FORMAT_ORDER: EndpointFormat[] = ['openai', 'responses', 'anthropic']

export default function SettingsModal() {
  const {
    configGroups, activeConfigGroupId, models,
    loadConfigGroups, createConfigGroup, updateConfigGroup,
    deleteConfigGroup, fetchModelsForGroup, testConnectionGroup,
    addCustomModel, removeCustomModel, customModels,
  } = useConfigStore()

  const { preferences, savePreferences } = useEditorStore()
  const { isSettingsOpen, closeSettings, setTheme, setThemeColor } = useUIStore()
  const themeColor = useUIStore((s) => s.themeColor)
  const shortcutStore = useShortcutStore()
  // The "current project" follows the ACTIVE SESSION — opening a folder only
  // browses it, so project settings (当前项目 label, MCP servers) use the
  // active conversation's bound project.
  const currentProjectPath = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.projectPath ?? null)

  const [activeTab, setActiveTab] = useState<'api' | 'appearance' | 'editor' | 'shortcuts' | 'features'>('api')
  const [editingGroup, setEditingGroup] = useState<Partial<ApiConfigGroup> | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  // Connection test state (per editor session)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testSteps, setTestSteps] = useState<ConnectionStep[]>([])
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)

  // Model management state (per editor session)
  const [editorModels, setEditorModels] = useState<ModelInfo[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelFetchError, setModelFetchError] = useState<string | null>(null)
  const [newModelName, setNewModelName] = useState('')

  const [showEditKey, setShowEditKey] = useState(false)
  const [headersText, setHeadersText] = useState('')
  const [lspServersText, setLspServersText] = useState(
    Object.entries(preferences.lspServers ?? {})
      .map(([lang, cmd]) => `${lang}: ${cmd}`)
      .join('\n'),
  )
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isSettingsOpen) {
      loadConfigGroups()
      useShortcutStore.getState().loadShortcuts()
      setEditingGroup(null)
      setIsCreating(false)
      setActiveTab('api')
      setShowEditKey(false)
      resetEditorState()
      dialogRef.current?.focus()
    }
  }, [isSettingsOpen, loadConfigGroups])

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

  /** Build a full ApiConfigGroup from the editor draft (for testing / model fetch). */
  function toFullGroup(group: Partial<ApiConfigGroup>): ApiConfigGroup {
    return {
      id: group.id || 'draft',
      name: group.name || '未命名配置',
      baseUrl: (group.baseUrl || '').trim(),
      apiKey: (group.apiKey || '').trim(),
      systemPrompt: group.systemPrompt || '',
      defaultModel: (group.defaultModel || '').trim(),
      provider: (group.provider || 'openai') as ApiConfigGroup['provider'],
      apiFormat: group.apiFormat,
      customHeaders: group.customHeaders || {},
      createdAt: group.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }
  }

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
    const name = newModelName.trim()
    if (!name || !editingGroup) return
    if (editorModels.some((m) => m.id === name)) { setNewModelName(''); return }
    addCustomModel({ name, provider: editingGroup.provider as ApiConfigGroup['provider'] })
    setEditorModels((prev) => [...prev, { id: name, name, isFree: false, isFavorite: false }])
    setNewModelName('')
  }

  const handleRemoveModel = (id: string) => {
    if (customModels.some((c) => c.id === id)) removeCustomModel(id)
    setEditorModels((prev) => prev.filter((m) => m.id !== id))
  }

  const handleImport = async () => {
    const { importConfigGroups } = useConfigStore.getState()
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const text = await file.text()
      const password = prompt('输入导入密码（无密码请留空）')
      await importConfigGroups(text, password || undefined)
      loadConfigGroups()
    }
    input.click()
  }

  const handleExport = async () => {
    const { exportConfigGroups } = useConfigStore.getState()
    const password = prompt('设置导出密码（无密码请留空）')
    const data = await exportConfigGroups(password || undefined)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `ourcode-configs-${Date.now()}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const fmt = resolveFormat(editingGroup?.provider || 'custom', editingGroup?.apiFormat)
  const providerMeta = getProviderMeta(editingGroup?.provider || '')
  const nativeFormat = providerMeta?.nativeFormat || 'openai'
  const formatOverrideWarning = !!editingGroup?.apiFormat
    && editingGroup.apiFormat !== 'auto'
    && editingGroup.apiFormat !== nativeFormat
  // Number of valid "Header: Value" lines currently in the custom-headers editor.
  const parsedHeaderCount = headersText.split('\n').reduce((n, line) => {
    const idx = line.indexOf(':')
    return idx > 0 && line.slice(idx + 1).trim() ? n + 1 : n
  }, 0)

  // ───────────── RENDER ─────────────
  return (
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="glass-modal rounded-xl shadow-2xl w-[1120px] max-w-[96vw] max-h-[90vh] flex flex-col overflow-hidden" style={{ animation: 'fadeIn 0.2s ease-out' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-7 py-5 border-b border-nova-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: 'rgba(37,99,235,0.15)', color: 'var(--accent)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-nova-text-primary" style={{ letterSpacing: '-0.3px' }}>设置</h2>
          </div>
          <button onClick={closeSettings} className="w-8 h-8 flex items-center justify-center rounded-md text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-7 py-1.5 border-b border-nova-border shrink-0" style={{ background: 'var(--bg)' }}>
          {([
            { key: 'api' as const, label: 'API 配置', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg> },
            { key: 'appearance' as const, label: '外观偏好', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg> },
            { key: 'editor' as const, label: '编辑器', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg> },
            { key: 'shortcuts' as const, label: '快捷键', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M6 16h.001M10 16h.001M14 16h.001" /></svg> },
            { key: 'features' as const, label: '功能', icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2l2.4 7.2H22l-6 4.6 2.3 7.2-6.3-4.5-6.3 4.5L8 13.8 2 9.2h7.6z" /></svg> },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              className={`flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'text-nova-accent bg-nova-accent/10'
                  : 'text-nova-text-muted hover:text-nova-text-secondary hover:bg-nova-hover'
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content: API tab manages its own two-pane scroll; other tabs scroll as one */}
        <div className={`flex-1 min-h-0 flex flex-col ${activeTab === 'api' ? 'px-7 py-4 overflow-hidden' : 'px-7 py-6 gap-6 overflow-y-auto'}`}>
          {/* ═══════ API 配置（Hermes 风格：左栏提供商 + 右侧编辑，独立滚动） ═══════ */}
          {activeTab === 'api' && (
            <div className="flex-1 min-h-0 flex gap-5">
              {/* ── Left rail (independent scroll) ── */}
              <div className="w-60 shrink-0 flex flex-col gap-4 border-r border-nova-border pr-4 -ml-7 pl-7 overflow-y-auto">
                <div>
                  <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                    <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                    API 配置
                  </h3>
                </div>

                <button onClick={() => startNewForProvider('openai')}
                  className="w-full px-3 py-2 text-xs bg-nova-accent text-white rounded-lg hover:opacity-90 transition-opacity flex items-center justify-center gap-1">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  新建配置
                </button>

                {/* Saved configs — on top, they are the primary quick pick */}
                <div className="flex flex-col gap-0.5">
                  <div className="text-[10px] font-semibold text-nova-text-muted uppercase tracking-wider px-2 py-1">
                    已保存配置（{configGroups.length}）
                  </div>
                  {configGroups.length === 0 ? (
                    <div className="text-[11px] text-nova-text-muted px-2 py-2 leading-relaxed">还没有配置，从下方选择一个提供商开始创建</div>
                  ) : (
                    configGroups.map((group) => {
                      const active = group.id === activeConfigGroupId
                      const selected = !isCreating && editingGroup?.id === group.id
                      return (
                        <button key={group.id} onClick={() => openSavedGroup(group)}
                          className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border transition-all text-left ${
                            selected
                              ? 'border-nova-accent bg-nova-accent/10 shadow-[0_0_0_1px_var(--accent)]'
                              : 'border-transparent hover:bg-nova-hover hover:border-nova-border'
                          }`}>
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: group.color || '#6C9EFF' }} />
                          <span className="flex-1 min-w-0">
                            <span className="block text-xs font-medium text-nova-text-primary truncate leading-tight">{group.name}</span>
                            <span className="block text-[10px] text-nova-text-muted truncate leading-tight font-mono">{group.baseUrl}</span>
                          </span>
                          {active && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-nova-accent/15 text-nova-accent shrink-0">使用中</span>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>

                {/* Provider picker (vertical) */}
                <div className="flex flex-col gap-0.5">
                  <div className="text-[10px] font-semibold text-nova-text-muted uppercase tracking-wider px-2 py-1">选择提供商</div>
                  {PROVIDER_REGISTRY.map((p) => {
                    const selected = isCreating && editingGroup?.provider === p.value
                    return (
                      <button key={p.value} onClick={() => startNewForProvider(p.value)}
                        className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border transition-all text-left ${
                          selected
                            ? 'border-nova-accent bg-nova-accent/10 shadow-[0_0_0_1px_var(--accent)]'
                            : 'border-transparent hover:bg-nova-hover hover:border-nova-border'
                        }`}>
                        <div className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0" style={{ background: `${p.color}20`, color: p.color }}>
                          {p.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-nova-text-primary leading-tight">{p.label}</div>
                          <div className="text-[10px] text-nova-text-muted truncate leading-tight">{p.description}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>

                {/* Import / export */}
                <div className="flex gap-1.5 mt-auto">
                  <button onClick={handleImport} className="flex-1 px-2 py-1.5 text-[11px] bg-nova-hover text-nova-text-secondary rounded-lg hover:text-nova-text-primary transition-colors flex items-center justify-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                    导入
                  </button>
                  <button onClick={handleExport} className="flex-1 px-2 py-1.5 text-[11px] bg-nova-hover text-nova-text-secondary rounded-lg hover:text-nova-text-primary transition-colors flex items-center justify-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                    导出
                  </button>
                </div>
              </div>

              {/* ── Editor (right, independent scroll, compact so everything fits) ── */}
              <div className="flex-1 min-w-0 min-h-0 overflow-y-auto pr-1">
                {editingGroup ? (
                  <div className="flex flex-col gap-3">
                    {/* Provider banner — compact */}
                    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-nova-border bg-nova-card">
                      {providerMeta && (
                        <div className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold shrink-0" style={{ background: `${providerMeta.color}20`, color: providerMeta.color }}>
                          {providerMeta.icon}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-semibold text-nova-text-primary">{providerMeta?.label || editingGroup.provider}</span>
                        <span className="ml-2 text-[11px] text-nova-text-muted truncate">{providerMeta?.description}</span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-nova-hover text-nova-text-muted shrink-0">
                        请求格式：{FORMAT_META[fmt]?.label || fmt}
                      </span>
                      {!isCreating && editingGroup.id && (
                        <button onClick={handleDeleteGroup}
                          className="shrink-0 px-2 py-0.5 text-[11px] rounded-md bg-transparent text-nova-text-muted hover:text-red-400 transition-colors">删除</button>
                      )}
                    </div>

                    {/* Name + default model */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] font-medium text-nova-text-secondary">配置名称 <span className="text-red-400">*</span></label>
                        <input type="text" value={editingGroup.name || ''} onChange={(e) => setEditingGroup({ ...editingGroup, name: e.target.value })}
                          className="px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-[13px] text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] font-medium text-nova-text-secondary">默认模型</label>
                        <input type="text" list="settings-model-options" value={editingGroup.defaultModel || ''}
                          onChange={(e) => setEditingGroup({ ...editingGroup, defaultModel: e.target.value })}
                          placeholder="可输入或从列表选择"
                          className="px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-[13px] text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors font-mono" />
                        <datalist id="settings-model-options">
                          {editorModels.map((m) => <option key={m.id} value={m.id} />)}
                        </datalist>
                      </div>
                    </div>

                    {/* Base URL */}
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-medium text-nova-text-secondary">API 基础 URL <span className="text-red-400">*</span></label>
                      <input type="text" value={editingGroup.baseUrl || ''} onChange={(e) => setEditingGroup({ ...editingGroup, baseUrl: e.target.value })}
                        placeholder={providerMeta?.defaultBaseUrl || 'https://api.example.com/v1'}
                        className="px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-[13px] text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors font-mono" />
                      <label className="flex items-center gap-1.5 text-[11px] text-nova-text-secondary cursor-pointer select-none mt-0.5">
                        <input
                          type="checkbox"
                          checked={!!editingGroup.skipTlsVerify}
                          onChange={(e) => setEditingGroup({ ...editingGroup, skipTlsVerify: e.target.checked })}
                          className="accent-nova-accent"
                        />
                        <span>跳过证书校验（仅内网自签名证书）</span>
                      </label>
                    </div>

                    {/* API request format — only the 3 supported wire formats */}
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-medium text-nova-text-secondary">
                        API 请求格式
                      </label>
                      <div className="grid grid-cols-4 gap-1.5">
                        <button
                          className={`flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-lg border text-left transition-all ${
                            (editingGroup.apiFormat || 'auto') === 'auto'
                              ? 'border-nova-accent bg-nova-accent/10 shadow-[0_0_0_1px_var(--accent)]'
                              : 'border-nova-border bg-nova-card hover:border-nova-border-strong'
                          }`}
                          onClick={() => setEditingGroup({ ...editingGroup, apiFormat: 'auto' })}
                        >
                          <span className="flex items-center gap-1 text-[11px] font-medium text-nova-text-primary leading-tight">
                            跟随提供商默认
                            <span className="text-[9px] px-1 py-0.5 rounded-full bg-nova-accent/15 text-nova-accent shrink-0">推荐</span>
                          </span>
                          <span className="text-[9px] text-nova-text-muted leading-tight">
                            {FORMAT_META[nativeFormat].label} · {FORMAT_META[nativeFormat].desc}
                          </span>
                        </button>
                        {FORMAT_ORDER.map((f) => {
                          const isNative = f === nativeFormat
                          const selected = editingGroup.apiFormat === f
                          return (
                            <button key={f}
                              className={`flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-lg border text-left transition-all ${
                                selected
                                  ? 'border-nova-accent bg-nova-accent/10 shadow-[0_0_0_1px_var(--accent)]'
                                  : 'border-nova-border bg-nova-card hover:border-nova-border-strong'
                              }`}
                              onClick={() => setEditingGroup({ ...editingGroup, apiFormat: f })}
                            >
                              <span className="flex items-center gap-1 text-[11px] font-medium text-nova-text-primary leading-tight">
                                {FORMAT_META[f].label}
                                {isNative && <span className="text-[9px] px-1 py-0.5 rounded-full bg-green-500/15 text-green-400 shrink-0">推荐</span>}
                              </span>
                              <span className="text-[9px] text-nova-text-muted leading-tight">{FORMAT_META[f].desc}</span>
                            </button>
                          )
                        })}
                      </div>
                      {formatOverrideWarning && (
                        <div className="flex items-center gap-1.5 text-[11px] text-yellow-400/90 px-2 py-1 bg-yellow-500/10 border border-yellow-500/25 rounded-md">
                          ⚠ 该格式与提供商默认（{FORMAT_META[nativeFormat].label}）不同，请确认你的网关/服务确实支持
                        </div>
                      )}
                    </div>

                    {/* API key + color */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] font-medium text-nova-text-secondary">API 密钥 <span className="text-red-400">*</span></label>
                        <div className="flex gap-1.5">
                          <input type={showEditKey ? 'text' : 'password'} value={editingGroup.apiKey || ''} onChange={(e) => setEditingGroup({ ...editingGroup, apiKey: e.target.value })}
                            className="flex-1 px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-[13px] text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors font-mono" />
                          <button onClick={() => setShowEditKey(!showEditKey)}
                            className="px-2 py-1 text-[11px] bg-nova-hover text-nova-text-secondary rounded-md hover:text-nova-text-primary transition-colors shrink-0">
                            {showEditKey ? '🙈' : '👁'}
                          </button>
                        </div>
                        <span className="text-[9px] text-nova-text-muted">支持环境变量 <code className="px-0.5 bg-nova-hover rounded text-[9px]">$ENV_KEY</code></span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] font-medium text-nova-text-secondary">标识颜色</label>
                        <div className="flex items-center gap-1.5 flex-wrap flex-1 content-center">
                          {CONFIG_COLORS.map((c) => (
                            <button key={c} onClick={() => setEditingGroup({ ...editingGroup, color: c })}
                              className={`w-5 h-5 rounded-full border-2 transition-all hover:scale-110 ${editingGroup.color === c ? 'border-white shadow-[0_0_0_2px_var(--accent)]' : 'border-transparent'}`}
                              style={{ background: c }} />
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Model management */}
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-medium text-nova-text-secondary">
                          模型列表
                          {editorModels.length > 0 && <span className="ml-1 text-[10px] text-nova-text-muted">（{editorModels.length} 个）</span>}
                        </label>
                        <button onClick={handleFetchModels} disabled={fetchingModels || testing}
                          className="px-2 py-1 text-[11px] bg-nova-hover text-nova-text-secondary rounded-md hover:text-nova-text-primary transition-colors disabled:opacity-50 flex items-center gap-1.5">
                          {fetchingModels ? (
                            <>
                              <span className="w-3 h-3 border-2 border-nova-accent/30 border-t-nova-accent rounded-full animate-spin" />
                              获取中…
                            </>
                          ) : (
                            <>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                              获取模型列表
                            </>
                          )}
                        </button>
                      </div>
                      {modelFetchError && (
                        <div className="text-[10px] text-red-400 px-2 py-1 bg-red-500/10 border border-red-500/25 rounded-md break-all">{modelFetchError}</div>
                      )}
                      {editorModels.length > 0 ? (
                        <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                          {editorModels.map((m) => {
                            const isDefault = m.id === editingGroup.defaultModel
                            const isCustom = customModels.some((c) => c.id === m.id)
                            return (
                              <span key={m.id}
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer group ${
                                  isDefault
                                    ? 'border-nova-accent bg-nova-accent/15 text-nova-accent'
                                    : 'border-nova-border bg-nova-card text-nova-text-secondary hover:border-nova-accent/50'
                                }`}
                                title={isDefault ? '当前默认模型' : '点击设为默认模型'}
                                onClick={() => setEditingGroup({ ...editingGroup, defaultModel: m.id })}
                              >
                                {m.id}
                                {isCustom && (
                                  <button onClick={(e) => { e.stopPropagation(); handleRemoveModel(m.id) }}
                                    className="text-nova-text-muted hover:text-red-400 transition-colors opacity-60 group-hover:opacity-100" title="移除自定义模型">
                                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                                  </button>
                                )}
                              </span>
                            )
                          })}
                        </div>
                      ) : (
                        !fetchingModels && (
                          <div className="text-[10px] text-nova-text-muted px-2 py-1 bg-nova-hover/40 border border-dashed border-nova-border rounded-md">
                            暂无模型：点「获取模型列表」拉取，或在下方手动添加。
                          </div>
                        )
                      )}
                      <div className="flex gap-1.5">
                        <input type="text" value={newModelName} onChange={(e) => setNewModelName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleAddModel() }}
                          placeholder="手动添加模型名，如 deepseek-reasoner"
                          className="flex-1 px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-xs text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors font-mono" />
                        <button onClick={handleAddModel} disabled={!newModelName.trim()}
                          className="px-2.5 py-1.5 text-xs bg-nova-hover text-nova-text-secondary rounded-md hover:text-nova-text-primary transition-colors disabled:opacity-50 shrink-0">＋ 添加</button>
                      </div>
                    </div>

                    {/* Custom headers (collapsed by default, expand to edit) */}
                    <details className="group rounded-lg border border-nova-border bg-nova-card">
                      <summary className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-nova-text-secondary cursor-pointer hover:text-nova-text-primary transition-colors select-none list-none [&::-webkit-details-marker]:hidden">
                        <svg className="w-3 h-3 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6" /></svg>
                        自定义请求头
                        {parsedHeaderCount > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-nova-hover text-nova-text-muted">{parsedHeaderCount} 条</span>
                        )}
                      </summary>
                      <div className="flex flex-col gap-1 px-2.5 pb-2.5 pt-1">
                        <span className="text-[9px] text-nova-text-muted">每行一条，格式：Header: Value</span>
                        <textarea value={headersText}
                          onChange={(e) => setHeadersText(e.target.value)}
                          onBlur={() => {
                            const map: Record<string, string> = {}
                            for (const line of headersText.split('\n')) {
                              const idx = line.indexOf(':')
                              if (idx > 0 && line.slice(idx + 1).trim()) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
                            }
                            setEditingGroup({ ...editingGroup, customHeaders: map })
                          }}
                          placeholder={'Authorization: Bearer sk-xxx\nX-API-Key: xxx'}
                          className="w-full h-24 px-2.5 py-2 bg-nova-input-bg border border-nova-border rounded-md text-xs text-nova-text-primary resize-none outline-none focus:border-nova-accent/50 font-mono" />
                      </div>
                    </details>

                    {/* Test result panel */}
                    {(testing || testSteps.length > 0 || testError) && (
                      <div className="flex flex-col gap-1.5">
                        {testError && !testing && (
                          <div className="flex items-center gap-1.5 text-[11px] text-red-400 px-2 py-1.5 bg-red-500/10 border border-red-500/25 rounded-md">{testError}</div>
                        )}
                        {testing && (
                          <div className="flex items-center gap-2 text-[11px] text-nova-text-secondary px-2 py-1.5">
                            <span className="w-3 h-3 border-2 border-nova-accent/30 border-t-nova-accent rounded-full animate-spin" />
                            正在测试连接…
                          </div>
                        )}
                        {testSteps.length > 0 && <TestResultPanel steps={testSteps} success={testResult?.success} />}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex justify-end gap-2 pt-2 border-t border-nova-border">
                      <button onClick={() => { setEditingGroup(null); setIsCreating(false); resetEditorState() }}
                        className="px-3.5 py-1.5 text-[13px] bg-nova-hover text-nova-text-secondary rounded-lg hover:text-nova-text-primary transition-colors">取消</button>
                      <button onClick={handleTest} disabled={testing}
                        className="px-3.5 py-1.5 text-[13px] bg-nova-hover text-nova-text-secondary rounded-lg hover:text-nova-text-primary transition-colors disabled:opacity-50">🧪 测试连接</button>
                      <button onClick={handleSaveGroup}
                        className="px-3.5 py-1.5 text-[13px] bg-nova-accent text-white rounded-lg hover:opacity-90 transition-opacity">💾 保存配置</button>
                    </div>
                  </div>
                ) : (
                  /* Empty state */
                  <div className="flex flex-col items-center justify-center gap-3 h-full min-h-[320px] text-center">
                    <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: 'rgba(37,99,235,0.12)', color: 'var(--accent)' }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                    </div>
                    <div className="text-sm font-semibold">选择一个提供商开始配置</div>
                    <div className="text-xs text-nova-text-muted max-w-[300px]">从左侧选择提供商新建配置，或点击已保存配置进行编辑。</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═══════ 外观偏好 ═══════ */}
          {activeTab === 'appearance' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-3">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  主题
                </h3>

                {/* Setting rows */}
                <SettingRow label="界面主题" desc="选择深色、浅色或跟随系统" right={
                  <select value={preferences.theme} onChange={(e) => { const th = e.target.value as any; savePreferences({ theme: th }); setTheme(th) }}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[160px]">
                    <option value="dark">🌙 深色模式</option>
                    <option value="light">☀️ 浅色模式</option>
                    <option value="system">💻 跟随系统</option>
                  </select>
                } />

                <SettingRow label="强调色" desc="修改界面主要强调色" right={
                  <div className="flex items-center gap-1.5">
                    {THEME_COLOR_PRESETS.map((c) => (
                      <button key={c} onClick={() => setThemeColor(c)}
                        className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${themeColor.toLowerCase() === c ? 'border-white shadow-[0_0_0_2px_var(--accent)]' : 'border-transparent'}`}
                        style={{ background: c }} />
                    ))}
                    <input type="color" value={themeColor} onChange={(e) => setThemeColor(e.target.value)}
                      className="w-6 h-6 rounded-full cursor-pointer border-2 border-nova-border p-0 bg-transparent" />
                  </div>
                } />

                <SettingRow label="界面语言" desc="选择界面显示语言" right={
                  <select value={preferences.language} onChange={(e) => savePreferences({ language: e.target.value as any })}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[160px]">
                    <option value="zh-CN">🇨🇳 简体中文</option>
                    <option value="en-US">🇺🇸 English</option>
                    <option value="system">💻 跟随系统</option>
                  </select>
                } />
              </div>

              <div className="flex flex-col gap-3">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  字体
                </h3>

                <SettingRow label="编辑器字号" desc="调整代码编辑器的字体大小" right={
                  <div className="flex items-center gap-2">
                    <input type="range" min={10} max={24} value={preferences.fontSize} onChange={(e) => savePreferences({ fontSize: Number(e.target.value) })}
                      className="w-[120px] accent-nova-accent" />
                    <span className="text-[11px] text-nova-text-muted w-8 text-right">{preferences.fontSize}px</span>
                  </div>
                } />

                <SettingRow label="制表符大小" desc="Tab 键对应的空格数" right={
                  <select value={preferences.tabSize} onChange={(e) => savePreferences({ tabSize: Number(e.target.value) })}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[120px]">
                    <option value={2}>2 空格</option>
                    <option value={4}>4 空格</option>
                    <option value={8}>8 空格</option>
                  </select>
                } />
              </div>
            </div>
          )}

          {/* ═══════ 编辑器 ═══════ */}
          {activeTab === 'editor' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-3">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  编辑器行为
                </h3>

                <SettingRow label="显示缩略图" desc="在编辑器右侧显示代码缩略导航图" right={
                  <ToggleButton on={preferences.showMinimap} onClick={() => savePreferences({ showMinimap: !preferences.showMinimap })} />
                } />
                <SettingRow label="对话历史编辑" desc="开启后支持编辑消息、拖动排序和批量删除" right={
                  <ToggleButton on={preferences.chatHistoryEditMode} onClick={() => savePreferences({ chatHistoryEditMode: !preferences.chatHistoryEditMode })} />
                } />
              </div>

              <div className="flex flex-col gap-3">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  AI 助手
                </h3>

                <SettingRow label="允许 AI 自动记忆" desc="开启后 AI 可在对话中自动把重要信息保存到长期记忆" right={
                  <ToggleButton on={preferences.aiAutoMemory} onClick={() => savePreferences({ aiAutoMemory: !preferences.aiAutoMemory })} />
                } />
                <SettingRow label="LLM 响应缓存" desc="相同请求直接复用上次结果，不再调用 API" right={
                  <ToggleButton on={preferences.llmResponseCache} onClick={() => savePreferences({ llmResponseCache: !preferences.llmResponseCache })} />
                } />
                <SettingRow label="Anthropic 提示词缓存" desc="重复的历史内容按缓存价计费（约 1/10）" right={
                  <ToggleButton on={preferences.anthropicPromptCache} onClick={() => savePreferences({ anthropicPromptCache: !preferences.anthropicPromptCache })} />
                } />
                <SettingRow label="Anthropic 缓存延长到 1 小时" desc="需模型支持，不支持时请求会失败" right={
                  <ToggleButton on={!!preferences.anthropicPromptCache1h} onClick={() => savePreferences({ anthropicPromptCache1h: !preferences.anthropicPromptCache1h })} />
                } />
                <SettingRow label="接收会话间消息" desc="其他会话发来的消息如何处理" right={
                  <select value={preferences.crossSessionInbound ?? 'accept'} onChange={(e) => savePreferences({ crossSessionInbound: e.target.value as 'accept' | 'hold' | 'refuse' })}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[160px]">
                    <option value="accept">✅ 接受并自动处理</option>
                    <option value="hold">📥 暂存（仅投递）</option>
                    <option value="refuse">🚫 拒绝接收</option>
                  </select>
                } />
                <SettingRow label="Agent 工具调用轮数上限" desc="Agent 循环中连续调用工具的轮数上限，防止一次运行过久" right={
                  <select value={preferences.agentMaxIterations ?? 0} onChange={(e) => savePreferences({ agentMaxIterations: Number(e.target.value) })}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[160px]">
                    <option value={0}>♾️ 无限（默认）</option>
                    <option value={50}>50 轮</option>
                    <option value={100}>100 轮</option>
                    <option value={200}>200 轮</option>
                    <option value={500}>500 轮</option>
                  </select>
                } />
                <SettingRow label="LLM 请求自动重试" desc="自动重试瞬时性失败（超时 / 网络 / 限流）" right={
                  <ToggleButton on={preferences.llmRetryEnabled !== false} onClick={() => savePreferences({ llmRetryEnabled: preferences.llmRetryEnabled === false })} />
                } />
                <SettingRow label="重试次数上限" desc="每次请求失败后最多自动重试的次数" right={
                  <select value={preferences.llmRetryMaxRetries ?? 2} onChange={(e) => savePreferences({ llmRetryMaxRetries: Number(e.target.value) })}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[160px]">
                    <option value={0}>0 次（关闭重试）</option>
                    <option value={1}>1 次</option>
                    <option value={2}>2 次（默认）</option>
                    <option value={3}>3 次</option>
                  </select>
                } />
                <SettingRow label="模型请求日志" desc="把每次模型请求（脱敏）记录到本地日志文件；内容是明文，排查完建议关闭" right={
                  <div className="flex items-center gap-2">
                    <ToggleButton
                      on={preferences.wireLogEnabled !== false}
                      onClick={() => { savePreferences({ wireLogEnabled: preferences.wireLogEnabled === false }) }}
                    />
                    <button
                      onClick={() => { void window.electronAPI.wireLogOpenDir().catch(() => {}) }}
                      className="px-2.5 py-1 text-xs text-nova-accent bg-nova-accent/10 hover:bg-nova-accent/20 rounded-md transition-colors"
                    >
                      打开日志目录
                    </button>
                  </div>
                } />
                <SettingRow label="工具输出截断上限" desc="工具结果超过该字符数时截断，保留首尾" right={
                  <select value={preferences.toolOutputMaxChars ?? 150000} onChange={(e) => savePreferences({ toolOutputMaxChars: Number(e.target.value) })}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[160px]">
                    <option value={50000}>50K 字符</option>
                    <option value={100000}>100K 字符</option>
                    <option value={150000}>150K 字符（默认）</option>
                    <option value={200000}>200K 字符</option>
                    <option value={500000}>500K 字符</option>
                  </select>
                } />
                <SettingRow label="上下文压缩" desc="上下文接近窗口上限时，把较早的历史压缩为摘要（原始消息不删除）" right={
                  <ToggleButton on={preferences.contextCompaction !== false} onClick={() => savePreferences({ contextCompaction: preferences.contextCompaction === false })} />
                } />
                <SettingRow label="压缩触发阈值" desc="估算上下文占模型窗口的比例，超过即压缩" right={
                  <select value={preferences.contextCompactionRatio ?? 0.8} onChange={(e) => savePreferences({ contextCompactionRatio: Number(e.target.value) })}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[160px]">
                    <option value={0.7}>70%</option>
                    <option value={0.8}>80%（默认）</option>
                    <option value={0.9}>90%</option>
                  </select>
                } />
                <SettingRow label="压缩使用模型" desc="生成压缩摘要的模型，可指定更便宜的模型省 token" right={
                  <select value={preferences.contextCompactionModel ?? ''} onChange={(e) => savePreferences({ contextCompactionModel: e.target.value || undefined })}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-sm text-nova-text-primary outline-none w-[160px]">
                    <option value="">跟随会话模型（默认）</option>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                  </select>
                } />
              </div>

              <div className="flex flex-col gap-3">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  文件浏览器
                </h3>

                <SettingRow label="显示隐藏文件" desc="在文件树中显示 . 开头的隐藏文件和文件夹" right={
                  <ToggleButton on={preferences.showHiddenFiles} onClick={() => savePreferences({ showHiddenFiles: !preferences.showHiddenFiles })} />
                } />
              </div>

              <div className="flex flex-col gap-3">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  LSP 服务器
                </h3>
                <p className="text-xs text-nova-text-muted">为不同语言配置语言服务器命令，格式：语言ID: 启动命令</p>
                <textarea
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
                  placeholder="python: pylsp&#10;go: gopls -mode stdio&#10;rust: rust-analyzer"
                  className="w-full h-20 p-3 bg-nova-input-bg border border-nova-border rounded-lg text-xs text-nova-text-primary font-mono resize-none outline-none focus:border-nova-accent/50"
                  spellCheck={false}
                />
              </div>

              {/* Danger zone */}
              <div className="border rounded-xl p-5" style={{ borderColor: 'rgba(244,135,113,0.3)', background: 'rgba(244,135,113,0.04)' }}>
                <h3 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider" style={{ color: 'var(--red)' }}>
                  <span style={{ width: 3, height: 14, background: 'var(--red)', borderRadius: 2 }} />
                  危险操作
                </h3>
                <p className="text-xs text-nova-text-muted mt-1.5 mb-3">重置所有设置、配置和聊天记录。此操作不可撤销。</p>
                <button
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
                  className="px-4 py-2 text-sm font-medium bg-red-500/15 text-red-400 border border-red-500/25 rounded-lg hover:bg-red-500/25 transition-colors inline-flex items-center gap-1.5"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  重置所有设置
                </button>
              </div>
            </div>
          )}

          {/* ═══════ 快捷键 ═══════ */}
          {activeTab === 'shortcuts' && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  键盘快捷方式
                </h3>
                <div className="flex items-center gap-2">
                  <select value={shortcutStore.preset} onChange={(e) => shortcutStore.setPreset(e.target.value as ShortcutPreset)}
                    className="px-3 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-xs text-nova-text-primary outline-none">
                    <option value="vscode">VS Code 预设</option>
                    <option value="jetbrains">JetBrains 预设</option>
                    <option value="custom">自定义</option>
                  </select>
                  {shortcutStore.preset === 'custom' && (
                    <button onClick={() => shortcutStore.resetToPreset('vscode')}
                      className="px-2 py-1 text-[10px] bg-nova-hover text-nova-text-muted rounded">重置</button>
                  )}
                </div>
              </div>

              {(['file', 'edit', 'view', 'chat', 'ai'] as const).map((category) => {
                const items = shortcutStore.shortcuts.filter((s) => s.category === category)
                if (items.length === 0) return null
                const labels: Record<string, string> = { file: '文件操作', edit: '编辑', view: '视图', chat: 'AI 助手', ai: 'AI 内联' }
                return (
                  <div key={category} className="flex flex-col gap-0.5">
                    <div className="text-[10px] font-semibold text-nova-text-muted uppercase tracking-wider px-3 py-1.5">{labels[category]}</div>
                    {items.map((s) => (
                      <div key={s.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-nova-hover transition-colors">
                        <span className="text-xs text-nova-text-secondary">{s.description}</span>
                        <kbd
                          className={`px-2 py-0.5 bg-nova-input-bg border border-nova-border rounded text-[10px] font-mono ${shortcutStore.preset === 'custom' ? 'text-nova-accent cursor-pointer' : 'text-nova-text-muted'}`}
                          onClick={() => { if (shortcutStore.preset !== 'custom') return; const k = prompt('输入新快捷键', s.keys); if (k?.trim()) shortcutStore.updateShortcut(s.id, k.trim()) }}
                        >
                          {s.keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          {/* ═══════ 功能（所有可配置功能的统一入口） ═══════ */}
          {activeTab === 'features' && (
            <div className="flex flex-col gap-6">
              {/* 功能入口 */}
              <section className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  功能入口
                </h3>
                <SettingRow
                  label="技能管理"
                  desc="查看和启用 AI 技能（Slash 命令）"
                  right={
                    <button
                      onClick={() => { closeSettings(); useUIStore.getState().openSkillRegistry() }}
                      className="px-3 py-1.5 text-xs text-nova-accent bg-nova-accent/10 hover:bg-nova-accent/20 rounded-md transition-colors"
                    >
                      打开
                    </button>
                  }
                />
                <SettingRow
                  label="记忆管理"
                  desc="查看、搜索和删除长期记忆"
                  right={
                    <button
                      onClick={() => { closeSettings(); useUIStore.getState().openMemoryManager() }}
                      className="px-3 py-1.5 text-xs text-nova-accent bg-nova-accent/10 hover:bg-nova-accent/20 rounded-md transition-colors"
                    >
                      打开
                    </button>
                  }
                />
              </section>

              {/* 插件（扩展） */}
              <section className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  插件（扩展）
                </h3>
                <PluginSection />
              </section>

              {/* 项目设置 */}
              <section className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  项目设置
                </h3>
                <SettingRow
                  label="当前项目"
                  desc={currentProjectPath || '尚未打开项目（打开文件夹后开始一个对话即绑定）'}
                  right={
                    <button
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
                      className="px-3 py-1.5 text-xs text-nova-accent bg-nova-accent/10 hover:bg-nova-accent/20 rounded-md transition-colors"
                    >
                      {currentProjectPath ? '切换项目' : '打开文件夹'}
                    </button>
                  }
                />
              </section>

              {/* MCP 服务器 */}
              <section className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
                  <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
                  MCP 服务器
                </h3>
                <McpConfigSection rootPath={currentProjectPath} />
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ───────────── Small reusable components ─────────────

function SettingRow({ label, desc, right }: { label: string; desc: string; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-nova-card border border-nova-border rounded-lg gap-4 hover:border-nova-border-strong transition-colors">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px] font-medium text-nova-text-primary">{label}</span>
        <span className="text-[11px] text-nova-text-muted">{desc}</span>
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        {right}
      </div>
    </div>
  )
}

function ToggleButton({ on, onClick, disabled = false }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-10 h-[22px] rounded-full transition-colors relative shrink-0 border-none ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      style={{ background: on ? 'var(--accent)' : 'var(--border)' }}
    >
      <div
        className="w-[18px] h-[18px] rounded-full bg-white absolute top-[1px] transition-all"
        style={{ left: on ? '20px' : '1px' }}
      />
    </button>
  )
}

/** Per-step connection test report. */
function TestResultPanel({ steps, success }: { steps: ConnectionStep[]; success?: boolean }) {
  return (
    <div className="flex flex-col gap-1 p-2 rounded-lg border border-nova-border bg-nova-card">
      <div className={`flex items-center gap-1.5 text-[11px] font-medium ${success === undefined ? 'text-nova-text-secondary' : success ? 'text-green-400' : 'text-red-400'}`}>
        <span>{success === undefined ? '测试中' : success ? '✓ 连接成功' : '✗ 连接失败'}</span>
      </div>
      {steps.map((step, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className={step.ok ? 'text-green-400' : 'text-red-400'}>{step.ok ? '✓' : '✗'}</span>
            <span className="text-nova-text-primary shrink-0">{step.name}</span>
            <span className="text-nova-text-muted truncate flex-1">{step.detail}</span>
            {step.ms !== undefined && <span className="text-nova-text-muted shrink-0 font-mono">{step.ms}ms</span>}
          </div>
          {step.url && (
            <div className="text-[9px] font-mono text-nova-text-muted break-all pl-4">{step.url}</div>
          )}
        </div>
      ))}
    </div>
  )
}
