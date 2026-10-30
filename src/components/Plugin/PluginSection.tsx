import { useState, useEffect } from 'react'
import { usePluginStore } from '@/stores/pluginStore'
import { PluginInfo, PluginManifest } from '@/services/plugin/types'
import { useI18n } from '@/i18n/useI18n'

/**
 * 插件（扩展）管理区 — the old extension marketplace, embedded in Settings
 * (设置 → 功能) instead of a standalone modal. Installation / uninstall /
 * enable-disable / permission logic is unchanged.
 */
export default function PluginSection() {
  const plugins = usePluginStore((s) => s.plugins)
  const isInstalling = usePluginStore((s) => s.isInstalling)
  const error = usePluginStore((s) => s.error)
  const loadPlugins = usePluginStore((s) => s.loadPlugins)
  const installPlugin = usePluginStore((s) => s.installPlugin)
  const uninstallPlugin = usePluginStore((s) => s.uninstallPlugin)
  const togglePlugin = usePluginStore((s) => s.togglePlugin)
  const clearError = usePluginStore((s) => s.clearError)
  const t = useI18n()

  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<'installed' | 'install'>('installed')
  const [manifestText, setManifestText] = useState('')
  const [codeText, setCodeText] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)
  const [showConfirmUninstall, setShowConfirmUninstall] = useState<string | null>(null)

  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])

  const filteredPlugins = plugins.filter((p) => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      p.manifest.name.toLowerCase().includes(q) ||
      p.manifest.description.toLowerCase().includes(q) ||
      p.manifest.author.toLowerCase().includes(q) ||
      p.manifest.id.toLowerCase().includes(q)
    )
  })

  const handleInstallFromFile = async () => {
    setInstallError(null)
    try {
      const manifest: PluginManifest = JSON.parse(manifestText)
      if (!manifest.id || !manifest.name || !manifest.version || !manifest.main) {
        setInstallError(t('plugin.errorManifestFields'))
        return
      }
      if (!codeText.trim()) {
        setInstallError(t('plugin.errorCodeRequired'))
        return
      }
      await installPlugin(manifest, codeText)
      setManifestText('')
      setCodeText('')
      setActiveTab('installed')
    } catch (e: any) {
      setInstallError(e.message || t('plugin.errorInvalidManifest'))
    }
  }

  const handleImportFile = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        if (data.manifest && data.code) {
          setManifestText(JSON.stringify(data.manifest, null, 2))
          setCodeText(data.code)
        } else if (data.id && data.name) {
          setManifestText(JSON.stringify(data, null, 2))
        } else {
          setInstallError(t('plugin.errorBadPackage'))
        }
      } catch (e: any) {
        setInstallError(t('plugin.errorReadFile', { error: e.message }))
      }
    }
    input.click()
  }

  const getStatusBadge = (status: PluginInfo['status']) => {
    const styles: Record<string, string> = {
      active: 'bg-success-10 text-success border-success-20',
      installed: 'bg-accent-10 text-accent-text border-accent-20',
      disabled: 'bg-nova-hover text-nova-text-muted border-nova-border',
      error: 'bg-error-10 text-error border-error-20',
    }
    const labelKeys: Record<string, string> = {
      active: '已启用',
      installed: '已安装',
      disabled: '已禁用',
      error: '错误',
    }
    return (
      <span className={`rounded-full border px-2 py-0.5 text-[12px] leading-[18px] font-medium ${styles[status] || styles.installed}`}>
        {labelKeys[status] || status}
      </span>
    )
  }

  const getPermissionLabel = (perm: string): string => {
    const labelKeys: Record<string, string> = {
      'editor.read': t('plugin.permissionEditorRead'),
      'editor.write': t('plugin.permissionEditorWrite'),
      'file.read': t('plugin.permissionFileRead'),
      'file.write': t('plugin.permissionFileWrite'),
      'ai.chat': t('plugin.permissionAiChat'),
      'ai.completion': t('plugin.permissionAiCompletion'),
      'ui.panel': t('plugin.permissionUiPanel'),
      'ui.statusbar': t('plugin.permissionUiStatusbar'),
      'terminal.read': t('plugin.permissionTerminalRead'),
      'terminal.write': t('plugin.permissionTerminalWrite'),
      'network': t('plugin.permissionNetwork'),
    }
    return labelKeys[perm] || perm
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Tabs — segmented, matching the rest of the settings surface */}
      <div role="tablist" aria-label={t('plugin.installedTab', { count: plugins.length })} className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-nova-border bg-nova-input-bg p-0.5">
        <button
          role="tab"
          aria-selected={activeTab === 'installed'}
          className={`h-7 rounded-md px-2.5 text-[12px] leading-[18px] font-medium transition-colors ${
            activeTab === 'installed'
              ? 'bg-nova-accent text-white'
              : 'text-nova-text-secondary hover:text-nova-text-primary'
          }`}
          onClick={() => setActiveTab('installed')}
        >
          {t('plugin.installedTab', { count: plugins.length })}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'install'}
          className={`h-7 rounded-md px-2.5 text-[12px] leading-[18px] font-medium transition-colors ${
            activeTab === 'install'
              ? 'bg-nova-accent text-white'
              : 'text-nova-text-secondary hover:text-nova-text-primary'
          }`}
          onClick={() => setActiveTab('install')}
        >
          {t('plugin.installTab')}
        </button>
      </div>

      {activeTab === 'installed' ? (
        <div>
          {/* Search */}
          <div className="mb-3">
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-nova-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                aria-label={t('plugin.searchPlaceholder')}
                placeholder={t('plugin.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 w-full rounded-lg border border-nova-border bg-nova-input-bg pl-8 pr-3 text-[13px] leading-[18px] text-nova-text-primary outline-none transition-colors placeholder:text-nova-text-muted focus:border-accent-60"
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-error-20 bg-error-10 px-3 py-2">
              <span className="text-[12px] leading-[18px] text-error">{error}</span>
              <button onClick={clearError} className="text-[12px] leading-[18px] text-error hover:underline">{t('plugin.close')}</button>
            </div>
          )}

          {/* Plugin list */}
          {filteredPlugins.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-[12px] leading-[18px] text-nova-text-muted">
                {searchQuery ? t('plugin.noMatch') : t('plugin.noneInstalled')}
              </p>
              {!searchQuery && (
                <button
                  onClick={() => setActiveTab('install')}
                  className="mt-2 text-[13px] leading-[18px] text-accent-text hover:underline"
                >
                  {t('plugin.installFirst')}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.manifest.id}
                  plugin={plugin}
                  onToggle={() => togglePlugin(plugin.manifest.id)}
                  onUninstall={() => setShowConfirmUninstall(plugin.manifest.id)}
                  getPermissionLabel={getPermissionLabel}
                  getStatusBadge={getStatusBadge}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Install tab */
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] leading-[18px] text-nova-text-secondary">
              {t('plugin.installDesc')}
            </p>
            <button
              onClick={handleImportFile}
              className="h-8 shrink-0 rounded-lg border border-nova-border bg-nova-hover px-3 text-[13px] leading-[18px] text-nova-text-secondary transition-colors hover:text-nova-text-primary"
            >
              {t('plugin.importPackage')}
            </button>
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] leading-[18px] font-medium text-nova-text-secondary">
              {t('plugin.manifestJson')}
            </label>
            <textarea
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              placeholder={`{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A sample plugin",
  "author": "Developer",
  "main": "index.js",
  "permissions": ["editor.read", "ai.chat"]
}`}
              className="h-40 w-full resize-none rounded-lg border border-nova-border bg-nova-input-bg p-2.5 font-mono text-[12px] leading-[18px] text-nova-text-primary outline-none transition-colors placeholder:text-nova-text-muted focus:border-accent-60"
              spellCheck={false}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] leading-[18px] font-medium text-nova-text-secondary">
              {t('plugin.codeLabel')}
            </label>
            <textarea
              value={codeText}
              onChange={(e) => setCodeText(e.target.value)}
              placeholder={`// Plugin entry point (runs in a sandboxed Web Worker)
// Access the API via the global 'api' object
// e.g., await api.editor.getActiveFile()

api.ui.registerPanel('my-panel', 'My Plugin', () => {
  // Workers have no DOM — return an HTML string
  return '<div>Hello from my plugin!</div>';
});`}
              className="h-48 w-full resize-none rounded-lg border border-nova-border bg-nova-input-bg p-2.5 font-mono text-[12px] leading-[18px] text-nova-text-primary outline-none transition-colors placeholder:text-nova-text-muted focus:border-accent-60"
              spellCheck={false}
            />
          </div>

          {(installError || error) && (
            <div className="rounded-lg border border-error-20 bg-error-10 p-2.5">
              <span className="text-[12px] leading-[18px] text-error">{installError || error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => { setManifestText(''); setCodeText(''); setInstallError(null) }}
              className="h-8 rounded-lg px-3 text-[13px] leading-[18px] text-nova-text-muted transition-colors hover:text-nova-text-primary"
            >
              {t('plugin.clear')}
            </button>
            <button
              onClick={handleInstallFromFile}
              disabled={isInstalling || !manifestText.trim() || !codeText.trim()}
              className="inline-flex h-8 items-center justify-center rounded-lg bg-nova-accent px-4 text-[13px] leading-[18px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isInstalling ? t('plugin.installing') : t('plugin.install')}
            </button>
          </div>
        </div>
      )}

      {/* Uninstall confirmation */}
      {showConfirmUninstall && (
        <div role="dialog" aria-modal="true" aria-label={t('plugin.uninstallDialog')} className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60" onClick={() => setShowConfirmUninstall(null)}>
          <div className="glass-modal rounded-2xl p-6 w-[400px]" style={{ boxShadow: 'var(--shadow-xl)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-nova-text-primary mb-2">{t('plugin.uninstallDialog')}</h3>
            <p className="mb-1 text-[13px] leading-[18px] text-nova-text-secondary">
              {t('plugin.uninstallConfirm')}
            </p>
            <p className="mb-5 text-[12px] leading-[18px] text-nova-text-muted">
              {t('plugin.uninstallDesc', { id: showConfirmUninstall })}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowConfirmUninstall(null)}
                className="h-8 rounded-lg px-3 text-[13px] leading-[18px] text-nova-text-muted transition-colors hover:text-nova-text-primary"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={async () => {
                  await uninstallPlugin(showConfirmUninstall)
                  setShowConfirmUninstall(null)
                }}
                className="inline-flex h-8 items-center justify-center rounded-lg bg-error px-4 text-[13px] leading-[18px] font-medium text-white transition-opacity hover:opacity-90"
              >
                {t('plugin.uninstall')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PluginCard({
  plugin,
  onToggle,
  onUninstall,
  getPermissionLabel,
  getStatusBadge,
}: {
  plugin: PluginInfo
  onToggle: () => void
  onUninstall: () => void
  getPermissionLabel: (p: string) => string
  getStatusBadge: (s: PluginInfo['status']) => JSX.Element
}) {
  const [expanded, setExpanded] = useState(false)
  const t = useI18n()

  // Color based on first letter
  const iconColors = [
    { bg: 'rgba(37,99,235,0.15)', fg: '#2563eb' },
    { bg: 'rgba(168,85,247,0.15)', fg: '#a855f7' },
    { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e' },
    { bg: 'rgba(34,211,238,0.15)', fg: '#22d3ee' },
    { bg: 'rgba(251,146,60,0.15)', fg: '#fb923c' },
  ]
  const colorIdx = plugin.manifest.name.charCodeAt(0) % iconColors.length
  const iconColor = iconColors[colorIdx]

  return (
    <div className="bg-nova-card border border-nova-border rounded-xl overflow-hidden hover:border-nova-border-strong transition-all cursor-pointer shadow-sm">
      <div className="flex items-center gap-3 p-3">
        {/* Icon */}
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[13px] leading-[18px] font-semibold"
          style={{ background: iconColor.bg, color: iconColor.fg }}
        >
          {plugin.manifest.name.charAt(0).toUpperCase()}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[13px] leading-[18px] font-semibold text-nova-text-primary">
              {plugin.manifest.name}
            </h3>
            <span className="shrink-0 font-mono text-[12px] leading-[18px] text-nova-text-muted">v{plugin.manifest.version}</span>
          </div>
          <p className="mt-0.5 truncate text-[12px] leading-[18px] text-nova-text-muted">
            {plugin.manifest.description || t('plugin.noDescription')}
          </p>
        </div>

        {/* Status badge */}
        {getStatusBadge(plugin.status)}

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded-md p-1 text-nova-text-muted transition-colors hover:text-nova-text-primary"
            aria-label={t('plugin.details')}
          >
            <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={onToggle}
            className={`h-7 rounded-md border px-2.5 text-[12px] leading-[18px] font-medium transition-colors ${
              plugin.status === 'active'
                ? 'border-warning-30 bg-warning-10 text-warning hover:bg-warning-30'
                : 'border-success-20 bg-success-10 text-success hover:opacity-80'
            }`}
          >
            {plugin.status === 'active' ? t('plugin.disable') : t('plugin.enable')}
          </button>
          <button
            onClick={onUninstall}
            className="h-7 rounded-md border border-error-20 bg-error-10 px-2.5 text-[12px] leading-[18px] font-medium text-error transition-colors hover:bg-error-20"
          >
            {t('plugin.uninstall')}
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-nova-border px-4 pb-4 pt-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="mb-1.5 text-[12px] leading-[18px] font-medium text-nova-text-muted">{t('plugin.basicInfo')}</h4>
              <dl className="space-y-1 text-[12px] leading-[18px]">
                <div className="flex gap-2">
                  <dt className="text-nova-text-muted w-16">ID</dt>
                  <dd className="text-nova-text-secondary font-mono">{plugin.manifest.id}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-nova-text-muted w-16">{t('plugin.entry')}</dt>
                  <dd className="text-nova-text-secondary font-mono">{plugin.manifest.main}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-nova-text-muted w-16">{t('plugin.path')}</dt>
                  <dd className="text-nova-text-secondary font-mono truncate">{plugin.installPath}</dd>
                </div>
              </dl>
            </div>
            <div>
              <h4 className="mb-1.5 text-[12px] leading-[18px] font-medium text-nova-text-muted">{t('plugin.permissions')}</h4>
              <div className="flex flex-wrap gap-1">
                {plugin.manifest.permissions.map((perm) => (
                  <span
                    key={perm}
                    className={`rounded border px-1.5 py-0.5 text-[12px] leading-[18px] ${
                      plugin.enabledPermissions.includes(perm as any)
                        ? 'border-success-20 bg-success-10 text-success'
                        : 'border-nova-border bg-nova-hover text-nova-text-muted line-through'
                    }`}
                  >
                    {getPermissionLabel(perm)}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {plugin.error && (
            <div className="mt-3 rounded-lg border border-error-20 bg-error-10 p-2 text-[12px] leading-[18px] text-error">
              {plugin.error}
            </div>
          )}
          {plugin.manifest.contributes && (
            <div className="mt-3">
              <h4 className="mb-1.5 text-[12px] leading-[18px] font-medium text-nova-text-muted">{t('plugin.contributions')}</h4>
              <div className="flex flex-wrap gap-1.5 text-[12px] leading-[18px] text-nova-text-muted">
                {plugin.manifest.contributes.commands && (
                  <span className="px-1.5 py-0.5 bg-nova-hover rounded">{t('plugin.countCommands', { count: plugin.manifest.contributes.commands.length })}</span>
                )}
                {plugin.manifest.contributes.keybindings && (
                  <span className="px-1.5 py-0.5 bg-nova-hover rounded">{t('plugin.countKeybindings', { count: plugin.manifest.contributes.keybindings.length })}</span>
                )}
                {plugin.manifest.contributes.themes && (
                  <span className="px-1.5 py-0.5 bg-nova-hover rounded">{t('plugin.countThemes', { count: plugin.manifest.contributes.themes.length })}</span>
                )}
                {plugin.manifest.contributes.languages && (
                  <span className="px-1.5 py-0.5 bg-nova-hover rounded">{t('plugin.countLanguages', { count: plugin.manifest.contributes.languages.length })}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
