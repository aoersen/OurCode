// Re-export shared types
export * from '@shared/types'
export * from '@shared/constants'

// Electron API type
export interface ElectronAPI {
  // File System
  readFile: (path: string) => Promise<{ content: string; encoding: string; hasBom: boolean }>
  writeFile: (path: string, content: string, encoding: string, hasBom?: boolean) => Promise<void>
  openFileStream: (path: string) => Promise<import('@shared/types').FileStreamStart>
  readFileChunk: (id: number) => Promise<import('@shared/types').FileStreamChunk | null>
  readFileChunkBatch: (id: number, maxBytes?: number) => Promise<import('@shared/types').FileStreamChunk[] | null>
  closeFileStream: (id: number) => Promise<void>
  openWriteStream: (path: string, encoding: string, hasBom?: boolean) => Promise<number>
  writeChunk: (id: number, chunk: string) => Promise<void>
  closeWriteStream: (id: number) => Promise<string | undefined>
  abortWriteStream: (id: number) => Promise<void>
  listDir: (path: string) => Promise<import('@shared/types').FileEntry[]>
  createFile: (path: string) => Promise<void>
  createDir: (path: string) => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  delete: (path: string) => Promise<void>
  stat: (path: string) => Promise<import('@shared/types').FileStat | null>
  /** False when the main process refused to register the path (untrusted workspace) */
  authorize: (path: string) => Promise<boolean>
  watch: (path: string) => Promise<{ ok: boolean; untrusted?: boolean } | undefined>
  unwatch: (path: string) => Promise<void>
  trustRequest: (path: string) => Promise<boolean>
  /** One-time READ permission for a chat attachment outside the workspace (native dialog; `mode` is the session's project edit mode and shapes the dialog) */
  requestFileTrust: (path: string, mode?: string) => Promise<boolean>
  /** Session-wide read policy for full-access mode — armed only by a native confirmation */
  armReadPolicy: () => Promise<boolean>
  /** Withdraw the session-wide read policy (safe direction; no dialog) */
  disarmReadPolicy: () => Promise<boolean>
  trustStatus: (path: string) => Promise<{ trusted: boolean }>
  trustRevoke: (path: string) => Promise<boolean>
  openInFinder: (path: string) => Promise<void>
  copyPath: (path: string) => Promise<void>
  copy: (src: string, dest: string) => Promise<void>
  move: (src: string, dest: string) => Promise<void>
  saveBackup: (filePath: string, content: string, encoding: string, hasBom?: boolean) => Promise<void>
  listBackups: () => Promise<import('@shared/types').BackupEntry[]>
  readBackup: (filePath: string) => Promise<{ content: string; encoding: string; hasBom: boolean } | null>
  deleteBackup: (filePath: string) => Promise<void>
  clearBackups: () => Promise<void>
  lspStart: (uri: string, command: string, args: string[], cwd: string, languageId: string, text: string) => Promise<{ ok: boolean; error?: string }>
  lspDidChange: (uri: string, version: number, text: string) => Promise<void>
  lspStop: (uri: string) => Promise<void>
  onLspDiagnostics: (callback: (payload: { uri: string; diagnostics: Array<Record<string, unknown>> }) => void) => () => void
  debugStart: (command: string, args: string[], cwd: string, launchConfig: Record<string, unknown>, breakpoints: Array<{ path: string; line: number }>) => Promise<{ ok: boolean; error?: string }>
  debugSetBreakpoints: (path: string, lines: number[]) => Promise<void>
  debugContinue: () => Promise<void>
  debugPause: () => Promise<void>
  debugStepOver: () => Promise<void>
  debugStepInto: () => Promise<void>
  debugStepOut: () => Promise<void>
  debugStop: () => Promise<void>
  onDebugEvent: (event: 'stopped' | 'output' | 'terminated', callback: (body: Record<string, unknown>) => void) => () => void
  onFileChanged: (callback: (path: string) => void) => () => void

  // File preview — live (unsaved) HTML content pushed into the ourcode-file://
  // protocol's buffer so the preview iframe shows edits without a save
  setPreviewContent: (path: string, content: string) => Promise<void>
  clearPreviewContent: (path: string) => Promise<void>

  // Store
  getConfigGroups: () => Promise<import('@shared/types').ApiConfigGroup[]>
  saveConfigGroup: (group: any) => Promise<import('@shared/types').ApiConfigGroup>
  deleteConfigGroup: (id: string) => Promise<void>
  getSessions: (mode?: 'main' | 'office') => Promise<import('@shared/types').ChatSession[]>
  saveSession: (session: any) => Promise<import('@shared/types').ChatSession>
  deleteSession: (id: string) => Promise<void>
  /** Durable sub-agent run records (office 任务流 / 代码变更 / 终端 回看) */
  getSubagentRuns: (sessionIds: string[]) => Promise<Array<{ toolCallId: string; record: import('@shared/types').SubAgentProgress }>>
  saveSubagentRun: (toolCallId: string, record: import('@shared/types').SubAgentProgress) => Promise<boolean>
  getPreferences: () => Promise<import('@shared/types').UserPreferences>
  savePreferences: (prefs: any) => Promise<void>
  resetAll: () => Promise<void>

  // Crypto
  encryptForExport: (text: string, password: string) => Promise<string>
  decryptForImport: (encryptedData: string, password: string) => Promise<string>

  // Dialog
  openFolder: () => Promise<string | null>
  openFile: () => Promise<string | null>
  saveFile: (defaultPath?: string) => Promise<string | null>

  // Drag & drop — absolute path for a file dropped from the OS file manager
  getPathForFile: (file: File) => string

  // Window
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  openDevTools: () => Promise<void>
  openNewWindow: () => Promise<void>
  /** 打开「一人公司」独立窗口（office 模式）。 */
  openOfficeWindow: () => Promise<void>
  /** 本窗口是否为办公室模式（preload 同步注入，主窗口为 false）。 */
  isOfficeMode: boolean
  onMaximized: (callback: (isMaximized: boolean) => void) => () => void

  // OS-level notification (session events while the window is unfocused)
  showSystemNotification: (title: string, body: string) => Promise<void>

  // Terminal
  termCreate: (id: string, cwd?: string) => Promise<void>
  termWrite: (id: string, data: string) => Promise<void>
  termResize: (id: string, cols: number, rows: number) => Promise<void>
  termDispose: (id: string) => Promise<void>
  termRunAgent: (id: string, command: string, cwd?: string) => Promise<void>
  termOutput: (id: string, tailChars?: number) => Promise<import('@shared/types').TerminalRunSnapshot | null>
  termKill: (id: string) => Promise<boolean>
  termAttach: (id: string) => Promise<{ command: string; running: boolean; output: string } | null>
  termList: () => Promise<import('@shared/types').AgentTerminalRun[]>
  onTermData: (id: string, callback: (data: string) => void) => () => void
  onTermExit: (id: string, callback: (code: number) => void) => () => void

  // Search
  searchInFiles: (dirPath: string, query: string, options?: import('@shared/types').SearchOptions) => Promise<import('@shared/types').SearchResult[]>
  searchFiles: (dirPath: string, query: string) => Promise<string[]>

  // Git
  gitExec: (cwd: string, args: string[], input?: string) => Promise<{ success: boolean; output: string; error?: string }>
  /** gitExec variant whose stdout is returned untrimmed (byte-exact blob reads). */
  gitExecRaw: (cwd: string, args: string[], input?: string) => Promise<{ success: boolean; output: string; error?: string }>

  // GitHub CLI (PR workflow) — runs the user's own `gh`, allowlisted subcommands only
  ghExec: (cwd: string, args: string[]) => Promise<{ success: boolean; output: string; error?: string }>
  ghStatus: (cwd: string) => Promise<{
    installed: boolean; authed: boolean; host?: string; user?: string; error?: string; raw?: string
  }>

  // Agent browser session
  browserNavigate: (url: string) => Promise<{ ok: boolean; state: import('@shared/types').BrowserSessionState; error?: string }>
  browserState: () => Promise<import('@shared/types').BrowserSessionState>
  browserConsole: (clear?: boolean) => Promise<{ entries: import('@shared/types').BrowserConsoleEntry[]; text: string }>
  browserPageText: (maxChars?: number) => Promise<{ ok: boolean; error?: string; title?: string; url?: string; text?: string }>
  browserScreenshot: () => Promise<{ ok: boolean; error?: string; url?: string; dataUrl?: string; mimeType?: string }>
  browserAct: (action: import('@shared/types').BrowserAction, opts?: import('@shared/types').BrowserActOptions) =>
    Promise<import('@shared/types').BrowserActResult & { state: import('@shared/types').BrowserSessionState }>
  browserHistory: (step: 'back' | 'forward' | 'reload') => Promise<import('@shared/types').BrowserSessionState>
  browserSetVisible: (visible: boolean) => Promise<import('@shared/types').BrowserSessionState>
  browserClose: () => Promise<void>
  onBrowserEvent: (callback: (payload: import('@shared/types').BrowserEvent) => void) => () => void

  // Shell
  shellExec: (command: string, cwd?: string, options?: { timeoutMs?: number; requestId?: string }) => Promise<{ success: boolean; output: string; error?: string }>
  shellKill: (requestId: string) => Promise<boolean>

  // Tool-output spill store — oversized tool results page through read_file
  spillSave: (sessionId: string, text: string) => Promise<string | null>
  spillDeleteSession: (sessionId: string) => Promise<void>

  // Model wire log (renderer emits, main process appends)
  wireLogAppend: (sessionId: string, line: string) => Promise<boolean>
  wireLogDeleteSession: (sessionId: string) => Promise<void>
  wireLogOpenDir: () => Promise<boolean>

  // Web fetch (web_search / read_url tools)
  webFetch: (url: string, options?: { timeoutMs?: number; maxBytes?: number }) => Promise<{
    ok: boolean; status?: number; contentType?: string; finalUrl?: string; text?: string; error?: string
  }>

  // LLM HTTP bridge — main-process net.fetch (no CORS), supports streaming
  llmHttp: (req: {
    id: string
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    stream?: boolean
    timeoutMs?: number
  }) => Promise<{ ok: boolean; status?: number; statusText?: string; headers?: Record<string, string>; text?: string; error?: string }>
  llmHttpAbort: (id: string) => void
  onLlmHttpHeaders: (callback: (payload: { id: string; ok: boolean; status: number; statusText: string; headers: Record<string, string> }) => void) => () => void
  onLlmHttpChunk: (callback: (payload: { id: string; data: string }) => void) => () => void
  onLlmHttpDone: (callback: (payload: { id: string }) => void) => () => void
  onLlmHttpError: (callback: (payload: { id: string; message: string }) => void) => () => void

  // Memories
  memoryList: () => Promise<import('@shared/types').Memory[]>
  memoryAdd: (content: string, scope?: string, projectPath?: string) => Promise<import('@shared/types').Memory>
  memoryDelete: (id: string) => Promise<void>

  // Workflows
  workflowList: () => Promise<import('@shared/types').Workflow[]>
  workflowAdd: (workflow: { name: string; description?: string; prompt: string }) => Promise<import('@shared/types').Workflow>
  workflowDelete: (id: string) => Promise<void>

  // Checkpoints (AI edit snapshots)
  checkpointList: (sessionId: string) => Promise<import('@shared/types').Checkpoint[]>
  checkpointCreate: (checkpoint: import('@shared/types').Checkpoint) => Promise<import('@shared/types').Checkpoint>
  checkpointDelete: (sessionId: string) => Promise<void>
  checkpointRevert: (checkpointId: string) => Promise<{ ok: boolean; restored: number; error?: string }>
  checkpointListReverted: (sessionId: string) => Promise<string[]>
  checkpointRestore: (sessionId: string, filePaths: string[]) => Promise<{ ok: boolean; restored: number; failed?: string[]; error?: string }>
  checkpointGetRevertedRecord: (sessionId: string, filePath: string) => Promise<import('@shared/types').RevertedFileRecord | null>

  // MCP (Model Context Protocol)
  mcpListTools: () => Promise<Array<{ server: string; name: string; description?: string; inputSchema?: Record<string, any> }>>
  mcpCallTool: (server: string, toolName: string, args: Record<string, any>) => Promise<{ ok: boolean; result?: string; error?: string }>
  mcpReload: (rootPath: string) => Promise<{ ok: boolean; error?: string }>
  mcpGetConfig: (rootPath: string) => Promise<{ ok: boolean; config: { mcpServers: Record<string, any> }; file: string | null; error?: string }>
  mcpSaveConfig: (rootPath: string, config: { mcpServers: Record<string, any> }, file?: string | null) => Promise<{ ok: boolean; file?: string; error?: string }>
  mcpGetGlobalConfig: () => Promise<{ ok: boolean; config: { mcpServers: Record<string, any> }; file: string | null; error?: string }>
  mcpSaveGlobalConfig: (config: { mcpServers: Record<string, any> }) => Promise<{ ok: boolean; file?: string; error?: string }>
  mcpToolDefinitions: (rootPath?: string) => Promise<import('@shared/types').ToolDefinition[]>
  mcpStatus: (rootPath?: string) => Promise<Array<{ name: string; state: 'connecting' | 'ready' | 'failed' | 'restarting' | 'disabled' | 'stopped'; retry?: number; error?: string; bundled?: boolean }>>
  mcpListResources: () => Promise<Array<{ server: string; uri: string; name?: string; mimeType?: string; description?: string }>>
  mcpReadResource: (server: string, uri: string) => Promise<{ ok: boolean; result?: string; error?: string }>
  mcpListPrompts: () => Promise<Array<{ server: string; name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>>
  mcpGetPrompt: (server: string, name: string, args?: Record<string, any>) => Promise<{ ok: boolean; result?: any; error?: string }>

  // Usage statistics (skills / subagents / MCP / LLM)
  recordUsage: (events: import('@shared/types').UsageEvent[]) => Promise<{ ok: boolean; error?: string }>
  getUsageSummary: (rangeDays?: number) => Promise<import('@shared/types').UsageSummary>
  clearUsage: () => Promise<{ ok: boolean }>

  // App
  getPath: (name: string) => Promise<string>
  /** Ensure the app-owned default empty project exists and return its path.
   *  按窗口模式分目录：office（一人公司窗口）与 main（对话窗口）各自独立。 */
  ensureDefaultProject: (mode?: 'main' | 'office') => Promise<string>
  getPlatform: () => Promise<string>
  resolveEnvVar: (name: string) => Promise<string>
  getVersion: () => Promise<string>
  getLocale: () => Promise<string>

  // Auto Update
  checkForUpdate: () => Promise<{ state: string; version?: string; message?: string }>
  downloadUpdate: () => Promise<{ state: string }>
  installUpdate: () => void
  onUpdateStatus: (callback: (status: { state: string; version?: string; message?: string }) => void) => () => void
  onUpdateProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
