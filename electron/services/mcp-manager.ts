/**
 * MCP (Model Context Protocol) client — main process.
 *
 * Loads two tiers of config:
 *  - global:   <userData>/mcp_config.json (via the `globalConfigPath` option)
 *              — servers available in EVERY workspace;
 *  - project:  <workspace root>/mcp_config.json (fallback .mcp.json).
 * A project entry with the same name overrides the global one. The merged
 * ("effective") config is what actually connects. Project switches apply a
 * diff, so unchanged servers (typically global ones) stay connected instead
 * of being torn down and re-handshaken on every workspace change.
 *
 * Two transports are supported:
 *
 *  - stdio:  spawn a local server as a child process; JSON-RPC 2.0 over
 *    newline-delimited JSON (LSP Content-Length framing also accepted).
 *  - HTTP:   MCP Streamable HTTP transport (2025-03-26) — POST JSON-RPC to the
 *    configured `serverUrl`, accepting `application/json` or
 *    `text/event-stream` responses, with `mcp-session-id` affinity and
 *    reconnect on stream loss.
 *
 * Lifecycle:
 *  - Tools:     tools/list → tools/call, merged into the agent's tool list.
 *  - Resources: resources/list → resources/read (context injection on demand).
 *  - Prompts:   prompts/list → prompts/get (reusable prompt templates).
 *  - Auto-restart: if a connection dies, the manager reconnects with
 *    exponential backoff (max `maxRetries`), re-runs the initialize handshake,
 *    and emits `ready` (with restarted=true). `stopAll()` marks an intentional
 *    shutdown so no zombie reconnects are scheduled.
 *
 * Security: servers are user-configured, so their tool calls are trusted.
 * stdio servers are spawned without a shell (array args); HTTP is restricted
 * to http/https and both transports cap response sizes.
 *
 * Bundled stdio servers (no system Node required): a config entry may use the
 * command "bundled-node" to run with Electron's own Node runtime
 * (process.execPath + ELECTRON_RUN_AS_NODE=1), and args starting with
 * "bundled:" resolve to the app's bundled mcp-servers directory (packaged:
 * <resources>/mcp-servers, dev: <project>/mcp-servers). See resolveStdio().
 */
import { spawn, ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { EventEmitter } from 'events'
import { request as httpRequest, ClientRequest, IncomingMessage } from 'http'
import { request as httpsRequest } from 'https'
import { scrubEnv } from './env-scrub'

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  serverUrl?: string
  url?: string
  disabled?: boolean
  disabledTools?: string[]
  headers?: Record<string, string>
  /** Skip TLS certificate verification (intranet / self-signed / private CA certs). */
  skipTlsVerify?: boolean
}

export interface McpToolInfo {
  server: string
  name: string
  description?: string
  inputSchema?: Record<string, any>
  /** True when the tool comes from lastKnownTools of a server that is NOT
   *  currently connected — the model-facing definition list filters these out,
   *  but consumers that render state (e.g. a management panel) can show
   *  "已断开" instead of the tools silently vanishing. */
  stale?: boolean
}

export interface McpResourceInfo {
  server: string
  uri: string
  name?: string
  mimeType?: string
  description?: string
}

export interface McpPromptInfo {
  server: string
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface MCPManagerOptions {
  requestTimeoutMs?: number
  restart?: { maxRetries?: number; baseDelayMs?: number }
  /**
   * Absolute path to the app's bundled `mcp-servers` directory. Enables the
   * "bundled-node" command and "bundled:" arg prefix for stdio servers — lets
   * dependency-free MCP servers run on Electron's own Node (no system Node).
   */
  bundledNodeDir?: string
  /**
   * Absolute path to the global MCP config (<userData>/mcp_config.json).
   * Servers declared there load for every workspace; a project entry with the
   * same name overrides the global one. Undefined in headless/test contexts.
   */
  globalConfigPath?: string
}

/** Connection state of a configured MCP server, as surfaced to the
 *  management UI (MCP 管理中心). */
export type McpServerState =
  | 'connecting' // handshake in progress
  | 'ready' // initialized, tools available
  | 'failed' // start/init error or reconnects exhausted
  | 'restarting' // connection lost, reconnect scheduled (backoff)
  | 'disabled' // present in config but disabled
  | 'stopped' // configured but never started (no config loaded / stopped)

export interface McpServerStatus {
  name: string
  state: McpServerState
  /** Reconnect attempt count while restarting (1-based). */
  retry?: number
  /** Last failure reason, kept while failed. */
  error?: string
  /** Runs code that shipped inside the app package rather than something the
   *  machine or the workspace provides — the renderer uses this to decide
   *  whether an `mcp__*` call needs the user's approval. */
  bundled?: boolean
}

/**
 * True when the server can only be the app's own code: Electron's Node runtime
 * plus entry points that resolve inside the packaged mcp-servers dir.
 *
 * Every other shape (`node`, `npx`, an installed CLI, a remote URL) executes
 * something this install didn't ship, so its tools keep the approval gate.
 */
export function isBundledServerConfig(server: McpServerConfig): boolean {
  if (server.serverUrl || server.url) return false
  if (server.command !== 'bundled-node') return false
  const args = server.args || []
  return args.length > 0 && args.every((arg) => arg.startsWith('bundled:'))
}

/**
 * Byte-stable identity of a server entry for diffing — key order is
 * normalized, so an edit that only reorders keys does not trigger a
 * spurious disconnect + reconnect.
 */
export function configSignature(server: McpServerConfig): string {
  return JSON.stringify(server, Object.keys(server).sort())
}

interface ServerConnection {
  transport: McpTransport
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
  idCounter: number
  initialized: boolean
}

/**
 * A server-side transport: writes JSON-RPC messages and delivers parsed
 * inbound messages. Connection loss surfaces through onEnd.
 */
interface McpTransport {
  readonly label: string
  send(msg: Record<string, any>): void
  onMessage(cb: (msg: any) => void): void
  onLog(cb: (line: string) => void): void
  onEnd(cb: (err: Error) => void): void
  close(): void
}

const PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Cap for the tools/list enumeration — it's a pure read that runs on every
 *  message send; a hung server should never hold up the whole list for the
 *  full 30s default (parallel query + this cap keeps TTFT bounded). */
const LIST_TOOLS_TIMEOUT_MS = 10_000
const DEFAULT_RESTART = { maxRetries: 5, baseDelayMs: 1_000 }
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024
/**
 * A server that stays ready for this long after its last death counts as a NEW
 * outage for backoff purposes — an occasionally restarted server (e.g. one that
 * reloads every few minutes) must not burn down maxRetries and stop reconnecting
 * forever, while a crash-looping server (never survives the window) still does.
 */
const STABLE_WINDOW_MS = 60_000

/** Pure decision for the backoff-budget reset. Exported for tests. */
export function shouldResetRetry(
  lastReady: number | undefined,
  lastDeath: number | undefined,
  now: number,
  stableWindowMs: number = STABLE_WINDOW_MS,
): boolean {
  // Never became ready (init never succeeded) → still crash-looping, no reset.
  if (lastReady === undefined) return false
  // First death after a successful ready → definitely a new outage.
  if (lastDeath === undefined) return true
  return now - lastDeath >= stableWindowMs
}

// ─────────────────────────── stdio transport ───────────────────────────

class StdioTransport implements McpTransport {
  readonly label: string
  private proc: ChildProcess
  private buffer = ''
  private framing: 'jsonl' | 'lsp' = 'jsonl'
  private messageCb: (msg: any) => void = () => {}
  private logCb: (line: string) => void = () => {}
  private endCb: (err: Error) => void = () => {}
  private closed = false

  constructor(name: string, command: string, args: string[], env: Record<string, string>, cwd: string) {
    this.label = name
    const proc = spawn(command, args, {
      cwd: cwd || undefined,
      // Inherited env is scrubbed (no credential-shaped variables leak into
      // the server); the server's OWN configured env wins over the scrub.
      env: { ...scrubEnv(process.env ?? {}), ...env } as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc = proc
    proc.stdout?.on('data', (data: Buffer) => this.onData(data.toString('utf-8')))
    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString('utf-8').trim()
      if (line) this.logCb(line)
    })
    proc.on('error', (error) => this.handleEnd(new Error(`启动失败: ${error.message}`)))
    proc.on('exit', (code) => this.handleEnd(new Error(`进程退出 (code=${code})`)))
  }

  send(msg: Record<string, any>): void {
    if (this.closed) return
    this.proc.stdin?.write(JSON.stringify(msg) + '\n')
  }

  onMessage(cb: (msg: any) => void): void { this.messageCb = cb }
  onLog(cb: (line: string) => void): void { this.logCb = cb }
  onEnd(cb: (err: Error) => void): void { this.endCb = cb }

  close(): void {
    this.closed = true
    try { this.proc.kill() } catch { /* already dead */ }
  }

  private handleEnd(err: Error): void {
    if (this.closed) return
    this.closed = true
    this.endCb(err)
  }

  private onData(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (this.buffer.length > MAX_MESSAGE_BYTES) return

    // Detect LSP Content-Length framing on first contact
    if (this.framing === 'jsonl' && this.buffer.startsWith('Content-Length:')) {
      this.framing = 'lsp'
    }
    if (this.framing === 'lsp') this.consumeLsp()
    else this.consumeJsonl()
  }

  private consumeJsonl(): void {
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      try {
        this.messageCb(JSON.parse(line))
      } catch { /* skip malformed line */ }
    }
  }

  private consumeLsp(): void {
    const headerEnd = this.buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.slice(0, headerEnd))
    if (!match) { this.buffer = this.buffer.slice(headerEnd + 4); return }
    const length = parseInt(match[1], 10)
    const bodyStart = headerEnd + 4
    if (this.buffer.length < bodyStart + length) return
    const body = this.buffer.slice(bodyStart, bodyStart + length)
    this.buffer = this.buffer.slice(bodyStart + length)
    try {
      this.messageCb(JSON.parse(body))
    } catch { /* skip malformed frame */ }
  }
}

// ─────────────────────────── HTTP (Streamable) transport ───────────────────────────

/**
 * Rewrite raw Node TLS errors into a message that points at the fix: enable
 * skipTlsVerify for intranet / self-signed / private-CA HTTPS endpoints.
 */
function friendlyCertError(err: Error): Error {
  const msg = err?.message || ''
  if (/certificate|cert_|tls|ssl|self[- ]signed/i.test(msg)) {
    return new Error(`${msg} — HTTPS 证书校验失败：内网自签名 / 私有 CA 证书请为该服务器勾选「跳过证书校验」`)
  }
  return err
}

/**
 * MCP Streamable HTTP transport (2025-03-26):
 *  - every request is a POST of a JSON-RPC message to the configured endpoint;
 *  - the response is either `application/json` (single message) or
 *    `text/event-stream` (message arrives as an SSE `data:` payload and the
 *    stream stays open for further server messages);
 *  - the `mcp-session-id` response header is captured and echoed back;
 *  - when the stream/connection drops, onEnd fires so the manager can
 *    reconnect with backoff and re-run the handshake.
 */
class HttpTransport implements McpTransport {
  readonly label: string
  private url: URL
  private extraHeaders: Record<string, string>
  private skipTlsVerify: boolean
  private sessionId: string | null = null
  private messageCb: (msg: any) => void = () => {}
  private endCb: (err: Error) => void = () => {}
  private closed = false
  private streams = new Set<ClientRequest>()

  constructor(serverUrl: string, headers: Record<string, string> = {}, skipTlsVerify = false) {
    const url = new URL(serverUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`不支持的 MCP 传输协议: ${url.protocol}`)
    }
    this.url = url
    this.extraHeaders = headers
    this.skipTlsVerify = skipTlsVerify
    this.label = serverUrl
  }

  send(msg: Record<string, any>): void {
    if (this.closed) return
    const requestFn = this.url.protocol === 'https:' ? httpsRequest : httpRequest
    // HTTP/SSE requests run in the main process (Node), so they are not subject
    // to browser CORS. rejectUnauthorized only matters for https — self-signed /
    // intranet certs are bypassed when the server config has skipTlsVerify.
    const req = requestFn(this.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      rejectUnauthorized: !this.skipTlsVerify,
    }, (res) => {
      // Non-2xx means the connection/session is unusable — fail fast and let
      // the manager reconnect instead of waiting for the request timeout.
      if (res.statusCode != null && res.statusCode >= 400) {
        res.resume()
        this.handleEnd(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim()))
        return
      }
      if (typeof res.headers['mcp-session-id'] === 'string' && !this.sessionId) {
        this.sessionId = res.headers['mcp-session-id']
      }
      const contentType = res.headers['content-type'] || ''
      if (contentType.includes('text/event-stream')) {
        this.streams.add(req)
        this.consumeSse(res, () => this.streams.delete(req))
      } else {
        this.consumeJson(res)
      }
    })
    req.on('error', (err) => this.handleEnd(friendlyCertError(err)))
    req.end(JSON.stringify(msg))
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...this.extraHeaders,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    return headers
  }

  private consumeJson(res: IncomingMessage): void {
    let data = ''
    res.setEncoding('utf-8')
    res.on('data', (chunk) => { data += chunk })
    res.on('end', () => {
      if (this.closed || !data.trim()) return
      try {
        this.messageCb(JSON.parse(data))
      } catch { /* skip malformed body */ }
    })
    res.on('error', (err) => this.handleEnd(err))
  }

  private consumeSse(res: IncomingMessage, onDone: () => void): void {
    let buffer = ''
    res.setEncoding('utf-8')
    res.on('data', (chunk: string) => {
      buffer += chunk.replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const payload = raw
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (!payload) continue
        try {
          this.messageCb(JSON.parse(payload))
        } catch { /* skip malformed SSE payload */ }
      }
    })
    // A graceful close after the server finished sending is normal (Streamable
    // HTTP opens a fresh stream per request) — keep the session alive.
    res.on('end', () => onDone())
    // An abrupt teardown means the connection is unusable → reconnect
    res.on('error', (err) => {
      onDone()
      this.handleEnd(err)
    })
    res.on('close', () => {
      if (!res.complete) {
        onDone()
        this.handleEnd(new Error('SSE 连接被中断'))
      }
    })
  }

  private handleEnd(err: Error): void {
    if (this.closed) return
    this.closed = true
    for (const s of this.streams) { try { s.destroy() } catch { /* ignore */ } }
    this.streams.clear()
    this.endCb(err)
  }

  onMessage(cb: (msg: any) => void): void { this.messageCb = cb }
  onLog(): void { /* HTTP has no stderr log stream */ }
  onEnd(cb: (err: Error) => void): void { this.endCb = cb }

  close(): void {
    this.closed = true
    for (const s of this.streams) { try { s.destroy() } catch { /* ignore */ } }
    this.streams.clear()
  }
}

// ─────────────────────────── manager ───────────────────────────

export class MCPManager extends EventEmitter {
  private connections = new Map<string, ServerConnection>()
  /** Effective (merged) config: global overridden by same-name project entries.
   *  This is what actually connects — all consumers read this. */
  private config: Record<string, McpServerConfig> = {}
  /** Global-tier config (<userData>/mcp_config.json) — last successfully read. */
  private globalConfig: Record<string, McpServerConfig> = {}
  /** Project-tier config (<root>/mcp_config.json) — last successfully read. */
  private projectConfig: Record<string, McpServerConfig> = {}
  private rootPath = ''
  /** False once servers have been (re)loaded — guards against zombie reconnects. */
  private intentionalStop = true
  private restartTimers = new Map<string, NodeJS.Timeout>()
  /** Per-server connection state, tracked for the management UI. */
  private statuses = new Map<string, McpServerStatus>()
  /** When each server last became ready — for backoff-budget resets. */
  private readyAt = new Map<string, number>()
  /** When each server last died — for backoff-budget resets. */
  private lastDeathAt = new Map<string, number>()
  /** Last successfully enumerated tools per server. Survives a disconnect so
   *  consumers can show stale tools while the server is gone; cleared on
   *  stopAll / config reload. */
  private lastKnownTools = new Map<string, McpToolInfo[]>()

  constructor(private options: MCPManagerOptions = {}) {
    super()
  }

  /**
   * Emit an 'error' event only when a listener exists. EventEmitter treats an
   * unhandled 'error' as fatal (throws), which would otherwise break
   * reconnect loops in headless contexts (e.g. tests).
   */
  private emitError(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error)
  }

  /** Merge a status patch and notify listeners (used by the management UI —
   *  the same 'status' event the reconnect path already emitted). */
  private setStatus(name: string, patch: Partial<McpServerStatus>): void {
    const prev = this.statuses.get(name) || { name, state: 'stopped' }
    const next: McpServerStatus = { ...prev, ...patch }
    this.statuses.set(name, next)
    this.emit('status', { server: name, state: next.state, retry: next.retry })
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  private get restartConfig(): { maxRetries: number; baseDelayMs: number } {
    return { ...DEFAULT_RESTART, ...(this.options.restart || {}) }
  }

  private get bundledNodeDir(): string | undefined {
    return this.options.bundledNodeDir
  }

  private get globalConfigPath(): string | undefined {
    return this.options.globalConfigPath
  }

  /**
   * Working directory for a server's child process. Project servers run in the
   * workspace they belong to; global servers run in the global config's own
   * directory (userData) — they exist independently of any workspace, so a
   * relative `args` path would otherwise break per-project. Global stdio
   * entries should use absolute paths or PATH-resolved commands.
   */
  private cwdFor(name: string): string {
    if (name in this.projectConfig) return this.rootPath
    return this.globalConfigPath ? dirname(this.globalConfigPath) : ''
  }

  /**
   * Read + parse a config file. Returns null when the file is missing or
   * unparsable (parse failures emit an 'error' event and count as empty —
   * a broken file must not silently keep yesterday's servers alive).
   */
  private readConfigFile(file: string): Record<string, McpServerConfig> | null {
    let raw = ''
    try {
      raw = readFileSync(file, 'utf-8')
    } catch {
      return null // missing file
    }
    try {
      const parsed = JSON.parse(raw)
      return (parsed.mcpServers || parsed.servers || {}) as Record<string, McpServerConfig>
    } catch (error: any) {
      this.emitError(new Error(`MCP 配置文件解析失败 (${file}): ${error.message}`))
      return null
    }
  }

  /**
   * Load global + project config and apply the diff. `rootPath` may be '' —
   * then only the global tier loads (used at startup, before any workspace
   * is open).
   */
  async loadConfig(rootPath: string): Promise<void> {
    this.rootPath = rootPath
    this.globalConfig = this.globalConfigPath ? (this.readConfigFile(this.globalConfigPath) ?? {}) : {}
    this.projectConfig = {}
    if (rootPath) {
      for (const file of [join(rootPath, 'mcp_config.json'), join(rootPath, '.mcp.json')]) {
        if (existsSync(file)) {
          this.projectConfig = this.readConfigFile(file) ?? {}
          break
        }
      }
    }
    this.applyEffectiveConfig()
  }

  /** Re-read ONLY the global tier (after a global-config save) and re-apply. */
  async loadGlobalConfig(): Promise<void> {
    if (!this.globalConfigPath) return
    this.globalConfig = this.readConfigFile(this.globalConfigPath) ?? {}
    this.applyEffectiveConfig()
  }

  /**
   * Reconcile live connections with the effective config. Full start on the
   * first load (or after stopAll); afterwards a diff — unchanged servers keep
   * their connections (global servers survive project switches without a
   * teardown + re-handshake), removed/changed ones are torn down and replaced.
   */
  private applyEffectiveConfig(): void {
    const effective: Record<string, McpServerConfig> = { ...this.globalConfig, ...this.projectConfig }
    const prev = this.config
    const removed: string[] = []
    const added: string[] = []
    for (const name of Object.keys(prev)) {
      if (!(name in effective)) removed.push(name)
      else if (configSignature(prev[name]) !== configSignature(effective[name])) {
        removed.push(name)
        added.push(name)
      } else if (this.statuses.get(name)?.state === 'failed' && !effective[name].disabled) {
        // 配置没变但连接已失败：任何一次重载（手动「重试」/ 切换项目回来）
        // 都重新发起连接尝试，而不是永远停在 failed 上等重启 IDE。
        removed.push(name)
        added.push(name)
      }
    }
    for (const name of Object.keys(effective)) {
      if (!(name in prev)) added.push(name)
    }

    this.config = effective

    if (this.intentionalStop) {
      // Fresh generation (first load / after stopAll): connect everything.
      this.intentionalStop = false
      for (const [name, server] of Object.entries(effective)) {
        this.seedAndStart(name, server)
      }
      return
    }

    for (const name of removed) this.teardownServer(name)
    for (const name of added) this.seedAndStart(name, effective[name])
  }

  /** Seed the status map, then connect (or mark disabled) — shared by the
   *  full-start and diff paths. */
  private seedAndStart(name: string, server: McpServerConfig): void {
    // Seed the status map from config before any connection attempt — the
    // UI can then show disabled/stopped servers even while none connect.
    this.setStatus(name, { name, state: server.disabled ? 'disabled' : 'stopped' })
    if (server.disabled) return
    if (server.serverUrl || server.url) {
      this.startHttpServer(name, server, 0)
    } else {
      this.startServer(name, server, 0)
    }
  }

  /** Remove a server from the live set: kill its transport, drop its status /
   *  backoff / stale-tools state. No stray statuses leak into getStatus(). */
  private teardownServer(name: string): void {
    const timer = this.restartTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.restartTimers.delete(name)
    }
    const conn = this.connections.get(name)
    if (conn) {
      try { conn.transport.close() } catch { /* already closed */ }
      this.connections.delete(name)
      this.rejectAll(conn, new Error(`MCP 服务器 "${name}" 配置已移除`))
    }
    this.statuses.delete(name)
    this.lastKnownTools.delete(name)
    this.readyAt.delete(name)
    this.lastDeathAt.delete(name)
  }

  /**
   * Resolve "bundled" stdio configs so MCP servers can run on Electron's own
   * Node runtime instead of a system-installed Node:
   *  - command "bundled-node"  → process.execPath + ELECTRON_RUN_AS_NODE=1
   *  - args starting "bundled:" → absolute path under the bundled mcp-servers
   *    dir (guarded so the resolved path cannot escape it)
   */
  private resolveStdio(server: McpServerConfig): { command: string; args: string[]; env: Record<string, string> } {
    let { command = '', args = [], env = {} } = server
    const usesBundledNode = command === 'bundled-node'
    const usesBundledPath = args.some((arg) => arg.startsWith('bundled:'))
    if ((usesBundledNode || usesBundledPath) && !this.bundledNodeDir) {
      throw new Error(`MCP 服务器 "${command}" 使用内置运行时（bundled-node / bundled:），但应用未配置内置 mcp-servers 目录`)
    }
    if (usesBundledNode) {
      command = process.execPath
      env = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    }
    args = args.map((arg) => {
      if (!arg.startsWith('bundled:')) return arg
      const rel = arg.slice('bundled:'.length)
      if (!rel) throw new Error('MCP 服务器参数 "bundled:" 后缺少相对路径')
      const resolved = join(this.bundledNodeDir!, rel)
      // The first relative path segment must not be ".." — the resolved path
      // may not escape the bundled mcp-servers dir. (Comparing only the first
      // segment, not startsWith('..'), so a filename that legitimately begins
      // with "..", e.g. "..foo.js", stays allowed.)
      const firstSegment = relative(this.bundledNodeDir!, resolved).split(/[\\/]/)[0]
      if (firstSegment === '..') {
        throw new Error(`MCP 服务器参数 "bundled:" 路径越界: ${rel}`)
      }
      return resolved
    })
    return { command, args, env }
  }

  private connectTransport(name: string, transport: McpTransport, retry: number): ServerConnection {
    const conn: ServerConnection = { transport, pending: new Map(), idCounter: 1, initialized: false }
    this.connections.set(name, conn)
    transport.onMessage((msg) => this.handleMessage(conn, msg))
    transport.onLog((line) => this.emit('serverLog', { server: name, line }))
    transport.onEnd((err) => {
      this.emitError(new Error(`MCP 服务器 "${name}" 连接断开: ${err.message}`))
      this.handleDeath(name, conn, retry, err.message)
    })
    return conn
  }

  private startServer(name: string, server: McpServerConfig, retry: number): void {
    if (this.intentionalStop) return
    if (!server.command) {
      this.setStatus(name, { state: 'failed', error: '缺少 command' })
      this.emitError(new Error(`MCP 服务器 "${name}" 缺少 command`))
      return
    }
    let conn: ServerConnection | null = null
    try {
      this.setStatus(name, { state: 'connecting', retry, error: undefined })
      const { command, args, env } = this.resolveStdio(server)
      const transport = new StdioTransport(name, command, args, env, this.cwdFor(name))
      conn = this.connectTransport(name, transport, retry)
      this.initialize(name, conn, retry).catch((error) => {
        this.emitError(new Error(`MCP 服务器 "${name}" 初始化失败: ${error.message}`))
        this.handleDeath(name, conn!, retry, error.message)
      })
    } catch (error: any) {
      this.setStatus(name, { state: 'failed', error: error.message })
      this.emitError(new Error(`MCP 服务器 "${name}" 启动失败: ${error.message}`))
      this.handleDeath(name, conn, retry, error.message)
    }
  }

  private startHttpServer(name: string, server: McpServerConfig, retry: number): void {
    if (this.intentionalStop) return
    const url = server.serverUrl || server.url || ''
    let conn: ServerConnection | null = null
    try {
      this.setStatus(name, { state: 'connecting', retry, error: undefined })
      const transport = new HttpTransport(url, server.headers || {}, server.skipTlsVerify === true)
      conn = this.connectTransport(name, transport, retry)
      this.initialize(name, conn, retry).catch((error) => {
        this.emitError(new Error(`MCP 服务器 "${name}" 初始化失败: ${error.message}`))
        this.handleDeath(name, conn!, retry, error.message)
      })
    } catch (error: any) {
      this.setStatus(name, { state: 'failed', error: error.message })
      this.emitError(new Error(`MCP 服务器 "${name}" 连接失败: ${error.message}`))
      this.handleDeath(name, conn, retry, error.message)
    }
  }

  /**
   * Connection lost (crash / exit / stream drop). Reject in-flight requests,
   * then schedule a reconnect with exponential backoff unless intentional.
   */
  private handleDeath(name: string, conn: ServerConnection | null, retry: number, reason: string): void {
    // A single death often fires multiple end signals — only act on the first
    if (conn && this.connections.get(name) !== conn) return
    if (conn) {
      this.connections.delete(name)
      this.rejectAll(conn, new Error(`MCP 服务器 "${name}" ${reason}`))
    }

    if (this.intentionalStop) return

    const now = Date.now()
    // Backoff-budget reset: if the server stayed ready for a full stable
    // window since its last death, this is a NEW outage — reset the retry
    // counter so a healthy-but-occasionally-restarted server never burns down
    // maxRetries and stops reconnecting forever. A crash-looping server never
    // survives the window, so its retries keep exhausting as before.
    if (shouldResetRetry(this.readyAt.get(name), this.lastDeathAt.get(name), now) && retry > 0) {
      retry = 0
    }
    this.lastDeathAt.set(name, now)

    const { maxRetries, baseDelayMs } = this.restartConfig
    if (retry >= maxRetries) {
      this.setStatus(name, { state: 'failed', error: reason, retry })
      this.emit('failed', { server: name, reason, retries: retry })
      this.emitError(new Error(`MCP 服务器 "${name}" 重连 ${maxRetries} 次后仍失败: ${reason}`))
      return
    }

    const delay = baseDelayMs * 2 ** retry
    this.setStatus(name, { state: 'restarting', retry: retry + 1, error: reason })
    const timer = setTimeout(() => {
      this.restartTimers.delete(name)
      if (this.intentionalStop) return
      const server = this.config[name]
      if (!server) return
      if (server.serverUrl || server.url) this.startHttpServer(name, server, retry + 1)
      else this.startServer(name, server, retry + 1)
    }, delay)
    this.restartTimers.set(name, timer)
  }

  private async initialize(name: string, conn: ServerConnection, retry: number): Promise<void> {
    const result = await this.request(conn, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'OurCode-ide', version: '0.1.0' },
    })
    void result // serverInfo/capabilities — retained for protocol negotiation
    // Send the initialized notification (no id → notification)
    this.notify(conn, 'notifications/initialized', {})
    conn.initialized = true
    // Record when this server became ready — the backoff-budget reset in
    // handleDeath uses it to tell "new outage" from "still crash-looping".
    this.readyAt.set(name, Date.now())
    // Only announce readiness if this connection is still the active one
    if (this.connections.get(name) === conn) {
      this.setStatus(name, { state: 'ready', error: undefined })
      this.emit('ready', { server: name, restarted: retry > 0 })
    }
  }

  private handleMessage(conn: ServerConnection, msg: any): void {
    if (!msg || typeof msg !== 'object') return
    if (typeof msg.id === 'number' && conn.pending.has(msg.id)) {
      const { resolve, reject } = conn.pending.get(msg.id)!
      conn.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || 'MCP 请求错误'))
      else resolve(msg.result)
    }
    // Notifications (no id) are ignored — e.g. logging from the server
  }

  private request(conn: ServerConnection, method: string, params: any, timeoutMs?: number): Promise<any> {
    const id = conn.idCounter++
    const ms = timeoutMs ?? this.requestTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        reject(new Error(`MCP 请求超时 (${method})`))
      }, ms)
      conn.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      conn.transport.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(conn: ServerConnection, method: string, params: any): void {
    conn.transport.send({ jsonrpc: '2.0', method, params })
  }

  private rejectAll(conn: ServerConnection, error: Error): void {
    for (const { reject } of conn.pending.values()) {
      reject(error)
    }
    conn.pending.clear()
  }

  /** List every tool across all connected servers (applies disabledTools).
   *  Queries all servers IN PARALLEL — the old sequential for-await made every
   *  message send pay the sum of all servers' latencies, and one slow/hung
   *  server stalled the rest for the full 30s default timeout. tools/list is a
   *  pure read, so a dedicated 10s cap bounds a misbehaving server while
   *  healthy ones finish in parallel. */
  async listTools(): Promise<McpToolInfo[]> {
    const servers = [...this.connections].filter(([, conn]) => conn.initialized)
    const perServer = await Promise.all(servers.map(async ([name, conn]) => {
      const serverConfig = this.config[name]
      try {
        const result = await this.request(conn, 'tools/list', {}, Math.min(this.requestTimeoutMs, LIST_TOOLS_TIMEOUT_MS))
        const items: any[] = result?.tools || []
        const disabled = new Set(serverConfig?.disabledTools || [])
        const tools: McpToolInfo[] = items
          .filter((tool) => !disabled.has(tool.name))
          .map((tool) => ({
            server: name,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }))
        // Cache the successfully enumerated tools — they survive a disconnect
        // (marked stale) so consumers can keep showing the server's capability
        // surface while it is gone.
        this.lastKnownTools.set(name, tools)
        return tools
      } catch {
        // Skip servers that fail to enumerate tools
        return []
      }
    }))
    const live = perServer.flat()
    // Stale tools: configured + previously enumerated servers that are not
    // currently connected. Marked stale so model-facing consumers filter them;
    // panel/state consumers can display "已断开" instead of the tools silently
    // vanishing. Cleared on stopAll / config reload.
    for (const [name, tools] of this.lastKnownTools) {
      const serverConfig = this.config[name]
      if (!serverConfig || serverConfig.disabled) continue
      const conn = this.connections.get(name)
      if (conn && conn.initialized) continue
      for (const tool of tools) live.push({ ...tool, stale: true })
    }
    return live
  }

  /** Call a tool on a specific server */
  async callTool(server: string, toolName: string, args: Record<string, any>): Promise<any> {
    const conn = this.connections.get(server)
    if (!conn || !conn.initialized) {
      throw new Error(`MCP 服务器 "${server}" 未连接`)
    }
    const result = await this.request(conn, 'tools/call', {
      name: toolName,
      arguments: args || {},
    })
    if (result?.isError) {
      const text = extractMcpText(result)
      throw new Error(text || `MCP 工具执行失败: ${toolName}`)
    }
    return result
  }

  /** List resources across all connected servers */
  async listResources(): Promise<McpResourceInfo[]> {
    const resources: McpResourceInfo[] = []
    for (const [name, conn] of this.connections) {
      if (!conn.initialized) continue
      try {
        const result = await this.request(conn, 'resources/list', {})
        for (const item of (result?.resources || [])) {
          resources.push({
            server: name,
            uri: item.uri,
            name: item.name,
            mimeType: item.mimeType,
            description: item.description,
          })
        }
      } catch {
        // Skip servers that fail to enumerate resources
      }
    }
    return resources
  }

  /** Read a resource by URI from a specific server */
  async readResource(server: string, uri: string): Promise<any> {
    const conn = this.connections.get(server)
    if (!conn || !conn.initialized) throw new Error(`MCP 服务器 "${server}" 未连接`)
    return this.request(conn, 'resources/read', { uri })
  }

  /** List prompts across all connected servers */
  async listPrompts(): Promise<McpPromptInfo[]> {
    const prompts: McpPromptInfo[] = []
    for (const [name, conn] of this.connections) {
      if (!conn.initialized) continue
      try {
        const result = await this.request(conn, 'prompts/list', {})
        for (const item of (result?.prompts || [])) {
          prompts.push({
            server: name,
            name: item.name,
            description: item.description,
            arguments: item.arguments,
          })
        }
      } catch {
        // Skip servers that fail to enumerate prompts
      }
    }
    return prompts
  }

  /** Get a prompt template (and its rendered arguments) from a specific server */
  async getPrompt(server: string, name: string, args?: Record<string, any>): Promise<any> {
    const conn = this.connections.get(server)
    if (!conn || !conn.initialized) throw new Error(`MCP 服务器 "${server}" 未连接`)
    return this.request(conn, 'prompts/get', { name, arguments: args || {} })
  }

  /** Stop every server and mark the shutdown intentional (no reconnects). */
  stopAll(): void {
    this.intentionalStop = true
    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    this.restartTimers.clear()
    for (const [name, conn] of this.connections) {
      try {
        conn.transport.close()
      } catch { /* already closed */ }
      this.connections.delete(name)
    }
    // Stale tools / backoff state belong to a loaded config generation — drop
    // them so a config reload (or app quit) can't resurrect stale state.
    this.lastKnownTools.clear()
    this.readyAt.clear()
    this.lastDeathAt.clear()
  }

  isConfigured(): boolean {
    return Object.keys(this.config).length > 0
  }

  serverNames(): string[] {
    return Array.from(this.connections.keys())
  }

  /** The workspace whose mcp_config.json is currently loaded ('' if none). */
  get loadedRoot(): string {
    return this.rootPath
  }

  /** Per-server connection state for the management UI — one entry per
   *  configured server (disabled/stopped servers included). */
  getStatus(): McpServerStatus[] {
    return Object.keys(this.config).map((name) => {
      const server = this.config[name]
      const bundled = isBundledServerConfig(server)
      if (server.disabled) return { name, state: 'disabled', bundled }
      const status = this.statuses.get(name) || { name, state: 'stopped' }
      return { ...status, bundled }
    })
  }
}

/** Extract the human-readable text from an MCP tool result or resource */
export function extractMcpText(result: any): string {
  if (!result || typeof result !== 'object') return String(result ?? '')
  if (typeof result.content === 'string') return result.content
  const parts: string[] = []
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      else if (item?.type === 'resource') parts.push(`[资源] ${item.resource?.uri || ''}`)
    }
  }
  // resources/read returns { contents: [...] } (plural) — tools/call uses content
  if (Array.isArray(result.contents)) {
    for (const item of result.contents) {
      if (item && typeof item.text === 'string') parts.push(item.text)
      else if (item?.uri) parts.push(`[资源] ${item.uri}`)
    }
  }
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2))
  return parts.join('\n')
}

export function toMcpToolDefinition(tool: McpToolInfo): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, any> }
} {
  const name = `mcp__${tool.server}__${tool.name}`
  return {
    type: 'function',
    function: {
      name,
      description: `[MCP:${tool.server}] ${tool.description || tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }
}
