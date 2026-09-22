// Shared types between main and renderer processes

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
  // Project edit mode: controls tool-approval behavior in agent mode
  // 'confirm_before_change' — ask before every file-modifying tool
  // 'auto_edit' — auto-approve file edits (write/edit files)
  // 'plan' — read-only → submit plan → approve → execute
  // 'full_access' — auto-approve all tool calls
  projectEditMode?: 'confirm_before_change' | 'auto_edit' | 'plan' | 'full_access'
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
   *  窗口。两个模式的会话完全隔离（SQLite 按 mode 过滤），互不显示。 */
  mode?: 'main' | 'office'
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
}

// Model Info
export interface ModelInfo {
  id: string
  name: string
  isFree: boolean
  isFavorite: boolean
  alias?: string
  contextWindow?: number // context window size in tokens
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

// ───────────────────────── 3D 办公室 × 目标模式 ─────────────────────────
// 状态类型供 officeBridge（IDE）与 OfficeView 使用；场景为源码库化（vendored
// office-v3），直接函数调用驱动，不再走 iframe/postMessage。

/** 3D 场景 9 种工位状态（对应 office-v3 statusMeta 的 key）。 */
export type OfficeStatus =
  | 'working' | 'idle' | 'transfer' | 'thinking' | 'receiving'
  | 'reviewing' | 'completed' | 'error' | 'offline'

export interface OfficeLog {
  t: string
  k: string
  title: string
  desc: string
}

/** 一个工位的完整可视化状态。 */
export interface OfficeAgentState {
  id: number // 1..8
  role: string
  codeName: string
  status: OfficeStatus
  task: string
  progress: number // 0-100
  logs: OfficeLog[]
}

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

export type BrowserAction = 'click' | 'type' | 'press' | 'scroll' | 'wait'

/** Arguments for one in-page interaction. `selector` is a CSS selector; an
 *  empty one means "the focused element" (press) or is rejected (click/type). */
export interface BrowserActOptions {
  selector?: string
  text?: string
  key?: string
  ms?: number
}

export interface BrowserActResult {
  ok: boolean
  error?: string
  /** What the page looked like after the action (title + url), when known. */
  detail?: string
}

/** Pushed from the main process whenever the session changes (navigation, title,
 *  or one new console line). */
export type BrowserEvent =
  | { type: 'state'; state: BrowserSessionState }
  | { type: 'console'; entry: BrowserConsoleEntry }
