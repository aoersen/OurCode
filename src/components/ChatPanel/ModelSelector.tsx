import { useState, useMemo, lazy, Suspense } from 'react'
import { useConfigStore, setLastModelForGroup } from '@/stores/configStore'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { lookupModelMetadata } from '@/types'

const ModelCompareView = lazy(() => import('./ModelCompareView'))

/** Extract provider hint from model ID */
function getProviderFromModelId(modelId: string): string {
  const lower = modelId.toLowerCase()
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('chatgpt')) return 'openai'
  if (lower.startsWith('claude')) return 'anthropic'
  if (lower.startsWith('gemini') || lower.startsWith('palm')) return 'google'
  if (lower.startsWith('deepseek')) return 'deepseek'
  if (lower.startsWith('llama') || lower.startsWith('mixtral') || lower.startsWith('gemma')) return 'groq'
  if (lower.includes('qwen')) return 'alibaba'
  if (lower.includes('mistral')) return 'mistral'
  return 'other'
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f', anthropic: '#d47757', google: '#4285f4', deepseek: '#4f46e5', groq: '#f97316', other: '#2563eb',
}

export default function ModelSelector() {
  const models = useConfigStore((s) => s.models)
  const isLoadingModels = useConfigStore((s) => s.isLoadingModels)
  const modelsError = useConfigStore((s) => s.modelsError)
  const configGroups = useConfigStore((s) => s.configGroups)
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const setActiveConfigGroup = useConfigStore((s) => s.setActiveConfigGroup)
  const fetchModels = useConfigStore((s) => s.fetchModels)
  const getActiveConfigGroup = useConfigStore((s) => s.getActiveConfigGroup)
  const toggleFavorite = useConfigStore((s) => s.toggleFavorite)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const getActiveSession = useChatStore((s) => s.getActiveSession)
  const updateSessionModel = useChatStore((s) => s.updateSessionModel)
  const openSettings = useUIStore((s) => s.openSettings)

  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const [showModelList, setShowModelList] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  const [showFavorites, setShowFavorites] = useState(false)
  const [showCompare, setShowCompare] = useState(false)

  const activeSession = getActiveSession()
  const activeGroup = getActiveConfigGroup()
  // The session's OWN config group — the runtime model resolves from
  // session.model || session.configGroup.defaultModel (chatStore), so the
  // selector must follow the session's group, NOT the globally active one
  // (they can diverge right after startup or a group switch — using the global
  // group's defaultModel showed a freshly-added default as "current" even
  // though the conversation still ran on its own group's model).
  const sessionConfigGroup = useConfigStore((s) =>
    activeSession ? s.configGroups.find((g) => g.id === activeSession.configGroupId) : undefined
  )
  const currentModel = activeSession?.model || sessionConfigGroup?.defaultModel || activeGroup?.defaultModel || ''

  // Filter models of the currently selected provider
  const filteredModels = useMemo(() => {
    let result = [...models]
    if (freeOnly) result = result.filter((m) => m.isFree)
    if (showFavorites) result = result.filter((m) => m.isFavorite)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((m) => m.id.toLowerCase().includes(q) || (m.alias && m.alias.toLowerCase().includes(q)))
    }
    result.sort((a, b) => { if (a.isFavorite && !b.isFavorite) return -1; if (!a.isFavorite && b.isFavorite) return 1; return a.id.localeCompare(b.id) })
    return result
  }, [models, freeOnly, searchQuery, showFavorites])

  // Favorite models (for horizontal quick-access strip)
  const favoriteModels = useMemo(() => models.filter((m) => m.isFavorite), [models])

  const handleProviderSelect = (groupId: string) => {
    setShowProviderMenu(false)
    setShowModelList(false)
    if (groupId !== activeConfigGroupId) setActiveConfigGroup(groupId)
  }

  const handleModelChange = (modelId: string) => {
    // Remember this choice so new sessions for this group start with it
    if (activeConfigGroupId) setLastModelForGroup(activeConfigGroupId, modelId)
    if (activeSessionId) {
      // Rebinding the session to the active group keeps its API key/base URL
      // in sync with the provider the model was picked from. Without this the
      // session keeps authenticating with a stale group's key (401).
      updateSessionModel(activeSessionId, modelId, activeConfigGroupId || undefined)
    }
    setShowModelList(false)
  }

  const freeCount = models.filter((m) => m.isFree).length

  return (
    <div className="space-y-2">
      {/* ── Provider first, then model ── */}
      <div className="flex items-center gap-2">
        {/* Provider selector */}
        <button
          onClick={() => { setShowProviderMenu(!showProviderMenu); setShowModelList(false) }}
          className="flex items-center gap-1.5 py-1.5 pl-2.5 pr-2 bg-nova-input-bg text-nova-text-secondary rounded-full border border-nova-border text-xs hover:border-nova-accent/40 transition-colors max-w-[45%]"
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: activeGroup?.color || '#6C9EFF' }} />
          <span className="truncate">{activeGroup?.name || '选择提供商'}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 opacity-60"><polyline points="6 9 12 15 18 9" /></svg>
        </button>

        {/* Model selector */}
        <button
          onClick={() => { setShowModelList(!showModelList); setShowProviderMenu(false) }}
          className="flex-1 min-w-0 py-1.5 px-3 bg-nova-input-bg text-nova-text-secondary rounded-full border border-nova-border text-xs text-left flex items-center gap-2 hover:border-nova-accent/40 transition-colors"
        >
          {currentModel ? (
            <>
              <span className="truncate">{currentModel}</span>
              {lookupModelMetadata(currentModel)?.contextWindow && (
                <span className="text-[10px] text-nova-text-muted shrink-0">
                  {Math.round((lookupModelMetadata(currentModel)?.contextWindow || 0) / 1000)}K
                </span>
              )}
            </>
          ) : (
            <span className="text-nova-text-muted">
              {isLoadingModels ? '加载中…' : '选择模型'}
            </span>
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 ml-auto opacity-60"><polyline points="6 9 12 15 18 9" /></svg>
        </button>

        <button onClick={() => fetchModels()} disabled={isLoadingModels}
          className="p-1.5 rounded-lg text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover disabled:opacity-50 transition-colors" title="刷新模型列表">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>

        {models.length > 0 && (
          <button onClick={() => setShowCompare(true)}
            className="p-1.5 rounded-lg text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors" title="模型对比">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Provider dropdown ── */}
      {showProviderMenu && (
        <div className="bg-nova-card border border-nova-border rounded-xl overflow-hidden" style={{ animation: 'fadeIn 0.15s ease-out' }}>
          {configGroups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
              <div className="text-xs font-medium text-nova-text-primary">还没有 API 配置</div>
              <div className="text-[10px] text-nova-text-muted">添加一个提供商后即可选择模型</div>
              <button
                onClick={() => { setShowProviderMenu(false); openSettings() }}
                className="mt-1 px-3 py-1.5 text-[11px] bg-nova-accent text-white rounded-lg hover:opacity-90 transition-opacity">
                去设置添加配置
              </button>
            </div>
          ) : (
            <div className="py-1">
              <div className="text-[10px] font-semibold text-nova-text-muted uppercase tracking-wider px-3 py-1.5">选择 API 配置（提供商）</div>
              {configGroups.map((g) => {
                const active = g.id === activeConfigGroupId
                return (
                  <button key={g.id} onClick={() => handleProviderSelect(g.id)}
                    className={`flex items-center gap-2.5 w-full px-3.5 py-2 text-left transition-colors ${
                      active ? 'bg-nova-accent/10' : 'hover:bg-nova-hover'
                    }`}>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color || '#6C9EFF' }} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12px] font-medium text-nova-text-primary truncate">{g.name}</span>
                      <span className="block text-[10px] text-nova-text-muted truncate font-mono">{g.baseUrl}</span>
                    </span>
                    {active && <span className="text-[11px] text-nova-accent shrink-0">✓</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Model dropdown ── */}
      {showModelList && (
        <div className="bg-nova-card border border-nova-border rounded-xl overflow-hidden" style={{ animation: 'fadeIn 0.15s ease-out' }}>
          {models.length > 0 && (
            <>
              {/* Search */}
              <div className="relative px-2.5 pt-2">
                <svg className="absolute left-4.5 top-3.5 w-3 h-3 text-nova-text-muted pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="8" strokeWidth="2" /><line x1="21" y1="21" x2="16.65" y2="16.65" strokeWidth="2" />
                </svg>
                <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full pl-6 pr-2 py-1.5 bg-nova-input-bg border border-nova-border rounded text-[11px] text-nova-text-primary outline-none focus:border-nova-accent/50 placeholder-nova-text-muted" />
              </div>
              {/* Filters */}
              <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                <button onClick={() => setFreeOnly(!freeOnly)}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-full border transition-colors ${
                    freeOnly ? 'bg-green-500/15 text-green-400 border-green-500/40' : 'bg-nova-hover text-nova-text-muted border-transparent hover:text-nova-text-secondary'
                  }`}>
                  免费 {freeCount > 0 && `(${freeCount})`}
                </button>
                <button onClick={() => setShowFavorites(!showFavorites)}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-full border transition-colors ${
                    showFavorites ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/40' : 'bg-nova-hover text-nova-text-muted border-transparent hover:text-nova-text-secondary'
                  }`}>
                  ★ 收藏
                </button>
              </div>
            </>
          )}

          {/* Loading */}
          {isLoadingModels && (
            <div className="flex items-center gap-2 px-3.5 py-4 text-[11px] text-nova-text-secondary">
              <span className="w-3.5 h-3.5 border-2 border-nova-accent/30 border-t-nova-accent rounded-full animate-spin" />
              正在获取模型列表…
            </div>
          )}

          {/* Error */}
          {modelsError && (
            <div className="flex items-center gap-2 px-3.5 py-3 text-[11px] bg-red-500/10 border-t border-red-500/30 text-red-400">
              <span className="flex-1 truncate">获取模型失败: {modelsError}</span>
              <button onClick={() => fetchModels()} disabled={isLoadingModels}
                className="shrink-0 px-2 py-0.5 bg-red-500/20 text-red-300 rounded hover:bg-red-500/30 disabled:opacity-50 transition-colors">重试</button>
            </div>
          )}

          {/* Empty / no match */}
          {!isLoadingModels && !modelsError && filteredModels.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
              {models.length === 0 ? (
                <>
                  <div className="text-xs font-medium text-nova-text-primary">暂无模型</div>
                  <div className="text-[10px] text-nova-text-muted">点「刷新」从接口拉取，或在设置里添加模型</div>
                  <button onClick={() => fetchModels()} className="mt-1 px-3 py-1.5 text-[11px] bg-nova-hover text-nova-text-secondary rounded-lg hover:text-nova-text-primary transition-colors">
                    刷新获取模型
                  </button>
                </>
              ) : (
                <div className="text-[11px] text-nova-text-muted">没有匹配的模型</div>
              )}
            </div>
          )}

          {/* Model list */}
          {!isLoadingModels && filteredModels.length > 0 && (
            <div className="max-h-[220px] overflow-y-auto border-t border-nova-border">
              {filteredModels.slice(0, 50).map((model) => {
                const meta = lookupModelMetadata(model.id)
                const provider = getProviderFromModelId(model.id)
                return (
                  <div
                    key={model.id}
                    className={`flex items-center gap-2.5 px-3.5 py-2.5 cursor-pointer transition-colors border-b border-nova-border last:border-b-0 ${
                      currentModel === model.id ? 'bg-nova-accent/10' : 'hover:bg-nova-hover'
                    }`}
                    onClick={() => handleModelChange(model.id)}
                  >
                    {/* Star */}
                    <button onClick={(e) => { e.stopPropagation(); toggleFavorite(model.id) }}
                      className={`shrink-0 text-sm ${model.isFavorite ? 'text-yellow-400' : 'text-nova-text-muted hover:text-yellow-400'} bg-transparent border-none cursor-pointer`}>
                      {model.isFavorite ? '★' : '☆'}
                    </button>

                    {/* Provider icon */}
                    <div className="w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0"
                      style={{ background: `${PROVIDER_COLORS[provider] || '#2563eb'}20`, color: PROVIDER_COLORS[provider] || '#2563eb' }}>
                      {provider.charAt(0).toUpperCase()}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-nova-text-primary truncate">{model.alias || model.id}</div>
                      <div className="text-[10px] text-nova-text-muted">{provider}</div>
                    </div>

                    {/* Meta tags */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {meta?.contextWindow && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-nova-hover text-nova-text-muted">
                          {meta.contextWindow >= 1048576 ? `${Math.round(meta.contextWindow / 1048576)}M` : `${Math.round(meta.contextWindow / 1000)}K`}
                        </span>
                      )}
                      {meta?.vision && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-nova-accent/10 text-nova-accent">👁 视觉</span>
                      )}
                      {meta?.functionCall && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-nova-accent/10 text-nova-accent">⚡ 函数调用</span>
                      )}
                      {model.isFree && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400">免费</span>
                      )}
                    </div>
                  </div>
                )
              })}
              {filteredModels.length > 50 && (
                <div className="text-[10px] text-nova-text-muted text-center py-2">还有 {filteredModels.length - 50} 个模型...</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Persistent error banner (collapsed state) */}
      {modelsError && !showModelList && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] bg-red-500/10 border border-red-500/30 text-red-400">
          <span className="flex-1 truncate">获取模型失败: {modelsError}</span>
          <button onClick={() => fetchModels()} disabled={isLoadingModels}
            className="shrink-0 px-2 py-0.5 bg-red-500/20 text-red-300 rounded hover:bg-red-500/30 disabled:opacity-50 transition-colors">重试</button>
        </div>
      )}

      {/* Favorites quick-access strip */}
      {favoriteModels.length > 0 && (
        <div className="flex gap-2 overflow-x-auto py-1">
          {favoriteModels.map((m) => {
            const meta = lookupModelMetadata(m.id)
            const provider = getProviderFromModelId(m.id)
            return (
              <button
                key={m.id}
                onClick={() => handleModelChange(m.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full shrink-0 border transition-all ${
                  currentModel === m.id
                    ? 'border-nova-accent bg-nova-accent/10'
                    : 'border-nova-border bg-nova-card hover:border-nova-accent/50'
                }`}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PROVIDER_COLORS[provider] || '#2563eb' }} />
                <span className="text-[11px] font-medium text-nova-text-primary">{m.alias || m.id}</span>
                {meta?.contextWindow && (
                  <span className="text-[11px] text-nova-text-muted">{Math.round(meta.contextWindow / 1000)}K</span>
                )}
                <span className="text-[10px] text-yellow-400">★</span>
              </button>
            )
          })}
          <button
            onClick={() => setShowModelList(true)}
            className="flex items-center justify-center w-9 h-9 rounded-full border border-dashed border-nova-border text-nova-text-muted hover:text-nova-text-primary hover:border-nova-accent/50 transition-colors shrink-0"
            style={{ minWidth: 36 }}
          >
            <span className="text-sm">+</span>
          </button>
        </div>
      )}

      {/* Model comparison modal */}
      {showCompare && (
        <Suspense fallback={<div className="text-xs text-nova-text-muted">加载中...</div>}>
          <ModelCompareView onClose={() => setShowCompare(false)} />
        </Suspense>
      )}
    </div>
  )
}
