// Shared types between main and renderer processes
import type { ClawAccessPolicy, ClawChannelId } from './claw'
import type { ModelCapability, ModelModality, ReasoningLevel } from './modelCatalog'

export type { ClawAccessPolicy, ClawChannelId }

// API Configuration Group
export interface ApiConfigGroup {
  id: string
  name: string
  baseUrl: string
  apiKey: string // Decrypted at runtime in renderer
  systemPrompt: string
  defaultModel: string
  provider: 'openai' | 'responses' | 'anthropic' | 'gemini' | 'ollama' | 'deepseek' | 'groq' | 'azure' | 'custom'
  /** Override the API format regardless of provider. 'auto' uses the provider's native format. */
  apiFormat?: 'auto' | 'openai' | 'responses' | 'anthropic' | 'gemini' | 'ollama' | 'azure'
  customHeaders: Record<string, string>
  /** Skip TLS certificate verification for this group's host (intranet / self-signed / private CA certs). */
  skipTlsVerify?: boolean
  color?: string // Color label for the config group
  sortOrder?: number // smaller = higher priority
  createdAt: number
  updatedAt: number
}

// Model Parameters
/** 思考档位：关闭 / 低 / 中 / 高 / 最高。统一表达「是否思考 + 多努力思考」，
 *  取代原先 thinking(boolean) + reasoningEffort 两个字段；旧会话无此字段时
 *  由 resolveThinkingLevel 从 thinking/reasoningEffort 回退推导。 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max'

export interface ModelParams {
  temperature: number
  maxTokens: number
  topP: number
  frequencyPenalty: number
  presencePenalty: number
  // Deep thinking (reasoning models): toggle + effort level
  thinking: boolean
  reasoningEffort: 'low' | 'medium' | 'high'
  /** 统一思考档位（优先于 thinking/reasoningEffort，见 resolveThinkingLevel）。 */
  thinkingLevel?: ThinkingLevel
}

/** 解析一个 ModelParams 的有效思考档位：新会话直接读 thinkingLevel；旧会话
 *  按 thinking(boolean) + reasoningEffort 回退（thinking=false → 'off'）。 */
export function resolveThinkingLevel(p: ModelParams): ThinkingLevel {
  if (p.thinkingLevel) return p.thinkingLevel
  return p.thinking ? (p.reasoningEffort as ThinkingLevel) : 'off'
}

/** 把思考档位归一化为 OpenAI 系（DeepSeek/Groq/Responses/OpenAI）支持的最高档：
 *  这些 provider 的 reasoning_effort 只有 low/medium/high，max → high。支持
 *  预算档的 provider（Anthropic/Gemini）直接读 ThinkingLevel 的 max 档。 */
export function normalizeReasoningEffort(e?: string): 'low' | 'medium' | 'high' {
  return e === 'low' || e === 'medium' ? e : 'high'
}

// Chat Branch
export interface ChatBranch {
  id: string
  name: string
  forkedFromMessageId: string // message id where this branch forks from
  messages: ChatMessage[]
  createdAt: number
}

// Chat Session
export interface ChatSession {
  id: string
  title: string
  configGroupId: string
  model: string
  modelParams: ModelParams
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  /** 最近一次用户发消息的时间。会话列表按此排序——agent 运行期间 updatedAt
   *  会被工具调用/进度更新频繁刷新，若按 updatedAt 排序会话位置会一直跳动。 */
  lastUserMessageAt?: number
  activeBranchId?: string // active branch id, undefined/null = main branch
  branches?: ChatBranch[] // all branches except the main one
  pinnedAt?: number
  archivedAt?: number
  // Agent mode: 'chat' answers freely (with tool calls), 'agent' is the merged
  // planning + execution mode — the planning phase is read-only (enforced via
  // PLAN_TOOLS when projectEditMode='plan'), then executes after plan approval
  // or directly for trivial tasks under other edit modes.
  agentMode?: 'chat' | 'agent'
  // Lightweight records of past agent runs (shown in the Agent tasks panel)
  agentRuns?: AgentRun[]
  // Project edit mode: controls tool-approval behavior in agent mode (五档，
  // 对齐 ZCode：手动/自动/计划/自主/完全)
  // 'confirm_before_change' — ask before every file-modifying tool (手动)
  // 'auto_edit' — auto-approve file edits (write/edit files) (自动)
  // 'plan' — read-only → submit plan → approve → execute (计划)
  // 'guarded' — auto-approve all tool calls; dangerous commands still ask once (自主)
  // 'yolo' — auto-approve all tool calls, dangerous commands included (完全)
  // Legacy persisted 'full_access' means the old guarded semantics — migrate
  // to 'guarded' on load (chatStore / sqlite-store).
  projectEditMode?: 'confirm_before_change' | 'auto_edit' | 'plan' | 'guarded' | 'yolo'
  // Target mode (agent mode only): the agent runs autonomously — auto-approves
  // tool calls and auto-continues after rounds are exhausted — until the user
  // decides the goal is done and stops it.
  targetMode?: boolean
  // Agent-managed todo list shown in the chat panel
  todos?: TodoItem[]
  // Plan awaiting approval (set by submit_plan)
  planContent?: string
  planStatus?: 'none' | 'pending_approval' | 'approved' | 'canceled'
  /** 计划声明的最终产物文件（绝对或相对 projectPath 的路径）。计划模式批准后
   *  仅允许写入这些路径；缺省 = 未声明（fail closed，所有写入被拦截）。 */
  planDeliverables?: string[]
  // Project workspace path this session belongs to (captured at creation time)
  projectPath?: string
  // Real context size (input + cache + output tokens) reported by the last API
  // response. The "已使用 X%" indicator baselines on this (Claude Code-style)
  // and only estimates messages added after it, instead of re-summing the whole
  // history from characters (which drifts further from reality every round).
  lastContextTokens?: number
  /** session.messages.length when lastContextTokens was recorded — messages
   *  added after that point are the only part that needs rough estimation. */
  lastContextMessageCount?: number
  /** 上下文压缩摘要（最早由 contextCompaction 生成）。原始消息永不删除——
   *  摘要只在请求构建时替换边界前的历史（请求视角），会话历史保持完整。 */
  summary?: string
  /** 摘要覆盖的 session.messages 条数：边界前的消息在请求中被摘要替代。
   *  越界时自动 clamp（用户可能编辑/删除了历史）。 */
  summaryMessageCount?: number
  /** Durable compaction lock — true while the LLM summarizer is mid-flight.
   *  Persisted to SQLite so a crash mid-compaction is detected and cleared on
   *  the next load (the pre-crash summary stays valid). Not user-visible. */
  compactionInProgress?: boolean
  /** 会话所属窗口模式：'main' = 对话窗口（默认），'office' = 一人公司独立
   *  窗口，'claw' = Claw 渠道接入专用会话（微信/企业微信/QQ/飞书/Telegram 的
   *  消息都在这里，不显示在主界面会话列表）。三个模式的会话完全隔离
   *  （SQLite 按 mode 过滤），互不显示。 */
  mode?: 'main' | 'office' | 'claw'
  /** 一人公司角色员工（M4）：本会话是某个工位的员工。workerRole = 角色类型
   *  （tm-developer / tm-ui-developer / tm-requirement-analyst / tm-tester），
   *  workerSlot = 1~8 工位号。此类会话对用户隐藏（hidden），只在 list_agents /
   *  派发协议里出现；总监通过 send_message 派活，员工完成后主动回报。 */
  workerRole?: string
  workerSlot?: number
  hidden?: boolean
}

// Agent todo list item (managed via the manage_todo tool)
export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  order: number
}

// Tool-call category used for rendering the agent's execution trace
// (think/search/edit/execute/... get distinct icons, Windsurf-style)
export type AgentToolKind = 'think' | 'search' | 'edit' | 'execute' | 'fetch' | 'switch_mode' | 'ask' | 'other'

// Stage of a session's agent loop — drives the "正在…" placeholder in the chat
// transcript so a silent wait shows what the app is actually doing (preparing
// context / compacting history / waiting for the model's first token) instead
// of a generic "analyzing the codebase" label.
export type AgentRunPhase =
  | 'preparing'  // refreshing tools / building system prompt / codebase retrieval
  | 'compacting' // context-compaction summarizer LLM call (runs before the main request)
  | 'waiting'    // LLM request sent, no token received yet (time-to-first-token)
  | 'streaming'  // model output (content/thinking) is flowing

// One executed tool call inside an agent run (transient, shown in AgentRunPanel)
export interface AgentTraceEntry {
  id: string
  toolCallId: string
  name: string
  kind: AgentToolKind
  status: 'running' | 'success' | 'error' | 'rejected'
  summary: string
  /** Wall-clock start of the tool call (ms epoch), captured when the call is
   *  dispatched. Transient — mirrors the timing persisted on the message's
   *  toolResults for the trajectory view. */
  startedAt?: number
  /** Wall-clock end of the tool call (ms epoch), set when its result lands. */
  finishedAt?: number
}

// One tool call made by a sub-agent (transient, shown in SubAgentProgressBlock)
export interface SubAgentProgressStep {
  id: string
  name: string
  arguments: Record<string, any>
  status: 'running' | 'success' | 'error'
  /** Tool result text once the step finished */
  result?: string
}

// Live execution progress of one run_subagent call, keyed by the PARENT tool
// call id. Pushed by subagentRunner while the sub-agent works, so the UI can
// render its thinking / tool calls in real time instead of a silent spinner.
export interface SubAgentProgress {
  status: 'running' | 'done' | 'error' | 'stopped'
  sessionId: string
  name: string
  task: string
  description?: string
  startedAt: number
  /** Accumulated thinking text of the current/final LLM round */
  thinking: string
  steps: SubAgentProgressStep[]
  toolCallCount: number
  tokenCount: number
  error?: string
}

// Lightweight persisted record of an agent run (shown in the Agent tasks panel)
export interface AgentRun {
  id: string
  task: string
  status: 'running' | 'creating_plan' | 'waiting_plan' | 'approved_running' | 'done' | 'stopped' | 'error' | 'rejected'
  plan?: string // JSON plan (same shape as session.planContent) when submitted
  startedAt: number
  finishedAt?: number
  toolCallCount: number
  fileChangeCount: number
  stepCount: number
  lastError?: string
  // Real token usage reported by the provider, accumulated across the run's
  // LLM requests (0 / absent when the provider reported no usage).
  tokensIn?: number
  tokensOut?: number
  // Extra usage detail for the token badge popover: how many LLM requests the
  // run made, and how many were client-side cache hits (plus tokens saved).
  requestCount?: number
  cacheHits?: number
  cacheTokensSaved?: number
  // Server-side prompt-cache tokens (Anthropic cache_read_input_tokens /
  // DeepSeek prompt_cache_hit_tokens) reported by the provider, accumulated
  // across the run's LLM requests. Shown separately from client-side replays.
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// One file's content snapshot inside a checkpoint
export interface CheckpointFile {
  path: string
  content: string
  existed: boolean
  /** The pre-image could not be read (locked file, EIO, permission) — "existed:
   *  false" then means "unknown", not "did not exist". Revert MUST skip such
   *  entries instead of deleting the file. */
  snapshotFailed?: boolean
}

// Checkpoint: file snapshots taken right before a write tool ran, so the user
// can revert the AI's edits (Windsurf-style checkpoints)
export interface Checkpoint {
  id: string
  sessionId: string
  createdAt: number
  label: string // e.g. "edit_file → src/foo.ts"
  messageId?: string // assistant message that triggered the tool call
  files: CheckpointFile[]
}

// A reverted file's forward snapshot — captured at revert time so the revert
// can be undone (恢复). `content`/`existed` describe the AI-written state that
// was on disk right before the revert, and `messageId` points back at the
// assistant message whose checkpoint was reverted (used to rebuild a re-
// revertable checkpoint on restore). `hasSnapshot` is false for legacy rows
// created before forward snapshots existed — those must never be restored.
export interface RevertedFileRecord {
  path: string
  content: string
  existed: boolean
  revertedAt: number
  messageId?: string
  hasSnapshot: boolean
}

// ── Workspace checkpoints (whole-tree snapshots) ───────────────────────────
// The per-file checkpoints above are fast and cover write tools. Workspace
// checkpoints cover the cases the per-file snapshot cannot: directory deletes,
// run_command side effects, MCP/plugin writes and non-git projects. They are
// backed by a shadow git repository under userData (never the project's .git).

export type WorkspaceCheckpointKind =
  | 'files'
  | 'command'
  | 'restore-safety'
  | 'mkdir'
  | 'dir-delete'
  /** Whole-tree anchor taken before a company task's first tool call. The
   *  "恢复整个任务" action restores this — it covers per-file write/edit
   *  checkpoints that are not tied to a taskId. */
  | 'task-start'
  /** The project's initial state: "回到初始状态" restores to this snapshot.
   *  Created once per project (or on demand), never pruned. */
  | 'baseline'

export interface WorkspaceCheckpoint {
  id: string
  sessionId: string
  /** Absolute project root this snapshot belongs to. */
  projectPath: string
  /** Director session id (one-person-company task); optional for agent mode. */
  taskId?: string
  /** Tool call that created this snapshot (restore-to-before target). */
  toolCallId?: string
  /** Assistant message that triggered the tool call. */
  messageId?: string
  label: string
  createdAt: number
  /** Commit in the shadow repository. */
  commit: string
  /** Absolute paths involved in the operation (filled after the post-diff). */
  paths: string[]
  /** Absolute empty directories to recreate on restore. */
  emptyDirs: string[]
  /** Absolute directories created by the operation (removed on restore when empty). */
  createdDirs: string[]
  kind: WorkspaceCheckpointKind
}

export interface WorkspaceRestoreResult {
  ok: boolean
  restored: number
  deleted: number
  skipped: number
  conflicts?: string[]
  safetyCheckpointId?: string
  error?: string
}

export interface WorkspaceDiffEntry {
  /** Absolute path. */
  path: string
  status: 'added' | 'modified' | 'deleted'
}

// Persistent user memory (injected into the system prompt)
export interface Memory {
  id: string
  content: string
  scope: 'global' | 'project'
  projectPath?: string // the project path this memory belongs to (only for scope='project')
  createdAt: number
  updatedAt: number
}

// Reusable workflow (Windsurf-style): a named prompt template that can be
// re-run against the current workspace/selection
export interface Workflow {
  id: string
  name: string
  description: string
  prompt: string
  createdAt: number
  updatedAt: number
}

// Ask-user-question interaction (asked by the agent during the loop)
export interface UserQuestion {
  id: string
  question: string
  options?: string[]
  /** When true the user may pick several options at once (single otherwise) */
  multiSelect?: boolean
  /** Optional per-option preview text (aligned with `options`) shown under
   *  each choice — e.g. ASCII mockups the user can compare side by side. */
  preview?: string[]
}

// Structured LLM error (rendered as a friendly error card instead of raw text)
export interface ChatError {
  /** HTTP status code when the upstream service returned one */
  code?: number
  type: 'auth' | 'timeout' | 'network' | 'rate_limit' | 'server' | 'bad_request' | 'unknown'
  /** Localized, user-friendly message shown in the error card */
  message: string
  /** Raw upstream detail (e.g. the JSON error body) — shown in a collapsible area */
  detail?: string
}

// Chat Message
/** An image the user attached to a message. `dataBase64` is the raw payload
 *  without the `data:` URL prefix; it travels to vision-capable models and is
 *  persisted with the message so a rebuilt history keeps its attachments. */
export interface MessageAttachment {
  id: string
  name: string
  mimeType: string
  dataBase64: string
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  sortOrder: number
  contextFiles: string[]
  tokenCount: number
  attachments?: MessageAttachment[]
  thinking?: string
  editedAt?: number
  createdAt: number
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any>; startedAt?: number }>
  toolResults?: Array<{ toolCallId: string; name: string; result: string; isError?: boolean; startedAt?: number; finishedAt?: number; durationMs?: number }>
  toolCallId?: string
  error?: ChatError
  // The agent run that produced this message (agent mode). Lets the header
  // badge render THIS message's own status/tokens instead of the session's
  // latest run — a completed reply must never re-badge when a later request
  // starts or errors in the same conversation.
  runId?: string
  // ── Per-round LLM request timing/usage (assistant messages) ──────────────
  // One assistant message = one LLM round. These fields persist the wall-clock
  // timing and provider-reported token usage of the request that produced this
  // message, so the trajectory view can render a request row per round without
  // re-deriving it from usage_events. Absent on legacy messages and on user/
  // tool messages.
  requestStartedAt?: number
  requestDurationMs?: number
  /** Time-to-first-token (ms) — undefined when the provider streamed no token
   *  (empty reply) or on legacy messages. */
  ttftMs?: number
  requestTokensIn?: number
  requestTokensOut?: number
}

// Open File
export interface OpenFile {
  path: string
  content: string
  language: string
  encoding: string
  lineEnding: 'lf' | 'crlf'
  isDirty: boolean
  cursorPosition?: { line: number; column: number }
  hasBom?: boolean // original file started with a byte-order mark; preserved on save
  isLoading?: boolean // true while the file is being streamed into the editor
  loadProgress?: number // 0-100, shown while isLoading (large files)
  size?: number // file size in bytes (from stat/stream)
  plainText?: boolean // large file: loaded as plain text (no syntax highlighting)
  readOnly?: boolean // very large file: shown as a read-only preview (head only), no edits
}

// Chunked file stream (main process -> renderer, pull-based)
export interface FileStreamStart {
  id: number
  encoding: string
  hasBom: boolean
  totalBytes: number
  chunk: string // first chunk, already decoded
}

export interface FileStreamChunk {
  chunk: string // decoded text; on done it carries the decoder flush
  done: boolean
}

// File Entry
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  isHidden: boolean
  size?: number
  modifiedAt?: number
  gitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | null
  children?: FileEntry[]
}

// File Stat
export interface FileStat {
  size: number
  isFile: boolean
  isDirectory: boolean
  createdAt: number
  modifiedAt: number
}

// Hot-exit backup entry (an unsaved dirty buffer mirrored by the main process)
export interface BackupEntry {
  filePath: string
  encoding: string
  hasBom: boolean
  size: number
  mtime: number
}

// User Preferences
export interface UserPreferences {
  theme: 'light' | 'dark' | 'system'
  fontSize: number
  fontFamily: string
  tabSize: number
  showMinimap: boolean
  showHiddenFiles: boolean
  chatPosition: 'right' | 'bottom'
  /** 'system' follows the OS locale (zh-* → zh-CN, otherwise en-US) */
  language: 'zh-CN' | 'en-US' | 'system'
  /** When enabled the chat history becomes editable: edit messages, drag to
   *  reorder, and batch-delete. Off by default so history can't be mangled
   *  by an accidental drag. */
  chatHistoryEditMode: boolean
  /** When enabled the agent may call the remember tool to auto-save important
   *  information into long-term memory (managed in Settings). */
  aiAutoMemory: boolean
  /** Cache identical LLM requests (same provider/model/messages/params) and
   *  replay the stored response instead of calling the API again. Only
   *  deterministic requests (temperature 0) are cached. */
  llmResponseCache: boolean
  /** Send Anthropic prompt-caching cache_control breakpoints (system/tools/
   *  mid-conversation) so repeated reads are billed at the cached rate. */
  anthropicPromptCache: boolean
  /** Extend Anthropic prompt-cache breakpoints to a 1-hour TTL (cache_control
   *  { type: 'ephemeral', ttl: '1h' }) instead of the default 5 minutes — long
   *  agent runs keep their prefix cached across slow tool rounds. Only models
   *  with 1h ephemeral cache support accept the ttl field. */
  anthropicPromptCache1h?: boolean
  /** Model wire log: replayable redacted request/response lines under
   *  <userData>/wire-logs/<session>.jsonl (defaults ON). */
  wireLogEnabled?: boolean
  /** LSP servers by Monaco language id, e.g. { python: "pylsp", go: "gopls -mode stdio" } */
  lspServers?: Record<string, string>
  /** How this app treats inbound cross-session messages (send_message tool):
   *  'accept' = deliver and auto-trigger the receiving session's agent loop,
   *  'hold' = deliver into history but don't auto-process,
   *  'refuse' = reject delivery (senders get an error). */
  crossSessionInbound?: 'accept' | 'hold' | 'refuse'
  /** Agent 工具调用循环的轮数上限；0 或缺失 = 无限。只作为防死循环安全阀，
   *  默认不限制。 */
  agentMaxIterations?: number
  /** 自动重试瞬时性 LLM 失败（超时/网络/限流/5xx）。只在流尚未产出任何
   *  内容时重试；鉴权错误、参数错误、上下文溢出一律不重试。 */
  llmRetryEnabled?: boolean
  /** 每次请求失败后的自动重试次数上限（0 = 关闭重试）。 */
  llmRetryMaxRetries?: number
  /** 工具输出统一截断：工具结果（MCP / run_command / 技能等）超过该字符数
   *  时保留头部+尾部并提示分页读取。默认高于内置工具自身的上限，只兜住
   *  无上限的输出路径。 */
  toolOutputMaxChars?: number
  /** 工具输出统一截断：同时按行数上限截断。 */
  toolOutputMaxLines?: number
  /** 上下文压缩：当估算上下文超过模型窗口的阈值时，把较早的历史压缩为
   *  摘要（仅请求视角替换，原始消息永不删除）。 */
  contextCompaction?: boolean
  /** 压缩触发阈值（占模型上下文窗口的比例，0.7 = 70%）。 */
  contextCompactionRatio?: number
  /** 压缩摘要使用的模型 ID；留空则跟随会话模型。 */
  contextCompactionModel?: string
  /** 提问自动继续（ZCode 风格）：Agent 的 ask_user_question 默认带 5 分钟
   *  倒计时，超时未回答时 Agent 按自己的判断继续并打标。关闭后提问一直
   *  等待。权限审批与计划审批不受此开关影响（永远等待）。 */
  questionAutoContinue?: boolean
  /** 启动后延迟自动检查更新（默认开）。自动检查静默失败，只有发现新版本才提示。 */
  autoUpdateCheck?: boolean
  /** 发现新版本后自动静默下载（默认关；下载完成后仍需用户点击重启安装）。 */
  autoUpdateDownload?: boolean
  /** 自定义更新源：generic provider 的 base URL（目录下需放 latest.yml 与安装包）。
   *  留空则使用打包内置的默认源（GitHub Releases）。 */
  updateFeedUrl?: string
  /** Claw 渠道接入总开关（关闭时所有渠道网关不启动、渠道消息不处理）。 */
  clawEnabled?: boolean
  /** Claw 会话审批模式：'approve' 逐条审批（默认）| 'full_access' 免审批。 */
  clawApprovalMode?: 'approve' | 'full_access'
  /** Claw 工作区根目录：Claw 任务都在此目录下进行；留空 = 使用最近打开的项目。 */
  clawWorkspaceDir?: string
  /** Claw 会话使用的 API 配置组 id（留空 = 跟随 IDE 当前组）。 */
  clawConfigGroupId?: string
  /** Claw 会话使用的模型 id（留空 = 组的默认模型）。 */
  clawModelId?: string
  /** Agent 执行浏览器导航/操作时自动显示内置浏览器窗口（独立窗口，
   *  showInactive 不抢焦点）。默认开；关闭后仍可从设置手动显示。 */
  browserAutoShow?: boolean
  /** 电脑操控总开关（关闭时不暴露 computer_* 工具、不启动 helper）。 */
  computerUseEnabled?: boolean
  /** 追加敏感应用黑名单（内置黑名单始终生效）。 */
  computerUseAppDenylist?: string[]
  /** true = 只允许白名单应用。 */
  computerUseAllowlistMode?: boolean
  computerUseAppAllowlist?: string[]
  /** 允许子智能体使用电脑操控（默认禁止）。 */
  computerUseInSubagent?: boolean
  /** 「正在操作」覆盖层。 */
  computerUseShowOverlay?: boolean
  /** 单次观察节点上限。 */
  computerUseMaxNodes?: number
  /** 动作后 settle 起始等待（ms）。 */
  computerUsePostActionMs?: number
  /** 截图帧保留分钟数。 */
  computerUseKeepFramesMin?: number
  /** web_search 后端：auto = 有 DeepSeek Key 用 DeepSeek，其次 SearXNG，然后 Bing，最后 DuckDuckGo；multi = 多源并发聚合。 */
  webSearchProvider?: 'auto' | 'multi' | 'deepseek' | 'searxng' | 'bing' | 'brave' | 'duckduckgo'
  /** DeepSeek Search/Fetch API Key；留空时自动复用官方 DeepSeek 配置组的 Key。 */
  webSearchDeepseekApiKey?: string
  /** DeepSeek API Base URL；默认 https://api.deepseek.com（也可填 …/v1）。 */
  webSearchDeepseekBaseUrl?: string
  /** SearXNG 实例地址；需在 settings.yml 的 search.formats 中开启 json。 */
  webSearchSearxngUrl?: string
  /** read_url 抓取方式：auto = 本地抽取优先，失败或正文过短时回退 DeepSeek Fetch。 */
  webFetchProvider?: 'auto' | 'local' | 'deepseek'
  /** 允许 read_url 访问内网/本地地址（默认关闭；会带来 SSRF 风险）。 */
  webFetchAllowPrivate?: boolean
}

// Model Info
export interface ModelInfo {
  id: string
  name: string
  isFree: boolean
  isFavorite: boolean
  alias?: string
  contextWindow?: number // context window size in tokens
  maxOutputTokens?: number // vendor default cap on a single reply
  inputModalities?: ModelModality[]
  outputModalities?: ModelModality[]
  capabilities?: ModelCapability[]
  reasoningLevels?: ReasoningLevel[]
  vision?: boolean
  functionCall?: boolean
}

// LLM Message
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  toolCalls?: LLMToolCall[]
  toolCallId?: string
  /** Images sent alongside `content` on this turn (user role only). Each
   *  adapter maps these to its own multimodal part type. */
  images?: Array<{ mimeType: string; dataBase64: string }>
}

// Tool definition for LLM function calling
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

// Raw tool call from LLM response
export interface LLMToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// LLM Request
export interface LLMRequest {
  model: string
  messages: LLMMessage[]
  temperature: number
  maxTokens: number
  topP: number
  frequencyPenalty: number
  presencePenalty: number
  stream: boolean
  tools?: ToolDefinition[]
  // Deep thinking (reasoning models); optional so non-chat request builders stay compatible
  thinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  /** Per-model extra request-body fields from the model config's reasoning
   *  mapping (e.g. { reasoning_effort: 'low' }). Merged last by each adapter,
   *  so it can override vendor defaults but not auth/headers. */
  extraBody?: Record<string, unknown>
  /** Internal: emit provider prompt-caching markers (e.g. Anthropic cache_control).
   *  Set by the client when the user enabled prompt caching — not part of the
   *  cache key. */
  providerCache?: boolean
  /** Internal: extend Anthropic cache_control breakpoints to a 1-hour TTL
   *  (cache_control { type: 'ephemeral', ttl: '1h' }) instead of the default
   *  ~5 minutes. Set alongside providerCache by the client. */
  providerCacheTtl1h?: boolean
}

// LLM Stream Chunk
export interface LLMStreamChunk {
  content: string
  thinking?: string
  done: boolean
  toolCalls?: LLMToolCall[]
  /** Provider finish/stop reason on the terminal chunk ('stop', 'length',
   *  'tool_calls', …). Surfaced so callers can detect silent overflow
   *  (finish_reason 'length' + zero output = input filled the window). */
  finishReason?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    /** Server-side prompt-cache tokens read this request (Anthropic
     *  cache_read_input_tokens / DeepSeek prompt_cache_hit_tokens). Part of
     *  promptTokens; billed at the cached-read rate. 0 when the provider
     *  doesn't report cache accounting. */
    cacheReadTokens?: number
    /** Server-side cache write (Anthropic cache_creation_input_tokens /
     *  DeepSeek prompt_cache_miss_tokens). 0 when not reported. */
    cacheCreationTokens?: number
  }
  /** Set on a replayed response from the client-side cache: the request hit the
   *  local cache and no API call was made. `usage` carries 0/0; the saved token
   *  counts are reported here so the usage dashboard can show the saving. */
  cacheHit?: {
    savedTokensIn: number
    savedTokensOut: number
  }
}

// Custom Model (user-added)
export interface CustomModel {
  id: string
  name: string
  provider: ApiConfigGroup['provider']
  contextWindow?: number
  /** Default cap on a single reply; 0/undefined means "provider default". */
  maxOutputTokens?: number
  inputModalities?: ModelModality[]
  outputModalities?: ModelModality[]
  capabilities?: ModelCapability[]
  /** Thinking levels the model accepts (metadata shown in the config editor). */
  reasoningLevels?: ReasoningLevel[]
  /** JSON object mapping a thinking level to extra request-body fields, e.g.
   *  {"low":{"reasoning_effort":"low"},"high":{"reasoning_effort":"high"}}. */
  reasoningParamMap?: string
  vision?: boolean
  functionCall?: boolean
  createdAt: number
}

// Custom AI Command
export interface CustomAICommand {
  id: string
  name: string
  prompt: string
  icon?: string
  shortcut?: string
}

// Terminal
export interface TerminalInfo {
  id: string
  name: string
}

// Search options
export interface SearchOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  filePattern?: string // e.g. "*.ts,*.tsx"
  excludeFolders?: string // e.g. "node_modules,.git,dist"
}

// Search result
export interface SearchResult {
  filePath: string
  fileName: string
  lineNumber: number
  lineContent: string
  matchStart: number
  matchEnd: number
}

// ───────────────────── Usage statistics ─────────────────────

/** Feature category of a recorded usage event (persisted in usage_events) */
export type UsageEventCategory = 'llm' | 'skill' | 'subagent' | 'mcp'

/**
 * One recorded usage event. Collection points:
 * - 'llm'       name = model id, sub = provider (chatStore / arena)
 * - 'skill'     name = skill name (SkillManager / skill__ tool)
 * - 'subagent'  name = subagent role name (subagentRunner)
 * - 'mcp'       name = `${server}__${tool}` (or `server__<lifecycle>`), sub = server (ToolExecutor / MCPManager)
 */
export interface UsageEvent {
  id: string
  category: UsageEventCategory
  name: string
  sub?: string
  sessionId?: string
  projectPath?: string
  startedAt: number
  finishedAt?: number
  durationMs?: number
  tokensIn?: number
  tokensOut?: number
  ok?: boolean
  error?: string
  payload?: Record<string, any>
}

/** One row of an aggregated ranking (byModel / skills / subagents / mcp) */
export interface UsageRankRow {
  name: string
  sub: string
  count: number
  tokensIn: number
  tokensOut: number
  errors: number
  lastUsed: number
}

/** One day of the token-usage trend (key: 'YYYY-MM-DD' local time) */
export interface UsageDailyRow {
  day: string
  tokensIn: number
  tokensOut: number
  requests: number
}

/** A recent usage event, as returned by the summary query (denormalized) */
export interface UsageRecentRow {
  id: string
  category: UsageEventCategory
  name: string
  sub: string
  sessionId: string
  startedAt: number
  durationMs: number
  tokensIn: number
  tokensOut: number
  ok: boolean
  error: string
}

/** Dashboard payload returned by usage:summary for a given time range */
export interface UsageSummary {
  totals: { requests: number; tokensIn: number; tokensOut: number; errors: number }
  daily: UsageDailyRow[]
  byModel: UsageRankRow[]
  skills: UsageRankRow[]
  subagents: UsageRankRow[]
  mcp: UsageRankRow[]
  recent: UsageRecentRow[]
}

// ───────────────────────── 一人公司（目标模式看板） ─────────────────────────

/** 工位状态（看板状态元数据 officeTheme.OFFICE_STATE_META 的 key）。 */
export type OfficeStatus =
  | 'working' | 'idle' | 'transfer' | 'thinking' | 'receiving'
  | 'reviewing' | 'completed' | 'error' | 'offline'

/** One agent-owned pty run, as the main process reports it through `term:list`. */
export interface AgentTerminalRun {
  id: string
  command: string
  running: boolean
  exitCode: number | null
}

/** What the main process knows about one pty run — an integrated-terminal tab
 *  or a command the assistant started. `output` is the raw pty stream (ANSI
 *  sequences included); stripping is the reader's job. */
export interface TerminalRunSnapshot {
  output: string
  /** True when the stream was cut to the requested tail */
  truncated: boolean
  running: boolean
  exitCode: number | null
  command: string
}

// ── Agent browser session ───────────────────────────────────────────────────
// One shared, hidden webContents that both the UI and the assistant drive, so
// "the agent looked at the page" and "what the user sees in the Browser panel"
// are the same thing. See electron/services/browser-session.ts.

/** One captured console/error line from the browsed page. */
export interface BrowserConsoleEntry {
  level: 'verbose' | 'info' | 'warning' | 'error'
  text: string
  /** Source URL + line, when the page reported one. */
  source?: string
  at: number
}

/** Observable state of the browser session, pushed to the renderer on change. */
export interface BrowserSessionState {
  url: string
  title: string
  loading: boolean
  /** Whether the session is surfaced as a visible window (user chose "显示"). */
  visible: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Last main-frame load failure (`did-fail-load`), cleared on next navigation. */
  lastError?: string
}

export type BrowserAction = 'click' | 'type' | 'press' | 'scroll' | 'hover' | 'drag' | 'wait'

export type BrowserMouseButton = 'left' | 'right' | 'middle'

/** auto = real CDP input, fall back to synthetic DOM events; real = CDP only;
 *  dom = synthetic DOM events only. */
export type BrowserActStrategy = 'auto' | 'real' | 'dom'

/** Arguments for one in-page interaction. `selector` is a CSS selector; an
 *  empty one means "the focused element" (press) or is rejected (click/type).
 *  `ref` (from browser_snapshot) takes precedence: it addresses the isolated
 *  world node by backend id, so it survives React re-renders and shadow DOM.
 *
 *  `x` / `y` are CSS pixels in the page viewport (the same space as
 *  getBoundingClientRect), for canvas/custom widgets with no addressable node.
 *  A ref/selector wins when both are supplied. */
export interface BrowserActOptions {
  selector?: string
  ref?: string
  text?: string
  key?: string
  ms?: number
  /** Pointer target, CSS pixels relative to the viewport. */
  x?: number
  y?: number
  /** Drag end point, CSS pixels relative to the viewport. */
  toX?: number
  toY?: number
  button?: BrowserMouseButton
  /** 1 = click, 2 = double click, 3 = triple click. */
  clickCount?: number
  /** Wheel deltas in CSS pixels (action=scroll). */
  deltaX?: number
  deltaY?: number
  direction?: 'up' | 'down' | 'left' | 'right'
  strategy?: BrowserActStrategy
}

export interface BrowserPoint {
  x: number
  y: number
}

export interface BrowserActResult {
  ok: boolean
  error?: string
  /** What the page looked like after the action (title + url), when known. */
  detail?: string
  /** How the action was delivered: real CDP input or synthetic DOM fallback. */
  strategy?: 'cdp' | 'dom'
  /** Viewport point used by a mouse/wheel action. */
  point?: BrowserPoint
}

/** Viewport geometry of the last screenshot. Coordinates are CSS pixels in
 *  this viewport; image pixels may be larger on HiDPI (divide by the ratio). */
export interface BrowserViewport {
  width: number
  height: number
  devicePixelRatio: number
}

export interface BrowserScreenshotResult {
  ok: boolean
  error?: string
  url?: string
  dataUrl?: string
  mimeType?: string
  viewport?: BrowserViewport
  /** PNG size in image pixels (compare with viewport to map coordinates). */
  image?: { width: number; height: number }
}

/** One compact accessibility node, as handed to the model by browser_snapshot. */
export interface BrowserAxNode {
  role: string
  name?: string
  value?: string
  /** Present only for nodes an action can target; the model passes it as `ref`. */
  ref?: string
  children?: BrowserAxNode[]
}

export interface BrowserSnapshotResult {
  ok: boolean
  error?: string
  url?: string
  title?: string
  /** `- role "name" [ref=e3]` tree, capped and de-noised. */
  text?: string
  nodes?: number
  /** Opaque id of this snapshot; refs from an older snapshot are rejected. */
  snapshotId?: string
}

/** Pushed from the main process whenever the session changes (navigation, title,
 *  or one new console line). */
export type BrowserEvent =
  | { type: 'state'; state: BrowserSessionState }
  | { type: 'console'; entry: BrowserConsoleEntry }

// ── Claw 渠道接入：网关事件协议 ────────────────────────────────────────────
// 与 electron/claw-gateway/gateway.mjs 的 stdout 事件对齐。每个渠道一个网关
// 子进程；事件统一带 `channel` 字段，主进程经 IPC_CHANNELS.CLAW_EVENT 广播，
// 渲染层按 channel + event 分发。渠道目录与接入策略见 shared/claw.ts。

export type ClawChannelState = 'idle' | 'loggingIn' | 'connected' | 'disconnected' | 'stopped'

export interface ClawStatusEvent {
  event: 'status'
  channel: ClawChannelId
  state: ClawChannelState
  accountId?: string
}

export interface ClawQrEvent {
  event: 'qr'
  channel: ClawChannelId
  qrcodeUrl: string
}

export interface ClawInboundEvent {
  event: 'inbound'
  channel: ClawChannelId
  msgId?: string
  from?: string
  /** 发件人显示名（渠道能给就给，面板与日志用）。 */
  fromName?: string
  /** 回复目标：群消息为群 id，否则为发送者本人。 */
  replyTo?: string
  isGroup: boolean
  /** 适配器已归一化：群消息里 @机器人 的前缀已被剥离。 */
  text: string
  ts?: number
  /** 渠道侧的回执令牌（微信 context_token、QQ msg_id 等），回复时原样带回。 */
  contextToken?: string
  /** 该消息是否 @ 了机器人（群聊接入控制的判定依据）。 */
  mentioned?: boolean
}

export interface ClawSentEvent {
  event: 'sent'
  channel?: ClawChannelId
  clientMsgId?: string
  ok: boolean
  messageId?: string
  error?: string
}

/**
 * 渠道配置/启停变更（主进程广播，不来自网关子进程）。
 *
 * 只表示「配置已经变了，去重新拉一次」：不携带数据，避免各窗口各自缓存出
 * 一份不一致的配置。多窗口（对话窗口 + 一人公司窗口）必须靠它在保存设置、
 * 拨动渠道开关或切换总开关后保持一致。
 */
export interface ClawConfigChangedEvent {
  event: 'configChanged'
}

export type ClawGatewayEvent =
  | ClawStatusEvent
  | ClawQrEvent
  | { event: 'scanned'; channel: ClawChannelId }
  | { event: 'needVerifyCode'; channel: ClawChannelId }
  | { event: 'verifyBlocked'; channel: ClawChannelId }
  | { event: 'loginFailed'; channel: ClawChannelId; message: string }
  | { event: 'sessionExpired'; channel: ClawChannelId; message: string }
  | { event: 'policyDrop'; channel: ClawChannelId; reason: string; from: string }
  | ClawInboundEvent
  | ClawSentEvent
  | { event: 'error'; channel: ClawChannelId; message: string }
  | ClawConfigChangedEvent

// ── Claw Agent 状态（ClawAgentState）───────────────────────────────────────
// Claw 接入是一个独立的常驻 agent：状态与用户偏好（user_preferences）分离，
// 运行期一切以这里的 AgentState 为准；偏好只作初始值。持久化在
// SQLite claw_agent_state 表（单行），经主进程 IPC 读写。**所有渠道共享这一份
// 状态**（同一个数字员工），渠道差异只体现在连接配置与接入控制策略上。

export interface ClawAgentMemoryItem {
  id: string
  text: string
  createdAt: number
}

export interface ClawAgentState {
  /** 沙盒根目录（安装目录优先，不可写回退 userData；由主进程探测并固定）。 */
  sandboxPath: string
  /** 当前工作区；null = 沙盒模式。切换工作区即修改此字段。 */
  currentWorkspace: string | null
  /** 审批模式：approve = 逐条审批（默认），full_access = 免审批。 */
  approvalMode: 'approve' | 'full_access'
  /** Claw Agent 使用的 API 配置组 id（空 = 回退 IDE 当前组/第一个组）。 */
  configGroupId: string
  /** 模型偏好；null = 跟随配置组默认模型。 */
  modelId: string | null
  /** agent 自己的记忆条目（注入系统提示）。 */
  memory: ClawAgentMemoryItem[]
  updatedAt: number
}

// ── Claw 渠道配置与接入控制 ────────────────────────────────────────────────
// 每个渠道一行：连接凭据 + 启停 + 接入策略。凭据在主进程 SQLite 里按 API key
// 同等标准加密落盘（CryptoService），启动时解密写入 <userData>/claw/<渠道>/
// config.json（0600）供网关子进程读取；不进命令行、不进日志。
// 接入控制策略由主进程在**入站事件进入 agent 之前**强制执行。
// 所有渠道都是主动长连接（WebSocket / 长轮询），因此没有回调地址、端口、
// 加密密钥这类配置——凭据最多 2 个。

export interface ClawChannelConfig {
  id: ClawChannelId
  enabled: boolean
  /** 渠道凭据（字段定义见 shared/claw.ts 的 CLAW_CHANNELS[].fields）。 */
  values: Record<string, string>
  /** 接入控制策略；主进程在入站事件进入 agent 之前强制执行。 */
  policy: ClawAccessPolicy
  updatedAt: number
}

/** 单个渠道的运行状态（面板与设置页共用）。 */
export interface ClawChannelStatus {
  id: ClawChannelId
  state: ClawChannelState
  enabled: boolean
  /** 必填凭据是否齐全（qr 渠道恒为 true）。 */
  configured: boolean
  accountId?: string
  lastError?: string
}

export interface ClawHubStatus {
  channels: ClawChannelStatus[]
}

// ── 微信 Agent × 一人公司：观察与干预 ────────────────────────────────────
// 一人公司窗口把运行状态推成紧凑快照（节流），主进程缓存供微信侧读取；
// 微信侧经确认后向总监会话（公司）注入指令，office 渲染层校验后注入。

export interface OfficeCompanySnapshot {
  sessionId: string
  title: string
  projectPath: string
  running: boolean
  phase: string | null
}

export interface OfficeWorkerSnapshot {
  sessionId: string
  role: string
  slot: number
  running: boolean
  task: string
}

export interface OfficeActivitySnapshot {
  label: string
  task: string
  status: 'running' | 'done' | 'failed' | 'pending'
  startedAt: number
}

/** 一人公司运行状态快照（office 渲染层节流推给主进程）。 */
export interface OfficeSnapshot {
  /** 公司（总监会话）列表，按最近更新排序。 */
  companies: OfficeCompanySnapshot[]
  workers: OfficeWorkerSnapshot[]
  /** 近期角色活动（子智能体/派发），最多 10 条。 */
  recentActivity: OfficeActivitySnapshot[]
  updatedAt: number
}

/** 微信侧向总监下达的指令（经主进程路由到 office 窗口）。 */
export interface OfficeInstructionRequest {
  instructionId: string
  /** 目标公司（总监会话）id；空 = 由 office 侧解析（唯一运行中/最近更新）。 */
  sessionId: string
  /** 指令正文（作为用户消息注入总监会话）。 */
  text: string
}

export interface OfficeInstructionResult {
  instructionId: string
  ok: boolean
  /** started = 总监立即开跑；queued = 公司忙，已排队；failed = 会话不可用。 */
  status?: 'started' | 'queued' | 'failed'
  message?: string
}

