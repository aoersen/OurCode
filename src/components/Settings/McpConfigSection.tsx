import { useState, useEffect, useCallback } from 'react'

/**
 * MCP server configuration editor (MCP 管理中心 → 配置).
 *
 * Two tiers, matching the main-process manager's merge rule:
 *  - 全局 (<userData>/mcp_config.json): available in EVERY project, editable
 *    even with no project open;
 *  - 项目 (<projectRoot>/mcp_config.json): this project only. A project entry
 *    with the same name OVERRIDES the global one — the editor warns about the
 *    overlap instead of blocking it.
 *
 * Schema per entry (mcp-manager):
 *   { "mcpServers": { name: { command?, args?, env?, serverUrl?, headers?, disabled?, skipTlsVerify? } } }
 * Two transports: stdio (command+args+env) and HTTP (serverUrl+headers;
 * skipTlsVerify for intranet self-signed certs). Stdio servers can run on the
 * IDE's bundled Node (no system Node): command "bundled-node" + args prefixed
 * "bundled:" (see "内置 Git 服务器" button).
 */

interface McpServerDraft {
  name: string
  enabled: boolean
  type: 'stdio' | 'http'
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
  skipTlsVerify: boolean
}

function parseArgs(text: string): string[] {
  return text.split(/\s+/).map((s) => s.trim()).filter(Boolean)
}

function parseKeyValue(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(sep)
    if (idx <= 0) continue
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return out
}

function toKeyValueLines(obj: Record<string, string> | undefined, sep: '=' | ':'): string {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')
}

const emptyServer = (): McpServerDraft => ({
  name: '',
  enabled: true,
  type: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
  skipTlsVerify: false,
})

/** Draft from a persisted config entry (any of the two tiers). */
function draftFromEntry(name: string, s: any): McpServerDraft {
  return {
    name,
    enabled: s.disabled !== true,
    type: s.serverUrl || s.url ? 'http' : 'stdio',
    command: s.command || '',
    argsText: (s.args || []).join(' '),
    envText: toKeyValueLines(s.env, '='),
    url: s.serverUrl || s.url || '',
    headersText: toKeyValueLines(s.headers, ':'),
    skipTlsVerify: s.skipTlsVerify === true,
  }
}

const bundledGitDraft = (): McpServerDraft => ({
  name: 'git',
  enabled: true,
  type: 'stdio',
  command: 'bundled-node',
  argsText: 'bundled:git-server/server.js',
  envText: 'GIT_PAGER=cat',
  url: '',
  headersText: '',
  skipTlsVerify: false,
})

/** Persisted entry from a draft — validated (returns null + message on error). */
function entryFromDraft(s: McpServerDraft): { entry: Record<string, any> } | { error: string } {
  const entry: any = { disabled: !s.enabled }
  if (s.type === 'http') {
    const url = s.url.trim()
    if (!url) return { error: `服务器 "${s.name}" 缺少 URL` }
    entry.serverUrl = url
    const headers = parseKeyValue(s.headersText, ':')
    if (Object.keys(headers).length > 0) entry.headers = headers
    if (s.skipTlsVerify) entry.skipTlsVerify = true
  } else {
    const command = s.command.trim()
    if (!command) return { error: `服务器 "${s.name}" 缺少 command` }
    entry.command = command
    const args = parseArgs(s.argsText)
    if (args.length > 0) entry.args = args
    const env = parseKeyValue(s.envText, '=')
    if (Object.keys(env).length > 0) entry.env = env
  }
  return { entry }
}

export default function McpConfigSection({ rootPath }: { rootPath: string | null }) {
  const [projectServers, setProjectServers] = useState<McpServerDraft[]>([])
  const [globalServers, setGlobalServers] = useState<McpServerDraft[]>([])
  const [projectFile, setProjectFile] = useState<string | null>(null)
  const [globalFile, setGlobalFile] = useState<string | null>(null)
  const [status, setStatus] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null)

  const loadConfig = useCallback(async () => {
    setStatus(null)
    const [projectRes, globalRes] = await Promise.all([
      rootPath ? window.electronAPI.mcpGetConfig(rootPath) : Promise.resolve({ ok: false as const, error: 'NO_PROJECT' }),
      window.electronAPI.mcpGetGlobalConfig(),
    ])
    if (!globalRes.ok) {
      setStatus({ type: 'error', text: globalRes.error || '读取全局配置失败' })
      return
    }
    setGlobalFile(globalRes.file)
    setGlobalServers(Object.entries(globalRes.config.mcpServers || {}).map(([name, s]) => draftFromEntry(name, s)))
    if (!projectRes.ok) {
      setProjectServers([])
      setProjectFile(null)
      return // 未打开项目 — 只管理全局
    }
    setProjectFile(projectRes.file)
    setProjectServers(Object.entries(projectRes.config.mcpServers || {}).map(([name, s]) => draftFromEntry(name, s)))
  }, [rootPath])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  const updateServer = (list: 'global' | 'project', index: number, patch: Partial<McpServerDraft>) => {
    const setter = list === 'global' ? setGlobalServers : setProjectServers
    setter((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const removeServer = (list: 'global' | 'project', index: number) => {
    const setter = list === 'global' ? setGlobalServers : setProjectServers
    setter((prev) => prev.filter((_, i) => i !== index))
  }

  const addServer = (list: 'global' | 'project') => {
    const setter = list === 'global' ? setGlobalServers : setProjectServers
    setter((prev) => [...prev, emptyServer()])
  }

  // Quick-add the bundled git MCP server (project tier only — it operates on
  // the current workspace, so a global copy makes no sense).
  const addBundledGitServer = () => {
    setProjectServers((prev) => {
      const idx = prev.findIndex((s) => s.name === 'git')
      return idx !== -1 ? prev.map((s, i) => (i === idx ? bundledGitDraft() : s)) : [...prev, bundledGitDraft()]
    })
  }

  /** Drafts → mcpServers map; validates non-empty names and per-group dupes. */
  const collectServers = (drafts: McpServerDraft[]): { mcpServers: Record<string, any> } | { error: string } => {
    const mcpServers: Record<string, any> = {}
    const seen = new Set<string>()
    for (const s of drafts) {
      const name = s.name.trim()
      if (!name) continue
      if (seen.has(name)) return { error: `服务器名称 "${name}" 重复，请先修改再保存` }
      seen.add(name)
      const built = entryFromDraft(s)
      if ('error' in built) return built
      mcpServers[name] = built.entry
    }
    return { mcpServers }
  }

  const saveConfig = async () => {
    // 项目层（仅当打开项目）
    let projectMerged: Record<string, any> | null = null
    if (rootPath) {
      const built = collectServers(projectServers)
      if ('error' in built) {
        setStatus({ type: 'error', text: built.error })
        return
      }
      const res = await window.electronAPI.mcpSaveConfig(rootPath, { mcpServers: built.mcpServers }, projectFile)
      if (!res.ok) {
        setStatus({ type: 'error', text: res.error || '保存失败' })
        return
      }
      projectMerged = built.mcpServers
    }
    // 全局层（任何情况下都可保存）
    const globalBuilt = collectServers(globalServers)
    if ('error' in globalBuilt) {
      setStatus({ type: 'error', text: globalBuilt.error })
      return
    }
    const globalRes = await window.electronAPI.mcpSaveGlobalConfig({ mcpServers: globalBuilt.mcpServers })
    if (!globalRes.ok) {
      setStatus({ type: 'error', text: globalRes.error || '保存全局配置失败' })
      return
    }
    // Reload first — loadConfig() clears the status, so re-apply the message
    // afterwards (otherwise it would never be visible).
    await loadConfig()
    const overlap = projectMerged
      ? Object.keys(projectMerged).filter((name) => name in globalBuilt.mcpServers)
      : []
    if (overlap.length > 0) {
      setStatus({
        type: 'info',
        text: `已保存并重新加载。注意：${overlap.join('、')} 与全局同名，本项目中以项目配置为准。`,
      })
    } else {
      setStatus({ type: 'ok', text: '已保存并重新加载 MCP 服务器' })
    }
  }

  const groupHeaderCls = 'text-[11px] font-semibold text-nova-text-secondary flex items-center gap-1.5'

  return (
    <div className="flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-nova-text-muted truncate">
          配置分两级：全局（所有项目可用）与当前项目（仅本项目）
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {status && (
            <span
              className={`text-[10px] px-2 py-1 rounded ${
                status.type === 'ok'
                  ? 'text-green-500 bg-green-500/10'
                  : status.type === 'error'
                    ? 'text-red-400 bg-red-500/10'
                    : 'text-nova-text-muted bg-nova-hover'
              }`}
            >
              {status.text}
            </span>
          )}
          <button
            onClick={loadConfig}
            className="px-2.5 py-1 text-[11px] text-nova-text-secondary hover:text-nova-text-primary hover:bg-nova-hover rounded-md transition-colors"
          >
            重新加载
          </button>
          <button
            onClick={saveConfig}
            className="px-3 py-1 text-[11px] font-medium text-white rounded-full hover:opacity-90 transition-all shadow-sm" style={{ background: 'var(--grad-brand)' }}
          >
            保存配置
          </button>
        </div>
      </div>

      {/* ─────────────── 全局 MCP ─────────────── */}
      <div className="rounded-xl border border-nova-accent/30 bg-nova-card/70 p-3 flex flex-col gap-2.5">
        <div className={groupHeaderCls}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-nova-accent shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          全局 MCP · 所有项目可用
          <span className="font-normal text-nova-text-muted truncate shrink min-w-0">
            {globalFile ? ` — ${globalFile}` : ' — 尚未创建全局配置文件'}
          </span>
        </div>
        {globalServers.length === 0 && (
          <div className="text-[11px] text-nova-text-muted px-1 py-1">
            还没有全局 MCP 服务器，点击下方「添加全局服务器」开始
          </div>
        )}
        {globalServers.map((s, i) => (
          <ServerCard
            key={`global-${i}`}
            draft={s}
            onChange={(patch) => updateServer('global', i, patch)}
            onDelete={() => removeServer('global', i)}
          />
        ))}
        <button
          onClick={() => addServer('global')}
          className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-nova-accent bg-nova-accent/10 hover:bg-nova-accent/20 rounded-full transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          添加全局服务器
        </button>
      </div>

      {/* ─────────────── 项目 MCP ─────────────── */}
      <div className="rounded-xl border border-nova-border bg-nova-card/70 p-3 flex flex-col gap-2.5">
        <div className={groupHeaderCls}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-nova-text-muted shrink-0">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          项目 MCP · 仅当前项目
          <span className="font-normal text-nova-text-muted truncate shrink min-w-0">
            {projectFile ? ` — ${projectFile}` : rootPath ? ' — 尚未创建项目配置文件' : ' — 未打开项目，暂不可用'}
          </span>
        </div>
        {!rootPath && (
          <div className="text-[11px] text-nova-text-muted px-1 py-1">
            打开文件夹并开始一个对话后，即可为该项目配置独立的 MCP 服务器
          </div>
        )}
        {rootPath && projectServers.length === 0 && (
          <div className="text-[11px] text-nova-text-muted px-1 py-1">
            还没有项目 MCP 服务器，点击下方「添加项目服务器」开始
          </div>
        )}
        {rootPath && projectServers.map((s, i) => (
          <ServerCard
            key={`project-${i}`}
            draft={s}
            onChange={(patch) => updateServer('project', i, patch)}
            onDelete={() => removeServer('project', i)}
          />
        ))}
        {rootPath && (
          <>
            <button
              onClick={addBundledGitServer}
              className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-nova-text-secondary border border-nova-border hover:border-nova-accent/40 rounded-full transition-colors"
              title="添加内置 Git MCP 服务器（使用 IDE 自带 Node 运行，无需安装 Node）"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
              </svg>
              内置 Git 服务器
            </button>
            <button
              onClick={() => addServer('project')}
              className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-nova-accent bg-nova-accent/10 hover:bg-nova-accent/20 rounded-full transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              添加项目服务器
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** One editable server row — shared by both tiers. */
function ServerCard({
  draft,
  onChange,
  onDelete,
}: {
  draft: McpServerDraft
  onChange: (patch: Partial<McpServerDraft>) => void
  onDelete: () => void
}) {
  const inputCls =
    'w-full px-2.5 py-1.5 text-xs bg-nova-input-bg border border-nova-border rounded-md text-nova-text-primary placeholder-nova-text-muted focus:border-nova-accent/50 focus:outline-none transition-colors'
  const labelCls = 'text-[10px] text-nova-text-muted mb-1 block'

  return (
    <div className="rounded-xl border border-nova-border bg-nova-card/70 p-3 flex flex-col gap-2.5 hover:border-nova-accent/30 transition-colors">
      <div className="flex items-center gap-2">
        <input
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="服务器名称"
          className={`${inputCls} flex-1 font-mono`}
        />
        <select
          value={draft.type}
          onChange={(e) => onChange({ type: e.target.value as 'stdio' | 'http' })}
          className="px-2 py-1.5 text-[11px] bg-nova-input-bg border border-nova-border rounded-md text-nova-text-primary outline-none cursor-pointer hover:border-nova-accent"
        >
          <option value="stdio">本地命令</option>
          <option value="http">HTTP / SSE</option>
        </select>
        <label className="flex items-center gap-1.5 text-[11px] text-nova-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            className="accent-nova-accent"
          />
          启用
        </label>
        <button
          onClick={onDelete}
          className="p-1.5 text-nova-text-muted hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
          title="删除服务器"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          </svg>
        </button>
      </div>

      {draft.type === 'stdio' ? (
        <>
          <div>
            <span className={labelCls}>启动命令 command</span>
            <input
              value={draft.command}
              onChange={(e) => onChange({ command: e.target.value })}
              placeholder="例如：node、npx；内置 Git 用 bundled-node（免装 Node）"
              className={`${inputCls} font-mono`}
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <span className={labelCls}>参数 args（空格分隔）</span>
              <input
                value={draft.argsText}
                onChange={(e) => onChange({ argsText: e.target.value })}
                placeholder="例如：server.js --port 3000"
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <span className={labelCls}>环境变量 env（每行 KEY=VALUE）</span>
              <textarea
                value={draft.envText}
                onChange={(e) => onChange({ envText: e.target.value })}
                placeholder="GIT_PAGER=cat"
                rows={2}
                className={`${inputCls} font-mono resize-y`}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          <div>
            <span className={labelCls}>服务器地址 URL（HTTP / SSE）</span>
            <input
              value={draft.url}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="例如：http://localhost:3001/mcp"
              className={`${inputCls} font-mono`}
            />
          </div>
          <div>
            <span className={labelCls}>请求头 headers（每行 KEY: VALUE）</span>
            <textarea
              value={draft.headersText}
              onChange={(e) => onChange({ headersText: e.target.value })}
              placeholder="Authorization: Bearer xxx"
              rows={2}
              className={`${inputCls} font-mono resize-y`}
            />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-nova-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={draft.skipTlsVerify}
              onChange={(e) => onChange({ skipTlsVerify: e.target.checked })}
              className="accent-nova-accent"
            />
            跳过证书校验（内网自签名 / 私有 CA 证书的 HTTPS 地址可勾选）
          </label>
        </>
      )}
    </div>
  )
}
