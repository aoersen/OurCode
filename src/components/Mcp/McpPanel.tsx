import { useState, useEffect, useCallback } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useI18n } from '@/i18n/useI18n'
import type { ToolDefinition } from '@shared/types'
import McpConfigSection from '../Settings/McpConfigSection'

/**
 * MCP 管理中心 — a left sidebar panel (same slot the old extension
 * marketplace used), opened from the activity bar like the other panels.
 *
 * Five tabs:
 *  - 服务器: configured servers from <root>/mcp_config.json with live
 *    connection state (connecting/ready/failed/restarting/disabled) and an
 *    enable/disable toggle (persisted via mcp:saveConfig + reload).
 *  - 配置: the full server editor (add / edit / delete, stdio + HTTP) —
 *    reuses the Settings form so configuring never requires leaving the panel.
 *  - 工具: every tool exposed by connected servers (mcp__<server>__<tool>)
 *    with its description and input schema.
 *  - 资源: resources/list → resources/read preview.
 *  - 提示词: prompts/list → prompts/get preview.
 *
 * Status is polled while the panel is mounted (cheap mcp:status IPC) so a
 * server that comes back online shows up without manual refreshes.
 */

type McpServerState = 'connecting' | 'ready' | 'failed' | 'restarting' | 'disabled' | 'stopped'

interface McpServerStatusItem {
  name: string
  state: McpServerState
  retry?: number
  error?: string
}

interface McpServerConfigEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  serverUrl?: string
  url?: string
  disabled?: boolean
  disabledTools?: string[]
  headers?: Record<string, string>
  skipTlsVerify?: boolean
}

interface McpResourceItem {
  server: string
  uri: string
  name?: string
  mimeType?: string
  description?: string
}

interface McpPromptItem {
  server: string
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

const STATE_BADGES: Record<McpServerState, string> = {
  ready: 'bg-[#22c55e]/15 text-[#22c55e] border-[#22c55e]/30',
  connecting: 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30',
  restarting: 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/30',
  disabled: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  stopped: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
}

export default function McpPanel() {
  // The current project follows the ACTIVE SESSION (same rule as SettingsModal)
  const currentProjectPath = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.projectPath ?? null)
  const t = useI18n()

  const [activeTab, setActiveTab] = useState<'servers' | 'config' | 'tools' | 'resources' | 'prompts'>('servers')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Servers
  const [servers, setServers] = useState<Array<{ name: string; entry: McpServerConfigEntry; status?: McpServerStatusItem; file: string | null }>>([])
  // Tools / resources / prompts
  const [tools, setTools] = useState<ToolDefinition[]>([])
  const [resources, setResources] = useState<McpResourceItem[]>([])
  const [prompts, setPrompts] = useState<McpPromptItem[]>([])
  // Resource / prompt preview
  const [preview, setPreview] = useState<{ title: string; content: string; error?: string } | null>(null)

  const refreshServers = useCallback(async () => {
    setError(null)
    const [cfgRes, statusRes] = await Promise.all([
      currentProjectPath ? window.electronAPI.mcpGetConfig(currentProjectPath) : Promise.resolve({ ok: false as const, error: 'NO_PROJECT' }),
      window.electronAPI.mcpStatus(),
    ])
    if (!cfgRes.ok) {
      if (cfgRes.error === 'NO_PROJECT') {
        setServers([])
        return
      }
      // Raw "路径不在允许范围内" from the main process — show a user-friendly
      // message instead of the internal path-validation string.
      const friendly = cfgRes.error?.includes('路径不在允许范围内')
        ? t('mcpCenter.pathNotAllowed')
        : (cfgRes.error || '加载配置失败')
      setError(friendly)
      return
    }
    const statusMap = new Map((statusRes || []).map((s) => [s.name, s]))
    setServers(
      Object.entries(cfgRes.config.mcpServers || {}).map(([name, entry]) => ({
        name,
        entry: entry as McpServerConfigEntry,
        status: statusMap.get(name),
        file: cfgRes.file,
      })),
    )
  }, [currentProjectPath])

  const refreshTools = useCallback(async () => {
    setError(null)
    try {
      setTools(await window.electronAPI.mcpToolDefinitions())
    } catch (e: any) {
      setError(e.message || '加载工具失败')
    }
  }, [])

  const refreshResources = useCallback(async () => {
    setError(null)
    try {
      setResources(await window.electronAPI.mcpListResources())
    } catch (e: any) {
      setError(e.message || '加载资源失败')
    }
  }, [])

  const refreshPrompts = useCallback(async () => {
    setError(null)
    try {
      setPrompts(await window.electronAPI.mcpListPrompts())
    } catch (e: any) {
      setError(e.message || '加载提示词失败')
    }
  }, [])

  // The panel unmounts when the user switches activity-bar tabs, so effects
  // below run on every (re)entry — no extra open/close state needed.
  useEffect(() => {
    void refreshServers()
  }, [refreshServers])

  // Refresh per tab
  useEffect(() => {
    if (activeTab === 'tools') void refreshTools()
    else if (activeTab === 'resources') void refreshResources()
    else if (activeTab === 'prompts') void refreshPrompts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  // Live status polling while the panel is open — lets a reconnected server
  // show up without manual refreshes. Paused when an error is showing so the
  // banner doesn't reappear immediately after the user dismisses it.
  useEffect(() => {
    if (activeTab !== 'servers' || error) return
    const timer = setInterval(() => {
      if (document.hidden) return // 窗口隐藏时暂停轮询
      void refreshServers()
    }, 3000)
    return () => clearInterval(timer)
  }, [activeTab, refreshServers, error])

  const refreshAll = async () => {
    setLoading(true)
    try {
      if (activeTab === 'tools') await refreshTools()
      else if (activeTab === 'resources') await refreshResources()
      else if (activeTab === 'prompts') await refreshPrompts()
      else if (activeTab === 'servers') await refreshServers()
    } finally {
      setLoading(false)
    }
  }

  /** Toggle a server's enabled flag: rewrite its config entry (disabled) and
   *  reload — same persistence path as the Settings editor. */
  const toggleServer = async (name: string, enabled: boolean) => {
    if (!currentProjectPath) return
    setError(null)
    const cfgRes = await window.electronAPI.mcpGetConfig(currentProjectPath)
    if (!cfgRes.ok) {
      const friendly = cfgRes.error?.includes('路径不在允许范围内')
        ? t('mcpCenter.pathNotAllowed')
        : (cfgRes.error || '读取配置失败')
      setError(friendly)
      return
    }
    const mcpServers = { ...(cfgRes.config.mcpServers || {}) }
    const entry: any = { ...(mcpServers[name] || {}) }
    if (enabled) delete entry.disabled
    else entry.disabled = true
    mcpServers[name] = entry
    const saveRes = await window.electronAPI.mcpSaveConfig(currentProjectPath, { mcpServers }, cfgRes.file)
    if (!saveRes.ok) {
      setError(saveRes.error || '保存配置失败')
      return
    }
    await refreshServers()
  }

  const readResource = async (item: McpResourceItem) => {
    setPreview({ title: item.name || item.uri, content: '加载中…' })
    const res = await window.electronAPI.mcpReadResource(item.server, item.uri)
    if (res.ok) setPreview({ title: item.name || item.uri, content: res.result || '(空)' })
    else setPreview({ title: item.name || item.uri, content: '', error: res.error })
  }

  const getPrompt = async (item: McpPromptItem) => {
    setPreview({ title: item.name, content: '加载中…' })
    const res = await window.electronAPI.mcpGetPrompt(item.server, item.name)
    if (res.ok) setPreview({ title: item.name, content: JSON.stringify(res.result, null, 2) })
    else setPreview({ title: item.name, content: '', error: res.error })
  }

  const tabs = [
    { key: 'servers' as const, label: t('mcpCenter.tabServers') },
    { key: 'config' as const, label: t('mcpCenter.tabConfig') },
    { key: 'tools' as const, label: t('mcpCenter.tabTools') },
    { key: 'resources' as const, label: t('mcpCenter.tabResources') },
    { key: 'prompts' as const, label: t('mcpCenter.tabPrompts') },
  ]

  return (
    <div className="h-full flex flex-col">
      {/* Panel header — same pattern as SkillPanel (own header: title + refresh) */}
      <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 36 }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-nova-text-muted flex items-center shrink-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </span>
          <span
            className="font-bold uppercase tracking-[0.08em] truncate"
            style={{ fontSize: 11, color: 'var(--text-secondary)', letterSpacing: '0.08em' }}
          >
            {t('mcpCenter.title')}
          </span>
        </div>
        <button
          onClick={refreshAll}
          disabled={loading}
          className="w-6 h-6 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover transition-colors disabled:opacity-50"
          title={t('mcpCenter.refresh')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 px-2 pb-1 border-b border-nova-border shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === tab.key
                ? 'text-nova-accent bg-nova-accent/10'
                : 'text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover'
            }`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        {error && (
          <div className="p-2.5 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
            <span className="text-xs text-red-400">{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300 text-[10px] shrink-0">{t('plugin.close')}</button>
          </div>
        )}

        {activeTab === 'servers' && (
          <ServersTab
            servers={servers}
            rootPath={currentProjectPath}
            onToggle={toggleServer}
            onEditConfig={() => setActiveTab('config')}
            onReload={() => refreshServers()}
            hasError={!!error}
          />
        )}

        {/* 配置 — the full server editor lives here, no need to leave the panel */}
        {activeTab === 'config' && (
          <McpConfigSection rootPath={currentProjectPath} />
        )}

        {activeTab === 'tools' && (
          <div className="flex flex-col gap-2">
            {tools.length === 0 ? (
              <EmptyState text={t('mcpCenter.noTools')} />
            ) : (
              <>
                <p className="text-[10px] text-nova-text-muted px-1">{t('mcpCenter.toolCount', { count: tools.length })}</p>
                {tools.map((tool) => (
                  <ToolCard key={tool.function.name} tool={tool} />
                ))}
              </>
            )}
          </div>
        )}

        {activeTab === 'resources' && (
          <div className="flex flex-col gap-2">
            {resources.length === 0 ? (
              <EmptyState text={t('mcpCenter.noResources')} />
            ) : (
              resources.map((item) => (
                <button
                  key={`${item.server}:${item.uri}`}
                  onClick={() => readResource(item)}
                  className="text-left bg-nova-card border border-nova-border rounded-lg p-2.5 hover:border-nova-accent/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[11px] px-1 py-0.5 rounded bg-nova-hover text-nova-text-muted shrink-0 font-mono">{item.server}</span>
                      <span className="text-[11px] font-medium text-nova-text-primary truncate">{item.name || item.uri}</span>
                    </div>
                    <span className="text-[11px] text-nova-accent shrink-0">{t('mcpCenter.resourceRead')}</span>
                  </div>
                  {item.description && <p className="text-[10px] text-nova-text-muted mt-1 truncate">{item.description}</p>}
                  <p className="text-[11px] text-nova-text-muted/60 mt-0.5 font-mono truncate">{item.uri}</p>
                </button>
              ))
            )}
          </div>
        )}

        {activeTab === 'prompts' && (
          <div className="flex flex-col gap-2">
            {prompts.length === 0 ? (
              <EmptyState text={t('mcpCenter.noPrompts')} />
            ) : (
              prompts.map((item) => (
                <button
                  key={`${item.server}:${item.name}`}
                  onClick={() => getPrompt(item)}
                  className="text-left bg-nova-card border border-nova-border rounded-lg p-2.5 hover:border-nova-accent/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[11px] px-1 py-0.5 rounded bg-nova-hover text-nova-text-muted shrink-0 font-mono">{item.server}</span>
                      <span className="text-[11px] font-medium text-nova-text-primary truncate font-mono">{item.name}</span>
                    </div>
                    <span className="text-[11px] text-nova-accent shrink-0">{t('mcpCenter.promptGet')}</span>
                  </div>
                  {item.description && <p className="text-[10px] text-nova-text-muted mt-1">{item.description}</p>}
                  {item.arguments && item.arguments.length > 0 && (
                    <p className="text-[11px] text-nova-text-muted/60 mt-0.5">
                      {item.arguments.map((a) => (a.required ? `[${a.name}]` : `(${a.name})`)).join(' ')}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Resource / prompt preview drawer */}
      {preview && (
        <div className="border-t border-nova-border px-3 py-2.5 flex flex-col gap-2 shrink-0 max-h-[40%]">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-nova-text-secondary truncate font-mono">{preview.title}</span>
            <button
              onClick={() => setPreview(null)}
              className="p-1 text-nova-text-muted hover:text-nova-text-primary rounded transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeWidth={2} d="M6 6l12 12M6 18L18 6" />
              </svg>
            </button>
          </div>
          {preview.error ? (
            <p className="text-[11px] text-red-400">{preview.error}</p>
          ) : (
            <pre className="flex-1 overflow-y-auto text-[11px] text-nova-text-secondary bg-nova-bg border border-nova-border rounded-lg p-2 font-mono whitespace-pre-wrap break-all">
              {preview.content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function ServersTab({
  servers,
  rootPath,
  onToggle,
  onEditConfig,
  onReload,
  hasError,
}: {
  servers: Array<{ name: string; entry: McpServerConfigEntry; status?: McpServerStatusItem; file: string | null }>
  rootPath: string | null
  onToggle: (name: string, enabled: boolean) => void
  onEditConfig: () => void
  onReload: () => void
  hasError: boolean
}) {
  const t = useI18n()

  const stateLabel = (state: McpServerState): string => {
    const keys: Record<McpServerState, string> = {
      connecting: 'mcpCenter.state.connecting',
      ready: 'mcpCenter.state.ready',
      failed: 'mcpCenter.state.failed',
      restarting: 'mcpCenter.state.restarting',
      disabled: 'mcpCenter.state.disabled',
      stopped: 'mcpCenter.state.stopped',
    }
    return t(keys[state] as any)
  }

  return (
    <div className="flex flex-col gap-2">
      {!rootPath && !hasError && <EmptyState text={t('mcpCenter.noProject')} />}
      {rootPath && servers.length === 0 && !hasError && (
        <EmptyState text={t('mcpCenter.noServers')} />
      )}
      {servers.map(({ name, entry, status }) => {
        const state: McpServerState = status?.state || (entry.disabled ? 'disabled' : 'stopped')
        const isHttp = !!(entry.serverUrl || entry.url)
        return (
          <div key={name} className="bg-nova-card border border-nova-border rounded-lg p-2.5 flex flex-col gap-1.5 hover:border-nova-border-strong transition-colors">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-nova-text-primary font-mono truncate">{name}</span>
                <span className="text-[11px] px-1 py-0.5 rounded bg-nova-hover text-nova-text-muted shrink-0">
                  {isHttp ? t('mcpCenter.serverTypeHttp') : t('mcpCenter.serverTypeStdio')}
                </span>
              </div>
              <span className={`text-[11px] px-1.5 py-0.5 rounded-full border font-medium shrink-0 ${STATE_BADGES[state]}`}>
                {stateLabel(state)}
                {state === 'restarting' && status?.retry ? ` (${status.retry})` : ''}
              </span>
              <label className="flex items-center gap-1 text-[10px] text-nova-text-secondary cursor-pointer select-none shrink-0">
                <input
                  type="checkbox"
                  checked={state !== 'disabled'}
                  onChange={(e) => onToggle(name, e.target.checked)}
                  className="accent-nova-accent"
                />
                {t('mcpCenter.enable')}
              </label>
            </div>
            {(state === 'failed' || state === 'restarting') && status?.error && (
              <p className="text-[10px] text-red-400 truncate">{status.error}</p>
            )}
            <div className="text-[11px] text-nova-text-muted font-mono truncate">
              {isHttp ? (entry.serverUrl || entry.url) : `${entry.command || ''} ${(entry.args || []).join(' ')}`.trim()}
            </div>
            {entry.disabledTools && entry.disabledTools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {entry.disabledTools.map((tool) => (
                  <span key={tool} className="text-[11px] px-1 py-0.5 rounded border border-gray-500/20 bg-gray-500/10 text-gray-400 line-through">
                    {tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {rootPath && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onReload}
            className="px-2.5 py-1.5 text-[10px] text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover rounded-md transition-colors"
          >
            {t('mcpCenter.reloadServers')}
          </button>
          <button
            onClick={onEditConfig}
            className="px-2.5 py-1.5 text-[10px] font-medium text-white rounded-full hover:opacity-90 transition-all shadow-sm" style={{ background: 'var(--grad-brand)' }}
          >
            {t('mcpCenter.editConfig')}
          </button>
        </div>
      )}
    </div>
  )
}

function ToolCard({ tool }: { tool: ToolDefinition }) {
  const t = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  // mcp__<server>__<toolName>
  const parts = tool.function.name.split('__')
  const server = parts[1] || ''
  const toolName = parts.slice(2).join('__') || tool.function.name

  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(tool.function.name)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="bg-nova-card border border-nova-border rounded-lg overflow-hidden hover:border-nova-border-strong transition-all">
      <div className="flex items-center gap-2 p-2.5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] px-1 py-0.5 rounded bg-nova-hover text-nova-text-muted shrink-0 font-mono">{server || '?'}</span>
            <span className="text-[11px] font-semibold text-nova-text-primary font-mono truncate">{toolName}</span>
          </div>
          <p className="text-[11px] text-nova-text-muted mt-0.5 truncate">{tool.function.description || t('plugin.noDescription')}</p>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); void copyName() }}
          className="px-1.5 py-1 text-[11px] text-nova-text-muted hover:text-nova-text-primary hover:bg-nova-hover rounded-md shrink-0 transition-colors"
          title={tool.function.name}
        >
          {copied ? t('mcpCenter.copied') : t('mcpCenter.copyName')}
        </button>
        <svg className={`w-3.5 h-3.5 text-nova-text-muted shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
      {expanded && (
        <div className="px-3 pb-3 border-t border-nova-border pt-2">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-[10px] font-medium text-nova-text-muted">Input Schema</h4>
            <span className="text-[11px] text-nova-text-muted font-mono truncate ml-2">{tool.function.name}</span>
          </div>
          <pre className="text-[10px] text-nova-text-secondary bg-nova-bg border border-nova-border rounded-lg p-2 font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
            {JSON.stringify(tool.function.parameters || {}, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-center py-10">
      <svg className="w-10 h-10 mx-auto text-nova-text-muted/30 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
      <p className="text-nova-text-muted text-xs px-4">{text}</p>
    </div>
  )
}
