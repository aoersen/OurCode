import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type { AgentTerminalRun, TerminalRunSnapshot } from '../shared/types'

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File System
  readFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_READ_FILE, path),
  writeFile: (path: string, content: string, encoding: string, hasBom?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.FS_WRITE_FILE, path, content, encoding, hasBom),
  openFileStream: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_OPEN_STREAM, path),
  readFileChunk: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.FS_READ_CHUNK, id),
  readFileChunkBatch: (id: number, maxBytes?: number) => ipcRenderer.invoke(IPC_CHANNELS.FS_READ_CHUNK_BATCH, id, maxBytes),
  closeFileStream: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.FS_CLOSE_STREAM, id),
  openWriteStream: (path: string, encoding: string, hasBom?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.FS_OPEN_WRITE_STREAM, path, encoding, hasBom),
  writeChunk: (id: number, chunk: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_WRITE_CHUNK, id, chunk),
  closeWriteStream: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.FS_CLOSE_WRITE_STREAM, id),
  abortWriteStream: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.FS_ABORT_WRITE_STREAM, id),
  listDir: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_DIR, path),
  createFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_CREATE_FILE, path),
  createDir: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_CREATE_DIR, path),
  rename: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FS_RENAME, oldPath, newPath),
  delete: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_DELETE, path),
  stat: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_STAT, path),
  authorize: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_AUTHORIZE, path),
  watch: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_WATCH, path),
  unwatch: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_UNWATCH, path),
  openInFinder: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_OPEN_IN_FINDER, path),
  copyPath: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_COPY_PATH, path),
  copy: (src: string, dest: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_COPY, src, dest),
  move: (src: string, dest: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_MOVE, src, dest),

  // Hot-exit backups
  saveBackup: (filePath: string, content: string, encoding: string, hasBom?: boolean) =>
    ipcRenderer.invoke('backup:save', filePath, content, encoding, hasBom),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  readBackup: (filePath: string) => ipcRenderer.invoke('backup:read', filePath),
  deleteBackup: (filePath: string) => ipcRenderer.invoke('backup:delete', filePath),
  clearBackups: () => ipcRenderer.invoke('backup:clearAll'),

  // LSP
  lspStart: (uri: string, command: string, args: string[], cwd: string, languageId: string, text: string) =>
    ipcRenderer.invoke('lsp:start', uri, command, args, cwd, languageId, text),
  lspDidChange: (uri: string, version: number, text: string) =>
    ipcRenderer.invoke('lsp:didChange', uri, version, text),
  lspStop: (uri: string) => ipcRenderer.invoke('lsp:stop', uri),
  onLspDiagnostics: (callback: (payload: { uri: string; diagnostics: Array<Record<string, unknown>> }) => void) => {
    const listener = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('lsp:diagnostics', listener)
    return () => { ipcRenderer.removeListener('lsp:diagnostics', listener) }
  },

  // Debug Adapter Protocol
  debugStart: (command: string, args: string[], cwd: string, launchConfig: Record<string, unknown>, breakpoints: Array<{ path: string; line: number }>) =>
    ipcRenderer.invoke('debug:start', command, args, cwd, launchConfig, breakpoints),
  debugSetBreakpoints: (path: string, lines: number[]) => ipcRenderer.invoke('debug:setBreakpoints', path, lines),
  debugContinue: () => ipcRenderer.invoke('debug:continue'),
  debugPause: () => ipcRenderer.invoke('debug:pause'),
  debugStepOver: () => ipcRenderer.invoke('debug:stepOver'),
  debugStepInto: () => ipcRenderer.invoke('debug:stepInto'),
  debugStepOut: () => ipcRenderer.invoke('debug:stepOut'),
  debugStop: () => ipcRenderer.invoke('debug:stop'),
  onDebugEvent: (event: 'stopped' | 'output' | 'terminated', callback: (body: Record<string, unknown>) => void) => {
    const listener = (_e: any, body: any) => callback(body)
    ipcRenderer.on(`debug:${event}`, listener)
    return () => { ipcRenderer.removeListener(`debug:${event}`, listener) }
  },
  onFileChanged: (callback: (path: string) => void) => {
    const listener = (_event: any, path: string) => callback(path)
    ipcRenderer.on(IPC_CHANNELS.FS_FILE_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.FS_FILE_CHANGED, listener)
    }
  },

  // File preview — push live (unsaved) HTML content into the ourcode-file://
  // protocol's buffer so the preview iframe shows edits without a save
  setPreviewContent: (path: string, content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_SET, path, content),
  clearPreviewContent: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CLEAR, path),

  // Store
  getConfigGroups: () => ipcRenderer.invoke(IPC_CHANNELS.STORE_GET_CONFIG_GROUPS),
  saveConfigGroup: (group: any) => ipcRenderer.invoke(IPC_CHANNELS.STORE_SAVE_CONFIG_GROUP, group),
  deleteConfigGroup: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.STORE_DELETE_CONFIG_GROUP, id),
  getSessions: (mode?: 'main' | 'office') => ipcRenderer.invoke(IPC_CHANNELS.STORE_GET_SESSIONS, mode),
  saveSession: (session: any) => ipcRenderer.invoke(IPC_CHANNELS.STORE_SAVE_SESSION, session),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.STORE_DELETE_SESSION, id),
  getPreferences: () => ipcRenderer.invoke(IPC_CHANNELS.STORE_GET_PREFERENCES),
  savePreferences: (prefs: any) => ipcRenderer.invoke(IPC_CHANNELS.STORE_SAVE_PREFERENCES, prefs),
  resetAll: () => ipcRenderer.invoke('store:resetAll'),

  // Usage statistics
  recordUsage: (events: any[]) => ipcRenderer.invoke(IPC_CHANNELS.USAGE_RECORD, events),
  getUsageSummary: (rangeDays?: number) => ipcRenderer.invoke(IPC_CHANNELS.USAGE_SUMMARY, rangeDays),
  clearUsage: () => ipcRenderer.invoke(IPC_CHANNELS.USAGE_CLEAR),

  // LLM response cache
  llmCacheGet: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CACHE_GET, key),
  llmCachePut: (entry: { key: string; provider: string; model: string; response: string; tokensIn: number; tokensOut: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_CACHE_PUT, entry),
  llmCacheClear: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_CACHE_CLEAR),

  // Crypto (Export/Import)
  encryptForExport: (text: string, password: string) => ipcRenderer.invoke('crypto:encryptForExport', text, password),
  decryptForImport: (encryptedData: string, password: string) => ipcRenderer.invoke('crypto:decryptForImport', encryptedData, password),

  // Dialog
  openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FOLDER),
  openFile: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FILE),
  saveFile: (defaultPath?: string) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE_FILE, defaultPath),

  // Drag & drop — resolve the absolute path of a file dropped from the OS
  // (renderer can't read File.path directly; webUtils must run in preload)
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Window
  minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
  maximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
  close: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
  isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  openDevTools: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS),
  openNewWindow: () => ipcRenderer.invoke('window:openNewWindow'),
  // 「一人公司」：打开独立办公室窗口（office 模式）。
  openOfficeWindow: () => ipcRenderer.invoke('window:openOfficeWindow'),
  // 本窗口是否为办公室模式：主进程通过 webPreferences.additionalArguments
  // 注入 '--office-mode'（沙箱 preload 可读 process.argv，同步可用）。
  isOfficeMode: process.argv.includes('--office-mode'),
  onMaximized: (callback: (isMaximized: boolean) => void) => {
    const listener = (_event: any, isMaximized: boolean) => callback(isMaximized)
    ipcRenderer.on('window:maximized', listener)
    return () => {
      ipcRenderer.removeListener('window:maximized', listener)
    }
  },

  // OS-level notification (used for session events while the window is unfocused)
  showSystemNotification: (title: string, body: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_SHOW, { title, body }),

  // Terminal
  termCreate: (id: string, cwd?: string) => ipcRenderer.invoke(IPC_CHANNELS.TERM_CREATE, id, cwd),
  termWrite: (id: string, data: string) => ipcRenderer.invoke(IPC_CHANNELS.TERM_WRITE, id, data),
  termResize: (id: string, cols: number, rows: number) => ipcRenderer.invoke(IPC_CHANNELS.TERM_RESIZE, id, cols, rows),
  termDispose: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TERM_DISPOSE, id),
  // Agent-owned runs: started/inspected/stopped through the same pty layer the
  // integrated terminal uses, so a dev server survives past one tool call.
  termRunAgent: (id: string, command: string, cwd?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERM_RUN_AGENT, id, command, cwd),
  termOutput: (id: string, tailChars?: number): Promise<TerminalRunSnapshot | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERM_OUTPUT, id, tailChars),
  termKill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TERM_KILL, id),
  termAttach: (id: string): Promise<{ command: string; running: boolean; output: string } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERM_ATTACH, id),
  termList: (): Promise<AgentTerminalRun[]> => ipcRenderer.invoke(IPC_CHANNELS.TERM_LIST),
  onTermData: (id: string, callback: (data: string) => void) => {
    const channel = `${IPC_CHANNELS.TERM_DATA}:${id}`
    const listener = (_event: any, data: string) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
  onTermExit: (id: string, callback: (code: number) => void) => {
    const channel = `${IPC_CHANNELS.TERM_EXIT}:${id}`
    const listener = (_event: any, code: number) => callback(code)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },

  // Search
  searchInFiles: (dirPath: string, query: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; filePattern?: string; excludeFolders?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_IN_FILES, dirPath, query, options),
  searchFiles: (dirPath: string, query: string) => ipcRenderer.invoke('search:files', dirPath, query),

  // Git
  gitExec: (cwd: string, args: string[], input?: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_EXEC, cwd, args, input),
  // Git with untrimmed stdout (byte-exact blob reads for the central diff)
  gitExecRaw: (cwd: string, args: string[], input?: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_EXEC_RAW, cwd, args, input),

  // GitHub CLI — PR workflow through the locally installed `gh` (its own
  // credentials, no account built into the app)
  ghExec: (cwd: string, args: string[]) => ipcRenderer.invoke(IPC_CHANNELS.GH_EXEC, cwd, args),
  ghStatus: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.GH_STATUS, cwd),

  // Agent browser session — one shared http(s) page the assistant can drive
  browserNavigate: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_NAVIGATE, url),
  browserState: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_STATE),
  browserConsole: (clear?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CONSOLE, clear),
  browserPageText: (maxChars?: number) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PAGE_TEXT, maxChars),
  browserScreenshot: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SCREENSHOT),
  browserAct: (action: string, opts?: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_ACT, action, opts),
  browserHistory: (step: 'back' | 'forward' | 'reload') => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY, step),
  browserSetVisible: (visible: boolean) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_VISIBLE, visible),
  browserClose: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE),
  onBrowserEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.BROWSER_EVENT, listener)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_EVENT, listener) }
  },

  // Shell
  shellExec: (command: string, cwd?: string, options?: { timeoutMs?: number }) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_EXEC, command, cwd, options),

  // Tool-output spill store — oversized tool results page through read_file
  spillSave: (sessionId: string, text: string) => ipcRenderer.invoke('spill:save', sessionId, text),
  spillDeleteSession: (sessionId: string) => ipcRenderer.invoke('spill:deleteSession', sessionId),

  // Model wire log (renderer emits, main process appends)
  wireLogAppend: (sessionId: string, line: string) => ipcRenderer.invoke('log:wireAppend', sessionId, line),
  wireLogDeleteSession: (sessionId: string) => ipcRenderer.invoke('log:deleteSession', sessionId),
  wireLogOpenDir: () => ipcRenderer.invoke('log:openDir'),

  // Web fetch (web_search / read_url tools)
  webFetch: (url: string, options?: { timeoutMs?: number; maxBytes?: number }) =>
    ipcRenderer.invoke('web:fetch', url, options),

  // LLM HTTP bridge — main-process net.fetch (no CORS), supports streaming
  llmHttp: (req: {
    id: string
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    stream?: boolean
    timeoutMs?: number
    /** Skip TLS certificate verification for this request (unsaved draft configs). */
    skipTlsVerify?: boolean
  }) => ipcRenderer.invoke('llm:http', req),
  llmHttpAbort: (id: string) => ipcRenderer.send('llm:httpAbort', id),
  onLlmHttpHeaders: (callback: (payload: { id: string; ok: boolean; status: number; statusText: string; headers: Record<string, string> }) => void) => {
    const listener = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('llm:httpHeaders', listener)
    return () => { ipcRenderer.removeListener('llm:httpHeaders', listener) }
  },
  onLlmHttpChunk: (callback: (payload: { id: string; data: string }) => void) => {
    const listener = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('llm:httpChunk', listener)
    return () => { ipcRenderer.removeListener('llm:httpChunk', listener) }
  },
  onLlmHttpDone: (callback: (payload: { id: string }) => void) => {
    const listener = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('llm:httpDone', listener)
    return () => { ipcRenderer.removeListener('llm:httpDone', listener) }
  },
  onLlmHttpError: (callback: (payload: { id: string; message: string }) => void) => {
    const listener = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('llm:httpError', listener)
    return () => { ipcRenderer.removeListener('llm:httpError', listener) }
  },

  // Memories
  memoryList: () => ipcRenderer.invoke('memory:list'),
  memoryAdd: (content: string, scope?: string, projectPath?: string) =>
    ipcRenderer.invoke('memory:add', content, scope, projectPath),
  memoryDelete: (id: string) => ipcRenderer.invoke('memory:delete', id),

  // Workflows
  workflowList: () => ipcRenderer.invoke('workflow:list'),
  workflowAdd: (workflow: { name: string; description?: string; prompt: string }) => ipcRenderer.invoke('workflow:add', workflow),
  workflowDelete: (id: string) => ipcRenderer.invoke('workflow:delete', id),

  // Checkpoints
  checkpointList: (sessionId: string) => ipcRenderer.invoke('checkpoint:list', sessionId),
  checkpointCreate: (checkpoint: any) => ipcRenderer.invoke('checkpoint:create', checkpoint),
  checkpointDelete: (sessionId: string) => ipcRenderer.invoke('checkpoint:delete', sessionId),
  checkpointRevert: (checkpointId: string) => ipcRenderer.invoke('checkpoint:revert', checkpointId),
  checkpointListReverted: (sessionId: string) => ipcRenderer.invoke('checkpoint:listReverted', sessionId),
  checkpointRestore: (sessionId: string, filePaths: string[]) => ipcRenderer.invoke('checkpoint:restore', sessionId, filePaths),
  checkpointGetRevertedRecord: (sessionId: string, filePath: string) => ipcRenderer.invoke('checkpoint:getRevertedRecord', sessionId, filePath),

  // MCP
  mcpListTools: () => ipcRenderer.invoke('mcp:listTools'),
  mcpCallTool: (server: string, toolName: string, args: Record<string, any>) =>
    ipcRenderer.invoke('mcp:callTool', server, toolName, args),
  mcpReload: (rootPath: string) => ipcRenderer.invoke('mcp:reload', rootPath),
  mcpGetConfig: (rootPath: string) => ipcRenderer.invoke('mcp:getConfig', rootPath),
  mcpSaveConfig: (rootPath: string, config: { mcpServers: Record<string, any> }, file?: string | null) =>
    ipcRenderer.invoke('mcp:saveConfig', rootPath, config, file),
  mcpToolDefinitions: () => ipcRenderer.invoke('mcp:toolDefinitions'),
  mcpListResources: () => ipcRenderer.invoke('mcp:listResources'),
  mcpReadResource: (server: string, uri: string) => ipcRenderer.invoke('mcp:readResource', server, uri),
  mcpListPrompts: () => ipcRenderer.invoke('mcp:listPrompts'),
  mcpGetPrompt: (server: string, name: string, args?: Record<string, any>) =>
    ipcRenderer.invoke('mcp:getPrompt', server, name, args),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),

  // App
  getPath: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PATH, name),
  ensureDefaultProject: (mode?: string) => ipcRenderer.invoke('app:ensureDefaultProject', mode),
  getPlatform: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PLATFORM),
  resolveEnvVar: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_RESOLVE_ENV_VAR, name),
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  getLocale: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_LOCALE),

  // Auto Update
  checkForUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),
  onUpdateStatus: (callback: (status: { state: string; version?: string; releaseNotes?: string; releaseDate?: string; message?: string }) => void) => {
    const listener = (_event: any, status: any) => callback(status)
    ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, listener)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATUS, listener) }
  },
  onUpdateProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => {
    const listener = (_event: any, progress: any) => callback(progress)
    ipcRenderer.on(IPC_CHANNELS.UPDATE_PROGRESS, listener)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_PROGRESS, listener) }
  },
})
