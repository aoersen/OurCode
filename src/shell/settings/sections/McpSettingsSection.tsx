import { useCallback, useEffect, useMemo, useState } from 'react'

import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
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
} from '../../agent/surfaces/mcp/mcpModel'
import { errorText } from '../errorText'
import {
  GroupLabel,
  InlineConfirm,
  MonoLine,
  SectionHeading,
  SelectField,
  StatusLine,
  TextAction,
  TextInput,
} from '../settingsParts'

type Scope = 'global' | 'project'

/**
 * 「MCP 服务器」：服务器列表 + 行内添加表单 + 校验。
 *
 * 事实来源是主进程的 MCP 配置（全局一份、项目一份），读写走
 * mcpGetGlobalConfig / mcpGetConfig / mcpSaveGlobalConfig / mcpSaveConfig /
 * mcpReload / mcpStatus；合并、传输判定、表单校验复用右栏 MCP 面的纯函数
 * （agent/surfaces/mcp/mcpModel），避免两套口径。
 */
export default function McpSettingsSection() {
  const projectPath = useChatStore(
    (state) => state.sessions.find((session) => session.id === state.activeSessionId)?.projectPath ?? null,
  )
  const notify = useUIStore((state) => state.showNotification)

  const [rows, setRows] = useState<McpServerRow[]>([])
  const [shadowed, setShadowed] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [scope, setScope] = useState<Scope>(projectPath ? 'project' : 'global')
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const friendly = useCallback((message: string | undefined, fallback: string) => {
    if (!message) return fallback
    return message.includes('路径不在允许范围内') ? '该路径不在允许范围内（工作区未信任）' : message
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [projectConfig, globalConfig, statusList] = await Promise.all([
        projectPath
          ? window.electronAPI.mcpGetConfig(projectPath)
          : Promise.resolve({ ok: false as const, config: { mcpServers: {} }, file: null, error: 'NO_PROJECT' }),
        window.electronAPI.mcpGetGlobalConfig(),
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
    } catch (cause) {
      setError(errorText(cause, '读取 MCP 配置失败'))
    } finally {
      setLoading(false)
    }
  }, [projectPath, friendly])

  useEffect(() => {
    void load()
  }, [load])

  const counts = useMemo(() => mcpCounts(rows), [rows])

  /** 读某一层的当前配置（合并前必须读，避免覆盖另一层）。 */
  const readTier = async (tier: Scope) => {
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

  const saveTier = async (tier: Scope, servers: McpServerMap, file: string | null) => {
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

  const reload = async () => {
    if (!projectPath) return
    try {
      const result = await window.electronAPI.mcpReload(projectPath)
      if (!result.ok) setError(friendly(result.error, '重连失败'))
    } catch (cause) {
      setError(errorText(cause, '重连失败'))
    }
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
      if (await saveTier(row.scope, servers, tier.file)) {
        setPendingDelete(null)
        await load()
      }
    } finally {
      setBusy(null)
    }
  }

  const resetForm = () => {
    setName('')
    setCommand('')
    setArgs('')
    setUrl('')
    setEnvText('')
    setHeadersText('')
    setFormError(null)
  }

  const submit = async () => {
    if (saving) return
    setFormError(null)
    const parsed = parseMcpEntryForm({ name, transport, command, args, url, envText, headersText })
    if ('error' in parsed) {
      setFormError(parsed.error)
      return
    }
    setSaving(true)
    try {
      const tier = await readTier(scope)
      if (!tier) return
      const servers = addMcpEntry(tier.servers, parsed.name, parsed.entry)
      if (!(await saveTier(scope, servers, tier.file))) return
      if (projectPath) await window.electronAPI.mcpReload(projectPath)
      notify(`已保存服务器「${parsed.name}」`, 'success')
      resetForm()
      setFormOpen(false)
      await load()
    } catch (cause) {
      setFormError(errorText(cause, '保存服务器失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <SectionHeading
        title="MCP 服务器"
        hint={projectPath ? '项目级条目覆盖同名全局条目；保存后重连对应会话。' : '未打开项目时只能配置全局层。'}
      >
        <TextAction onClick={() => void load()} label="重新读取 MCP 配置与状态">
          刷新
        </TextAction>
        <TextAction
          onClick={() => {
            setFormOpen((open) => !open)
            setFormError(null)
          }}
            label={formOpen ? '收起添加服务器表单' : '添加 MCP 服务器'}
        >
          {formOpen ? '取消' : '添加服务器'}
        </TextAction>
      </SectionHeading>

      <GroupLabel trailing={loading ? '读取中…' : `${counts.total} 个 · ${counts.ready} 就绪`}>
        服务器
      </GroupLabel>

      {formOpen ? (
        <div className="rounded-xl bg-[var(--pure-code)] px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              label="服务器名称"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 github"
              className="min-w-[160px] flex-1"
            />
            <SelectField
              label="传输方式"
              value={transport}
              onChange={(event) => setTransport(event.target.value as McpTransport)}
              options={[
                { value: 'stdio', label: '本地命令（stdio）' },
                { value: 'http', label: 'HTTP / SSE' },
              ]}
            />
            <SelectField
              label="配置层级"
              value={scope}
              onChange={(event) => setScope(event.target.value as Scope)}
              options={[
                { value: 'project', label: '当前项目', disabled: !projectPath },
                { value: 'global', label: '全局' },
              ]}
            />
          </div>

          {transport === 'stdio' ? (
            <div className="pt-2">
              <TextInput
                label="启动命令"
                mono
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npx / node / bundled-node"
              />
              <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-2">
                <TextInput
                  label="命令参数（空格分隔）"
                  mono
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder="-y @modelcontextprotocol/server-github"
                />
                <TextInput
                  label="环境变量（每行 KEY=VALUE）"
                  mono
                  value={envText}
                  onChange={(event) => setEnvText(event.target.value)}
                  placeholder="GITHUB_TOKEN=…"
                />
              </div>
            </div>
          ) : (
            <div className="pt-2">
              <TextInput
                label="服务器 URL"
                mono
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://localhost:3001/mcp"
              />
              <div className="pt-2">
                <TextInput
                  label="请求头（每行 KEY: VALUE）"
                  mono
                  value={headersText}
                  onChange={(event) => setHeadersText(event.target.value)}
                  placeholder="Authorization: Bearer …"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <TextAction onClick={() => void submit()} disabled={saving} label="保存 MCP 服务器">
              {saving ? '保存中…' : '保存'}
            </TextAction>
            <TextAction onClick={resetForm} label="清空表单">
              清空
            </TextAction>
            {formError ? <StatusLine tone="error">{formError}</StatusLine> : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="pt-2">
          <StatusLine tone="error">{error}</StatusLine>
        </div>
      ) : null}

      {!loading && rows.length === 0 ? (
        <p className="py-2 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">
          还没有 MCP 服务器。点右上「添加服务器」开始配置。
        </p>
      ) : null}

      {rows.map((row, index) => {
        const key = `${row.scope}:${row.name}`
        const open = expanded === key
        const failed = row.state === 'failed'
        const pending = pendingDelete === key
        return (
          <div key={key} className="py-2">
            <button
              type="button"
              onClick={() => setExpanded(open ? null : key)}
              aria-expanded={open}
              aria-label={`${row.name}，${row.transport === 'http' ? 'HTTP' : 'stdio'}，${row.scope === 'global' ? '全局' : '项目'}，${row.stateWord}${open ? '，已展开' : '，展开详情'}`}
              className="pure-focus pure-surface-row -mx-2 flex w-full items-baseline gap-3 px-2 py-1.5 text-left"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] leading-[20px] text-[var(--pure-ink)]">{row.name}</span>
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
            </button>

            {row.summary ? (
              <div className="truncate pt-0.5 font-mono text-[11px] leading-[18px] text-[var(--pure-muted)]" title={row.summary}>
                {row.summary}
              </div>
            ) : null}

            {open ? (
              <div className="pt-1">
                <MonoLine>{mcpDetailLines(row.entry).map((line) => `${line.label} ${line.value}`).join('\n')}</MonoLine>
                {row.error ? (
                  <div className="pt-1">
                    <StatusLine tone="error">{row.error}</StatusLine>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-3 pt-1.5">
                  <TextAction onClick={() => void reload()} disabled={busy === row.name} label="重连 MCP 服务器">
                    重连
                  </TextAction>
                  <TextAction
                    onClick={() => void toggleRow(row)}
                    disabled={busy === row.name}
                    label={row.entry.disabled === true ? `启用服务器 ${row.name}` : `停用服务器 ${row.name}`}
                  >
                    {row.entry.disabled === true ? '启用' : '停用'}
                  </TextAction>
                  <TextAction
                    onClick={() => setPendingDelete(pending ? null : key)}
                    disabled={busy === row.name}
                    danger
                    label={`删除服务器 ${row.name}`}
                  >
                    删除
                  </TextAction>
                  {row.file ? (
                    <span className="text-[11px] leading-[16px] text-[var(--pure-muted)]">
                      配置：{mcpFileLabel(row.file)}
                    </span>
                  ) : null}
                </div>
                {pending ? (
                  <div className="pt-1.5">
                    <InlineConfirm
                      message={`确定删除服务器「${row.name}」吗？`}
                      detail={`会写入${row.scope === 'global' ? '全局' : '项目'}配置并立即生效。`}
                      confirmLabel="删除"
                      danger
                      onConfirm={() => void deleteRow(row)}
                      onCancel={() => setPendingDelete(null)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {index === rows.length - 1 && shadowed > 0 ? (
              <div className="pt-1">
                <StatusLine>{shadowed} 个全局同名条目被项目覆盖</StatusLine>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
