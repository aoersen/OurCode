import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  EmptyHint,
  FieldLabel,
  FormShell,
  MonoWell,
  PlainInput,
  PlainSelect,
  SectionLabel,
  SurfaceRow,
  TextAction,
  useListKeyboard,
} from '../surfaceParts'
import { ROW_PAGE_SIZE, nextRowLimit, rowWindow } from '../surfaceModel'
import {
  addMcpEntry,
  mcpCounts,
  mcpDetailLines,
  mcpFileLabel,
  mergeMcpServers,
  parseMcpEntryForm,
  removeMcpEntry,
  setMcpEntryDisabled,
  type McpServerMap,
  type McpServerRow,
  type McpStatusItem,
  type McpTransport,
} from './mcpModel'

type AddScope = 'global' | 'project'

/**
 * 「MCP」面：服务器列表 + 展开详情 + 行内添加。
 *
 * 读写仍走主进程既有的 MCP 通道（mcp:getConfig / mcp:saveConfig /
 * mcp:saveGlobalConfig / mcp:status / mcp:reload），合并与校验用 mcpModel 的
 * 纯函数。没有独立的 mcpStore —— MCP 的状态本来就是主进程的事实。
 */
export default function McpSurface({ projectPath }: { projectPath: string | null }) {
  const [rows, setRows] = useState<McpServerRow[]>([])
  const [shadowed, setShadowed] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [limit, setLimit] = useState(ROW_PAGE_SIZE)

  const [addOpen, setAddOpen] = useState(false)
  const [scope, setScope] = useState<AddScope>(projectPath ? 'project' : 'global')
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const listKeyboard = useListKeyboard()

  const friendly = (message: string | undefined, fallback: string) => {
    if (!message) return fallback
    return message.includes('路径不在允许范围内') ? '该路径不在允许范围内（工作区未信任）' : message
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [projectConfig, globalConfig, statusList] = await Promise.all([
        projectPath
          ? window.electronAPI.mcpGetConfig(projectPath)
          : Promise.resolve({ ok: false as const, error: 'NO_PROJECT' }),
        window.electronAPI.mcpGetGlobalConfig(),
        // ?. 兜住没有完整的预加载桩的宿主（例如本地预览壳）
        window.electronAPI.mcpStatus?.(projectPath ?? undefined) ?? Promise.resolve([]),
      ])

      if (!globalConfig.ok) {
        setError(friendly(globalConfig.error, '读取全局 MCP 配置失败'))
        return
      }
      if (!projectConfig.ok && projectConfig.error !== 'NO_PROJECT') {
        setError(friendly(projectConfig.error, '读取项目 MCP 配置失败'))
        return
      }

      const merged = mergeMcpServers({
        project: (projectConfig.ok ? projectConfig.config.mcpServers : {}) as McpServerMap,
        global: (globalConfig.config.mcpServers || {}) as McpServerMap,
        status: (statusList || []) as McpStatusItem[],
        projectFile: projectConfig.ok ? projectConfig.file : null,
        globalFile: globalConfig.file ?? null,
      })
      setRows(merged.rows)
      setShadowed(merged.shadowed)
      setLimit(ROW_PAGE_SIZE)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    void load()
  }, [load])

  const counts = useMemo(() => mcpCounts(rows), [rows])
  const windowed = useMemo(() => rowWindow(rows, limit), [rows, limit])

  /** 读某一层的当前配置（合并前必须先读，避免覆盖另一层）。 */
  const readTier = async (tier: AddScope) => {
    if (tier === 'global') {
      const result = await window.electronAPI.mcpGetGlobalConfig()
      if (!result.ok) {
        setError(friendly(result.error, '读取全局 MCP 配置失败'))
        return null
      }
      return { servers: (result.config.mcpServers || {}) as McpServerMap, file: result.file ?? null }
    }
    if (!projectPath) {
      setError('未打开项目，无法写入项目级 MCP 配置')
      return null
    }
    const result = await window.electronAPI.mcpGetConfig(projectPath)
    if (!result.ok) {
      setError(friendly(result.error, '读取项目 MCP 配置失败'))
      return null
    }
    return { servers: (result.config.mcpServers || {}) as McpServerMap, file: result.file ?? null }
  }

  const saveTier = async (tier: AddScope, servers: McpServerMap, file: string | null) => {
    if (tier === 'global') {
      const result = await window.electronAPI.mcpSaveGlobalConfig({ mcpServers: servers })
      if (!result.ok) setError(friendly(result.error, '保存全局 MCP 配置失败'))
      return result.ok
    }
    if (!projectPath) return false
    const result = await window.electronAPI.mcpSaveConfig(projectPath, { mcpServers: servers }, file)
    if (!result.ok) setError(friendly(result.error, '保存项目 MCP 配置失败'))
    return result.ok
  }

  const reloadServers = async () => {
    if (!projectPath) {
      setError('未打开项目，无法重连 MCP 服务器')
      return
    }
    const result = await window.electronAPI.mcpReload(projectPath)
    if (!result.ok) setError(friendly(result.error, '重连失败'))
    await load()
  }

  const toggleRow = async (row: McpServerRow) => {
    if (busy) return
    setBusy(row.name)
    setError(null)
    try {
      const tier = await readTier(row.scope)
      if (!tier) return
      const servers = setMcpEntryDisabled(tier.servers, row.name, row.entry.disabled === true)
      if (await saveTier(row.scope, servers, tier.file)) await load()
    } finally {
      setBusy(null)
    }
  }

  const deleteRow = async (row: McpServerRow) => {
    if (busy) return
    setBusy(row.name)
    setError(null)
    try {
      const tier = await readTier(row.scope)
      if (!tier) return
      const servers = removeMcpEntry(tier.servers, row.name)
      if (await saveTier(row.scope, servers, tier.file)) await load()
    } finally {
      setBusy(null)
    }
  }

  const submitAdd = async () => {
    if (adding) return
    setAddError(null)
    const parsed = parseMcpEntryForm({ name, transport, command, args, url, envText, headersText })
    if ('error' in parsed) {
      setAddError(parsed.error)
      return
    }
    setAdding(true)
    try {
      const tier = await readTier(scope)
      if (!tier) return
      const servers = addMcpEntry(tier.servers, parsed.name, parsed.entry)
      if (!(await saveTier(scope, servers, tier.file))) return
      if (projectPath) await window.electronAPI.mcpReload(projectPath)
      setName('')
      setCommand('')
      setArgs('')
      setUrl('')
      setEnvText('')
      setHeadersText('')
      setAddOpen(false)
      await load()
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto pure-scroll px-5 pb-6">
      <div className="flex items-center gap-3 pt-1">
        <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
          {loading
            ? '读取中…'
            : `${counts.total} 个服务器 · ${counts.ready} 已就绪${counts.failed > 0 ? ` · ${counts.failed} 失败` : ''}`}
        </span>
        <span className="ml-auto inline-flex">
          <TextAction onClick={() => void load()} title="重新读取配置与状态">
            刷新
          </TextAction>
        </span>
        <TextAction
          onClick={() => {
            setAddOpen((open) => !open)
            setAddError(null)
          }}
          title={addOpen ? '收起添加服务器' : '添加服务器'}
        >
          {addOpen ? '取消' : '添加服务器'}
        </TextAction>
      </div>

      {addOpen && (
        <FormShell>
          <div className="flex items-center gap-2">
            <PlainInput
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="服务器名，例如 github"
              aria-label="服务器名称"
              className="flex-1"
            />
            <PlainSelect
              aria-label="传输方式"
              value={transport}
              onChange={(event) => setTransport(event.target.value as McpTransport)}
              options={[
                { value: 'stdio', label: '本地命令' },
                { value: 'http', label: 'HTTP / SSE' },
              ]}
            />
            <PlainSelect
              aria-label="配置层级"
              value={scope}
              onChange={(event) => setScope(event.target.value as AddScope)}
              options={[
                { value: 'project', label: '当前项目', disabled: !projectPath },
                { value: 'global', label: '全局' },
              ]}
            />
          </div>

          {transport === 'stdio' ? (
            <div className="pt-1.5">
              <FieldLabel>启动命令</FieldLabel>
              <PlainInput
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npx / node / bundled-node"
                aria-label="启动命令"
              />
              <div className="grid grid-cols-2 gap-2 pt-1.5">
                <div>
                  <FieldLabel>参数（空格分隔）</FieldLabel>
                  <PlainInput
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                    placeholder="-y @modelcontextprotocol/server-github"
                    aria-label="命令参数"
                  />
                </div>
                <div>
                  <FieldLabel>环境变量（每行 KEY=VALUE）</FieldLabel>
                  <PlainInput
                    value={envText}
                    onChange={(event) => setEnvText(event.target.value)}
                    placeholder="GITHUB_TOKEN=…"
                    aria-label="环境变量"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="pt-1.5">
              <FieldLabel>服务器 URL</FieldLabel>
              <PlainInput
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://localhost:3001/mcp"
                aria-label="服务器 URL"
              />
              <div className="pt-1.5">
                <FieldLabel>请求头（每行 KEY: VALUE）</FieldLabel>
                <PlainInput
                  value={headersText}
                  onChange={(event) => setHeadersText(event.target.value)}
                  placeholder="Authorization: Bearer …"
                  aria-label="请求头"
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            {addError && (
              <span className="text-[11.5px] leading-[18px] text-[var(--pure-danger)]" role="alert">
                {addError}
              </span>
            )}
            <span className="ml-auto inline-flex">
              <TextAction onClick={() => void submitAdd()} disabled={adding} title="保存服务器">
                {adding ? '保存中…' : '保存'}
              </TextAction>
            </span>
          </div>
        </FormShell>
      )}

      {error && (
        <div className="pt-2 text-[12px] leading-[18px] text-[var(--pure-danger)]" role="alert">
          {error}
        </div>
      )}

      <div onKeyDown={listKeyboard}>
        {!loading && rows.length === 0 ? (
          <EmptyHint>
            {projectPath
              ? '还没有 MCP 服务器。点上面的「添加服务器」开始。'
              : '还没有 MCP 服务器。未打开项目时只能配置全局层。'}
          </EmptyHint>
        ) : (
          <>
            <SectionLabel trailing={shadowed > 0 ? `${shadowed} 个全局同名条目被项目覆盖` : undefined}>
              服务器
            </SectionLabel>
            {windowed.rows.map((row) => {
              const key = `${row.scope}:${row.name}`
              const open = expanded === key
              const failed = row.state === 'failed'
              return (
                <SurfaceRow
                  key={key}
                  label={`${row.name} ${row.stateWord}`}
                  onActivate={() => setExpanded(open ? null : key)}
                  className="pure-row"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="flex-1 min-w-0 text-[13px] leading-[20px] text-[var(--pure-ink)] truncate">
                      {row.name}
                    </span>
                    <span className="shrink-0 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                      {row.transport === 'http' ? 'HTTP' : 'stdio'} · {row.scope === 'global' ? '全局' : '项目'}
                    </span>
                    <span
                      className={`shrink-0 text-[11.5px] leading-[18px] ${
                        failed ? 'text-[var(--pure-danger)]' : 'text-[var(--pure-muted)]'
                      }`}
                    >
                      {row.stateWord}
                      {row.state === 'restarting' && row.retry ? ` (${row.retry})` : ''}
                    </span>
                  </div>

                  {row.summary && (
                    <div className="pt-0.5 text-[11.5px] leading-[18px] text-[var(--pure-muted)] font-mono truncate" title={row.summary}>
                      {row.summary}
                    </div>
                  )}

                  {open && (
                    <>
                      <MonoWell lines={mcpDetailLines(row.entry)} />
                      <div className="flex items-center gap-3 pt-1.5">
                        {row.error && (
                          <span className="min-w-0 flex-1 text-[11.5px] leading-[18px] text-[var(--pure-danger)] truncate" title={row.error}>
                            {row.error}
                          </span>
                        )}
                        <span className="ml-auto flex items-center gap-3">
                          <TextAction onClick={() => void reloadServers()} disabled={busy === row.name} title="重连">
                            重连
                          </TextAction>
                          <TextAction
                            onClick={() => void toggleRow(row)}
                            disabled={busy === row.name}
                            title={row.entry.disabled === true ? '启用' : '停用'}
                          >
                            {row.entry.disabled === true ? '启用' : '停用'}
                          </TextAction>
                          <TextAction
                            onClick={() => void deleteRow(row)}
                            disabled={busy === row.name}
                            danger
                            title="删除服务器"
                          >
                            删除
                          </TextAction>
                        </span>
                      </div>
                      {row.file && (
                        <div className="pt-1 text-[11px] leading-[16px] text-[var(--pure-muted)]">
                          配置：{mcpFileLabel(row.file)}
                        </div>
                      )}
                    </>
                  )}
                </SurfaceRow>
              )
            })}
          </>
        )}

        {windowed.hidden > 0 && (
          <div className="pt-2">
            <TextAction onClick={() => setLimit((current) => nextRowLimit(current))}>
              显示更多（还有 {windowed.hidden} 个）
            </TextAction>
          </div>
        )}
      </div>
    </div>
  )
}

