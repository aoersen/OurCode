/**
 * 「MCP」面的视图模型（纯函数）。
 *
 * 配置形态与主进程 mcp-manager 一致：
 *   { mcpServers: { name: { command?, args?, env?, serverUrl?, headers?, disabled?, skipTlsVerify? } } }
 * 两级：全局（所有项目）/ 项目（同名覆盖全局）。合并规则与 McpPanel / 主进程一致，
 * 这里只是把它做成可单测的纯函数。
 */
import { lastPathSegment } from '../surfaceModel'

export type McpTransport = 'stdio' | 'http'

export type McpServerState = 'connecting' | 'ready' | 'failed' | 'restarting' | 'disabled' | 'stopped'

export interface McpServerEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  serverUrl?: string
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
  skipTlsVerify?: boolean
  disabledTools?: string[]
}

export type McpServerMap = Record<string, McpServerEntry>

export interface McpStatusItem {
  name: string
  state: McpServerState
  retry?: number
  error?: string
}

export interface McpServerRow {
  name: string
  entry: McpServerEntry
  scope: 'global' | 'project'
  state: McpServerState
  transport: McpTransport
  stateWord: string
  /** 行里那行省略的命令 / URL */
  summary: string
  error?: string
  retry?: number
  file: string | null
}

export function mcpTransport(entry: McpServerEntry): McpTransport {
  return entry.serverUrl || entry.url ? 'http' : 'stdio'
}

export function mcpStateWord(state: McpServerState): string {
  switch (state) {
    case 'ready':
      return '已就绪'
    case 'connecting':
      return '连接中'
    case 'restarting':
      return '重启中'
    case 'failed':
      return '连接失败'
    case 'disabled':
      return '已停用'
    default:
      return '未启动'
  }
}

/** 配置里的 disabled 优先于运行时状态（同 McpPanel 的口径）。 */
export function mcpEntryState(entry: McpServerEntry, status?: McpStatusItem): McpServerState {
  if (entry.disabled === true) return 'disabled'
  return status?.state ?? 'stopped'
}

export function mcpSummary(entry: McpServerEntry): string {
  if (mcpTransport(entry) === 'http') return entry.serverUrl || entry.url || ''
  return [entry.command || '', ...(entry.args || [])].join(' ').trim()
}

export interface MergeMcpInput {
  project: McpServerMap
  global: McpServerMap
  status: ReadonlyArray<McpStatusItem>
  projectFile: string | null
  globalFile: string | null
}

/**
 * 生效视图：项目条目在前，未被项目同名覆盖的全局条目在后。
 * `shadowed` = 被项目覆盖掉的全局条目数（界面上给一句灰字提示）。
 */
export function mergeMcpServers(input: MergeMcpInput): { rows: McpServerRow[]; shadowed: number } {
  const statusMap = new Map(input.status.map((item) => [item.name, item]))
  const rows: McpServerRow[] = []

  const push = (name: string, entry: McpServerEntry, scope: 'global' | 'project', file: string | null) => {
    const status = statusMap.get(name)
    const state = mcpEntryState(entry, status)
    rows.push({
      name,
      entry,
      scope,
      state,
      transport: mcpTransport(entry),
      stateWord: mcpStateWord(state),
      summary: mcpSummary(entry),
      error: status?.error,
      retry: status?.retry,
      file,
    })
  }

  for (const [name, entry] of Object.entries(input.project)) push(name, entry, 'project', input.projectFile)

  let shadowed = 0
  for (const [name, entry] of Object.entries(input.global)) {
    if (name in input.project) {
      shadowed += 1
      continue
    }
    push(name, entry, 'global', input.globalFile)
  }

  return { rows, shadowed }
}

export function mcpDetailLines(entry: McpServerEntry): Array<{ label: string; value: string }> {
  const transport = mcpTransport(entry)
  const lines: Array<{ label: string; value: string }> = []
  if (transport === 'http') {
    lines.push({ label: 'URL', value: entry.serverUrl || entry.url || '' })
    const headers = Object.entries(entry.headers || {})
    if (headers.length > 0) {
      lines.push({ label: 'headers', value: headers.map(([key, value]) => `${key}: ${value}`).join('\n') })
    }
    if (entry.skipTlsVerify) lines.push({ label: 'tls', value: '跳过证书校验' })
  } else {
    lines.push({ label: 'command', value: entry.command || '' })
    if (entry.args && entry.args.length > 0) lines.push({ label: 'args', value: entry.args.join(' ') })
    const env = Object.entries(entry.env || {})
    if (env.length > 0) {
      lines.push({ label: 'env', value: env.map(([key, value]) => `${key}=${value}`).join('\n') })
    }
  }
  if (entry.disabledTools && entry.disabledTools.length > 0) {
    lines.push({ label: '停用工具', value: entry.disabledTools.join(', ') })
  }
  return lines
}

export interface McpEntryFormInput {
  name: string
  transport: McpTransport
  command: string
  args: string
  url: string
  envText: string
  headersText: string
}

function parseKeyValue(text: string, separator: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf(separator)
    if (index <= 0) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return out
}

/** 行内「添加服务器」表单 → 配置条目；校验失败返回可读错误。 */
export function parseMcpEntryForm(input: McpEntryFormInput): { name: string; entry: McpServerEntry } | { error: string } {
  const name = input.name.trim()
  if (!name) return { error: '先给服务器起个名字' }
  if (/[\\/]/.test(name)) return { error: '服务器名不能包含路径分隔符' }

  if (input.transport === 'http') {
    const url = input.url.trim()
    if (!url) return { error: `服务器「${name}」缺少 URL` }
    if (!/^https?:\/\//i.test(url)) return { error: 'URL 需要以 http:// 或 https:// 开头' }
    const entry: McpServerEntry = { serverUrl: url }
    const headers = parseKeyValue(input.headersText, ':')
    if (Object.keys(headers).length > 0) entry.headers = headers
    return { name, entry }
  }

  const command = input.command.trim()
  if (!command) return { error: `服务器「${name}」缺少启动命令` }
  const entry: McpServerEntry = { command }
  const args = input.args.split(/\s+/).map((part) => part.trim()).filter(Boolean)
  if (args.length > 0) entry.args = args
  const env = parseKeyValue(input.envText, '=')
  if (Object.keys(env).length > 0) entry.env = env
  return { name, entry }
}

/** 启停：只改 disabled 标志，其余字段原样保留。 */
export function setMcpEntryDisabled(servers: McpServerMap, name: string, enabled: boolean): McpServerMap {
  const next: McpServerMap = { ...servers }
  const entry: McpServerEntry = { ...(servers[name] || {}) }
  if (enabled) delete entry.disabled
  else entry.disabled = true
  next[name] = entry
  return next
}

export function addMcpEntry(servers: McpServerMap, name: string, entry: McpServerEntry): McpServerMap {
  return { ...servers, [name]: entry }
}

export function removeMcpEntry(servers: McpServerMap, name: string): McpServerMap {
  const next: McpServerMap = { ...servers }
  delete next[name]
  return next
}

export function mcpCounts(rows: ReadonlyArray<McpServerRow>): {
  total: number
  ready: number
  failed: number
  disabled: number
} {
  let ready = 0
  let failed = 0
  let disabled = 0
  for (const row of rows) {
    if (row.state === 'ready') ready += 1
    else if (row.state === 'failed') failed += 1
    else if (row.state === 'disabled') disabled += 1
  }
  return { total: rows.length, ready, failed, disabled }
}

/** 配置文件路径的短展示（全局那份常年在 userData 下，路径很长）。 */
export function mcpFileLabel(file: string | null): string {
  if (!file) return ''
  const name = lastPathSegment(file)
  return name || file
}
