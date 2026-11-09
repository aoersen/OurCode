import { useEffect, useMemo, useRef, useState } from 'react'

import { usePluginStore } from '@/stores/pluginStore'
import { useUIStore } from '@/stores/uiStore'
import type { PluginInfo, PluginManifest } from '@/services/plugin/types'
import { errorText } from '../../errorText'
import {
  GroupLabel,
  InlineConfirm,
  Row,
  StatusLine,
  TextAction,
  TextArea,
  TextInput,
} from '../../settingsParts'

const STATUS_WORDS: Record<PluginInfo['status'], string> = {
  active: '已启用',
  installed: '已安装',
  disabled: '已停用',
  error: '异常',
}

const PERMISSION_WORDS: Record<string, string> = {
  'editor.read': '读编辑器',
  'editor.write': '写编辑器',
  'file.read': '读文件',
  'file.write': '写文件',
  'ai.chat': 'AI 对话',
  'ai.completion': 'AI 补全',
  'ui.panel': '面板',
  'ui.statusbar': '状态栏',
  'terminal.read': '读终端',
  'terminal.write': '写终端',
  network: '网络',
}

/**
 * 功能 › 插件：已安装列表 + 启停 / 卸载（确认）+ 手工安装（manifest + 代码）。
 *
 * 读写全部走 pluginStore（loadPlugins / togglePlugin / uninstallPlugin /
 * installPlugin），与旧面板同一套服务；这里只是换成纯文本行 + 文字动作。
 */
export default function PluginSettings() {
  const plugins = usePluginStore((state) => state.plugins)
  const isInstalling = usePluginStore((state) => state.isInstalling)
  const installErrorStore = usePluginStore((state) => state.error)
  const loadPlugins = usePluginStore((state) => state.loadPlugins)
  const installPlugin = usePluginStore((state) => state.installPlugin)
  const uninstallPlugin = usePluginStore((state) => state.uninstallPlugin)
  const togglePlugin = usePluginStore((state) => state.togglePlugin)
  const clearError = usePluginStore((state) => state.clearError)
  const notify = useUIStore((state) => state.showNotification)

  const [query, setQuery] = useState('')
  const [manifestText, setManifestText] = useState('')
  const [codeText, setCodeText] = useState('')
  const [installDraftError, setInstallDraftError] = useState<string | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null)
  const packageInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    try {
      loadPlugins()
    } catch (error) {
      notify(errorText(error, '读取插件列表失败'), 'error')
    }
  }, [loadPlugins, notify])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return plugins
    return plugins.filter((plugin) => {
      const manifest = plugin.manifest
      return (
        manifest.name.toLowerCase().includes(needle) ||
        manifest.id.toLowerCase().includes(needle) ||
        manifest.description.toLowerCase().includes(needle) ||
        manifest.author.toLowerCase().includes(needle)
      )
    })
  }, [plugins, query])

  const toggle = async (plugin: PluginInfo) => {
    try {
      await togglePlugin(plugin.manifest.id)
    } catch (error) {
      notify(errorText(error, '切换插件状态失败'), 'error')
    }
  }

  const uninstall = async (id: string) => {
    try {
      await uninstallPlugin(id)
      setPendingUninstall(null)
      notify('插件已卸载', 'success')
    } catch (error) {
      notify(errorText(error, '卸载插件失败'), 'error')
    }
  }

  const install = async () => {
    setInstallDraftError(null)
    clearError()
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(manifestText) as PluginManifest
    } catch (error) {
      setInstallDraftError(errorText(error, 'manifest 不是合法的 JSON'))
      return
    }
    if (!manifest.id || !manifest.name || !manifest.version || !manifest.main) {
      setInstallDraftError('manifest 需要 id / name / version / main 四个字段')
      return
    }
    if (!codeText.trim()) {
      setInstallDraftError('插件代码不能为空')
      return
    }
    try {
      await installPlugin(manifest, codeText)
      setManifestText('')
      setCodeText('')
      notify('插件已安装', 'success')
    } catch (error) {
      setInstallDraftError(errorText(error, '安装插件失败'))
    }
  }

  const importFromFile = async (file: File) => {
    setInstallDraftError(null)
    try {
      const text = await file.text()
      const data = JSON.parse(text) as { manifest?: PluginManifest; code?: string } & Partial<PluginManifest>
      if (data.manifest && data.code) {
        setManifestText(JSON.stringify(data.manifest, null, 2))
        setCodeText(data.code)
        return
      }
      if (data.id && data.name) {
        setManifestText(JSON.stringify(data, null, 2))
        return
      }
      setInstallDraftError('安装包里既没有 {manifest, code} 也没有完整的 manifest')
    } catch (error) {
      setInstallDraftError(errorText(error, '读取安装包失败'))
    }
  }

  return (
    <div>
      <GroupLabel trailing={`${plugins.length} 个已安装`}>插件</GroupLabel>

      {plugins.length === 0 ? (
        <p className="py-1 text-[12px] leading-[18px] text-[var(--pure-muted)]">还没有安装任何插件。</p>
      ) : (
        <div className="pb-1">
          <TextInput
            label="搜索插件"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按名称 / 作者 / id 过滤"
            className="mb-1"
          />
          {filtered.length === 0 ? (
            <p className="py-1 text-[12px] leading-[18px] text-[var(--pure-muted)]">没有匹配的插件。</p>
          ) : (
            filtered.map((plugin) => {
              const manifest = plugin.manifest
              const pending = pendingUninstall === manifest.id
              return (
                <div key={manifest.id} className="py-1.5">
                  <div className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-[13px] leading-[20px] text-[var(--pure-ink)]">
                      {manifest.name}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] leading-[18px] text-[var(--pure-muted)]">
                      v{manifest.version}
                    </span>
                    <span
                      className={`shrink-0 text-[11.5px] leading-[18px] ${
                        plugin.status === 'error' ? 'text-[var(--pure-danger)]' : 'text-[var(--pure-muted)]'
                      }`}
                    >
                      {STATUS_WORDS[plugin.status] ?? plugin.status}
                    </span>
                  </div>
                  <div className="pt-0.5 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                    {manifest.description || '没有描述'}
                    {manifest.permissions.length > 0
                      ? ` · 权限 ${manifest.permissions.map((permission) => PERMISSION_WORDS[permission] ?? permission).join('/')}`
                      : ''}
                  </div>
                  {plugin.error ? (
                    <div className="pt-0.5">
                      <StatusLine tone="error">{plugin.error}</StatusLine>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-3 pt-1">
                    <TextAction
                      onClick={() => void toggle(plugin)}
                      label={plugin.status === 'disabled' ? `启用插件 ${manifest.name}` : `停用插件 ${manifest.name}`}
                    >
                      {plugin.status === 'disabled' ? '启用' : '停用'}
                    </TextAction>
                    <TextAction
                      onClick={() => setPendingUninstall(pending ? null : manifest.id)}
                      danger
                      label={`卸载插件 ${manifest.name}`}
                    >
                      卸载
                    </TextAction>
                  </div>
                  {pending ? (
                    <div className="pt-1.5">
                      <InlineConfirm
                        message={`确定卸载「${manifest.name}」吗？`}
                        detail="插件代码与本地数据会被删除，卸载后需要重新安装。"
                        confirmLabel="卸载"
                        danger
                        onConfirm={() => void uninstall(manifest.id)}
                        onCancel={() => setPendingUninstall(null)}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      )}

      <Row label="手工安装" description="填入 manifest JSON 与插件代码；也可以从 .json 安装包导入" stacked>
        <div className="flex flex-col gap-2">
          <TextArea
            label="插件 manifest JSON"
            mono
            rows={4}
            value={manifestText}
            onChange={(event) => setManifestText(event.target.value)}
            placeholder={'{\n  "id": "my-plugin",\n  "name": "My Plugin",\n  "version": "1.0.0",\n  "main": "index.js",\n  "permissions": ["editor.read"]\n}'}
          />
          <TextArea
            label="插件代码"
            mono
            rows={4}
            value={codeText}
            onChange={(event) => setCodeText(event.target.value)}
            placeholder="// 插件入口代码"
          />
          <div className="flex flex-wrap items-center gap-3">
            <TextAction onClick={() => void install()} disabled={isInstalling} label="安装插件">
              {isInstalling ? '安装中…' : '安装'}
            </TextAction>
            <input
              ref={packageInputRef}
              type="file"
              accept=".json"
              aria-label="从 JSON 安装包导入插件"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importFromFile(file)
                event.target.value = ''
              }}
            />
            <TextAction onClick={() => packageInputRef.current?.click()} label="从 JSON 安装包导入插件">
              从文件导入
            </TextAction>
            {installErrorStore ? <StatusLine tone="error">{installErrorStore}</StatusLine> : null}
            {installDraftError ? <StatusLine tone="error">{installDraftError}</StatusLine> : null}
          </div>
        </div>
      </Row>
    </div>
  )
}
