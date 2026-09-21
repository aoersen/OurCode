import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, net, session, Notification, protocol, type WebContents, type IpcMainInvokeEvent, type MessageBoxOptions } from 'electron'
import { join, resolve, dirname, relative, isAbsolute, extname, basename } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { exec, execFile, spawn } from 'child_process'
import type { ExecFileOptions, ChildProcess } from 'child_process'
import * as pty from 'node-pty'
import picomatch from 'picomatch'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { FileSystemService } from './services/file-system'
import { FileIndexService } from './services/file-index'
import { SQLiteStore } from './services/sqlite-store'
import { BackupService } from './services/backup'
import { LspServer } from './services/lsp'
import { DebugAdapterClient } from './services/debug'
import { MCPManager, extractMcpText, toMcpToolDefinition } from './services/mcp-manager'
import { scrubbedSpawnEnv } from './services/env-scrub'
import { decideNavigation, hasArbitraryNavigation, revokeArbitraryNavigation, type NavigationPolicy } from './services/navigation-guard'
import { checkVcsArgs, parseGhAuthStatus } from './services/vcs-exec'
import { WireLogService } from './services/wire-log'
import {
  browserAct,
  browserClose,
  browserConsole,
  browserHistory,
  browserNavigate,
  browserPageText,
  browserScreenshot,
  browserSetVisible,
  browserState,
  initBrowserSession,
} from './services/browser-session'
import { SpillStore } from './services/spill-store'
import { WorkspaceTrust, canonicalDir, isWithinDir } from './services/workspace-trust'
import { v4 as uuidv4 } from 'uuid'
import { IPC_CHANNELS } from '../shared/constants'
import type { UsageEvent, BrowserAction, BrowserActOptions } from '../shared/types'

const DEFAULT_EXCLUDE_FOLDERS = ['node_modules', '.git', 'dist', 'build', 'out']

// Window/taskbar icon. build/ is shipped in the package (see package.json
// "build.files") and resolves to <app>/build/icon.png both in dev and when
// packaged, because __dirname is <app>/dist-electron in both cases.
const APP_ICON = join(__dirname, '..', 'build', 'icon.png')

// Files larger than this are skipped by search:inFiles (reading + splitting a
// multi-hundred-MB file to search it would block the main process)
const SEARCH_MAX_FILE_BYTES = 50 * 1024 * 1024

// ── 崩溃/异常留痕 ─────────────────────────────────────────────────────────────
// 此前主进程没有 uncaughtException 处理：任何未捕获异常都会让应用无声退出，
// 用户只看到「崩溃了」却没有任何可诊断的信息。这里把主进程异常、未处理的
// Promise 拒绝与渲染进程死亡统一追加到 userData/crash.log（保留现场供排查），
// 主进程不再因单个异常直接退出。
const CRASH_LOG_PATH = () => join(app.getPath('userData'), 'crash.log')

function appendCrashLog(kind: string, info: unknown): void {
  const line =
    `\n[${new Date().toISOString()}] ${kind}\n` +
    (info instanceof Error ? `${info.stack || info.message}` : typeof info === 'string' ? info : JSON.stringify(info)) +
    '\n'
  try {
    appendFileSync(CRASH_LOG_PATH(), line, 'utf-8')
  } catch {
    // 日志写入失败不能再抛（否则就是新的崩溃源）
  }
  console.error(`[crash:${kind}]`, info)
}

process.on('uncaughtException', (err) => appendCrashLog('uncaughtException', err))
process.on('unhandledRejection', (reason) => appendCrashLog('unhandledRejection', reason))
// 渲染进程/GPU 等子进程死亡（白屏、闪退的现场）也留痕
app.on('child-process-gone', (_event, details) => appendCrashLog('child-process-gone', details))

/**
 * Paths the renderer is allowed to touch. Populated from the dialogs the user
 * explicitly answered and from renderer-named paths that workspace trust already
 * covers (see authorizeRendererPath / WorkspaceTrust). Every fs:* handler
 * validates against this allowlist so that a compromised renderer (e.g. via the
 * Markdown surface) cannot read/write/delete arbitrary files outside what the
 * user opened.
 */
const allowedRoots: Set<string> = new Set()

/** The workspace-trust authority, created once the SQLite store is open. */
let trust: WorkspaceTrust | null = null

function normalizePath(p: string): string {
  return canonicalDir(p)
}

/** Register a directory (and everything under it) as accessible to the renderer */
function registerRoot(p: string): void {
  if (!p) return
  allowedRoots.add(normalizePath(p))
}

/**
 * Register a path the renderer named, but only if trust for it was established
 * somewhere the renderer can't forge — a native dialog the user answered, or a
 * grant persisted by an earlier run. Returns false when the path is untrusted;
 * callers must then surface the trust affordance instead of pretending the
 * workspace is merely empty.
 */
function authorizeRendererPath(p: string): boolean {
  if (!p || !isAbsolute(p)) return false
  if (!trust || !trust.isTrusted(p)) return false
  registerRoot(p)
  return true
}

/** Check whether a path is inside any registered root */
function isPathAllowed(p: string): boolean {
  // normalizePath already folds case on Windows, where the same folder has
  // many spellings (OS dialog vs stored session string).
  const probe = normalizePath(p)
  if (!probe) return false
  for (const root of allowedRoots) {
    if (isWithinDir(root, probe)) return true
  }
  return false
}

/** Throw if the path is outside every registered root */
function assertPathAllowed(p: string): void {
  if (!isPathAllowed(p)) {
    throw new Error(`路径不在允许范围内: ${p}`)
  }
}

// ── Local file preview protocol (ourcode-file://) ──────────────────────────
// The editor's preview panes (HTML browser preview / image preview) load local
// files through this scheme so relative resources (css/js/img/fonts) resolve to
// the filesystem, and the previewed HTML document gets its own permissive CSP
// instead of inheriting the app's strict one. Only files under registered roots
// are served. An optional in-memory buffer (preview:set) lets the HTML preview
// show unsaved edits live without writing them to disk.
const PREVIEW_SCHEME = 'ourcode-file'

/** Preview buffers: path → in-memory content pushed by the renderer for live
 *  HTML preview (unsaved edits). Cleared on save/close so disk is authoritative. */
const previewBuffers = new Map<string, string>()

const PREVIEW_MIME_TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  json: 'application/json', map: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain', md: 'text/markdown',
  svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf',
}

function mimeTypeOf(path: string): string {
  const ext = extname(path).toLowerCase().replace('.', '')
  return PREVIEW_MIME_TYPES[ext] || 'application/octet-stream'
}

/** Decode an ourcode-file:// URL into an absolute filesystem path. The path
 *  rides under the fixed `local` host (see previewFileUrl) so a Windows drive
 *  letter stays in the pathname instead of being parsed as the host. */
function previewUrlToPath(urlStr: string): string | null {
  let u: URL
  try {
    u = new URL(urlStr)
  } catch {
    return null
  }
  if (u.hostname !== 'local' || !u.pathname) return null
  const decoded = decodeURIComponent(u.pathname)
  return process.platform === 'win32' ? decoded.replace(/^\//, '') : decoded
}

/** Permissive CSP for previewed HTML — the page is the user's own code running
 *  in a sandboxed iframe, so scripts/styles/external CDNs behave like a browser. */
const PREVIEW_HTML_CSP = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'"

function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const filePath = previewUrlToPath(request.url)
    if (!filePath || !isPathAllowed(filePath)) {
      return new Response('Not found', { status: 404 })
    }
    const headers: Record<string, string> = {
      'content-type': mimeTypeOf(filePath),
    }
    if (headers['content-type'] === 'text/html') {
      headers['content-security-policy'] = PREVIEW_HTML_CSP
    }
    // Live preview buffer wins over disk while the file has unsaved edits
    const buffer = previewBuffers.get(filePath)
    if (buffer !== undefined) {
      return new Response(buffer, { headers })
    }
    try {
      return new Response(await readFile(filePath), { headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** Register the scheme as a standard, secure scheme so URL parsing matches
 *  http(s) (host + pathname) and the preview origin is stable. Must run before
 *  the app is ready. */
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

/** Validate an environment variable name (only plain identifiers may be resolved) */
function isSafeEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

// ── Read-only git command cache ──────────────────────────────────────────────
// StatusBar / FileTree / chatStore each poll git on their own timer (10s / 15s /
// 30s), all issuing `git status` / `git rev-parse` / `git log` independently.
// On a big repo a single `git status --porcelain` costs 0.5–5s and concurrent
// git processes contend for `.git/index.lock`, so the main process dedupes and
// serialises these read-only calls: within a TTL window the first request runs
// git and the rest are served from cache. Mutating commands and anything with
// stdin input bypass the cache. `gitExecRaw` (byte-exact blob reads for the
// diff editor) is intentionally NOT cached so it always reflects the latest
// working-tree state.
const GIT_READ_ONLY_SUBCOMMANDS = new Set(['rev-parse', 'status', 'log'])
const GIT_CACHE_TTL_MS = 5_000
const GIT_CACHE_MAX_ENTRIES = 256

interface GitCacheEntry {
  at: number
  promise: Promise<string>
}

const gitReadOnlyCache = new Map<string, GitCacheEntry>()

function gitCacheKey(cwd: string, args: string[]): string {
  return `${cwd}\u0000${args.join(' ')}`
}

function isReadOnlyGit(args: string[]): boolean {
  return args.length > 0 && GIT_READ_ONLY_SUBCOMMANDS.has(args[0])
}

/** Execute a git command and return stdout */
function gitExec(cwd: string, args: string[], input?: string): Promise<string> {
  if (!input && isReadOnlyGit(args)) {
    const key = gitCacheKey(cwd, args)
    const now = Date.now()
    const hit = gitReadOnlyCache.get(key)
    if (hit && now - hit.at < GIT_CACHE_TTL_MS) return hit.promise
    const promise = runGit(cwd, args, input, true)
    gitReadOnlyCache.set(key, { at: now, promise })
    // Simple FIFO eviction — the map preserves insertion order. The cache only
    // ever holds a handful of entries per project, so this is a safety net.
    if (gitReadOnlyCache.size > GIT_CACHE_MAX_ENTRIES) {
      const oldestKey = gitReadOnlyCache.keys().next().value
      if (oldestKey !== undefined) gitReadOnlyCache.delete(oldestKey)
    }
    return promise
  }
  // A mutating git command (or one with stdin input) invalidates the cached
  // read-only results, so the next status/log/rev-parse poll reflects the just-
  // performed mutation instead of serving a snapshot from up to 5s ago.
  gitReadOnlyCache.clear()
  return runGit(cwd, args, input, true)
}

/**
 * Execute a git command and return stdout WITHOUT trimming. Used to read blob
 * content (`git show :file` / `git show HEAD:file`) where a trailing newline or
 * leading whitespace is meaningful — the trimmed variant would corrupt the
 * left side of a diff (e.g. drop the final newline and invent a phantom change).
 */
function gitExecRaw(cwd: string, args: string[], input?: string): Promise<string> {
  return runGit(cwd, args, input, false)
}

function runGit(cwd: string, args: string[], input: string | undefined, trim: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 15000, maxBuffer: 5 * 1024 * 1024, input, env: scrubbedSpawnEnv() } as ExecFileOptions,
      (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (error) {
          reject(new Error(String(stderr || error.message)))
        } else {
          const text = String(stdout)
          resolve(trim ? text.trim() : text)
        }
      },
    )
  })
}

/** `gh` talks to GitHub over the network, so it gets a longer budget than git.
 *  Same argv discipline as runGit: execFile, no shell, scrubbed environment —
 *  except the two token variables, which are how a user may have chosen to
 *  authenticate the CLI. Handing them to `gh` is safe (its argv is allowlisted
 *  and it only ever talks to a GitHub host); handing them to `git` or a shell
 *  command would not be, and those stay fully scrubbed. */
function runGh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      {
        cwd,
        timeout: 90_000,
        maxBuffer: 5 * 1024 * 1024,
        env: scrubbedSpawnEnv({ keep: ['GH_TOKEN', 'GITHUB_TOKEN'] }),
      } as ExecFileOptions,
      (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (error) {
          // gh writes its diagnostics to BOTH streams (`gh pr view` on a repo
          // with no PRs, `gh auth status` when logged out). Returning only
          // stderr would turn "no pull request found" into an empty error.
          const text = `${String(stdout || '').trim()}\n${String(stderr || '').trim()}`.trim()
          reject(new Error(text || error.message))
        } else {
          resolve(String(stdout).trim())
        }
      },
    )
  })
}

let mainWindow: BrowserWindow | null = null
const allWindows: Set<BrowserWindow> = new Set()
let fileSystem: FileSystemService
let fileIndex: FileIndexService
let store: SQLiteStore
let backup: BackupService
let mcp: MCPManager
let spillStore: SpillStore
let wireLog: WireLogService

// Language servers by document URI (one per open file)
const lspServers = new Map<string, LspServer>()

// Active debug session (single, like VS Code's launch)
let debugClient: DebugAdapterClient | null = null

// Hosts whose TLS certificate verification is skipped (intranet / self-signed /
// private-CA certs). Populated from config groups with skipTlsVerify enabled —
// only those hosts get the bypass, everything else keeps default verification.
const tlsSkippedHosts: Set<string> = new Set()

// Hosts of in-flight requests that opted in via req.skipTlsVerify (unsaved
// draft configs being connection-tested). Removed when the request finishes.
const tlsDraftHosts: Set<string> = new Set()

/** Rebuild the TLS-bypass host set from the persisted config groups. */
function refreshTlsSkippedHosts(): void {
  tlsSkippedHosts.clear()
  try {
    for (const group of store.getConfigGroups()) {
      if (!group.skipTlsVerify) continue
      let parsed: URL
      try {
        parsed = new URL(group.baseUrl)
      } catch {
        continue
      }
      if (parsed.protocol === 'https:' && parsed.hostname) tlsSkippedHosts.add(parsed.hostname)
    }
  } catch {
    // Store not ready yet — the first refresh happens right after init
  }
}

/**
 * Accept certificates only for hosts the user explicitly opted into bypassing
 * (per-config skipTlsVerify). 0 = trust, -3 = fall back to default verification.
 * Affects main-process net.fetch (the llm:http / web:fetch bridge) as well as
 * webContents loads in the default session; Node https requests (e.g. MCP
 * transports) are unaffected.
 */
function registerTlsBypass(): void {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(tlsSkippedHosts.has(request.hostname) || tlsDraftHosts.has(request.hostname) ? 0 : -3)
  })
}

/** Broadcast a debug event to all windows. */
function emitDebugEvent(event: string, body: unknown): void {
  broadcast(`debug:${event}`, body)
}

/** Stop and clear the active debug session. */
async function stopDebugSession(): Promise<void> {
  if (!debugClient) return
  const client = debugClient
  debugClient = null
  await client.stop().catch(() => {})
}

/** Stop and remove the language server for a document (if any). */
async function lspStop(uri: string): Promise<void> {
  const server = lspServers.get(uri)
  if (server) {
    lspServers.delete(uri)
    await server.stop().catch(() => {})
  }
}

/** Stop every language server (app shutdown). */
async function stopAllLspServers(): Promise<void> {
  await Promise.all(Array.from(lspServers.keys()).map((uri) => lspStop(uri)))
}

interface TerminalSession {
  pty: pty.IPty
  webContents: WebContents
  /** 'view' = an integrated-terminal tab, killed when its tab closes.
   *  'agent' = started by the assistant, so it outlives any view. */
  owner: 'view' | 'agent'
  /** Raw pty output, oldest first, capped so a chatty watcher can't grow forever */
  chunks: string[]
  chars: number
  /** null while the process is still running */
  exitCode: number | null
  /** Command line an agent run was started with (shown as the tab title) */
  command: string
}
const terminals = new Map<string, TerminalSession>()

/** In-flight `shell:exec` runs keyed by the renderer's requestId, so hitting
 *  Stop can take the process down instead of only discarding its result. */
const shellRuns = new Map<string, ChildProcess>()
/** requestIds the user stopped — their exec callback reports 用户终止, not 超时 */
const shellStopped = new Set<string>()

/**
 * Kill a plain child process together with everything it launched.
 *
 * `child.kill()` only reaches the direct child: on Windows the shell is
 * powershell.exe, so `npm run build` leaves the real compiler holding the CPU
 * (and often the output files) after the agent already moved on. Ask the OS
 * for the whole tree there; SIGKILL can't be trapped on POSIX.
 */
function killChildTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid != null) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  child.kill('SIGKILL')
}

const CAPTURE_LIMIT_CHARS = 512 * 1024
/** Finished agent runs stay readable until this many are queued up; older ones
 *  are dropped so a long conversation cannot accumulate dead pty processes. */
const MAX_FINISHED_AGENT_RUNS = 8
/** Hard ceiling on live agent processes — `stop_terminal` is cooperative, and a
 *  model that ignores it must not be able to pile up shells indefinitely. */
const MAX_LIVE_AGENT_RUNS = 12

function captureOutput(session: TerminalSession, data: string): void {
  session.chunks.push(data)
  session.chars += data.length
  if (session.chars <= CAPTURE_LIMIT_CHARS) return
  // Drop from the front down to half the cap rather than trimming to exactly
  // the limit, so a stream that sits on the ceiling doesn't re-splice per chunk.
  let drop = 0
  while (session.chars > CAPTURE_LIMIT_CHARS / 2 && drop < session.chunks.length - 1) {
    session.chars -= session.chunks[drop].length
    drop++
  }
  session.chunks.splice(0, drop)
}

/** Free capacity for a new agent run by retiring its oldest finished siblings */
function pruneAgentRuns(): void {
  const finished: [string, TerminalSession][] = []
  for (const [id, session] of terminals) {
    if (session.owner === 'agent' && session.exitCode !== null) finished.push([id, session])
  }
  while (finished.length >= MAX_FINISHED_AGENT_RUNS) {
    const [id, session] = finished.shift()!
    terminals.delete(id)
    try {
      killProcessTree(session)
    } catch {
      /* already exited */
    }
  }
}

/**
 * Take a run down including whatever it launched.
 *
 * node-pty's own kill() only terminates the shell it spawned, so a dev server
 * the assistant started with it would keep the port bound and the CPU spinning
 * after `stop_terminal` claimed success. On POSIX the shell forwards SIGHUP to
 * its jobs; on Windows there is no such convention, so ask the OS for the tree.
 */
function killProcessTree(session: TerminalSession): void {
  const pid = session.pty.pid
  if (process.platform === 'win32' && pid) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  session.pty.kill()
}

/** Broadcast a message to every open window */
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

/** Target the window that sent an IPC request (supports multiple windows) */
function windowFromEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/** Per-window lifecycle: maximize state push + terminal cleanup on close */
function attachWindowLifecycle(win: BrowserWindow): void {
  // Capture eagerly — accessing win.webContents after 'closed' throws "Object has been destroyed"
  const wcId = win.webContents.id
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', true)
  })
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', false)
  })
  win.on('closed', () => {
    // Kill terminals owned by this window
    for (const [id, t] of terminals) {
      if (t.webContents.id === wcId) {
        if (t.owner === 'agent') killProcessTree(t)
        else t.pty.kill()
        terminals.delete(id)
      }
    }
    // The agent browser window is hidden and is not an app window: left open, it
    // keeps `window-all-closed` from ever firing, so on Windows/Linux the process
    // would linger with no UI. Deferred one tick so the listener that removes
    // THIS window from allWindows (registered after this one) has run. On macOS
    // the app intentionally survives with no windows, and the browser session
    // keeps its cookies for when it comes back — it goes with the app instead.
    if (process.platform !== 'darwin') {
      setImmediate(() => {
        if (allWindows.size === 0) browserClose()
      })
    }
  })
}

/** Pin every app window to the app's own origins (see navigation-guard.ts). */
function installNavigationGuards(): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const policy: NavigationPolicy = {
    devOrigin: devUrl ? new URL(devUrl).origin : undefined,
    rendererDir: join(__dirname, 'renderer'),
  }
  app.on('web-contents-created', (_event, contents) => {
    const arbitrary = (): boolean => hasArbitraryNavigation(contents.id)
    contents.on('will-navigate', (event, url) => {
      const decision = decideNavigation(url, policy, arbitrary())
      if (decision !== 'allow') {
        event.preventDefault()
        if (decision === 'open-external') void shell.openExternal(url).catch(() => {})
      }
    })
    // window.open() — including the popups the HTML preview iframe is allowed
    // to create. Without a handler Electron builds a window with default
    // preferences, so this is the only thing standing between previewed code
    // and an unguarded top-level page.
    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideNavigation(url, policy, arbitrary())
      if (decision === 'open-external') void shell.openExternal(url).catch(() => {})
      return { action: 'deny' }
    })
    contents.on('destroyed', () => revokeArbitraryNavigation(contents.id))
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1e1e1e',
    icon: APP_ICON,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // Renderers are sandboxed (like VS Code): the preload only uses the
      // sandbox-whitelisted electron APIs (contextBridge/ipcRenderer), so a
      // compromised renderer cannot reach Node.js primitives directly.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Open devtools in development. `is.dev` is true for ANY unpackaged app —
  // including Playwright e2e runs against dist-electron/main.js — and a docked
  // DevTools window squeezes the editor layout (which the e2e specs assert on).
  // Auto-open only under the electron-vite dev server, the precise dev signal.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.webContents.openDevTools()
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, 'renderer/index.html'))
  }

  attachWindowLifecycle(mainWindow)

  allWindows.add(mainWindow!)
  mainWindow!.on('closed', () => {
    allWindows.delete(mainWindow!)
    mainWindow = null
  })
}

function createNewWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1e1e1e',
    icon: APP_ICON,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, 'renderer/index.html'))
  }

  attachWindowLifecycle(win)

  allWindows.add(win)
  win.on('closed', () => {
    allWindows.delete(win)
  })
}

/**
 * 「一人公司」独立窗口：渲染进程通过 preload 暴露的 isOfficeMode 识别本窗口
 * 模式（webPreferences.additionalArguments → process.argv），从而以 3D 办公室
 * 视图为落地页，并使用独立的会话（mode='office'）/项目命名空间。与主对话
 * 窗口互不干扰。
 */
function createOfficeWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1e1e1e',
    icon: APP_ICON,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--office-mode'],
    },
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, 'renderer/index.html'))
  }

  attachWindowLifecycle(win)

  allWindows.add(win)
  win.on('closed', () => {
    allWindows.delete(win)
  })
}

// ── Search backends ─────────────────────────────────────────────────────────
// search:inFiles / search:files 的三级后端：内存索引（毫秒级）→ ripgrep
// （10-100x 快）→ Node 遍历（兜底）。调用链见 registerIpcHandlers。

type SearchInFilesResult = Array<{ filePath: string; fileName: string; lineNumber: number; lineContent: string; matchStart: number; matchEnd: number }>

/** 优先用随应用分发的 ripgrep（打包后固定在 resources/tools/ripgrep/）；
 *  开发 / 未打包环境先试仓库内置的对应平台/架构二进制，再退回 PATH 上的 rg。 */
function resolveRgBinary(): string | null {
  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'tools', 'ripgrep', rgName)
    if (existsSync(bundled)) return bundled
  } else {
    const osDir = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
    const local = join(app.getAppPath(), 'tools', 'ripgrep', osDir, process.arch, rgName)
    if (existsSync(local)) return local
  }
  return 'rg'
}

/** ripgrep 内容搜索。返回 null 表示 rg 不可用（调用方回退 Node 遍历）。 */
function rgSearchInFiles(
  dirPath: string,
  query: string,
  options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; filePattern?: string; excludeFolders?: string },
): Promise<SearchInFilesResult | null> {
  return new Promise((resolve) => {
    const rgBin = resolveRgBinary()
    if (!rgBin) return resolve(null)
    const args = ['--json', '--line-number', '--max-count', '50', '--no-ignore']
    if (!options?.caseSensitive) args.push('-i')
    // 非 regex / 非整词 → 固定字符串，query 里的特殊字符不解释
    if (!options?.regex && !options?.wholeWord) args.push('-F')
    for (const d of DEFAULT_EXCLUDE_FOLDERS) args.push('-g', `!${d}`)
    if (options?.excludeFolders) {
      for (const d of options.excludeFolders.split(',').map((s) => s.trim()).filter(Boolean)) args.push('-g', `!${d}`)
    }
    if (options?.filePattern) {
      for (const p of options.filePattern.split(',').map((s) => s.trim()).filter(Boolean)) args.push('-g', p)
    }
    const finalQuery = options?.wholeWord
      ? `\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
      : query
    args.push('--', finalQuery, dirPath)

    const results: SearchInFilesResult = []
    const maxResults = 500
    let done = false
    let buf = ''
    const child = spawn(rgBin, args, { windowsHide: true, env: scrubbedSpawnEnv() })
    child.stdout.on('data', (d: Buffer) => {
      if (done) return
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (obj.type !== 'match') continue
          const data = obj.data
          const full = String(data.lines?.text ?? '')
          const filePath = String(data.path?.text ?? '')
          const sm = data.submatches?.[0]
          if (!sm) continue
          const matchText = String(sm.match?.text ?? '')
          const start = full.indexOf(matchText)
          results.push({
            filePath,
            fileName: filePath.split(/[\\/]/).pop() || '',
            lineNumber: data.line_number ?? 0,
            lineContent: full.trim(),
            matchStart: start === -1 ? 0 : start,
            matchEnd: start === -1 ? matchText.length : start + matchText.length,
          })
          if (results.length >= maxResults) {
            done = true
            child.kill()
            return resolve(results)
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    })
    child.on('error', () => { if (!done) { done = true; resolve(null) } })
    child.on('close', () => { if (!done) { done = true; resolve(results) } })
    child.stderr.on('data', () => { /* 忽略 */ })
  })
}

/** ripgrep 文件名搜索（@ 引用）。返回 null 表示 rg 不可用。 */
function rgSearchFiles(dirPath: string, query: string, maxResults = 50): Promise<string[] | null> {
  return new Promise((resolve) => {
    const rgBin = resolveRgBinary()
    if (!rgBin) return resolve(null)
    if (!query) return resolve([])
    const args = ['--files', '--no-ignore']
    for (const d of DEFAULT_EXCLUDE_FOLDERS) args.push('-g', `!${d}`)
    // glob 元字符（* ? [] 等）→ 真 glob：rg 的 --iglob 按相对路径匹配且 `*`
    // 不跨 `/`，故加 `**/` 前缀以匹配任意层级（与索引层 basename 匹配对齐）。
    // 否则转义后按字面子串包裹 `*`（保持 @ 引用按片段命中的行为）。
    const hasGlob = /[*?[\]{}()!]/.test(query)
    if (hasGlob) {
      args.push('--iglob', `**/${query}`, '--', dirPath)
    } else {
      const escaped = query.replace(/[\\*?[\]{}()!]/g, '\\$&')
      args.push('--iglob', `*${escaped}*`, '--', dirPath)
    }
    const results: string[] = []
    let done = false
    let buf = ''
    const child = spawn(rgBin, args, { windowsHide: true, env: scrubbedSpawnEnv() })
    child.stdout.on('data', (d: Buffer) => {
      if (done) return
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const p = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (p) {
          results.push(p)
          if (results.length >= maxResults) {
            done = true
            child.kill()
            return resolve(results)
          }
        }
      }
    })
    child.on('error', () => { if (!done) { done = true; resolve(null) } })
    child.on('close', () => { if (!done) { done = true; resolve(results) } })
    child.stderr.on('data', () => { /* 忽略 */ })
  })
}

/** Node 遍历兜底 — 原 search:inFiles 实现（rg 不存在 / 失败时保持可用）。 */
async function nodeWalkSearchInFiles(
  dirPath: string,
  query: string,
  options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; filePattern?: string; excludeFolders?: string },
): Promise<SearchInFilesResult> {
  const results: SearchInFilesResult = []
  const maxResults = 500

  const userExcludes = options?.excludeFolders
    ? options.excludeFolders.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  const excludeSet = new Set([...DEFAULT_EXCLUDE_FOLDERS, ...userExcludes])

  const filePatterns = options?.filePattern
    ? options.filePattern.split(',').map((s) => s.trim()).filter(Boolean)
    : null
  const fileMatcher = filePatterns ? picomatch(filePatterns) : null

  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const searchInFile = async (filePath: string) => {
    try {
      const { content } = await fileSystem.readFile(filePath)
      const lines = content.split('\n')
      const fileName = filePath.split(/[\\/]/).pop() || ''

      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const line = lines[i]
        let match: RegExpExecArray | null = null

        if (options?.regex) {
          try {
            const flags = options?.caseSensitive ? 'g' : 'gi'
            const re = new RegExp(query, flags)
            match = re.exec(line)
          } catch { /* invalid regex */ }
        } else {
          const escaped = escapeRegExp(query)
          const pattern = options?.wholeWord ? `\\b${escaped}\\b` : escaped
          const flags = options?.caseSensitive ? 'g' : 'gi'
          const re = new RegExp(pattern, flags)
          match = re.exec(line)
        }

        if (match) {
          results.push({
            filePath,
            fileName,
            lineNumber: i + 1,
            lineContent: line.trim(),
            matchStart: match.index,
            matchEnd: match.index + match[0].length,
          })
        }
      }
    } catch { /* skip unreadable files */ }
  }

  const walkDir = async (dir: string) => {
    if (results.length >= maxResults) return
    try {
      const entries = await fileSystem.listDir(dir)
      for (const entry of entries) {
        if (results.length >= maxResults) return
        if (entry.isHidden) continue
        if (entry.isDirectory) {
          // Skip excluded folder names
          const dirName = entry.name || entry.path.split(/[\\/]/).pop() || ''
          if (excludeSet.has(dirName)) continue
          await walkDir(entry.path)
        } else {
          // Apply file pattern filter
          if (fileMatcher && !fileMatcher(entry.name || '')) continue
          // Skip huge files — reading + splitting them to search would freeze
          // the main process
          if ((entry.size ?? 0) > SEARCH_MAX_FILE_BYTES) continue
          await searchInFile(entry.path)
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  // dirPath 可能是单个文件（search_in_files 的 path 也接受文件）：直接搜该
  // 文件，而不是当目录递归——listDir 对文件会失败并静默返回空，导致本应命中
  // 的搜索变成 "No matches found"。
  try {
    const stat = await fileSystem.stat(dirPath)
    if (stat.isFile) {
      const fileName = dirPath.split(/[\\/]/).pop() || ''
      if (stat.size <= SEARCH_MAX_FILE_BYTES && (!fileMatcher || fileMatcher(fileName))) {
        await searchInFile(dirPath)
      }
      return results
    }
  } catch { /* stat 失败（路径不存在等）按目录处理，保持原有行为 */ }

  await walkDir(dirPath)
  return results
}

/** Node 遍历兜底 — 原 search:files 实现（rg 不存在 / 失败时保持可用）。 */
async function nodeWalkSearchFiles(dirPath: string, query: string): Promise<string[]> {
  const results: string[] = []
  const maxResults = 50
  const lowerQuery = (query || '').toLowerCase()

  if (!lowerQuery) return results

  // glob 元字符 → 按文件名（basename）glob 匹配；否则字面子串（与索引层对齐）
  const hasGlob = /[*?[\]{}()!]/.test(query)
  const matcher = hasGlob ? picomatch(query, { dot: true }) : null
  const nameHit = (name: string) =>
    hasGlob ? matcher!(name) : name.toLowerCase().includes(lowerQuery)

  const walkDir = async (dir: string) => {
    if (results.length >= maxResults) return
    try {
      const entries = await fileSystem.listDir(dir)
      for (const entry of entries) {
        if (results.length >= maxResults) return
        if (entry.isHidden) continue
        if (entry.isDirectory) {
          const dirName = entry.name || entry.path.split(/[\\/]/).pop() || ''
          if (DEFAULT_EXCLUDE_FOLDERS.includes(dirName)) continue
          await walkDir(entry.path)
        } else {
          if (nameHit(entry.name || '')) {
            results.push(entry.path)
          }
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  // 同上：dirPath 可能是单个文件，直接按文件名匹配
  try {
    const stat = await fileSystem.stat(dirPath)
    if (stat.isFile) {
      const fileName = dirPath.split(/[\\/]/).pop() || ''
      if (nameHit(fileName)) results.push(dirPath)
      return results
    }
  } catch { /* 按目录处理 */ }

  await walkDir(dirPath)
  return results
}

// Register IPC handlers
function registerIpcHandlers(): void {
  // File System handlers
  ipcMain.handle('fs:readFile', async (_event, path: string) => {
    assertPathAllowed(path)
    return fileSystem.readFile(path)
  })

  ipcMain.handle('fs:writeFile', async (_event, path: string, content: string, encoding: string, hasBom?: boolean) => {
    assertPathAllowed(path)
    await fileSystem.writeFile(path, content, encoding, hasBom)
    // A successful write moves the file past its reverted state — any stale
    // 「已回退 → 恢复」forward snapshot for this path is now outdated and must
    // not be able to restore old AI content over the new one.
    store.deleteRevertedFileByPath(path)
  })

  ipcMain.handle('fs:openStream', async (_event, path: string) => {
    assertPathAllowed(path)
    return fileSystem.openStream(path)
  })

  ipcMain.handle('fs:readChunk', async (_event, id: number) => {
    return fileSystem.readNext(id)
  })

  ipcMain.handle('fs:readChunkBatch', async (_event, id: number, maxBytes?: number) => {
    return fileSystem.readBatch(id, maxBytes)
  })

  ipcMain.handle('fs:closeStream', async (_event, id: number) => {
    return fileSystem.closeStream(id)
  })

  ipcMain.handle('fs:openWriteStream', async (_event, path: string, encoding: string, hasBom?: boolean) => {
    assertPathAllowed(path)
    return fileSystem.openWriteStream(path, encoding, hasBom)
  })

  ipcMain.handle('fs:writeChunk', async (_event, id: number, chunk: string) => {
    return fileSystem.writeChunk(id, chunk)
  })

  ipcMain.handle('fs:closeWriteStream', async (_event, id: number) => {
    const finalPath = await fileSystem.closeWriteStream(id)
    // Streamed saves (user Ctrl+S) also supersede any pending restore of the
    // written path — same reasoning as fs:writeFile.
    if (finalPath) store.deleteRevertedFileByPath(finalPath)
    return finalPath
  })

  ipcMain.handle('fs:abortWriteStream', async (_event, id: number) => {
    return fileSystem.abortWriteStream(id)
  })

  // File preview buffers — the renderer pushes live (unsaved) HTML content here
  // so the ourcode-file:// protocol serves it to the preview iframe without
  // writing to disk. Unauthorized paths are silently ignored (the protocol
  // handler refuses to serve them anyway) rather than throwing to the renderer.
  ipcMain.handle(IPC_CHANNELS.PREVIEW_SET, (_event, path: string, content: string) => {
    if (!isPathAllowed(path)) return
    previewBuffers.set(path, content)
  })

  ipcMain.handle(IPC_CHANNELS.PREVIEW_CLEAR, (_event, path: string) => {
    if (!isPathAllowed(path)) return
    previewBuffers.delete(path)
  })

  ipcMain.handle('fs:listDir', async (_event, path: string) => {
    assertPathAllowed(path)
    return fileSystem.listDir(path)
  })

  ipcMain.handle('fs:createFile', async (_event, path: string) => {
    assertPathAllowed(path)
    return fileSystem.createFile(path)
  })

  ipcMain.handle('fs:createDir', async (_event, path: string) => {
    assertPathAllowed(path)
    return fileSystem.createDir(path)
  })

  ipcMain.handle('fs:rename', async (_event, oldPath: string, newPath: string) => {
    assertPathAllowed(oldPath)
    assertPathAllowed(newPath)
    return fileSystem.rename(oldPath, newPath)
  })

  ipcMain.handle('fs:delete', async (_event, path: string) => {
    assertPathAllowed(path)
    await fileSystem.delete(path)
    // Deleting the file supersedes any pending restore of it (same reasoning
    // as fs:writeFile above).
    store.deleteRevertedFileByPath(path)
  })

  ipcMain.handle('fs:stat', async (_event, path: string) => {
    assertPathAllowed(path)
    try {
      return await fileSystem.stat(path)
    } catch (error) {
      // A missing file is a normal probe result (e.g. <userData>/skills.json
      // before any global skill config exists, or rules.json probes) — resolve
      // with null instead of rejecting, which would log an error per probe.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  })

  ipcMain.handle('fs:watch', async (_event, path: string) => {
    // Watching is also what starts a workspace's MCP servers, so this is the
    // one call that turns an untrusted folder into code execution. Untrusted
    // roots register nothing at all and say so.
    if (!authorizeRendererPath(path)) return { ok: false, untrusted: true }
    // Batch watcher events per root: a build (or install) emits hundreds of
    // change events in quick succession; broadcasting each one as its own
    // fs:fileChanged IPC message floods the renderer and forces a full
    // file-tree refresh per event. Coalesce paths within a short window and
    // flush them in one go. Heavily machine-generated dirs (dist/build/out/...)
    // are already dropped at the watcher level, so this only smooths over the
    // remaining burst of real source edits.
    const pendingPaths = new Set<string>()
    let flushTimer: NodeJS.Timeout | null = null
    const flush = (): void => {
      flushTimer = null
      const changed = Array.from(pendingPaths)
      pendingPaths.clear()
      for (const changedPath of changed) {
        broadcast('fs:fileChanged', changedPath)
        // Keep the in-memory codebase index fresh (single-file edits update in
        // place; event bursts debounce into a full rebuild)
        fileIndex.onFileChanged(changedPath)
      }
    }
    fileSystem.watch(path, (changedPath) => {
      pendingPaths.add(changedPath)
      if (flushTimer === null) flushTimer = setTimeout(flush, 150)
    })
    // Warm the search index in the background so the first search is already
    // served from memory; MCP servers load in parallel below.
    fileIndex.markWatched(path)
    // Loading a workspace also (re)loads its MCP servers
    try {
      await mcp.loadConfig(path)
    } catch (error: any) {
      console.error('MCP 配置加载失败:', error.message)
    }
    return { ok: true }
  })

  ipcMain.handle('fs:unwatch', async (_event, path: string) => {
    fileSystem.unwatch(path)
  })

  // Authorize a path (and everything under it) without starting a watcher or
  // loading MCP config. The renderer probes paths at startup (restoring the
  // last project) when the allowlist is still empty — fs:watch can't be reused
  // there because it would start a watcher / reload MCP servers as a side
  // effect. Registration is refused unless trust exists; the renderer reports
  // back and offers trust:request.
  ipcMain.handle('fs:authorize', async (_event, path: string) => {
    return authorizeRendererPath(path)
  })

  // Ask the user to trust a workspace. The confirmation is a NATIVE dialog that
  // only the main process opens — a renderer that got past the fs allowlist
  // must not also be able to answer the trust prompt on the user's behalf.
  ipcMain.handle('trust:request', async (event, path: string) => {
    if (!path || !isAbsolute(path)) return false
    if (authorizeRendererPath(path)) return true
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      return false
    }
    if (!isDir) return false
    // A prompt the user can't read isn't a consent. The renderer's i18n lives
    // behind the allowlist we are about to open, so the wording comes from the
    // OS locale here.
    const zh = app.getLocale().toLowerCase().startsWith('zh')
    const options: MessageBoxOptions = zh
      ? {
          type: 'warning',
          title: '信任该文件夹？',
          message: `是否允许 OurCode 使用「${basename(path)}」？`,
          detail:
            `${path}\n\n` +
            '信任后 IDE 才能读写该文件夹，并且会启动它自带的 MCP 服务——即 ' +
            'mcp_config.json / .mcp.json 里声明的进程。只信任来源可靠的文件夹。',
          buttons: ['信任并继续', '不信任'],
        }
      : {
          type: 'warning',
          title: 'Trust this folder?',
          message: `Allow OurCode to work in "${basename(path)}"?`,
          detail:
            `${path}\n\n` +
            'Only after you trust it can the IDE read and write the folder, and it will start ' +
            'the folder\u2019s own MCP servers \u2014 the processes declared in mcp_config.json / ' +
            '.mcp.json. Trust folders you know where they came from.',
          buttons: ['Trust', "Don't trust"],
        }
    Object.assign(options, { defaultId: 1, cancelId: 1, noLink: true })
    const win = windowFromEvent(event) ?? mainWindow
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    if (response !== 0) return false
    trust?.grant(path)
    registerRoot(path)
    return true
  })

  ipcMain.handle('trust:status', async (_event, path: string) => {
    return { trusted: !!path && !!trust?.isTrusted(path) }
  })

  // Withdraw trust: forget the durable grant, drop it from the session
  // allowlist, stop watching it, and take down the MCP servers it started.
  ipcMain.handle('trust:revoke', async (_event, path: string) => {
    if (!path || !isAbsolute(path)) return false
    trust?.revoke(path)
    const canonical = normalizePath(path)
    allowedRoots.delete(canonical)
    try {
      fileSystem.unwatch(path)
    } catch {
      /* not watched — nothing to stop */
    }
    if (mcp && normalizePath(mcp.loadedRoot || '') === canonical) mcp.stopAll()
    return true
  })

  ipcMain.handle('fs:openInFinder', async (_event, path: string) => {
    assertPathAllowed(path)
    shell.showItemInFolder(path)
  })

  ipcMain.handle('fs:copyPath', async (_event, path: string) => {
    clipboard.writeText(path)
  })

  ipcMain.handle('fs:copy', async (_event, src: string, dest: string) => {
    assertPathAllowed(src)
    assertPathAllowed(dest)
    return fileSystem.copy(src, dest)
  })

  ipcMain.handle('fs:move', async (_event, src: string, dest: string) => {
    assertPathAllowed(src)
    assertPathAllowed(dest)
    return fileSystem.move(src, dest)
  })

  // Hot-exit backups (unsaved dirty buffers mirrored off the real file)
  ipcMain.handle('backup:save', async (_event, filePath: string, content: string, encoding: string, hasBom?: boolean) => {
    return backup.save(filePath, content, encoding, Boolean(hasBom))
  })

  ipcMain.handle('backup:list', async () => {
    return backup.list()
  })

  ipcMain.handle('backup:read', async (_event, filePath: string) => {
    return backup.read(filePath)
  })

  ipcMain.handle('backup:delete', async (_event, filePath: string) => {
    return backup.delete(filePath)
  })

  ipcMain.handle('backup:clearAll', async () => {
    return backup.clearAll()
  })

  // LSP: start a language server for a document, push diagnostics back
  ipcMain.handle('lsp:start', async (_event, uri: string, command: string, args: string[], cwd: string, languageId: string, text: string) => {
    await lspStop(uri)
    if (cwd) assertPathAllowed(cwd)
    const server = new LspServer()
    server.onDiagnostics = (params) => {
      broadcast('lsp:diagnostics', { uri: params.uri, diagnostics: params.diagnostics })
    }
    server.onStderr = (line) => {
      if (is.dev) console.debug(`[lsp:${languageId}]`, line.trimEnd())
    }
    try {
      await server.start({ command, args, cwd })
      server.didOpen(uri, languageId, text)
      lspServers.set(uri, server)
      return { ok: true as const }
    } catch (error) {
      await server.stop().catch(() => {})
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('lsp:didChange', async (_event, uri: string, version: number, text: string) => {
    lspServers.get(uri)?.didChange(uri, text, version)
  })

  ipcMain.handle('lsp:stop', async (_event, uri: string) => {
    await lspStop(uri)
  })

  // DAP: single debug session
  ipcMain.handle('debug:start', async (_event, command: string, args: string[], cwd: string, launchConfig: Record<string, unknown>, breakpoints: Array<{ path: string; line: number }>) => {
    await stopDebugSession()
    if (cwd) assertPathAllowed(cwd)
    const client = new DebugAdapterClient()
    client.onStopped = (body) => emitDebugEvent('stopped', body)
    client.onOutput = (body) => emitDebugEvent('output', body)
    client.onTerminated = (body) => {
      emitDebugEvent('terminated', body)
      void stopDebugSession()
    }
    client.onStderr = (line) => {
      if (is.dev) console.debug('[dap]', line.trimEnd())
    }
    try {
      await client.start(command, args, cwd)
      debugClient = client
      // Group breakpoints by file
      const byFile = new Map<string, number[]>()
      for (const bp of breakpoints) {
        const list = byFile.get(bp.path) ?? []
        list.push(bp.line)
        byFile.set(bp.path, list)
      }
      for (const [path, lines] of byFile) {
        await client.setBreakpoints(path, lines)
      }
      await client.launch(launchConfig)
      await client.configurationDone()
      await client.continueReq()
      return { ok: true as const }
    } catch (error) {
      await client.stop().catch(() => {})
      debugClient = null
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('debug:setBreakpoints', async (_event, path: string, lines: number[]) => {
    if (!debugClient) return
    await debugClient.setBreakpoints(path, lines)
  })

  ipcMain.handle('debug:continue', async () => {
    await debugClient?.continueReq()
  })

  ipcMain.handle('debug:pause', async () => {
    await debugClient?.pause()
  })

  ipcMain.handle('debug:stepOver', async () => {
    await debugClient?.stepOver()
  })

  ipcMain.handle('debug:stepInto', async () => {
    await debugClient?.stepInto()
  })

  ipcMain.handle('debug:stepOut', async () => {
    await debugClient?.stepOut()
  })

  ipcMain.handle('debug:stop', async () => {
    await stopDebugSession()
  })

  // Store handlers
  ipcMain.handle('store:getConfigGroups', async () => {
    return store.getConfigGroups()
  })

  ipcMain.handle('store:saveConfigGroup', async (_event, group) => {
    const saved = store.saveConfigGroup(group)
    refreshTlsSkippedHosts()
    return saved
  })

  ipcMain.handle('store:deleteConfigGroup', async (_event, id: string) => {
    store.deleteConfigGroup(id)
    refreshTlsSkippedHosts()
  })

  ipcMain.handle('crypto:encryptForExport', async (_event, text: string, password: string) => {
    return store.getCrypto().encryptForExport(text, password)
  })

  ipcMain.handle('crypto:decryptForImport', async (_event, encryptedData: string, password: string) => {
    return store.getCrypto().decryptForImport(encryptedData, password)
  })

  ipcMain.handle('store:getSessions', async (_event, mode?: 'main' | 'office') => {
    return store.getSessions(mode)
  })

  ipcMain.handle('store:saveSession', async (_event, session) => {
    return store.saveSession(session)
  })

  ipcMain.handle('store:deleteSession', async (_event, id: string) => {
    return store.deleteSession(id)
  })

  // Sub-agent run records (durable twin of the renderer's subagentProgress)
  ipcMain.handle('store:getSubagentRuns', async (_event, sessionIds: string[]) => {
    if (!Array.isArray(sessionIds)) return []
    return store.getSubagentRuns(sessionIds.filter((x) => typeof x === 'string' && !!x).slice(0, 2000))
  })

  ipcMain.handle('store:saveSubagentRun', async (_event, toolCallId: string, record: any) => {
    if (typeof toolCallId !== 'string' || !toolCallId || !record || typeof record !== 'object') return false
    return store.saveSubagentRun(toolCallId, record)
  })

  ipcMain.handle('store:getPreferences', async () => {
    return store.getPreferences()
  })

  ipcMain.handle('store:savePreferences', async (_event, prefs) => {
    return store.savePreferences(prefs)
  })

  ipcMain.handle('store:resetAll', async () => {
    store.resetAll()
  })

  // LLM response cache
  ipcMain.handle(IPC_CHANNELS.LLM_CACHE_GET, async (_event, key: string) => {
    return store.getResponseCache(key)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_CACHE_PUT, async (_event, entry: { key: string; provider: string; model: string; response: string; tokensIn: number; tokensOut: number }) => {
    store.putResponseCache(entry.key, entry.provider, entry.model, entry.response, entry.tokensIn, entry.tokensOut)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_CACHE_CLEAR, async () => {
    store.clearResponseCache()
  })

  // Dialog handlers — a path the user picked here is trusted by definition, and
  // remembering it is what lets the next run restore the same workspace without
  // asking again.
  ipcMain.handle('dialog:openFolder', async (event) => {
    const result = await dialog.showOpenDialog(windowFromEvent(event) ?? mainWindow!, {
      properties: ['openDirectory'],
    })
    const selected = result.canceled ? null : result.filePaths[0]
    if (selected) {
      trust?.grant(selected)
      registerRoot(selected)
    }
    return selected
  })

  ipcMain.handle('dialog:openFile', async (event) => {
    const result = await dialog.showOpenDialog(windowFromEvent(event) ?? mainWindow!, {
      properties: ['openFile'],
    })
    const selected = result.canceled ? null : result.filePaths[0]
    if (selected) {
      const parent = dirname(selected)
      trust?.grant(parent)
      registerRoot(parent)
    }
    return selected
  })

  ipcMain.handle('dialog:saveFile', async (event, defaultPath?: string) => {
    const result = await dialog.showSaveDialog(windowFromEvent(event) ?? mainWindow!, {
      defaultPath,
    })
    const selected = result.canceled ? null : result.filePath
    if (selected) {
      const parent = dirname(selected)
      trust?.grant(parent)
      registerRoot(parent)
    }
    return selected
  })

  // Window handlers (target the window that sent the request)
  ipcMain.handle('window:minimize', (event) => {
    windowFromEvent(event)?.minimize()
  })

  ipcMain.handle('window:maximize', (event) => {
    const win = windowFromEvent(event)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.handle('window:close', (event) => {
    windowFromEvent(event)?.close()
  })

  ipcMain.handle('window:isMaximized', (event) => {
    return windowFromEvent(event)?.isMaximized() ?? false
  })

  ipcMain.handle('window:openDevTools', (event) => {
    windowFromEvent(event)?.webContents.openDevTools()
  })

  // OS-level notification (session events fired while the window is not
  // focused — the renderer shows its own in-app toast when focused). Clicking
  // the notification focuses/restores the main window.
  ipcMain.handle('notification:show', (_event, { title, body }: { title: string; body: string }) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: title || 'OurCode AI', body: body || '', silent: true })
    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    })
    notification.show()
  })

  ipcMain.handle('window:openNewWindow', () => {
    createNewWindow()
  })

  // 「一人公司」：独立窗口（office 模式），见 createOfficeWindow。
  ipcMain.handle('window:openOfficeWindow', () => {
    createOfficeWindow()
  })

  // Terminal handlers (each terminal belongs to the window that created it)
  ipcMain.handle('term:create', (event, id: string, cwd?: string) => {
    if (cwd) assertPathAllowed(cwd)
    const wc = event.sender
    const shellName = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const term = pty.spawn(shellName, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.cwd(),
      env: { ...process.env } as Record<string, string>,
    })

    const session: TerminalSession = {
      pty: term,
      webContents: wc,
      owner: 'view',
      chunks: [],
      chars: 0,
      exitCode: null,
      command: '',
    }

    term.onData((data) => {
      captureOutput(session, data)
      if (!wc.isDestroyed()) wc.send(`term:data:${id}`, data)
    })

    term.onExit(({ exitCode }) => {
      session.exitCode = exitCode
      if (!wc.isDestroyed()) wc.send(`term:exit:${id}`, exitCode)
      terminals.delete(id)
    })

    terminals.set(id, session)
  })

  ipcMain.handle('term:write', (_event, id: string, data: string) => {
    terminals.get(id)?.pty.write(data)
  })

  ipcMain.handle('term:resize', (_event, id: string, cols: number, rows: number) => {
    terminals.get(id)?.pty.resize(cols, rows)
  })

  ipcMain.handle('term:dispose', (_event, id: string) => {
    const t = terminals.get(id)
    // An agent run is not the view's to kill: the terminal tab that shows it is
    // just a window onto a process the assistant started (and may still read).
    if (!t || t.owner === 'agent') return
    t.pty.kill()
    terminals.delete(id)
  })

  // ── Agent-run terminal sessions ──────────────────────────────────────────
  // Long-running commands (dev servers, watchers, `npm install` with a prompt)
  // can't go through shell:exec — that waits for exit and kills at its timeout.
  // These run in the same pty layer as the integrated terminal, and their output
  // is captured in the main process so the assistant can poll it whether or not
  // a terminal tab is showing the session.
  ipcMain.handle('term:runAgent', (event, id: string, command: string, cwd?: string) => {
    if (!id || typeof command !== 'string' || !command.trim()) throw new Error('终端运行参数不完整')
    if (terminals.has(id)) throw new Error(`终端会话 ${id} 已存在`)
    if (cwd) assertPathAllowed(cwd)
    pruneAgentRuns()
    let live = 0
    for (const session of terminals.values()) {
      if (session.owner === 'agent' && session.exitCode === null) live++
    }
    if (live >= MAX_LIVE_AGENT_RUNS) {
      throw new Error(`已有 ${live} 个后台命令在运行，先用 stop_terminal 停掉不再需要的`)
    }
    const wc = event.sender
    const isWindows = process.platform === 'win32'
    // Hand the command to the shell as an argument instead of typing it into an
    // interactive session: the pty's own exit is then the command's exit, so
    // `running` / `exitCode` mean what the assistant needs them to (an
    // interactive shell would sit at a prompt forever after finishing).
    // A login shell (-lc) so the user's rc files put the same tools on PATH as
    // in their own terminal.
    const shellArgs = isWindows ? ['-NoLogo', '-Command', command] : ['-lc', command]
    const term = pty.spawn(isWindows ? 'powershell.exe' : 'bash', shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: cwd || process.cwd(),
      // This is the assistant's command, not the user's shell — keep the
      // credential scrub shell:exec applies, or anything the model runs could
      // read the API keys sitting in the app's environment.
      env: scrubbedSpawnEnv() as Record<string, string>,
    })
    const session: TerminalSession = {
      pty: term,
      webContents: wc,
      owner: 'agent',
      chunks: [],
      chars: 0,
      exitCode: null,
      command,
    }
    term.onData((data) => {
      captureOutput(session, data)
      if (!wc.isDestroyed()) wc.send(`term:data:${id}`, data)
    })
    term.onExit(({ exitCode }) => {
      session.exitCode = exitCode
      if (!wc.isDestroyed()) wc.send(`term:exit:${id}`, exitCode)
    })
    terminals.set(id, session)
  })

  /** null when the session is unknown (retired, or never existed) or it is a
   *  tab the user typed into — that scrollback is theirs, not the model's. */
  ipcMain.handle('term:output', (_event, id: string, tailChars?: number) => {
    const session = terminals.get(id)
    if (!session || session.owner !== 'agent') return null
    const full = session.chunks.join('')
    const output = tailChars && tailChars > 0 ? full.slice(-tailChars) : full
    return {
      output,
      truncated: output !== full,
      running: session.exitCode === null,
      exitCode: session.exitCode,
      command: session.command,
    }
  })

  ipcMain.handle('term:kill', (_event, id: string) => {
    const session = terminals.get(id)
    if (!session || session.owner !== 'agent') return false
    killProcessTree(session)
    return true
  })

  /** Agent runs in start order — the renderer treats this as the truth, so the
   *  list survives a window reload (the processes live here, not there). */
  ipcMain.handle('term:list', () => {
    const listed: { id: string; command: string; running: boolean; exitCode: number | null }[] = []
    for (const [id, session] of terminals) {
      if (session.owner !== 'agent') continue
      listed.push({
        id,
        command: session.command,
        running: session.exitCode === null,
        exitCode: session.exitCode,
      })
    }
    return listed
  })

  /** Point an agent run's stream at the requesting window's view. Only agent
   *  sessions are attachable — a tab the user typed into is theirs, not shareable. */
  ipcMain.handle('term:attach', (event, id: string) => {
    const session = terminals.get(id)
    if (!session || session.owner !== 'agent') return null
    session.webContents = event.sender
    return { command: session.command, running: session.exitCode === null, output: session.chunks.join('') }
  })

  // Search in files handler — 三级链路：内存索引（毫秒级）→ ripgrep（10-100x 快）
  // → Node 遍历（兜底）。后两级保持原有语义：跳过 hidden / 排除目录、按行匹配。
  ipcMain.handle('search:inFiles', async (_event, dirPath: string, query: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; filePattern?: string; excludeFolders?: string }) => {
    assertPathAllowed(dirPath)
    // 1) 内存代码库索引：watched 根 + 内容就绪 + 简单子串查询 → 毫秒级
    try {
      const fromIndex = await fileIndex.searchContent(dirPath, query, options ?? {})
      if (fromIndex) return fromIndex
    } catch { /* 索引异常直接走 rg/遍历 */ }
    // 2) ripgrep：更快，覆盖索引未就绪 / 超预算 / regex / wholeWord 的场景
    const fromRg = await rgSearchInFiles(dirPath, query, options)
    if (fromRg) return fromRg
    // 3) 纯 Node 遍历兜底（rg 不存在或失败时保持可用）
    return nodeWalkSearchInFiles(dirPath, query, options)
  })

  // Search files by name (used by @-references in the chat input)
  ipcMain.handle('search:files', async (_event, dirPath: string, query: string) => {
    assertPathAllowed(dirPath)
    try {
      const fromIndex = await fileIndex.searchFiles(dirPath, query, 50)
      // 空数组不能短路：索引返回空可能只是它答不上（如部分 glob 语义），仍要
      // 回退 rg/遍历以得到一致结果，否则 `*.ts` 这类查询会被静默吞掉。
      if (fromIndex && fromIndex.length > 0) return fromIndex
    } catch { /* 索引异常走 rg/遍历 */ }
    const fromRg = await rgSearchFiles(dirPath, query, 50)
    if (fromRg) return fromRg
    return nodeWalkSearchFiles(dirPath, query)
  })

  // Environment variable resolver
  ipcMain.handle('app:resolveEnvVar', (_event, name: string) => {
    if (!isSafeEnvVarName(name)) return ''
    return process.env[name] || ''
  })

  // ───────────────────── Web fetch (web_search / read_url tools) ─────────────────────
  // Only http(s) URLs may be fetched (no file://, no arbitrary schemes), with a
  // hard size cap so a hostile endpoint cannot balloon main-process memory.
  const MAX_WEB_BYTES = 2 * 1024 * 1024

  ipcMain.handle('web:fetch', async (_event, url: string, options?: { timeoutMs?: number; maxBytes?: number }) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, error: '无效的 URL' }
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: '仅支持 http/https URL' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs || 15000)
    try {
      const res = await net.fetch(parsed.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'OurCode-ide/0.1', 'accept': 'text/html,text/plain,*/*' },
      })
      const sizeLimit = options?.maxBytes || MAX_WEB_BYTES
      const contentLength = Number(res.headers.get('content-length') || 0)
      if (contentLength > sizeLimit) {
        // Cancel the body before returning so the connection isn't left draining.
        await res.body?.cancel().catch(() => {})
        return { ok: false, status: res.status, error: `响应超过大小上限 (${sizeLimit} bytes)` }
      }
      // Stream the body and stop at sizeLimit — the old code awaited the whole
      // arrayBuffer() first, so a lying/missing content-length made a malicious
      // endpoint download fully into memory before the cap was enforced.
      if (!res.body) {
        return {
          ok: res.ok,
          status: res.status,
          contentType: res.headers.get('content-type') || '',
          finalUrl: res.url || parsed.toString(),
          text: '',
        }
      }
      const reader = res.body.getReader()
      const chunks: Buffer[] = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = Buffer.from(value)
          total += chunk.length
          if (total > sizeLimit) {
            await reader.cancel().catch(() => {})
            return { ok: false, status: res.status, error: `响应超过大小上限 (${sizeLimit} bytes)` }
          }
          chunks.push(chunk)
        }
      } finally {
        reader.releaseLock()
      }
      const buf = Buffer.concat(chunks)
      return {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        finalUrl: res.url || parsed.toString(),
        text: buf.toString('utf-8').slice(0, sizeLimit),
      }
    } catch (error: any) {
      const aborted = controller.signal.aborted
      return { ok: false, error: aborted ? '请求超时' : (error.message || '网络请求失败') }
    } finally {
      clearTimeout(timer)
    }
  })

  // ───────────────────── LLM HTTP bridge (chat / model lists) ─────────────────────
  // The renderer is sandboxed, so its fetch() is subject to CORS. Third-party
  // OpenAI-compatible relays (longcat, one-api, new-api, ...) often omit CORS
  // headers, which makes renderer-side LLM calls fail with a cryptic
  // "Failed to fetch". Route LLM requests through net.fetch (main process, no
  // CORS) — same pattern as web:fetch above. Streaming responses are forwarded
  // chunk-by-chunk over IPC so the renderer's SSE parsing stays untouched.
  const llmControllers = new Map<string, AbortController>()

  ipcMain.on('llm:httpAbort', (_event, id: string) => {
    llmControllers.get(id)?.abort()
  })

  ipcMain.handle('llm:http', async (event, req: {
    id: string
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    stream?: boolean
    timeoutMs?: number
    skipTlsVerify?: boolean
  }) => {
    if (!req.id) return { ok: false, error: '缺少请求 id' }
    let parsed: URL
    try {
      parsed = new URL(req.url)
    } catch {
      return { ok: false, error: '无效的 URL' }
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: '仅支持 http/https URL' }
    }

    // Per-request TLS bypass: honor skipTlsVerify from the (possibly unsaved)
    // config group the renderer is testing, without touching the persisted set.
    const draftBypass = parsed.protocol === 'https:' && !!req.skipTlsVerify && !!parsed.hostname
    if (draftBypass) tlsDraftHosts.add(parsed.hostname)

    const controller = new AbortController()
    llmControllers.set(req.id, controller)
    // IDLE timeout, re-armed on every streamed chunk below: a long reasoning
    // stream must never be killed by a wall-clock deadline while data is still
    // flowing. Only a connection silent for timeoutMs gets aborted. Non-stream
    // requests keep the total-duration semantics (no chunks to reset on).
    let timer = setTimeout(() => controller.abort(), req.timeoutMs || 30_000)

    const headers: Record<string, string> = { ...req.headers }
    // Case-insensitive check: the renderer usually sends 'Content-Type' already;
    // appending a lowercased twin would produce a duplicate header that some
    // gateways (Spring Boot) reject with 415 Unsupported Media Type.
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
    if (req.body && !hasContentType) headers['content-type'] = 'application/json'

    try {
      const res = await net.fetch(parsed.toString(), {
        method: req.method || 'GET',
        headers,
        body: req.body,
        signal: controller.signal,
        redirect: 'follow',
      })

      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => { responseHeaders[key] = value })

      if (!req.stream) {
        const text = await res.text()
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
          text,
        }
      }

      // Streaming: forward status/headers first, then body chunks as base64
      event.sender.send('llm:httpHeaders', {
        id: req.id,
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      })

      if (!res.body) {
        // Empty body (e.g. 204) — signal end of stream right away
        if (!event.sender.isDestroyed()) {
          event.sender.send('llm:httpDone', { id: req.id })
        }
        return { ok: true }
      }

      const reader = res.body.getReader()
      const armTimeout = () => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), req.timeoutMs || 30_000)
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          // Any byte (or EOF) extends the deadline — an actively streaming
          // response is never cut off at 120s while data keeps arriving.
          armTimeout()
          if (done) break
          if (event.sender.isDestroyed()) break
          event.sender.send('llm:httpChunk', { id: req.id, data: Buffer.from(value).toString('base64') })
        }
      } finally {
        reader.releaseLock()
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send('llm:httpDone', { id: req.id })
      }
      return { ok: true }
    } catch (error: any) {
      const aborted = controller.signal.aborted
      const message = aborted ? '请求超时或已取消' : (error.message || '网络请求失败')
      if (req.stream && !event.sender.isDestroyed()) {
        event.sender.send('llm:httpError', { id: req.id, message })
      }
      return { ok: false, error: message }
    } finally {
      clearTimeout(timer)
      llmControllers.delete(req.id)
      if (draftBypass) tlsDraftHosts.delete(parsed.hostname)
    }
  })

  // ───────────────────── Memories ─────────────────────
  ipcMain.handle('memory:list', async () => {
    return store.getMemories()
  })

  ipcMain.handle('memory:add', async (_event, content: string, scope: string, projectPath?: string) => {
    const trimmed = (content || '').trim()
    if (!trimmed) throw new Error('记忆内容不能为空')
    return store.addMemory(trimmed, scope === 'project' ? 'project' : 'global', projectPath || undefined)
  })

  ipcMain.handle('memory:delete', async (_event, id: string) => {
    store.deleteMemory(id)
  })

  // ───────────────────── Workflows ─────────────────────
  ipcMain.handle('workflow:list', async () => {
    return store.getWorkflows()
  })

  ipcMain.handle('workflow:add', async (_event, workflow: { name: string; description?: string; prompt: string }) => {
    if (!workflow?.prompt?.trim()) throw new Error('工作流内容不能为空')
    return store.addWorkflow(workflow)
  })

  ipcMain.handle('workflow:delete', async (_event, id: string) => {
    store.deleteWorkflow(id)
  })

  // ───────────────────── Checkpoints (AI edit snapshots) ─────────────────────
  ipcMain.handle('checkpoint:list', async (_event, sessionId: string) => {
    return store.getCheckpoints(sessionId)
  })

  ipcMain.handle('checkpoint:create', async (_event, checkpoint: any) => {
    if (!checkpoint?.id || !checkpoint?.sessionId) throw new Error('检查点参数不完整')
    // The snapshot's file paths are later written/deleted on revert — refuse
    // to persist paths the renderer isn't allowed to touch, so a compromised
    // renderer can't stage an arbitrary-path revert.
    for (const f of checkpoint.files || []) {
      if (f?.path) assertPathAllowed(f.path)
    }
    return store.addCheckpoint(checkpoint)
  })

  ipcMain.handle('checkpoint:delete', async (_event, sessionId: string) => {
    store.deleteCheckpoints(sessionId)
    store.deleteRevertedFiles(sessionId)
  })

  ipcMain.handle('checkpoint:listReverted', async (_event, sessionId: string) => {
    return store.getRevertedFiles(sessionId)
  })

  // Revert a checkpoint: restore every snapshotted file (or delete it if it
  // didn't exist at snapshot time), then broadcast so open editors reload.
  // Before restoring each snapshot the CURRENT (AI-written) state is captured
  // into the reverted-files record, so the revert can be undone later via
  // checkpoint:restore (恢复).
  ipcMain.handle('checkpoint:revert', async (_event, checkpointId: string) => {
    const allSessions = store.getSessions()
    let target: import('../shared/types').Checkpoint | null = null
    for (const session of allSessions) {
      const list = store.getCheckpoints(session.id)
      const found = list.find((c) => c.id === checkpointId)
      if (found) { target = found; break }
    }
    if (!target) return { ok: false, error: '检查点不存在' }

    let restored = 0
    // Only files that were ACTUALLY reverted get a forward record — a file whose
    // revert failed keeps its AI content on disk, so restoring it would be a
    // no-op and must not show up as「已回退」.
    const forward: Array<{ path: string; content: string; existed: boolean }> = []
    for (const file of target.files) {
      try {
        // Defense in depth: re-validate each path at revert time (the snapshot
        // may predate an allowlist change, or be from an older version).
        if (!file?.path) continue
        assertPathAllowed(file.path)
        // Capture the current (AI-written) state BEFORE the revert writes the
        // pre-edit snapshot back — this is what checkpoint:restore replays.
        let current: { content: string; existed: boolean }
        try {
          current = { content: (await fileSystem.readFile(file.path)).content, existed: true }
        } catch {
          current = { content: '', existed: false }
        }
        if (file.existed) {
          await fileSystem.writeFile(file.path, file.content, 'utf-8', false)
        } else if (existsSync(file.path)) {
          await fileSystem.delete(file.path)
        }
        forward.push({ path: file.path, ...current })
        restored++
      } catch (error: any) {
        console.error(`回滚 ${file.path} 失败:`, error.message)
      }
    }
    // Drop the snapshot from the DB FIRST — a reverted checkpoint must never
    // survive, or it would come back on restart / session re-entry and show as
    // "not reverted" even though the file on disk was already restored. The
    // file-change notification below is best-effort and must not be able to
    // skip this deletion: a broadcast over a closing window previously threw,
    // leaving the file reverted but the checkpoint alive.
    store.deleteCheckpoint(target.id)
    // Record the reverted files WITH their AI-written forward snapshot so the
    // summary can show them as「已回退」and offer「恢复」(survives restart).
    store.addRevertedFiles(target.sessionId, forward.map((f) => ({ ...f, messageId: target.messageId })))
    // Notify open editors to reload the changed files (best-effort).
    try {
      for (const file of target.files) {
        broadcast('fs:fileChanged', file.path)
      }
    } catch {
      // Ignore notification failures — the revert itself is already complete.
    }
    return { ok: true, restored }
  })

  // Restore (undo a revert): write the captured AI version of each file back
  // (or delete it when the AI version didn't exist), snapshot the current
  // state into a fresh checkpoint attached to the original message — so the
  // file can be reverted AGAIN — and drop the reverted-files record.
  ipcMain.handle('checkpoint:restore', async (_event, sessionId: string, filePaths: string[]) => {
    const wanted = new Set((Array.isArray(filePaths) ? filePaths : []).map(String).filter(Boolean))
    const records = store.getRevertedFileRecords(sessionId).filter((r) => wanted.has(r.path))
    const failed: string[] = []
    let restored = 0
    for (const rec of records) {
      try {
        assertPathAllowed(rec.path)
        // Legacy rows (reverted before forward snapshots existed) have no
        // content to restore — refuse instead of writing an empty file over
        // whatever is on disk now.
        if (!rec.hasSnapshot) {
          failed.push(rec.path)
          console.warn(`无法恢复 ${rec.path}：该回退记录产生于旧版本，未保存可恢复的内容`)
          continue
        }
        // Snapshot the state that will be overwritten so the restored file
        // stays revertable (回退/恢复 become a round-trip instead of a dead end).
        let current: { content: string; existed: boolean }
        try {
          current = { content: (await fileSystem.readFile(rec.path)).content, existed: true }
        } catch {
          current = { content: '', existed: false }
        }
        if (rec.existed) {
          await fileSystem.writeFile(rec.path, rec.content, 'utf-8', false)
        } else if (existsSync(rec.path)) {
          await fileSystem.delete(rec.path)
        }
        store.addCheckpoint({
          id: uuidv4(),
          sessionId,
          createdAt: Date.now(),
          label: `恢复 → ${rec.path.split(/[/\\]/).pop() || rec.path}`,
          messageId: rec.messageId || undefined,
          files: [{ path: rec.path, ...current }],
        })
        store.deleteRevertedFile(sessionId, rec.path)
        restored++
      } catch (error: any) {
        failed.push(rec.path)
        console.error(`恢复 ${rec.path} 失败:`, error.message)
      }
    }
    try {
      for (const rec of records) {
        broadcast('fs:fileChanged', rec.path)
      }
    } catch {
      // Ignore notification failures — the restore itself is already complete.
    }
    return { ok: failed.length === 0, restored, failed }
  })

  // Forward snapshot of one reverted file — used by the file-changes panel to
  // diff「AI 版本 vs 回退后版本」after a revert.
  ipcMain.handle('checkpoint:getRevertedRecord', async (_event, sessionId: string, filePath: string) => {
    const rec = store.getRevertedFileRecords(sessionId).find((r) => r.path === filePath)
    return rec ?? null
  })

  // ───────────────────── MCP (Model Context Protocol) ─────────────────────
  ipcMain.handle('mcp:listTools', async () => {
    return mcp.listTools()
  })

  ipcMain.handle('mcp:callTool', async (_event, server: string, toolName: string, args: Record<string, any>) => {
    try {
      const result = await mcp.callTool(server, toolName, args || {})
      return { ok: true, result: extractMcpText(result) }
    } catch (error: any) {
      return { ok: false, error: error.message }
    }
  })

  ipcMain.handle('mcp:reload', async (_event, rootPath: string) => {
    try {
      if (rootPath) assertPathAllowed(rootPath)
      await mcp.loadConfig(rootPath)
      return { ok: true }
    } catch (error: any) {
      return { ok: false, error: error.message }
    }
  })

  // Read the workspace's MCP server config for the Settings UI
  ipcMain.handle('mcp:getConfig', (_event, rootPath: string) => {
    try {
      if (!rootPath) return { ok: true, config: { mcpServers: {} }, file: null }
      assertPathAllowed(rootPath)
      const candidates = [join(rootPath, 'mcp_config.json'), join(rootPath, '.mcp.json')]
      let raw = ''
      let file: string | null = null
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          raw = readFileSync(candidate, 'utf-8')
          file = candidate
          break
        }
      }
      if (!raw) return { ok: true, config: { mcpServers: {} }, file: join(rootPath, 'mcp_config.json') }
      const parsed = JSON.parse(raw)
      return {
        ok: true,
        config: { mcpServers: parsed.mcpServers || parsed.servers || {} },
        file,
      }
    } catch (error: any) {
      return { ok: false, error: error.message }
    }
  })

  // Persist the MCP server config (back to the file it was loaded from,
  // defaulting to <root>/mcp_config.json) and reload
  ipcMain.handle('mcp:saveConfig', async (_event, rootPath: string, config: { mcpServers: Record<string, any> }, file?: string | null) => {
    try {
      if (!rootPath) throw new Error('未打开项目，无法保存 MCP 配置')
      // Only write inside the workspace — resolve the target and verify it
      // doesn't escape the project root (blocks ../ traversal and arbitrary paths).
      assertPathAllowed(rootPath)
      const target = file ? resolve(rootPath, file) : join(rootPath, 'mcp_config.json')
      const rootResolved = resolve(rootPath)
      const rel = relative(rootResolved, target)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error('MCP 配置文件路径无效')
      }
      mkdirSync(rootPath, { recursive: true })
      writeFileSync(target, JSON.stringify({ mcpServers: config?.mcpServers || {} }, null, 2), 'utf-8')
      await mcp.loadConfig(rootPath)
      return { ok: true, file: target }
    } catch (error: any) {
      return { ok: false, error: error.message }
    }
  })

  // Used by the renderer to build tool definitions for the LLM
  ipcMain.handle('mcp:toolDefinitions', async () => {
    // Stale tools (from a disconnected server's last-known list) are filtered —
    // the model must never be offered a tool that would fail with "未连接".
    const tools = (await mcp.listTools()).filter((t) => !t.stale)
    return tools.map((t) => toMcpToolDefinition(t))
  })

  // MCP resources (context injection on demand)
  ipcMain.handle('mcp:listResources', async () => {
    return mcp.listResources()
  })

  ipcMain.handle('mcp:readResource', async (_event, server: string, uri: string) => {
    try {
      const result = await mcp.readResource(server, uri)
      return { ok: true, result: extractMcpText(result) }
    } catch (error: any) {
      return { ok: false, error: error.message }
    }
  })

  // MCP prompts (reusable prompt templates)
  ipcMain.handle('mcp:listPrompts', async () => {
    return mcp.listPrompts()
  })

  ipcMain.handle('mcp:getPrompt', async (_event, server: string, name: string, args?: Record<string, any>) => {
    try {
      const result = await mcp.getPrompt(server, name, args)
      return { ok: true, result }
    } catch (error: any) {
      return { ok: false, error: error.message }
    }
  })

  // Per-server connection state for the MCP management UI (MCP 管理中心)
  ipcMain.handle('mcp:status', async () => {
    return mcp.getStatus()
  })

  // ───────────────────── Usage statistics ─────────────────────
  ipcMain.handle(IPC_CHANNELS.USAGE_RECORD, (_event, events: UsageEvent[]) => {
    try {
      store.recordUsageEvents(Array.isArray(events) ? events : [])
      return { ok: true }
    } catch (error: any) {
      return { ok: false, error: error.message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.USAGE_SUMMARY, (_event, rangeDays?: number) => {
    return store.getUsageSummary(rangeDays)
  })

  ipcMain.handle(IPC_CHANNELS.USAGE_CLEAR, () => {
    store.clearUsageEvents()
    return { ok: true }
  })

  // Git handler — argv goes through checkVcsArgs: the renderer (and the model
  // through it) must not be able to reach `git -c core.pager=…`, `--exec-path`,
  // `ext::` transports or `--output`, all of which are command execution or file
  // writes dressed up as git arguments. `input` stays supported: the central diff
  // editor applies per-hunk patches through stdin.
  const gatedGit = async (
    cwd: string,
    args: unknown,
    input?: string,
    raw = false,
  ): Promise<{ success: boolean; output: string; error?: string }> => {
    const checked = checkVcsArgs('git', args)
    if (!checked.ok) return { success: false, output: '', error: checked.error }
    try {
      if (cwd) assertPathAllowed(cwd)
      const result = raw
        ? await gitExecRaw(cwd, checked.args, input)
        : await gitExec(cwd, checked.args, input)
      return { success: true, output: result }
    } catch (error: any) {
      return { success: false, output: '', error: error.message }
    }
  }

  ipcMain.handle('git:exec', (_event, cwd: string, args: unknown, input?: string) => gatedGit(cwd, args, input))

  // Git handler returning untrimmed stdout (byte-exact blob reads)
  ipcMain.handle('git:execRaw', (_event, cwd: string, args: unknown, input?: string) =>
    gatedGit(cwd, args, input, true))

  // GitHub CLI — the hosting layer (PR list / create / review comments).
  // Same shape and same argv gate as git:exec.
  ipcMain.handle('gh:exec', async (_event, cwd: string, args: unknown) => {
    const checked = checkVcsArgs('gh', args)
    if (!checked.ok) return { success: false, output: '', error: checked.error }
    try {
      if (cwd) assertPathAllowed(cwd)
      return { success: true, output: await runGh(cwd, checked.args) }
    } catch (error: any) {
      return { success: false, output: '', error: error.message }
    }
  })

  // Is `gh` installed and authenticated for this repo's host? Probed here (not in
  // the renderer) because both answers come from process exit codes + stderr.
  ipcMain.handle('gh:status', async (_event, cwd: string) => {
    try {
      if (cwd) assertPathAllowed(cwd)
    } catch (error: any) {
      return { installed: false, authed: false, error: error.message }
    }
    let installed = false
    try {
      await runGh(cwd || process.cwd(), ['--version'])
      installed = true
    } catch (error: any) {
      // `--version` is not in the subcommand allowlist — execFile still ran, so
      // anything other than ENOENT means the binary exists.
      installed = !/ENOENT/.test(String(error?.message || ''))
    }
    if (!installed) return { installed: false, authed: false }
    let text = ''
    try {
      text = await runGh(cwd || process.cwd(), ['auth', 'status'])
    } catch (error: any) {
      text = String(error?.message || '')
    }
    return { installed: true, ...parseGhAuthStatus(text), raw: text.slice(0, 2000) }
  })

  // ── Agent browser session ────────────────────────────────────────────────
  // One hidden http(s)-only page that the assistant drives and the Browser
  // panel mirrors. The tools (browser_navigate / browser_read_console /
  // browser_screenshot / browser_act) call the same IPC from the renderer.
  initBrowserSession({
    broadcast: (payload) => broadcast(IPC_CHANNELS.BROWSER_EVENT, payload),
  })
  ipcMain.handle(IPC_CHANNELS.BROWSER_NAVIGATE, (_event, url: string) => browserNavigate(String(url ?? '')))
  ipcMain.handle(IPC_CHANNELS.BROWSER_STATE, () => browserState())
  ipcMain.handle(IPC_CHANNELS.BROWSER_CONSOLE, (_event, clear?: boolean) => browserConsole(clear === true))
  ipcMain.handle(IPC_CHANNELS.BROWSER_PAGE_TEXT, (_event, maxChars?: number) => browserPageText(maxChars))
  ipcMain.handle(IPC_CHANNELS.BROWSER_SCREENSHOT, () => browserScreenshot())
  ipcMain.handle(IPC_CHANNELS.BROWSER_ACT, (_event, action: BrowserAction, opts?: BrowserActOptions) =>
    browserAct(action, opts))
  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY, (_event, step: 'back' | 'forward' | 'reload') => browserHistory(step))
  ipcMain.handle(IPC_CHANNELS.BROWSER_VISIBLE, (_event, visible: boolean) => browserSetVisible(visible === true))
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE, () => browserClose())

  // Shell exec handler (for run_command tool)
  ipcMain.handle(IPC_CHANNELS.SHELL_EXEC, async (_event, command: string, cwd?: string, options?: { timeoutMs?: number; requestId?: string }) => {
    return new Promise((resolve) => {
      try {
        if (cwd) assertPathAllowed(cwd)
      } catch (error: any) {
        resolve({ success: false, output: '', error: error.message })
        return
      }
      // 默认 30s 超时，允许 run_command 的 timeoutMs 覆盖（构建/测试等长命令
      // 传更大值）；上限 10 分钟防失控。
      const timeoutMs = Math.max(1000, Math.min(Math.floor(options?.timeoutMs || 30000), 600_000))
      // requestId lets the renderer cancel THIS run via shell:kill. Without it
      // a stop could only drop the result while the build kept burning CPU.
      const requestId = typeof options?.requestId === 'string' && options.requestId ? options.requestId : uuidv4()
      const child = exec(command, {
        cwd: cwd || undefined,
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
        shell: process.platform === 'win32' ? 'powershell.exe' : 'bash',
        env: scrubbedSpawnEnv(),
      }, (error: any, stdout: string, stderr: string) => {
        shellRuns.delete(requestId)
        const stoppedByUser = shellStopped.delete(requestId)
        if (error) {
          // exec 超时会把子进程杀掉并置 killed=true（signal='SIGTERM'）。超时
          // 必须明确标注 [超时]——否则 agent 无法区分「命令超时」与「命令本身
          // 失败」，会把超时误判成环境/参数问题，陷入反复换姿势重试（曾见
          // build 超时被当成构建环境坏了，多烧 6 分钟调试）。用户终止同理要单独
          // 标注：它既不是超时也不是失败，重试反而不是用户要的。
          const timedOut = !stoppedByUser && (error.killed === true || error.signal === 'SIGTERM')
          const msg = stoppedByUser
            ? '[已终止] 用户停止了任务，这条命令及其子进程已被结束。不要重试它；如需要可先向用户确认。'
            : timedOut
              ? `[超时] 命令执行超过 ${Math.round(timeoutMs / 1000)} 秒被终止。若是构建/测试/安装等长命令，请在 run_command 的 timeoutMs 参数中加大超时（如 120000），或改用异步方式等待，不要重复执行同一命令。`
              : (stderr || error.message)
          resolve({ success: false, output: stdout || '', error: msg })
        } else {
          resolve({ success: true, output: stdout.trim() })
        }
      })
      shellRuns.set(requestId, child)
    })
  })

  // Cancel an in-flight shell:exec (the user hit Stop). Returns false when the
  // command already finished — the renderer's abort listener may fire late.
  ipcMain.handle(IPC_CHANNELS.SHELL_KILL, (_event, requestId: string) => {
    if (typeof requestId !== 'string' || !requestId) return false
    const child = shellRuns.get(requestId)
    if (!child) return false
    shellRuns.delete(requestId)
    shellStopped.add(requestId)
    killChildTree(child)
    return true
  })

  // Tool-output spill store — oversized tool results page through read_file
  ipcMain.handle('spill:save', async (_event, sessionId: string, text: string) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') return null
    return spillStore.save(sessionId, text)
  })
  ipcMain.handle('spill:deleteSession', async (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') return
    await spillStore.deleteSession(sessionId)
  })

  // Model wire log — the renderer emits one JSON line per request event; the
  // main process appends it to <userData>/wire-logs/<session>.jsonl. Best-
  // effort by design: a logging failure never affects the request path.
  ipcMain.handle('log:wireAppend', async (_event, sessionId: string, line: string) => {
    if (typeof sessionId !== 'string' || typeof line !== 'string') return false
    return wireLog.append(sessionId, line)
  })
  ipcMain.handle('log:deleteSession', async (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') return
    await wireLog.deleteSession(sessionId)
  })
  ipcMain.handle('log:openDir', async () => {
    const dir = wireLog.root
    try {
      await mkdirSync(dir, { recursive: true })
    } catch { /* the open below still targets the same path */ }
    const err = await shell.openPath(dir)
    return err === ''
  })

  // App handlers
  ipcMain.handle('app:getPath', (_event, name: string) => {
    return app.getPath(name as any)
  })

  // The default empty project — a workspace the app owns so users can start an
  // agent conversation before opening any real folder. Created lazily under the
  // user's Documents directory (idempotent); reusing an existing folder of the
  // same name is harmless.
  // 按窗口模式分目录：对话窗口与一人公司窗口各自独立的默认项目，两边项目列表
  // 互不「一致」——一人公司项目/工作区与对话模式彻底分开。
  ipcMain.handle('app:ensureDefaultProject', async (_event, mode?: string) => {
    const base = (() => {
      try { return app.getPath('documents') } catch { /* ignore */ }
    })()
    const dir = join(base || app.getPath('home'), mode === 'office' ? 'OurCode-office' : 'OurCode')
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    return dir
  })

  ipcMain.handle('app:getPlatform', () => {
    return process.platform
  })

  // System locale, used by the renderer to pick the default UI language
  // (the preference defaults to 'system' and resolves against this).
  ipcMain.handle('app:getLocale', () => {
    return app.getLocale()
  })

  // Auto Update handlers
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  if (!is.dev) {
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      broadcast('update:status', {
        state: 'available',
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
      })
    })

    autoUpdater.on('update-not-available', () => {
      broadcast('update:status', { state: 'not-available' })
    })

    autoUpdater.on('download-progress', (progress) => {
      broadcast('update:progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    })

    autoUpdater.on('update-downloaded', () => {
      broadcast('update:status', { state: 'downloaded' })
    })

    autoUpdater.on('error', (error) => {
      broadcast('update:status', {
        state: 'error',
        message: error.message,
      })
    })
  }

  ipcMain.handle('update:check', async () => {
    if (is.dev) {
      return { state: 'not-available' }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result) {
        return {
          state: 'available',
          version: result.updateInfo.version,
          releaseNotes: result.updateInfo.releaseNotes,
          releaseDate: result.updateInfo.releaseDate,
        }
      }
      return { state: 'not-available' }
    } catch (error: any) {
      return { state: 'error', message: error.message }
    }
  })

  ipcMain.handle('update:download', async () => {
    if (is.dev) return { state: 'not-available' }
    try {
      await autoUpdater.downloadUpdate()
      return { state: 'downloading' }
    } catch (error: any) {
      return { state: 'error', message: error.message }
    }
  })

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  // App version handler
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion()
  })
}

// Only one instance may run at a time. A second launch (double-click while the
// dev server is up, or a stray `npm run dev`) would fight for the same GPU/disk
// cache in userData — Chromium logs "Unable to move the cache" / "Unable to
// create cache" (ERROR_ACCESS_DENIED, 0x5). Refuse the second instance and
// focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// App lifecycle

// OURCODE_USER_DATA lets tests / multi-instance runs point the app at a
// throwaway data dir instead of the real userData. Redirect the FULL Chromium
// profile too (localStorage — editor session, recent projects, UI state —
// lives there, not in the app's own stores), so the isolation is complete.
// Must happen before the app is ready / Chromium initializes the profile.
if (process.env.OURCODE_USER_DATA) {
  app.setPath('userData', process.env.OURCODE_USER_DATA)
}

app.whenReady().then(() => {
  // Local file preview protocol (ourcode-file://) — must be registered after
  // the app is ready (scheme privileges were declared above, before ready)
  registerPreviewProtocol()

  // Initialize services
  const userDataPath = process.env.OURCODE_USER_DATA || app.getPath('userData')
  // The renderer's skill/agent scanners discover global dirs in userData via
  // fs:listDir / fs:stat, so register them alongside user-opened workspaces.
  // Create them so first-run (and the fs:listDir bridge) doesn't hit ENOENT.
  mkdirSync(join(userDataPath, 'skills'), { recursive: true })
  mkdirSync(join(userDataPath, 'agents'), { recursive: true })
  // The userData root itself: global skills config (skills.json) and other
  // app-owned data live directly under userData — grant the whole dir.
  registerRoot(userDataPath)
  registerRoot(join(userDataPath, 'skills'))
  registerRoot(join(userDataPath, 'agents'))
  fileSystem = new FileSystemService()
  fileIndex = new FileIndexService(fileSystem)
  store = new SQLiteStore(userDataPath)
  // Trust needs the store for its durable grants, so it can only exist here.
  // The userData dir is the app's own and never needs asking about.
  trust = new WorkspaceTrust({
    load: () => store.listTrustedWorkspaces(),
    add: (p) => store.trustWorkspace(p),
    remove: (p) => store.untrustWorkspace(p),
  })
  trust.addAppOwned(userDataPath)
  backup = new BackupService(join(userDataPath, 'backups'))
  // Tool-output spill store: full outputs of oversized tool results live under
  // userData/spill/<session>/ (read_file can page them back). Sweep the TTL on
  // every startup — spills are cache, not user data.
  spillStore = new SpillStore(join(userDataPath, 'spill'))
  void spillStore.sweep()
  // Model wire log: replayable request/response lines under userData/wire-logs
  // (swept on startup like spills — logs are diagnostics, not user data).
  wireLog = new WireLogService(join(userDataPath, 'wire-logs'))
  void wireLog.sweep()
  // Bundled MCP servers (e.g. the git-server) ship inside the package via
  // extraResources → <resources>/mcp-servers (outside app.asar, so a plain
  // Node child can read them); in dev they live in the repo root.
  const bundledMcpDir = app.isPackaged
    ? join(process.resourcesPath, 'mcp-servers')
    : join(app.getAppPath(), 'mcp-servers')
  mcp = new MCPManager({ bundledNodeDir: bundledMcpDir })

  // Per-group TLS bypass for intranet / self-signed certificates
  refreshTlsSkippedHosts()
  registerTlsBypass()

  // Track MCP server lifecycle for the usage dashboard (ready / failure counts,
  // mirroring Windsurf's McpServerState tracking)
  mcp.on('ready', ({ server, restarted }: { server: string; restarted?: boolean }) => {
    store.recordUsageEvents([{
      id: uuidv4(),
      category: 'mcp',
      name: `${server}__server`,
      sub: server,
      startedAt: Date.now(),
      ok: true,
      payload: { event: restarted ? 'restarted' : 'ready' },
    }])
  })
  mcp.on('error', (error: Error) => {
    const match = /MCP 服务器 "([^"]+)"/.exec(error.message)
    const server = match ? match[1] : 'unknown'
    store.recordUsageEvents([{
      id: uuidv4(),
      category: 'mcp',
      name: `${server}__server`,
      sub: server,
      startedAt: Date.now(),
      ok: false,
      error: error.message,
      payload: { event: 'error' },
    }])
  })

  registerIpcHandlers()
  installNavigationGuards()
  createWindow()

  app.on('activate', () => {
    // allWindows, not BrowserWindow.getAllWindows(): the hidden browser session
    // is a real window and would otherwise make the dock icon do nothing.
    if (allWindows.size === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  mcp?.stopAll()
  void stopAllLspServers()
  void stopDebugSession()
  // Close the SQLite store only when the app is actually quitting. On macOS the
  // app stays alive with zero windows (activate re-creates one), so closing the
  // store here made every later store:* IPC throw "database is not open".
  if (process.platform !== 'darwin') {
    store.close()
    app.quit()
  }
})

app.on('will-quit', () => {
  browserClose()
  store.close()
})
