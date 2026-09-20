import { create } from 'zustand'
import { ChatSession, ChatMessage, MessageAttachment, ChatBranch, ModelParams, LLMToolCall, DEFAULT_MODEL_PARAMS, TodoItem, Checkpoint, UserQuestion, AgentRun, AgentTraceEntry, AgentToolKind, UsageEvent, SubAgentProgress, AgentRunPhase, resolveThinkingLevel } from '@/types'
import { TOOL_ALLOWLIST_PREFIX, lookupModelMetadata } from '@shared/constants'
import { IS_OFFICE, WINDOW_MODE, modeKey } from '@/utils/windowMode'
import { useConfigStore } from './configStore'
import { useEditorStore } from './editorStore'
import { useMemoryStore } from './memoryStore'
import { useUIStore } from './uiStore'
import { getLastModelForGroup } from './configStore'
import { TARGET_MODE_INSTRUCTION } from './targetModeInstruction'
import { budgetExceeded, getBudgetUsage, refreshBudgetLimit } from '@/services/targetMode/budget'
import { ensureInitialized, readStatus, readStatusText, parseStatus, TargetModeStatus } from '@/services/targetMode/targetModeService'
import { t } from '@/i18n'
import { getFileContent } from '@/editor/modelRegistry'
import { sendLLMRequest, configureLLMCache, configureLLMRetry } from '@/services/llm/LLMClient'
import { parseLLMError } from '@/services/llm/errors'
import { classifyLLMError, isSilentContextOverflow } from '@/services/llm/classify'
import { redactSecrets } from '@/services/llm/redact'
import { maybeCompact, runSummarizer, buildSummaryBlock, getContextWindow, DEFAULT_COMPACTION_RATIO } from '@/services/llm/compaction'
import { djb2Hash, toolSignature, rememberRequestSignature, getPreviousSignature, analyzeCacheBreak, recordCacheRead, hasSeenCacheRead } from '@/services/llm/cacheDiagnostics'
import { ToolExecutor, configureToolOutput, configureSecretRedaction } from '@/services/tools'
import { ToolCall, ToolResult } from '@/services/tools/types'
import { writeToolPaths } from '@/services/tools/writePaths'
import { createApprovalPreHook } from './approvalHook'
import { runWithConcurrency } from '@/services/subagents/parallel'
import {
  extractKeywords,
  scoreAgainstKeywords,
  loadWorkspaceKnowledge,
  buildActiveFileRulesBlock,
  retrieveRelevantContext,
  getEditorSelectionContext,
} from '@/services/tools/context'
import { v4 as uuidv4 } from 'uuid'
import { captureCheckpoint as captureCheckpointService } from '@/services/checkpointService'

// Wire the LLM cache toggles to user preferences (lazily evaluated per
// request). Every sendLLMRequest caller — chat, agent loop, arena, subagents,
// inline completion, lifeguard — benefits without each knowing the prefs.
configureLLMCache({
  responseCacheEnabled: () => useEditorStore.getState().preferences.llmResponseCache,
  anthropicPromptCacheEnabled: () => useEditorStore.getState().preferences.anthropicPromptCache,
  anthropicPromptCache1hEnabled: () => !!useEditorStore.getState().preferences.anthropicPromptCache1h,
})
// Retry transient LLM failures (timeout / network / rate-limit / 5xx) before
// any stream output — same lazy-per-request wiring as the cache toggles.
configureLLMRetry({
  enabled: () => useEditorStore.getState().preferences.llmRetryEnabled !== false,
  maxRetries: () => useEditorStore.getState().preferences.llmRetryMaxRetries ?? 2,
})
// Tool-output truncation limits — every ToolExecutor instance (main agent loop
// + subagents) shares the user's configured caps.
configureToolOutput(() => ({
  maxChars: useEditorStore.getState().preferences.toolOutputMaxChars,
  maxLines: useEditorStore.getState().preferences.toolOutputMaxLines,
}))
// Secret redaction for tool-error text / usage telemetry — always mask the
// currently-active group's key & header values (lazy so it tracks the group
// the user actually switches to; the request path is redacted separately).
configureSecretRedaction(() => {
  const group = useConfigStore.getState().getActiveConfigGroup()
  return group
    ? { apiKey: group.apiKey, baseUrl: group.baseUrl, customHeaders: group.customHeaders }
    : undefined
})

// Cached git info (refreshed via refreshGitBranch)
let _cachedGitBranch = ''
let _cachedGitStatus: string[] = []
let _cachedGitLog: string[] = []
let _gitBranchFetchedAt = 0

/** Minimum interval between git fetches (ms). Avoids redundant `git` calls
 *  when multiple consumers request git context within a short window. */
const GIT_CACHE_TTL = 5_000

/** Minimum interval between streaming store flushes (ms). LLM SSE streams can
 *  emit dozens of chunks per second; without throttling every token triggers a
 *  zustand set → the whole conversation re-renders and the growing markdown
 *  answer is re-parsed (marked + highlight.js + DOMPurify) on every token.
 *  Flushing at ~20fps is imperceptible for chat text but cuts the render and
 *  parse budget by an order of magnitude. */
const STREAM_FLUSH_MS = 50

/** localStorage key for the last active chat session (restored on next launch).
 *  按窗口模式区分 key —— 对话窗口与一人公司窗口各自恢复各自的最后会话。 */
const LAST_SESSION_KEY = modeKey('lastActiveSessionId')

/** localStorage key that carries the user's last project edit mode (完全访问
 *  etc.) over to newly created sessions and NEW WINDOWS — the same cross-restart
 *  pattern as the last-model persistence in configStore. */
const LAST_PROJECT_EDIT_MODE_KEY = 'lastProjectEditMode'

/** Last project edit mode chosen by the user (手动确认/完全访问/自动编辑/计划). */
function getLastProjectEditMode(): 'confirm_before_change' | 'auto_edit' | 'plan' | 'full_access' | null {
  try {
    const v = localStorage.getItem(LAST_PROJECT_EDIT_MODE_KEY)
    return v === 'confirm_before_change' || v === 'auto_edit' || v === 'plan' || v === 'full_access' ? v : null
  } catch {
    return null
  }
}

/** Default title of a brand-new session — replaced by an auto-generated title
 *  after the first message, and never overwritten once the user renames. */
export const DEFAULT_SESSION_TITLE = '新对话'

/** 从未使用的"幽灵会话"：没有消息、标题仍是默认的"新对话"、且未置顶/归档。
 *  新建后啥也不干的空对话不应出现在任何会话列表里（首条消息发出后才算真正的
 *  会话，进入列表并持久化）——否则"新建对话"会堆积一堆空白会话。 */
export function isGhostSession(s: Pick<ChatSession, 'messages' | 'title' | 'pinnedAt' | 'archivedAt'>): boolean {
  return (
    s.messages.length === 0 &&
    (!s.title || s.title === DEFAULT_SESSION_TITLE) &&
    !s.pinnedAt &&
    !s.archivedAt
  )
}

/** Derive a concise conversation title from the first user message: first
 *  non-empty line, stripped of markdown-ish prefixes, capped at 30 chars.
 *  Exported for unit tests. */
export function generateSessionTitle(content: string): string {
  const firstLine = content.split('\n').map((l) => l.trim()).find(Boolean) || content.trim()
  const cleaned = firstLine.replace(/^[#>*-`~]+/, '').trim() || firstLine
  const MAX_TITLE_LEN = 30
  return cleaned.length > MAX_TITLE_LEN ? cleaned.slice(0, MAX_TITLE_LEN) + '…' : cleaned
}

/** System prompt for the AI-summarized conversation title (first user message) */
const TITLE_SYSTEM_PROMPT = `你是对话标题生成器。根据用户的第一条消息，用与消息相同的语言生成一个简洁的对话标题。
要求：
- 不超过 15 个字符
- 概括消息的主题或意图，不要复述原文
- 不要引号、书名号、句号等标点符号
- 只输出标题本身，不要任何解释或前缀`

/**
 * Ask the model to summarize a short title from the first user message.
 * Non-streaming with a bounded output; returns '' on any failure (no API
 * config, provider error, empty reply) so callers fall back to the heuristic.
 * Exported for unit tests.
 */
export async function generateAiSessionTitle(userContent: string, preferredModel?: string, configGroupId?: string): Promise<string> {
  try {
    // 取会话自己的配置组（preferredModel 通常来自该会话）——用活动组会把
    // 会话组 B 的模型名发到活动组 A 的端点 → 400 "Unsupported model"。
    const group = useConfigStore.getState().getConfigGroupFor(configGroupId)
    if (!group) return ''
    const model = (preferredModel || group.defaultModel || '').trim()
    if (!model) return ''
    let title = ''
    for await (const chunk of sendLLMRequest(
      {
        model,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        stream: false,
        temperature: 0,
        maxTokens: 50,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
      },
      group,
      15_000,
    )) {
      if (chunk.content) title += chunk.content
      if (chunk.done) break
    }
    // Defensive cleanup: strip wrapping quotes/braces, cap the length.
    return title.trim().replace(/^[\s"'「『【《]+|[\s"'」』】》]+$/g, '').slice(0, 30)
  } catch {
    return ''
  }
}

export async function refreshGitBranch(): Promise<void> {
  const rootPath = getWorkspaceRoot()
  if (!rootPath) return

  // Skip re-fetch when the cache is still fresh (e.g. multiple consumers
  // requesting git context within the same short window).
  if (_gitBranchFetchedAt > 0 && Date.now() - _gitBranchFetchedAt < GIT_CACHE_TTL) return
  // Mark as fetched before the git calls so even a full failure (e.g. not a
  // repo) doesn't cause repeated retries within the TTL window.
  _gitBranchFetchedAt = Date.now()
  try {
    const res = await (window as any).electronAPI?.gitExec(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (res?.success) {
      _cachedGitBranch = res.output.trim()
    }
  } catch { /* ignore */ }
  try {
    // Working-tree changes (porcelain v1, capped) so the model knows the
    // workspace state without running a command itself.
    const statusRes = await (window as any).electronAPI?.gitExec(rootPath, ['status', '--porcelain=v1'])
    if (statusRes?.success) {
      // Porcelain v1 lines are "XY path" — leading space is the staged-column
      // char, so only strip trailing whitespace, never the leading state.
      _cachedGitStatus = statusRes.output.split('\n').map((l: string) => l.trimEnd()).filter(Boolean).slice(0, 30)
    } else {
      // git unavailable / not a repo — never surface stale workspace state
      _cachedGitStatus = []
    }
  } catch { _cachedGitStatus = [] }
  try {
    // Recent commit headlines for context
    const logRes = await (window as any).electronAPI?.gitExec(rootPath, ['log', '--oneline', '-5'])
    if (logRes?.success) {
      _cachedGitLog = logRes.output.split('\n').map((l: string) => l.trimEnd()).filter(Boolean).slice(0, 5)
    } else {
      _cachedGitLog = []
    }
  } catch { _cachedGitLog = [] }
}

// Auto-refresh git branch every 30s when module is active
let _gitBranchInterval: ReturnType<typeof setInterval> | null = null
_gitBranchInterval = setInterval(() => { if (Date.now() - _gitBranchFetchedAt > 30000) refreshGitBranch() }, 30000)

/** Stop git branch polling (for cleanup) */
export function stopGitBranchPolling(): void {
  if (_gitBranchInterval) {
    clearInterval(_gitBranchInterval)
    _gitBranchInterval = null
  }
}

/** The "current project" follows the ACTIVE SESSION — the project the active
 *  conversation is bound to (captured at creation). Opening a folder or
 *  entering a project in the sidebar file tree only browses it; only a session
 *  makes a project current (creating a conversation in it, or activating one
 *  that belongs to it). */
export function getCurrentProjectPath(): string | null {
  return useChatStore.getState().getActiveSession()?.projectPath ?? null
}

function getWorkspaceRoot(): string {
  // The workspace follows the current project (= the active session's bound
  // project), NOT whichever folder is being browsed in the sidebar file tree.
  // The tree only mounts in tree view — fall back to the browsed folder so
  // agent mode keeps working when the sidebar is on the project list (or
  // hidden) without a mounted tree.
  return getCurrentProjectPath() || document.getElementById('file-tree-root')?.getAttribute('data-root-path') || useUIStore.getState().rootPath || ''
}

/** Build enhanced system prompt with workspace context */
function buildEnhancedSystemPrompt(basePrompt: string, projectPath?: string): string {
  const rootPath = projectPath || getWorkspaceRoot()
  const editorState = useEditorStore.getState()
  const activeFile = editorState.openFiles.find((f) => f.path === editorState.activeFilePath)

  let enhanced = basePrompt

  // Resolve template variables
  const currentFileName = activeFile?.path.split(/[/\\]/).pop() || ''
  const fileExt = currentFileName.split('.').pop() || ''
  const languageMap: Record<string, string> = {
    js: 'JavaScript', jsx: 'JavaScript (React)', ts: 'TypeScript', tsx: 'TypeScript (React)',
    py: 'Python', rb: 'Ruby', java: 'Java', go: 'Go', rs: 'Rust', c: 'C', cpp: 'C++',
    cs: 'C#', php: 'PHP', swift: 'Swift', kt: 'Kotlin', html: 'HTML', css: 'CSS',
    scss: 'SCSS', json: 'JSON', yaml: 'YAML', md: 'Markdown', sql: 'SQL', sh: 'Shell',
  }
  const language = languageMap[fileExt] || fileExt || '未知'
  const projectName = rootPath.split(/[/\\]/).pop() || '未知项目'
  const frameworkMap: Record<string, string> = { tsx: 'React', jsx: 'React', vue: 'Vue', svelte: 'Svelte' }
  const framework = frameworkMap[fileExt] || '未知框架'

  enhanced = enhanced
    .replace(/\{\{language\}\}/g, language)
    .replace(/\{\{framework\}\}/g, framework)
    .replace(/\{\{projectName\}\}/g, projectName)
    .replace(/\{\{currentFile\}\}/g, currentFileName || '无')
    .replace(/\{\{gitBranch\}\}/g, _cachedGitBranch || '(未检测到Git分支)')
    .replace(/\{\{date\}\}/g, new Date().toLocaleDateString())

  return enhanced
}

/** Per-turn environment block (dynamic: date + git branch + working-tree
 *  state) — kept OUT of the stable system prompt so the prompt prefix stays
 *  byte-identical across turns and provider prefix caches keep hitting. */
function buildEnvironmentBlock(projectPath?: string): string {
  const rootPath = projectPath || getWorkspaceRoot()
  let block = `\n\n<environment>
工作区路径: ${rootPath}
平台: ${navigator.platform}
当前日期: ${new Date().toLocaleDateString()}
Git 分支: ${_cachedGitBranch || '未知'}`
  if (_cachedGitStatus.length > 0) {
    block += `\n工作区改动 (${_cachedGitStatus.length} 项):\n` + _cachedGitStatus.map((l) => `- ${l}`).join('\n')
  }
  if (_cachedGitLog.length > 0) {
    block += `\n最近提交:\n` + _cachedGitLog.map((l) => `- ${l}`).join('\n')
  }
  return block + `\n</environment>`
}

/** Per-turn open-files list (dynamic editor state). */
function buildOpenFilesBlock(): string {
  const editorState = useEditorStore.getState()
  if (editorState.openFiles.length === 0) return ''
  let block = `\n\n<open_files>`
  for (const file of editorState.openFiles) {
    block += `\n- ${file.path}${file.isDirty ? ' (未保存)' : ''}`
  }
  return block + `\n</open_files>`
}

/** Per-turn current file content, live from the editor model. */
function buildCurrentFileBlock(): string {
  const editorState = useEditorStore.getState()
  const activeFile = editorState.openFiles.find((f) => f.path === editorState.activeFilePath)
  if (!activeFile) return ''
  const liveContent = getFileContent(activeFile.path, activeFile.content)
  const lines = liveContent.split('\n')
  const truncated = lines.length > 200
  const content = truncated ? lines.slice(0, 200).join('\n') + '\n... (truncated)' : liveContent
  return `\n\n<current_file path="${activeFile.path}">\n${content}\n</current_file>`
}

/** Inject matching persistent memories into the system prompt */
async function buildMemoriesBlock(userContent: string): Promise<string> {
  const memories = useMemoryStore.getState().memories
  if (!memories.length) return ''
  const keywords = extractKeywords(userContent)
  const activeFile = useEditorStore.getState().openFiles.find((f) => f.path === useEditorStore.getState().activeFilePath)
  if (activeFile) {
    const name = activeFile.path.split(/[/\\]/).pop() || ''
    if (name) keywords.push(name.toLowerCase())
  }
  const scored = memories
    .map((m) => ({ m, s: scoreAgainstKeywords(m.content, keywords) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
  if (scored.length === 0) return ''
  return `\n\n<user_memories>\n关于用户的长期记忆（请在实际编码时遵循）：\n${scored.map((x) => `- ${x.m.content}`).join('\n')}\n</user_memories>`
}

/**
 * Assemble the system prompt as two parts for cache friendliness:
 *  - `stable`: base + template vars + workspace knowledge — byte-identical
 *    across turns, so provider prefix caches (OpenAI / DeepSeek / Anthropic)
 *    keep hitting on the shared conversation prefix.
 *  - `dynamic`: per-turn context (env / open files / current file / editor
 *    selection / memories / retrieved files) — merged into the request's final
 *    user message so it never invalidates the stable prefix.
 */
async function buildSystemPrompt(
  basePrompt: string,
  userContent: string,
  contextFiles: string[],
  projectPath?: string,
  skipAutoRetrieval = false,
): Promise<{ stable: string; dynamic: string }> {
  // The prompt's workspace context is always the SESSION's own project — never
  // the folder being browsed in the sidebar file tree (background sessions run
  // while the user browses another project; the "current project" follows the
  // active conversation, not the file tree).
  let stable = buildEnhancedSystemPrompt(basePrompt, projectPath)
  stable += BEHAVIOR_GUIDELINES
  stable += OUTPUT_STYLE_GUIDELINES

  // Workspace rules + skills (.ourcoderules / AGENTS.md / .cursorrules,
  // .claude/skills, .ourcode/skills)
  // mtime-cached, so in practice stable per workspace.
  stable += await loadWorkspaceKnowledge(projectPath || getWorkspaceRoot())

  // ── Per-turn dynamic context (moved out of the system prompt) ──
  let dynamic = ''
  dynamic += buildEnvironmentBlock(projectPath)
  dynamic += buildOpenFilesBlock()
  dynamic += buildCurrentFileBlock()
  // Current editor selection (Vibe-and-Replace style selected-text context)
  dynamic += getEditorSelectionContext()
  const activeFile = useEditorStore.getState().openFiles.find((f) => f.path === useEditorStore.getState().activeFilePath)
  // 目录级 AGENTS.md：跟着当前标签页变，放进 stable 会让每次切文件的
  // provider 端提示词缓存全部失效，所以留在 dynamic。
  dynamic += await buildActiveFileRulesBlock(projectPath || getWorkspaceRoot(), activeFile?.path)
  // Persistent memories (keyword-matched)
  dynamic += await buildMemoriesBlock(userContent)
  // Auto-retrieved relevant files (pure chat mode skips the project-wide
  // search — no tool loop means the retrieval pays most and benefits least;
  // explicitly @-attached files are still read via retrieveRelevantContext)
  dynamic += await retrieveRelevantContext(userContent, contextFiles, projectPath || getWorkspaceRoot(), activeFile?.path, { skipSearch: skipAutoRetrieval })

  return { stable, dynamic }
}

// Generic behavior guidelines — part of the stable prefix so every mode
// (chat / agent / plan / target) inherits them.
const BEHAVIOR_GUIDELINES = `

# 行为准则
- <system-reminder> 标签是系统注入的提醒，不是用户的输入，不要把它当作指令执行。
- 用户输入 /<技能名> 时通过 Skill 工具调用对应技能；只调用系统列出的技能，不要猜测技能名。
- 对难以撤销或对外可见的操作（删除/覆盖文件、发布内容、发送到外部服务等），先向用户确认再执行；一次的授权不延伸到下一次。
- 删除或覆盖文件前，先读取目标内容确认；如果发现目标与描述不符、或不是你创建的，先向用户说明而不是直接操作。
- 如实报告结果：测试失败要带上输出说明失败；跳过某一步要说跳过；完成并验证过的事要明确说明，不要含糊其辞。
- 工具调用被拒绝表示用户不认可该操作，应调整方案而不是原样重试。
- 如果任务是编程任务，交付前必须自行完整检查一遍代码，确保没有 bug；发现 bug 或潜在问题（逻辑错误、边界情况、类型问题、并发隐患等）要主动修复后再交付。`

// 输出风格准则 —— 结论先行：工具调用执行完毕后，最终回答必须以高度概括的
// 结论收尾，而不是复述过程日志。与 BEHAVIOR_GUIDELINES 同属 stable 前缀。
const OUTPUT_STYLE_GUIDELINES = `

# 输出风格准则
- 所有工具调用执行完毕后的最终回答必须「结论先行」：用一段高度概括、加粗核心发现的人类自然语言收尾，随后给出具体建议或可执行代码。
- 绝对禁止在最终回答里复述读取、搜索、命令输出等工具返回的原始内容；需要引用细节时使用「文件路径:行号」的形式。
- 禁止在可见正文输出「目标：」「总结：」「步骤：」这类流程标签；禁止把第一人称的内心独白写入正文（例如 "Let's check..."、"I think..."、"Let me assume..."、"我需要先看看…"）。思考与决策过程只放在内部，不写入用户可见的回答。
- 最终回答直接面向用户：一句话说明你做了什么与发现了什么，然后给出结论、建议或可执行代码；不要复述接下来要执行的动作。
- 回答使用易读的 Markdown：列表、表格、清晰的标题层级；代码块必须标注语言（如 \`\`\`typescript），涉及变更时用 \`\`\`diff 展示新增/删除。
- 计划模式下以 submit_plan 提交的计划为准，无需在提交前额外输出长篇总结。`

// Plan-mode prompt: explore + produce a plan, no mutations
const PLAN_MODE_INSTRUCTION = `

你当前处于「计划模式」。在做出任何修改之前，你必须先制定并提交一份清晰的实施计划。
规则：
- 你可以使用只读工具（读取文件、列出目录、搜索文件、搜索内容、Web 搜索、读取 URL）来调研代码库。
- 不要调用任何会修改文件、删除文件、创建目录或执行命令的工具。
- 调研完成后，调用 submit_plan 提交你的分步实施计划。
- 如果信息不足或任务有歧义，可以调用 ask_user_question 向用户提问。
- 也可以调用 manage_todo 维护任务列表。`

const PLAN_APPROVED_PREFIX = `用户已批准以下计划，现在开始执行。请严格按计划逐步完成，并在执行过程中用 manage_todo 维护任务列表。计划内容：\n`

// Agent-mode prompt: 直接动手（Claude Code / opencode 风格）。规划只发生在
// 用户主动进入计划模式时；agent 模式默认动作导向——先调研再实现再验证，
// 用 manage_todo 跟踪进度，而不是先提交计划等待批准。
const AGENT_MODE_INSTRUCTION = `

你当前处于「Agent 模式」。你可以自主完成编码任务。
规则：
- 用搜索/读取工具理解代码库后直接动手实现，不要为规划而规划；需要多步推进的任务用 manage_todo 维护任务列表，让用户看到进度。
- 完成修改后用项目现有的测试 / lint / typecheck 脚本验证（存在的话）。
- 有专用工具时禁止用 run_command 绕过：git 操作一律用 git_status / git_diff / git_add / git_commit / git_push / git_split_commit，文件操作一律用 read_file / write_file / edit_file / search_in_files。禁止为一次性的 git 操作编写或调试脚本。
- 用 run_command 时记住：Windows 上是 PowerShell，赋值用 $env:NAME=... 而不是 set NAME=...，没有 &&（连续执行分多次调用）。构建/测试/类型检查等长命令默认 30 秒超时会被中断——调用时要设 timeoutMs（如 120000）。若命令仍返回 [超时]，说明它需要更长时间，直接用更大的 timeoutMs 重试一次或换一种验证方式（如只构建相关模块），不要通过加内存参数、换 shell、重装依赖等方式反复折腾同一命令。
- 不会自己退出的进程（dev server、watch、需要应答的安装）必须用 run_command 的 background=true 在集成终端里启动：它立即返回 terminalId，之后用 read_terminal_output 读输出（没就绪就隔几秒再读，不要密集轮询），用 stop_terminal 收尾；任务收尾时把你启动的进程停掉，或明确告诉用户它还在运行。
- 提交前先 git_status + git_diff 确认改动范围；按功能拆分提交时用 git_add 逐组暂存 + git_commit，或 git_split_commit 一次完成分组提交；commit message 遵循仓库风格（feat:/fix:/refactor: 前缀）。
- 工具结果可能被系统压缩清理：重要的信息（文件内容、命令输出、关键结论）及时写入你的可见回复，不要假设之后还能读到原始工具结果。
- 修改文件时用 edit_file 尽量精确，不要破坏无关代码。
- 如果信息不足或任务有歧义，可以调用 ask_user_question 向用户提问。`

/** Map a tool name to its trace category (used for icon rendering) */
function getToolKind(name: string): AgentToolKind {
  if (['read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files'].includes(name)) return 'search'
  if (['web_search', 'read_url'].includes(name)) return 'fetch'
  if (['write_file', 'edit_file', 'multi_edit_file', 'create_directory', 'delete_file'].includes(name)) return 'edit'
  if (['run_command', 'git_split_commit', 'stop_terminal'].includes(name)) return 'execute'
  if (name === 'read_terminal_output') return 'search'
  if (name === 'submit_plan') return 'switch_mode'
  if (name === 'ask_user_question') return 'ask'
  return 'other'
}

/** Short human-readable summary of a tool call for the trace list */
function summarizeToolCall(tc: ToolCall): string {
  const a = tc.arguments || {}
  if (['read_file', 'write_file', 'delete_file', 'list_directory', 'get_directory_tree', 'create_directory', 'edit_file'].includes(tc.name)) {
    return String(a.path || a.filePath || a.directory || '')
  }
  if (tc.name === 'read_multiple_files') {
    const paths = Array.isArray(a.paths) ? a.paths.map(String) : []
    return paths.length > 1 ? `${paths.length} files` : String(paths[0] || '')
  }
  if (tc.name === 'multi_edit_file') {
    const edits = Array.isArray(a.edits) ? a.edits : []
    return `${edits.length} edits`
  }
  if (tc.name === 'run_command') return String(a.command || a.cmd || '')
  if (tc.name === 'read_terminal_output' || tc.name === 'stop_terminal') return String(a.terminalId || '(最近一次后台会话)')
  if (['search_files', 'web_search'].includes(tc.name)) return String(a.query || '')
  if (tc.name === 'search_in_files') return String(a.pattern || a.query || '')
  if (tc.name === 'read_url') return String(a.url || '')
  if (tc.name === 'manage_todo') return String(a.action || a.content || '')
  if (tc.name === 'submit_plan') return String(a.title || '')
  if (tc.name === 'ask_user_question') return String(a.question || '')
  if (tc.name === 'send_message') return String(a.targetSessionId || a.targetTitle || '')
  if (tc.name === 'list_agents') return String(a.search || '')
  if (tc.name === 'git_split_commit') {
    const groups = Array.isArray(a.groups) ? a.groups : []
    return `${groups.length} 组: ${groups.map((g: any) => String(g?.message || '').split(':')[0] || '').filter(Boolean).join(' / ')}`
  }
  return tc.name
}

/** Normalize raw manage_todo input into TodoItem[] — validates the status
 *  enum and enforces at most one in_progress (the first one wins; the rest are
 *  demoted to pending — never completed, so no work is misreported as done). */
export function normalizeTodos(raw: unknown): TodoItem[] {
  let seenInProgress = false
  return (Array.isArray(raw) ? raw : [])
    .map((t: any, i: number) => {
      let status = (['pending', 'in_progress', 'completed', 'failed'].includes(t?.status) ? t?.status : 'pending') as TodoItem['status']
      if (status === 'in_progress') {
        if (seenInProgress) status = 'pending'
        else seenInProgress = true
      }
      return {
        id: t?.id || uuidv4(),
        content: String(t?.content || ''),
        status,
        order: i,
      }
    })
}

/** Parse a streamed tool call's arguments. `ok` is false when the JSON is
 *  incomplete — which happens when the response hits max_tokens mid-call. */
export function parseToolArguments(raw: string | undefined): { args: Record<string, any>; ok: boolean } {
  if (!raw) return { args: {}, ok: true }
  try {
    const parsed = JSON.parse(raw)
    return { args: parsed && typeof parsed === 'object' ? parsed : {}, ok: true }
  } catch {
    return { args: {}, ok: false }
  }
}

/** Object keys are sorted so two calls that differ only in key order — which
 *  streamed providers do freely — compare equal. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(value)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
    .join(',') + '}'
}

export function toolCallSignature(tc: ToolCall): string {
  return tc.name + '|' + stableStringify(tc.arguments ?? {})
}

// Tools allowed in plan mode (read-only + agent-control)
const PLAN_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files',
  'web_search', 'read_url', 'manage_todo', 'submit_plan', 'ask_user_question', 'list_agents',
  // 原生只读 git 工具 — 计划模式也应能查看仓库状态（Claude Code 风格：
  // 提交前先 git_status / git_diff 探查，再提交计划）
  'git_status', 'git_diff', 'git_log', 'git_branch',
])

// Write tools get a checkpoint snapshot before they run
const CHECKPOINT_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory', 'multi_edit_file'])

// ── 目标模式监管 Agent 工具硬约束（v2 多 Agent 协作）────────────────────────
// 提示词只说「监管不直接写业务代码」，弱模型会无视并自己 npm install / 改码
// （团队看板全 IDLE、supervisor.md 无派发记录）。这里是工具层硬约束：
// 1) 下列工具对监管直接隐藏（不出现在 toolDefinitions）；
// 2) runAgentLoop 里再挂 guard 兜底（模型幻觉调用时返回引导性错误，
//    教它改用 run_subagent 派发），guard 只作用于监管会话本身——
//    子 Agent 用独立 executor 实例，不受影响。
// 监管保留：读/搜/web/git 只读/manage_todo/ask/run_subagent 等；
// write_file / create_directory / delete_file 仅限 .ourcode/targemode/ 下的文档。
const TARGET_MODE_SUPERVISOR_DENIED = new Set([
  'run_command',            // 安装/构建/测试命令 → tm-developer / tm-tester
  'edit_file',              // 业务代码修改 → tm-developer / tm-ui-developer
  'multi_edit_file',
  'git_add', 'git_commit', 'git_push', 'git_split_commit', // 变更类 git 操作不归监管
])

/** 监管可写路径门禁：仅允许目标模式状态目录（规划/状态/日志/信封文档）。 */
function isTargemodePath(p: unknown): boolean {
  const s = String(p || '').replace(/\\/g, '/').toLowerCase()
  return s.includes('.ourcode/targemode/')
}

// 计划模式防空转 — 计划模式只暴露只读工具；当用户请求明显需要写操作/命令
// （提交/推送/安装/执行…）而 agent 连续多轮纯只读探索（读文件/搜索）且不提交
// 计划时，强制弹一次提问让用户决定，而不是把轮次和 token 烧在空转上
// （参见那次「提交一下项目」会话：20 轮 / 38 次只读调用 / 1.1M token 没提交成）。
const PLAN_MODE_FLAIL_ROUNDS = 5
const FLAIL_READ_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files', 'web_search', 'read_url',
  // 只读 git 探索也算「空转」——否则 agent 可无限 git_status/git_diff 而
  // 不触发防空转（光看状态不提交/不计划 = 没有产出）
  'git_status', 'git_diff', 'git_log', 'git_branch',
])
const WRITE_INTENT_RE = /(git|commit|push|pull|merge|stash|install|run|build|deploy|create|delete|write|edit|remove|提交|推送|拉取|合并|暂存|执行|运行|安装|删除|新建|创建|写入|修改|改动|发布|部署|打包|构建|启动)/i

// Max concurrent run_subagent executions within one tool-call batch
const MAX_PARALLEL_SUBAGENTS = 3
/** 同一批 tool_calls 中普通工具的并发上限（Claude Code / opencode 风格：
 *  无依赖的独立工具调用在同一轮并行执行，如 git_status + git_diff）。 */
const MAX_PARALLEL_TOOLS = 6

// 命令连续失败熔断阈值：同一 run_command 连续失败/超时达到此数即停下提问。
// 防的是 agent 把超时误判成环境问题后无限换姿势自救（曾见 build 超时被当成
// 构建环境坏了，反复加内存/重装依赖/换 shell 调试 6 分钟）。每个 run 只问一次。
const COMMAND_FAIL_BREAK_ROUNDS = 2

// 打转守卫 — 模型反复用完全相同的参数调用同一工具时，结果必然相同，继续跑只
// 是烧轮次和 token（曾见反复重读同一文件而不动手）。达到 NUDGE 先在最后一次
// 调用的工具结果尾部追加提醒，达到 HALT 直接停止本 run 并说明原因。
// 提醒写在 tool 结果里而不是插入 user 消息：Anthropic 等 provider 要求
// user/assistant 交替，连续两条 user 会被拒；tool 结果永远合法。
const REPEAT_CALL_NUDGE = 3
const REPEAT_CALL_HALT = 6

/** 守卫的前提是「参数相同 ⇒ 结果相同」，轮询类工具是它的例外：后台进程的
 *  输出会随时间变长，等 dev server 起来本来就要连着读几次。重复调用照样提醒，
 *  但不因为次数到了就把这种等待当成打转停掉。 */
const POLLING_TOOLS = new Set(['read_terminal_output'])

/** Agent 会话默认编辑模式——与 Claude Code 默认一致：直接动手，但改文件前
 *  先征求用户确认。计划模式（plan）改为用户主动选择，不再作为默认。 */
const DEFAULT_PROJECT_EDIT_MODE: 'confirm_before_change' | 'auto_edit' | 'plan' | 'full_access' = 'confirm_before_change'

// Undo stack for message deletion
interface UndoEntry {
  sessionId: string
  messages: ChatMessage[]
  timestamp: number
}

const UNDO_WINDOW_MS = 5000

/** Re-index sortOrder so messages remain dense (0..n-1) */
function reindexMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m, i) => ({ ...m, sortOrder: i }))
}

/** 会话的「用户最近活动」时间：优先最近一次用户发消息的时间；旧数据没有该
 *  字段时回退到 updatedAt（保持兼容，行为与之前一致）。会话列表（左侧项目
 *  列表 / 历史侧栏）一律用此值排序与显示，避免 agent 运行期间 updatedAt 被
 *  频繁刷新导致会话位置一直跳动。 */
export function sessionLastUserActivity(s: ChatSession): number {
  return s.lastUserMessageAt ?? s.updatedAt
}

/** 从会话历史推导「最近用户发消息的时间」（用于旧数据回填） */
function deriveLastUserMessageAt(s: ChatSession): number {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    if (m.role === 'user') return m.createdAt || s.createdAt
  }
  return s.createdAt
}

interface ChatState {
  sessions: ChatSession[]
  activeSessionId: string | null
  /** Sessions currently generating (agent loop active) — one entry per running
   *  session so multiple conversations can run in parallel. Used by the sidebar
   *  for status icons and by ChatMessages/ChatInput to scope streaming state
   *  and the stop button to the session the user is actually viewing. */
  runningSessionIds: string[]
  /** Per-session live streaming text (sessionId → { content, thinking }) */
  streamingBySession: Record<string, { content: string; thinking: string }>
  /** Per-session agent-loop stage (sessionId → { phase, since }). Drives the
   *  "正在…" placeholder in ChatMessages so a silent wait shows what the app
   *  is actually doing (preparing context / compacting / waiting for the
   *  model's first token) instead of a generic codebase-analysis label. */
  runPhaseBySession: Record<string, { phase: AgentRunPhase; since: number; detail?: string }>
  /** Per-session timestamp of the last agent activity (stream chunk / tool
   *  step / approval dialog). The idle "已 X 分钟无响应" indicator reads it. */
  streamLastActivityBySession: Record<string, number>
  /** Per-session AbortController — stopping one conversation must never touch
   *  another (previously a single global controller: switching sessions made
   *  the stop button abort the *other* conversation). */
  abortControllers: Record<string, AbortController>
  undoStack: UndoEntry[]

  // Tool call state — scoped to the owning session; dialogs only render for
  // the session the user is currently viewing
  pendingApproval: { sessionId: string; toolCall: ToolCall; preview: string } | null
  approveToolCall: () => void
  rejectToolCall: () => void

  // Ask-user-question state
  pendingQuestion: (UserQuestion & { sessionId: string }) | null
  answerQuestion: (answer: string) => void

  /** Per-session gate for the ask_user_question dialog — req: don't pop the
   *  modal in the user's face when they're on another session; instead show a
   *  confirm bar when they switch back, and only then reveal the dialog.
   *  'auto'      — question fired while the user was already on the session,
   *                the dialog may show immediately.
   *  'confirm'   — question fired off-session; show the confirm bar when the
   *                user switches to the session (default for off-session).
   *  'dismissed' — user clicked "later"; bar hidden until they leave & re-enter. */
  questionGate: Record<string, 'auto' | 'confirm' | 'dismissed'>
  setQuestionGate: (sessionId: string, gate: 'auto' | 'confirm' | 'dismissed') => void

  // ── Agent run (transient) state — per session (parallel runs) ─────────
  /** Active (or most recent) agent run per session (sessionId → run ref) */
  activeRuns: Record<string, { runId: string; sessionId: string }>
  /** Live tool-execution trace per session */
  agentTraces: Record<string, AgentTraceEntry[]>
  /** Live sub-agent progress per run_subagent tool call (parent toolCallId →
   *  progress). Pushed by subagentRunner, rendered by SubAgentProgressBlock. */
  subagentProgress: Record<string, SubAgentProgress>
  /** Per-session batch-approval flag (true = remaining tools auto-approved) */
  batchApprovedBySession: Record<string, boolean>
  /** Per-project "always allow this tool" allowlist (projectPath → tool names) */
  toolAllowlist: Record<string, string[]>
  /** Pending batch-approval dialog (agent mode: first round with write tools) */
  batchApproval: { sessionId: string; runId: string; tools: ToolCall[]; previews: string[] } | null

  // ── Inline decision dock (docked above the mode bar, replaces popups) ──
  /** Pending regenerate / revert-all confirmation rendered inline in the
   *  conversation panel instead of a popup dialog. */
  inlineConfirm:
    | { type: 'regenerate'; sessionId: string; messageId: string; checkpointIds: string[]; filePaths: string[] }
    | { type: 'revert_all'; sessionId: string; filePaths: string[] }
    | null
  requestRegenerateConfirm: (sessionId: string, messageId: string, checkpointIds: string[], filePaths: string[]) => void
  requestRevertAllConfirm: (sessionId: string, filePaths: string[]) => void
  dismissInlineConfirm: () => void
  /** Revert a single file path in a session — reverts every checkpoint that
   *  snapshotted it; true when all those checkpoints reverted cleanly. */
  revertPathInSession: (sessionId: string, path: string) => Promise<boolean>
  /** Revert a list of file paths; returns ok/failed counts for notifications. */
  revertFilesByPaths: (sessionId: string, paths: string[]) => Promise<{ ok: number; failed: number }>

  // Agent run actions
  startAgentRun: (sessionId: string, task: string, opts?: { resumeRunId?: string }) => void
  setRunStatus: (runId: string, status: AgentRun['status'], patch?: Partial<AgentRun>) => void
  appendTrace: (sessionId: string, entry: AgentTraceEntry) => void
  setTraceStatus: (sessionId: string, toolCallId: string, status: AgentTraceEntry['status']) => void
  /** Merge a partial update into a sub-agent's live progress record (keyed by
   *  the parent run_subagent tool call id). Steps are capped to the newest 100. */
  updateSubagentProgress: (toolCallId: string, patch: Partial<SubAgentProgress>) => void
  finishAgentRun: (sessionId: string, runId: string, status: AgentRun['status'], extra?: { error?: string; tokensIn?: number; tokensOut?: number; requestCount?: number; cacheHits?: number; cacheTokensSaved?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void
  approveBatchRun: (sessionId: string) => void
  decideBatchApproval: (decision: 'confirm' | 'all' | 'reject') => void
  allowToolPermanently: (toolName: string) => void
  loadToolAllowlist: (projectPath: string) => void
  clearToolAllowlist: (projectPath: string) => void
  deleteAgentRun: (sessionId: string, runId: string) => void

  // Queued messages (type while the agent is working) — per session
  queuedMessagesBySession: Record<string, QueuedMessage[]>
  queueMessage: (sessionId: string, content: string, attachments?: MessageAttachment[]) => void
  removeQueuedMessage: (sessionId: string, index: number) => void
  /** "立即发送" — stop the current run so its finally drains the message next,
   *  or send it right away if nothing is running. */
  sendQueuedNow: (sessionId: string, index: number) => void
  clearQueue: (sessionId: string) => void

  // Inbound cross-session messages (send_message tool) awaiting the target
  // session's agent loop; drained in runAgentLoop's finally.
  inboundQueue: Array<{ targetSessionId: string; senderTitle: string; content: string; hold: boolean }>
  /** Deliver a cross-session message into another session's history. hold=true
   *  appends without auto-processing; otherwise the target's agent loop is
   *  triggered when idle (messages arriving mid-run are queued). Returns a
   *  human-readable delivery status for the send_message tool. */
  receiveInboundMessage: (senderTitle: string, targetSessionId: string, message: string, hold?: boolean) => string

  // Checkpoints (AI edit snapshots) for the active session
  checkpoints: Checkpoint[]
  // File paths whose changes have been reverted (display-only, survives restart)
  revertedFiles: string[]
  loadCheckpoints: (sessionId: string) => Promise<void>
  revertCheckpoint: (checkpointId: string) => Promise<{ ok: boolean; restored: number; error?: string } | null>

  // Session management
  loadSessions: () => Promise<void>
  createSession: (configGroupId: string, projectPath?: string) => string
  deleteSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => void
  setActiveSession: (sessionId: string) => void
  getActiveSession: () => ChatSession | undefined
  /** After a project is removed from the list ("从列表中移除"), the active
   *  conversation must not stay bound to it — roll the selection over to the
   *  most recently used conversation of another (non-removed) project, or
   *  clear the selection when no such conversation exists. The removed
   *  project's sessions stay stored and come back when it's re-opened. */
  rollActiveSessionAwayFrom: (projectPath: string) => void

  // Agent mode + plan approval
  setProjectEditMode: (sessionId: string, mode: 'confirm_before_change' | 'auto_edit' | 'plan' | 'full_access') => void
  // Target mode: the agent keeps working autonomously (auto-approve tool calls,
  // auto-continue after rounds are exhausted) until the user stops it.
  setTargetMode: (sessionId: string, enabled: boolean) => void
  /** Current parsed target-mode status (.ourcode/targemode/implementationStatus.md) */
  targetModeStatus: TargetModeStatus | null
  refreshTargetModeStatus: () => Promise<void>
  approvePlan: (sessionId: string, opts?: { autoApprove?: boolean }) => Promise<void>
  dismissPlan: (sessionId: string) => void
  setTodos: (sessionId: string, todos: TodoItem[]) => void
  continueGeneration: (sessionId: string) => Promise<void>

  // Message operations
  addMessage: (sessionId: string, msg: Partial<ChatMessage>) => void
  appendToolResult: (sessionId: string, assistantMsgId: string, result: ToolResult) => void
  editMessage: (sessionId: string, msgId: string, content: string) => void
  deleteMessage: (sessionId: string, msgId: string) => void
  deleteMessages: (sessionId: string, msgIds: string[]) => void
  undoDelete: () => void
  reorderMessages: (sessionId: string, fromIndex: number, toIndex: number) => void
  clearMessages: (sessionId: string) => void

  // Core functionality
  sendMessage: (sessionId: string, content: string, contextFiles?: string[], attachments?: MessageAttachment[]) => Promise<void>
  regenerateFromMessage: (sessionId: string, msgId: string) => Promise<void>
  stopGeneration: (sessionId: string) => void

  // Branch: fork the conversation into a new session (see implementation)
  createBranchFromMessage: (sessionId: string, messageId: string) => void

  // Pin / Archive
  togglePin: (sessionId: string) => void
  toggleArchive: (sessionId: string) => void

  // Import/Export
  exportSession: (sessionId: string, format: 'markdown' | 'json') => string
  importSession: (data: string) => void

  // Persistence
  saveSession: (sessionId: string) => Promise<void>
  updateSessionModel: (sessionId: string, model: string, configGroupId?: string) => void
  updateSessionConfigGroup: (sessionId: string, configGroupId: string) => void
  updateSessionParams: (sessionId: string, params: Partial<ModelParams>) => void
  resetStore: () => void
}

// Token estimation — calibrated toward real provider tokenizers (DeepSeek /
// Claude / GPT). The old formula was ~2–4× over: it counted CJK at 2 tokens/char
// AND double-counted English (englishWords × 1.3 PLUS every char × 0.5), so a
// single agent conversation with a few file reads could show 70–80% of a 200K
// window that the real request never reached.
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[一-鿿]/g) || []).length
  // CJK ≈ 1.2 tokens/char; everything else (English, code, JSON, punctuation,
  // whitespace) ≈ 3.3 chars/token.
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars * 1.2 + otherChars * 0.3)
}

/** A message typed while its session's agent is running. Images ride along so
 *  type-ahead with a screenshot doesn't silently drop the attachment when the
 *  queue drains. */
export interface QueuedMessage {
  content: string
  attachments?: MessageAttachment[]
}

type RequestMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: LLMToolCall[]
  toolCallId?: string
  images?: Array<{ mimeType: string; dataBase64: string }>
}

/** Attachments that can go into a chat request — images only. Other file types
 *  stay as context-file paths; a non-image mime type here means the caller
 *  attached something the providers cannot accept as a content part, so it is
 *  dropped from the request (it still shows in the transcript). */
export function toRequestImages(
  attachments: ChatMessage['attachments']
): RequestMessage['images'] | undefined {
  const images = (attachments || [])
    .filter((a) => a.dataBase64 && a.mimeType.startsWith('image/'))
    .map((a) => ({ mimeType: a.mimeType, dataBase64: a.dataBase64 }))
  return images.length ? images : undefined
}

/**
 * Agent 循环的历史压缩 — 每轮 LLM 请求都会把此前所有工具结果（read_file
 * 全文、search 结果等）原样重发给模型，轮数一多输入 token 呈平方级增长
 * （一个 20 轮的任务总输入 ≈ Σ 每轮全量历史，轻松到 1M+）。
 *
 * 主流工具（Cursor/Windsurf/Claude Code）的做法是只保留最近几轮工具结果，
 * 更早的压缩成一行提示。这里不删除任何消息（保住 tool 配对的完整性），
 * 只把「较早的、体积大的」tool 消息内容替换成简短提示；模型需要细节时
 * 自然会重新 read_file。UI 里持久化的会话消息不受影响（只改请求数组）。
 */
// 工具结果压缩——兜底安全网，不是主动参与者。实验证明阈值设太低
// （1500 字符）会把模型的工作集压掉：单文件 git diff（0.5-9KB）和普通
// read_file 结果一掉出最近 N 条就被替换成占位符，模型看不到内容只能
// 重读，重读又产生新结果把旧的挤出窗口——轮次不减反增（实测 git_diff
// 被重复调用 5 次）。因此：只保留最近 10 条完整结果、只压缩 >12KB 的
// 真正大输出（整库 diff、超大文件读取、海量命令输出）；常规 diff 和
// 文件读取保持可见。上下文增长的根因是轮数（已靠「直接动手 + 按功能
// 提交」压到 ~20 轮），不是结果体积。
const MAX_UNCOMPACTED_TOOL_RESULTS = 10
const COMPACT_TOOL_RESULT_THRESHOLD = 12000 // 字符
/** Head preview kept when an old oversized tool result is compacted — the file
 *  path header + first lines so the model still knows what it was. The notice
 *  points at precise retrieval instead of re-running the tool (the old
 *  "重新调用对应工具读取" induced the re-read loop on long runs). */
const COMPACTED_TOOL_PREVIEW_CHARS = 500

/** Build the compacted form of an oversized tool result: a short head preview
 *  plus a notice that steers the model to paged reads instead of re-running. */
function buildCompactedToolResult(content: string): string {
  const head = content.slice(0, COMPACTED_TOOL_PREVIEW_CHARS)
  return `${head}\n\n[…该工具结果较长（共 ${content.length} 字符），后续内容已压缩以节省上下文。需要完整内容时，用 read_file 按 startLine/endLine 分页读取或 search_in_files 定向检索，不要整体重读。]`
}

/**
 * Estimate a stored conversation's FULL history size the way the live request
 * would see it — old oversized tool results are compacted to a short preview +
 * note just like `compactToolResults` does on the request path. Used by the
 * context warning banner + status bar so the displayed "已使用 X%" reflects
 * what the model actually receives, not the raw (pre-compaction) history.
 */
export function estimateSessionHistoryTokens(messages: Array<{ role: string; content: string }>): number {
  const totalTools = messages.filter((m) => m.role === 'tool').length
  let seen = 0
  let sum = 0
  for (const m of messages) {
    if (m.role === 'tool') {
      seen++
      // Mirror compactToolResults: only compact OLD oversized results (10 most
      // recent kept verbatim); the compacted preview + notice is estimated at
      // its real (bounded) size so the banner matches the request.
      const fromBack = totalTools - seen + 1
      const len = m.content?.length || 0
      sum += fromBack > MAX_UNCOMPACTED_TOOL_RESULTS && len > COMPACT_TOOL_RESULT_THRESHOLD
        ? estimateTokens(buildCompactedToolResult(m.content || ''))
        : estimateTokens(m.content || '')
    } else {
      sum += estimateTokens(m.content || '')
    }
  }
  return sum
}

/**
 * Estimate the context window a session occupies — REAL token usage from the
 * last API response (input + cache + output, provider-aware) as the baseline,
 * plus a rough estimate for messages added since (Claude Code's
 * tokenCountWithEstimation pattern). This is what the "已使用 X%" indicator
 * shows: the baseline is exact (billing-accurate), only the delta is estimated.
 * Falls back to pure estimation when no real usage has been recorded yet.
 */
export function estimateContextTokens(session: {
  lastContextTokens?: number
  lastContextMessageCount?: number
  summary?: string
  summaryMessageCount?: number
  messages: Array<{ role: string; content: string }>
}): number {
  const baseCount = session.lastContextMessageCount ?? 0
  const baseline = session.lastContextTokens
  if (baseline == null || baseline <= 0 || baseCount <= 0) {
    // Compaction-aware fallback: the request view is [summary + messages after
    // the compaction boundary], not the raw full history — count exactly that.
    const summarized = Math.min(session.summaryMessageCount ?? 0, session.messages.length)
    const anchor = session.summary ? estimateTokens(buildSummaryBlock(session.summary)) : 0
    return anchor + estimateSessionHistoryTokens(session.messages.slice(summarized))
  }
  // History edits (opt-in) may have deleted messages below the baseline count —
  // clamp so the delta can't go negative; the baseline then slightly
  // over-counts until the next request refreshes it.
  const added = session.messages.slice(Math.min(baseCount, session.messages.length))
  return baseline + estimateSessionHistoryTokens(added)
}

/** Exported for unit tests. */
export function compactToolResults(messages: RequestMessage[]): RequestMessage[] {
  const totalTools = messages.filter((m) => m.role === 'tool').length
  let seen = 0
  return messages.map((m) => {
    if (m.role !== 'tool') return m
    seen++
    // 从前往后第 seen 条，其「从后往前」位置 = totalTools - seen + 1。
    // 只压缩位置超过 MAX_UNCOMPACTED_TOOL_RESULTS（即较早）的超长结果；
    // 消息本身全部保留，tool 配对完整。
    const fromBack = totalTools - seen + 1
    if (fromBack > MAX_UNCOMPACTED_TOOL_RESULTS && m.content && m.content.length > COMPACT_TOOL_RESULT_THRESHOLD) {
      return {
        ...m,
        content: buildCompactedToolResult(m.content),
      }
    }
    return m
  })
}

/**
 * Context-window management: if the full history's token estimate exceeds the
 * model's budget (80% of its context window — headroom for the reply), drop the
 * oldest messages while always keeping the system prompt and the newest message
 * (the current user turn). A truncation notice is inserted so the model knows
 * earlier context was cut. Exported for unit tests.
 */
export function trimHistoryForContext(messages: RequestMessage[], modelId: string): RequestMessage[] {
  const contextWindow = getContextWindow(modelId)
  const budget = Math.floor(contextWindow * 0.8)
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  if (total <= budget) return messages

  const trimmed = [...messages]
  let removed = 0
  // Never drop the system message (index 0) or the newest message (current turn)
  while (
    trimmed.length > 2
    && trimmed.reduce((sum, m) => sum + estimateTokens(m.content), 0) > budget
  ) {
    trimmed.splice(1, 1)
    removed++
  }
  if (removed > 0) {
    trimmed.splice(1, 0, {
      role: 'system',
      content: `[上下文管理] 为适配模型上下文窗口，较早的 ${removed} 条消息已省略。如需更早的上下文请明确说明。`,
    })
  }
  return trimmed
}

/**
 * Restore the API's tool-call pairing invariant on a rebuilt history: an
 * assistant message that declares tool_calls must be followed by tool messages
 * answering EVERY declared tool_call_id, and a tool message is only valid as
 * the response to such a message. Interrupted runs (stop mid-batch), manual
 * message edits and legacy sessions can leave orphaned halves of a round-trip
 * behind — instead of letting the provider reject the whole request with a 400
 * ("An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'"), strip the unpaired side here. Exported
 * for unit tests.
 */
export function sanitizeToolPairing(messages: RequestMessage[]): RequestMessage[] {
  const out: RequestMessage[] = []
  // The assistant tool_calls round currently being validated: the message, the
  // ids still awaiting a tool response, and the buffered tool responses so far
  // (emitted together with the assistant once every id is answered).
  let round: RequestMessage | null = null
  let roundMissing = new Set<string>()
  let roundTools: RequestMessage[] = []

  const endRound = (strip: boolean) => {
    if (!round) return
    out.push(strip ? { ...round, toolCalls: undefined } : round)
    if (!strip) out.push(...roundTools)
    round = null
    roundMissing = new Set()
    roundTools = []
  }

  for (const m of messages) {
    if (m.role === 'tool') {
      const answersRound = round !== null && !!m.toolCallId && roundMissing.has(m.toolCallId)
      if (!answersRound) {
        // Orphaned tool message — no pending round declares this id (or no
        // round is pending at all). Drop it; a broken pending round has its
        // assistant side stripped so it degrades to a plain (valid) answer.
        if (round) endRound(true)
        continue
      }
      roundMissing.delete(m.toolCallId!)
      roundTools.push(m)
      continue
    }
    // Any non-tool message ends a pending round. If not every declared id got
    // a response the pairing is broken → strip the toolCalls instead of 400-ing.
    if (round) endRound(roundMissing.size > 0)
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      round = m
      roundMissing = new Set(m.toolCalls.map((tc) => tc.id))
      roundTools = []
    } else {
      out.push(m)
    }
  }
  // Assistant tool_calls at the very end with un-answered ids → strip.
  if (round) endRound(roundMissing.size > 0)
  return out
}

/**
 * Convert stored (parsed) tool calls back to the raw LLM wire format.
 * ChatMessage.toolCalls is stored as {id, name, arguments(object)} for the UI,
 * but the LLM adapters (OpenAI/Anthropic) expect {id, type, function:{name, arguments(string)}}.
 * Without this conversion, second-turn history rebuilds crash with "Cannot read properties of undefined".
 */
function toRawToolCalls(toolCalls?: ChatMessage['toolCalls']): LLMToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    },
  }))
}

/** Format a stored plan back into readable text for the approved-plan prompt */
function formatPlanText(planContent: string): string {
  try {
    const plan = JSON.parse(planContent)
    const steps = Array.isArray(plan.steps) ? plan.steps : []
    const lines = steps.map((s: any, i: number) => `${i + 1}. ${s.summary || ''}${s.detail ? ` — ${s.detail}` : ''}`)
    return `${plan.title || '执行计划'}\n${lines.join('\n')}`
  } catch {
    return planContent
  }
}

// Singleton tool executor
const toolExecutor = new ToolExecutor()

/**
 * 已经真正写入过磁盘的会话 id。幽灵会话（0 消息、标题未改、未置顶/归档）默认
 * 不落盘——否则每次开办公室/切换编辑模式/改模型都会在 SQLite 里沉淀一条空白
 * 「新对话」，重启后全部加载回来（office 窗口的启动兜底会话每次都新建一条）。
 * 一旦会话真正保存过一次（首条消息、重命名、置顶…），即使之后清空全部消息
 * 也继续落盘——「删除全部消息」必须跨重启生效，不能因为会话变空而跳过。
 */
const _persistedSessionIds = new Set<string>()

/** 已确认写入磁盘的图片附件（messageId → 该消息附件 id 集合的签名）。agent 每
 *  一轮都会整会话保存一次，而一张截图 base64 就有几百 KB，重复序列化 + 跨 IPC
 *  传输会白白拖慢长任务；首存之后从保存载荷里剥掉，主进程的 UPSERT 用 COALESCE
 *  保留既有副本（附件一旦发出就不会变）。 */
const _durableAttachmentIds = new Map<string, string>()

export function attachmentSignature(msg: Pick<ChatMessage, 'attachments'>): string {
  return (msg.attachments || []).map((a) => a.id).sort().join(',')
}

/** Drop the base64 of attachments already on disk. Returns the same object
 *  (no copy) when the session carries no attachments at all. Exported for tests. */
export function stripDurableAttachments<T extends Pick<ChatSession, 'messages'>>(session: T): T {
  if (!session.messages.some((m) => m.attachments?.length)) return session
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.attachments?.length && _durableAttachmentIds.get(m.id) === attachmentSignature(m)
        ? { ...m, attachments: undefined }
        : m
    ),
  }
}

// Pending approval resolves — keyed by session so parallel conversations can
// each wait on their own dialog without clobbering each other.
const _approvalResolves = new Map<string, (approved: boolean) => void>()
// Pending batch-approval resolves (agent mode)
const _batchResolves = new Map<string, (decision: 'confirm' | 'all' | 'reject') => void>()
// Pending ask-user-question resolves
const _questionResolves = new Map<string, (answer: string) => void>()

// Inbound-delivery guard: reference count of agent-loop chains (re)launched
// per session by receiveInboundMessage / the finally-drain. Each launch
// increments before running, each settled chain decrements. Using a count
// (not a boolean Set) closes the handoff race where a drained loop settles
// (count-- ) while the next loop it just launched is still mid-startup
// (running flag not yet set) — a boolean would briefly report "idle" and
// let a third loop start concurrently.
const _inboundLaunches = new Map<string, number>()

function markInboundLaunch(sessionId: string): void {
  _inboundLaunches.set(sessionId, (_inboundLaunches.get(sessionId) || 0) + 1)
}

function markInboundSettled(sessionId: string): void {
  const next = (_inboundLaunches.get(sessionId) || 1) - 1
  if (next <= 0) _inboundLaunches.delete(sessionId)
  else _inboundLaunches.set(sessionId, next)
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  runningSessionIds: [],
  streamingBySession: {},
  runPhaseBySession: {},
  streamLastActivityBySession: {},
  abortControllers: {},
  undoStack: [],
  pendingApproval: null,
  pendingQuestion: null,
  questionGate: {},
  queuedMessagesBySession: {},
  inboundQueue: [],
  checkpoints: [],
  revertedFiles: [],
  activeRuns: {},
  agentTraces: {},
  subagentProgress: {},
  batchApprovedBySession: {},
  toolAllowlist: {},
  batchApproval: null,
  inlineConfirm: null,
  targetModeStatus: null,

  approveToolCall: () => {
    const { pendingApproval } = get()
    if (pendingApproval) {
      _approvalResolves.get(pendingApproval.sessionId)?.(true)
      _approvalResolves.delete(pendingApproval.sessionId)
      set({ pendingApproval: null })
    }
  },

  rejectToolCall: () => {
    const { pendingApproval } = get()
    if (pendingApproval) {
      _approvalResolves.get(pendingApproval.sessionId)?.(false)
      _approvalResolves.delete(pendingApproval.sessionId)
      set({ pendingApproval: null })
    }
  },

  answerQuestion: (answer) => {
    const { pendingQuestion } = get()
    if (pendingQuestion) {
      _questionResolves.get(pendingQuestion.sessionId)?.(answer)
      _questionResolves.delete(pendingQuestion.sessionId)
    }
    // Clear the per-session gate together with the question itself
    set((s) => {
      const questionGate = { ...s.questionGate }
      if (pendingQuestion) delete questionGate[pendingQuestion.sessionId]
      return { pendingQuestion: null, questionGate }
    })
  },

  setQuestionGate: (sessionId, gate) => set((s) => ({
    questionGate: { ...s.questionGate, [sessionId]: gate },
  })),

  // ───────────── Agent run (transient) state ─────────────

  startAgentRun: (sessionId, task, opts) => {
    const now = Date.now()
    let runId = opts?.resumeRunId
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== sessionId) return sess
        const existing = sess.agentRuns || []
        // Resume an existing run (plan approval / continue): keep its record
        if (runId && existing.find((r) => r.id === runId)) {
          return {
            ...sess,
            agentRuns: existing.map((r) =>
              r.id === runId ? { ...r, status: 'running' } : r
            ),
            updatedAt: now,
          }
        }
        const run: AgentRun = {
          id: uuidv4(),
          task,
          status: 'running',
          startedAt: now,
          toolCallCount: 0,
          fileChangeCount: 0,
          stepCount: 0,
        }
        runId = run.id
        return { ...sess, agentRuns: [run, ...existing].slice(0, 20), updatedAt: now }
      }),
    }))
    const finalRunId = runId
    if (finalRunId) {
      set((s) => ({
        activeRuns: { ...s.activeRuns, [sessionId]: { runId: finalRunId, sessionId } },
        agentTraces: { ...s.agentTraces, [sessionId]: [] },
        batchApprovedBySession: { ...s.batchApprovedBySession, [sessionId]: false },
      }))
    }
  },

  setRunStatus: (runId, status, patch) => {
    const activeRuns = get().activeRuns
    const entry = Object.values(activeRuns).find((e) => e.runId === runId)
    if (!entry) return
    const { sessionId } = entry
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId && sess.agentRuns
          ? {
              ...sess,
              agentRuns: sess.agentRuns.map((r) => (r.id === runId ? { ...r, ...patch, status } : r)),
              updatedAt: Date.now(),
            }
          : sess
      ),
    }))
  },

  appendTrace: (sessionId, entry) => {
    set((s) => ({
      agentTraces: { ...s.agentTraces, [sessionId]: [...(s.agentTraces[sessionId] || []), entry].slice(-200) },
    }))
  },

  setTraceStatus: (sessionId, toolCallId, status) => {
    set((s) => ({
      agentTraces: {
        ...s.agentTraces,
        [sessionId]: (s.agentTraces[sessionId] || []).map((t) => (t.toolCallId === toolCallId ? { ...t, status } : t)),
      },
    }))
  },

  updateSubagentProgress: (toolCallId, patch) => {
    set((s) => {
      const prev = s.subagentProgress[toolCallId]
      const next: SubAgentProgress = prev
        ? { ...prev, ...patch, steps: patch.steps ?? prev.steps }
        : {
            status: 'running',
            sessionId: '',
            name: '',
            task: '',
            startedAt: Date.now(),
            thinking: '',
            steps: [],
            toolCallCount: 0,
            tokenCount: 0,
            ...patch,
          }
      // Keep the transient record bounded (newest 100 steps)
      if (next.steps.length > 100) next.steps = next.steps.slice(-100)
      return { subagentProgress: { ...s.subagentProgress, [toolCallId]: next } }
    })
  },

  finishAgentRun: (sessionId, runId, status, extra) => {
    const trace = get().agentTraces[sessionId] || []
    const session = get().sessions.find((s) => s.id === sessionId)
    const stepCount = session?.todos?.length || 0
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId && sess.agentRuns
          ? {
              ...sess,
              agentRuns: sess.agentRuns.map((r) =>
                r.id === runId
                  ? {
                      ...r,
                      status,
                      finishedAt: Date.now(),
                      toolCallCount: trace.length,
                      fileChangeCount: trace.filter((t) => t.kind === 'edit').length,
                      stepCount,
                      lastError: extra?.error || r.lastError,
                      tokensIn: extra?.tokensIn ?? r.tokensIn,
                      tokensOut: extra?.tokensOut ?? r.tokensOut,
                      requestCount: extra?.requestCount ?? r.requestCount,
                      cacheHits: extra?.cacheHits ?? r.cacheHits,
                      cacheTokensSaved: extra?.cacheTokensSaved ?? r.cacheTokensSaved,
                      cacheReadTokens: extra?.cacheReadTokens ?? r.cacheReadTokens,
                      cacheWriteTokens: extra?.cacheWriteTokens ?? r.cacheWriteTokens,
                    }
                  : r
              ),
              updatedAt: Date.now(),
            }
          : sess
      ),
    }))
    set((s) => ({ batchApprovedBySession: { ...s.batchApprovedBySession, [sessionId]: false } }))
    get().saveSession(sessionId)
  },

  approveBatchRun: (sessionId) => set((s) => ({
    batchApprovedBySession: { ...s.batchApprovedBySession, [sessionId]: true },
    batchApproval: s.batchApproval?.sessionId === sessionId ? null : s.batchApproval,
  })),

  decideBatchApproval: (decision) => {
    const { batchApproval } = get()
    if (batchApproval) {
      _batchResolves.get(batchApproval.sessionId)?.(decision)
      _batchResolves.delete(batchApproval.sessionId)
    }
    set({ batchApproval: null })
  },

  allowToolPermanently: (toolName) => {
    const activeId = get().activeSessionId
    // Prefer the running session of the currently viewed conversation, then the
    // active session itself — the allowlist is scoped to that session's project.
    const active = activeId ? get().activeRuns[activeId] : undefined
    const session = active
      ? get().sessions.find((s) => s.id === active.sessionId)
      : get().sessions.find((s) => s.id === activeId)
    const rootPath = session?.projectPath || getWorkspaceRoot()
    if (!rootPath) return
    const key = TOOL_ALLOWLIST_PREFIX + rootPath
    let list: string[] = []
    try { list = JSON.parse(localStorage.getItem(key) || '[]') } catch { /* ignore */ }
    const next = Array.from(new Set([...list, toolName]))
    localStorage.setItem(key, JSON.stringify(next))
    set((s) => ({ toolAllowlist: { ...s.toolAllowlist, [rootPath]: next } }))
  },

  // ── Inline decision dock (docked above the mode bar, replaces popups) ──

  requestRegenerateConfirm: (sessionId, messageId, checkpointIds, filePaths) =>
    set({ inlineConfirm: { type: 'regenerate', sessionId, messageId, checkpointIds, filePaths } }),

  requestRevertAllConfirm: (sessionId, filePaths) =>
    set({ inlineConfirm: { type: 'revert_all', sessionId, filePaths } }),

  dismissInlineConfirm: () => set({ inlineConfirm: null }),

  revertPathInSession: async (sessionId, path) => {
    // Read the freshest checkpoints from the store (not a render closure): the
    // previous revert may have consumed a checkpoint that also snapshotted other
    // files, so a later revert must see it already gone.
    const cps = get().checkpoints
      .filter((cp) => cp.sessionId === sessionId)
      .filter((cp) => (cp.files || []).some((f) => f.path === path))
    if (cps.length === 0) return true
    let ok = 0
    for (const cp of cps) {
      const res = await get().revertCheckpoint(cp.id)
      if (res?.ok) ok++
    }
    return ok === cps.length
  },

  revertFilesByPaths: async (sessionId, paths) => {
    let okFiles = 0
    let failedFiles = 0
    for (const p of paths) {
      if (await get().revertPathInSession(sessionId, p)) okFiles++
      else failedFiles++
    }
    return { ok: okFiles, failed: failedFiles }
  },

  loadToolAllowlist: (projectPath) => {
    if (!projectPath) return
    try {
      const arr = JSON.parse(localStorage.getItem(TOOL_ALLOWLIST_PREFIX + projectPath) || '[]')
      set((s) => ({
        toolAllowlist: { ...s.toolAllowlist, [projectPath]: Array.isArray(arr) ? arr : [] },
      }))
    } catch { /* ignore */ }
  },

  clearToolAllowlist: (projectPath) => {
    localStorage.removeItem(TOOL_ALLOWLIST_PREFIX + projectPath)
    set((s) => {
      const next = { ...s.toolAllowlist }
      delete next[projectPath]
      return { toolAllowlist: next }
    })
  },

  deleteAgentRun: (sessionId, runId) => {
    set((s) => {
      const clearActive = s.activeRuns[sessionId]?.runId === runId
      const activeRuns = { ...s.activeRuns }
      const agentTraces = { ...s.agentTraces }
      if (clearActive) {
        delete activeRuns[sessionId]
        delete agentTraces[sessionId]
      }
      return {
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId && sess.agentRuns
            ? { ...sess, agentRuns: sess.agentRuns.filter((r) => r.id !== runId), updatedAt: Date.now() }
            : sess
        ),
        activeRuns,
        agentTraces,
      }
    })
    get().saveSession(sessionId)
  },

  queueMessage: (sessionId, content, attachments) => {
    const trimmed = content.trim()
    if ((!trimmed && !attachments?.length) || !sessionId) return
    const item: QueuedMessage = { content: trimmed, ...(attachments?.length ? { attachments } : {}) }
    set((s) => ({
      queuedMessagesBySession: {
        ...s.queuedMessagesBySession,
        [sessionId]: [...(s.queuedMessagesBySession[sessionId] || []), item],
      },
    }))
  },

  removeQueuedMessage: (sessionId, index) => {
    const queue = get().queuedMessagesBySession[sessionId]
    if (!sessionId || !queue || index < 0 || index >= queue.length) return
    set((s) => ({
      queuedMessagesBySession: {
        ...s.queuedMessagesBySession,
        [sessionId]: queue.filter((_, i) => i !== index),
      },
    }))
  },

  sendQueuedNow: (sessionId, index) => {
    const queue = get().queuedMessagesBySession[sessionId]
    if (!sessionId || !queue || index < 0 || index >= queue.length) return
    // Promote the picked message to the front of the queue.
    const next = [...queue]
    const [msg] = next.splice(index, 1)
    next.unshift(msg)
    set((s) => ({
      queuedMessagesBySession: {
        ...s.queuedMessagesBySession,
        [sessionId]: next,
      },
    }))
    if (get().runningSessionIds.includes(sessionId)) {
      // Abort the current run — its finally block drains the (now front)
      // message as the very next thing sent, ahead of the rest of the queue.
      get().stopGeneration(sessionId)
    } else {
      // Nothing is generating for this session; send it right away.
      void get().sendMessage(sessionId, msg.content, undefined, msg.attachments)
    }
  },

  clearQueue: (sessionId) => {
    if (!sessionId) return
    set((s) => {
      const next = { ...s.queuedMessagesBySession }
      delete next[sessionId]
      return { queuedMessagesBySession: next }
    })
  },

  receiveInboundMessage: (senderTitle, targetSessionId, message, hold = false) => {
    const chatStore = useChatStore.getState()
    const target = chatStore.sessions.find((s) => s.id === targetSessionId)
    if (!target) return '目标会话不存在。'
    const content = `[来自会话「${senderTitle}」的会话间消息]\n\n${message}`
    const busy = chatStore.runningSessionIds.includes(targetSessionId) || (_inboundLaunches.get(targetSessionId) || 0) > 0
    if (busy) {
      set((s) => ({
        inboundQueue: [...s.inboundQueue, { targetSessionId, senderTitle, content, hold }],
      }))
      return hold
        ? '目标会话忙，消息已排队（hold 模式不自动处理）。'
        : '目标会话正在生成，消息已排队，结束后自动处理。'
    }
    chatStore.addMessage(targetSessionId, { role: 'user', content })
    void chatStore.saveSession(targetSessionId)
    if (hold) {
      return '已投递到目标会话历史（hold 模式，未触发处理）。'
    }
    markInboundLaunch(targetSessionId)
    void runAgentLoop(targetSessionId).finally(() => { markInboundSettled(targetSessionId) })
    return '已投递并触发目标会话处理。'
  },

  loadCheckpoints: async (sessionId) => {
    // Clear synchronously first so a previous session's list can't briefly
    // leak into the new session's summary while the fetch is in flight (the
    // checkpoints are filterable by sessionId, but revertedFiles are not).
    set({ checkpoints: [], revertedFiles: [] })
    try {
      const checkpoints = await window.electronAPI.checkpointList(sessionId)
      const revertedFiles = await window.electronAPI.checkpointListReverted(sessionId)
      set({ checkpoints, revertedFiles })
    } catch {
      set({ checkpoints: [], revertedFiles: [] })
    }
  },

  revertCheckpoint: async (checkpointId) => {
    let res: { ok: boolean; restored: number; error?: string } | null = null
    try {
      res = await window.electronAPI.checkpointRevert(checkpointId)
    } catch (error) {
      // A transient IPC/main-process error must not abort the whole revert
      // loop. Return a failed result instead of throwing, so callers keep
      // reverting the remaining checkpoints and this file stays retryable —
      // previously an exception here silently killed `handleRevertAll` and
      // the file would never be marked "已回退".
      res = { ok: false, restored: 0, error: error instanceof Error ? error.message : String(error) }
    }
    if (res?.ok) {
      set((s) => {
        // Remove the consumed snapshot and remember its file paths as reverted,
        // so the summary keeps the row (marked「已回退」) instead of dropping it.
        const cp = s.checkpoints.find((c) => c.id === checkpointId)
        const revertedPaths = (cp?.files || []).map((f) => f.path).filter(Boolean)
        return {
          checkpoints: s.checkpoints.filter((c) => c.id !== checkpointId),
          revertedFiles: Array.from(new Set([...s.revertedFiles, ...revertedPaths])),
        }
      })
    }
    return res ?? null
  },

  loadSessions: async () => {
    try {
      // 只加载本窗口模式的会话：对话窗口 mode='main'，一人公司窗口 mode='office'。
      const sessions = await window.electronAPI.getSessions(WINDOW_MODE)
      // 旧数据回填 lastUserMessageAt：从最后一条用户消息推导，避免升级后
      // 排序/显示时间回退到 updatedAt（会被 agent 活动刷新而跳动）。
      // agentMode 也一律归一为 'agent'——chat 模式已移除，升级前的旧会话
      // （可能存着 'chat'）重新加载后同样按 agent 模式运行。
      const normalized = sessions.map((s) => ({
        ...s,
        agentMode: 'agent' as const,
        lastUserMessageAt: s.lastUserMessageAt ?? deriveLastUserMessageAt(s),
      }))
      // 加载出来的都是已落盘会话——记入集合，后续即使被清空消息也要继续保存
      // （删除全部消息必须跨重启生效）。
      for (const s of normalized) _persistedSessionIds.add(s.id)
      set({ sessions: normalized })
      // Restore the last active session across restarts (only on the first load).
      // 一人公司窗口不自动恢复上次会话：开公司 = 开一家新公司（白纸），旧对话
      // 仍在左侧项目/任务列表里可手动点开，避免「开公司把之前的对话带过来」。
      // 主窗口（对话模式）保持原样恢复上次会话。
      if (sessions.length > 0 && !get().activeSessionId && !IS_OFFICE) {
        // Sessions of projects removed from the list ("从列表中移除") must not
        // restore as active — that would reopen a conversation of a project the
        // user deliberately hid, and the fallback below could otherwise pick it
        // when the last-active pointer is gone.
        const removed = new Set(useUIStore.getState().removedProjects)
        const candidates = sessions.filter((s) => !removed.has(s.projectPath ?? ''))
        const lastId = localStorage.getItem(LAST_SESSION_KEY)
        const restored = candidates.find((s) => s.id === lastId)
        const target = restored || candidates[0]
        if (target) {
          set({ activeSessionId: target.id })
          // 恢复会话后同步加载它的回滚快照（checkpoints）——否则应用重启后
          // 「文件改动汇总框」会因 checkpoints 数组为空而不显示，直到用户
          // 再次手动点击会话（setActiveSession）才加载。
          get().loadCheckpoints(target.id)
          // Sync the provider group (header badge / model pill / status bar) to
          // the restored session's OWN group — the chat loop always resolves the
          // model from session.configGroupId, so without this the model display
          // can show nothing (or the wrong default) right after startup while a
          // model is actually in use.
          if (target.configGroupId) {
            useConfigStore.getState().setActiveConfigGroup(target.configGroupId)
          }
        }
      }
    } catch (error) {
      console.error('加载会话失败:', error)
    }
  },

  createSession: (configGroupId, projectPath) => {
    // The project binding is captured at creation so the session shows up under
    // its project in the left sidebar. Callers may pass an explicit project
    // (e.g. the "新建对话" button on a project list item) — otherwise fall back
    // to the current project (the active session's project, since the current
    // project follows the conversation), then the folder being browsed.
    const rootPath = projectPath || getCurrentProjectPath() || document.getElementById('file-tree-root')?.getAttribute('data-root-path') || useUIStore.getState().rootPath || ''
    // 一人公司排他：办公室建会话走 targetMode 直置（见下），绕过了 setTargetMode
    // 的「同项目仅一个目标模式会话」门禁。这里只拦「正在运行」的公司——同项目
    // 有目标模式会话在运行时，直接激活既有会话而不是再开一家，防止两个监管对
    // 同一项目双跑（状态文件互相覆盖、预算分别记账）。**未在运行的既有会话不
    // 占位**：新建任务 = 新会话（干净上下文），旧会话保留在历史区回看；否则会
    // 出现「我没在跑任务，却提示已有公司在运营」的误导（会话存在 ≠ 在运营）。
    if (IS_OFFICE && rootPath) {
      const running = get().sessions.find(
        (s) =>
          s.targetMode === true &&
          s.projectPath === rootPath &&
          get().runningSessionIds.includes(s.id),
      )
      if (running) {
        set({ activeSessionId: running.id })
        get().loadCheckpoints(running.id)
        useUIStore.getState().showNotification(t('office.companyAlreadyRunning'), 'info')
        return running.id
      }
    }
    const id = uuidv4()
    const session: ChatSession = {
      id,
      title: DEFAULT_SESSION_TITLE,
      configGroupId,
      // Seed with the model the user last picked for this config group, so the
      // choice (e.g. Longcat) carries over to new chats instead of resetting.
      model: getLastModelForGroup(configGroupId),
      modelParams: DEFAULT_MODEL_PARAMS,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // Every conversation runs in agent mode now — the chat/agent toggle is
      // gone. The session still records its workspace (or the default project)
      // so the agent loop has somewhere to operate.
      agentMode: 'agent',
      // The last edit mode (手动确认/完全访问/自动编辑/计划) also carries over —
      // opening a new window / chat keeps the mode the user had selected.
      projectEditMode: getLastProjectEditMode() ?? undefined,
      todos: [],
      planStatus: 'none',
      projectPath: rootPath || undefined,
      // 会话所属窗口模式：一人公司窗口的会话与对话窗口完全隔离（SQLite mode 过滤）。
      mode: WINDOW_MODE,
      // 一人公司窗口的会话一律默认进入目标模式：办公室的对话就是「派活给公司」，
      // 而非普通 agent 对话。此前只有 App 启动兜底会话被置位 targetMode，其余
      // 入口（双击项目/打开文件夹/新建任务对话）建出的会话都是普通 agent 模式——
      // 在办公室右下对话区看起来就是一条普通对话（无目标条/无监管调度）。
      // 主窗口会话保持默认关闭。
      targetMode: IS_OFFICE || undefined,
    }

    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: id,
    }))
    localStorage.setItem(LAST_SESSION_KEY, id)

    // 新会话先不落盘：创建即保存会让"新建对话"在磁盘上堆积一堆没有消息的
    // 空白会话（重启后全部加载回来）。首条消息发出后才会持久化——发送流程
    // 的 auto-title 重命名（renameSession）和 runAgentLoop 的 finally 都会
    // 调用 saveSession；从未发过消息的空白会话随进程退出自然消失。

    return id
  },

  deleteSession: (sessionId) => {
    set((s) => {
      const remaining = s.sessions.filter((sess) => sess.id !== sessionId)
      // Drop transient sub-agent progress belonging to the deleted session
      const subagentProgress = { ...s.subagentProgress }
      for (const [id, p] of Object.entries(subagentProgress)) {
        if (p.sessionId === sessionId) delete subagentProgress[id]
      }
      // 顺带清掉从未用过的幽灵会话（新建后没发消息的空对话）；"下一个激活"绝不
      // 能落到幽灵上——否则删除当前对话后界面会跳到一个不可见的空白会话。若当前
      // 激活会话（可能是用户正在输入的空对话）没被删除则保留它。
      const newSessions = remaining.filter(
        (sess) => sess.id === s.activeSessionId || !isGhostSession(sess)
      )
      return {
        sessions: newSessions,
        activeSessionId: s.activeSessionId === sessionId
          ? newSessions[0]?.id || null
          : s.activeSessionId,
        checkpoints: s.activeSessionId === sessionId ? [] : s.checkpoints,
        revertedFiles: s.activeSessionId === sessionId ? [] : s.revertedFiles,
        subagentProgress,
      }
    })
    window.electronAPI.deleteSession(sessionId)
    window.electronAPI.checkpointDelete(sessionId)
    _persistedSessionIds.delete(sessionId)
    // Remove the session's spilled tool-output files (best-effort cache cleanup)
    void window.electronAPI.spillDeleteSession(sessionId).catch(() => {})
    // Drop the executor's per-session read-tracking (read-before-write guard)
    toolExecutor.forgetSession(sessionId)
  },

  rollActiveSessionAwayFrom: (projectPath) => {
    const { sessions, activeSessionId } = get()
    const active = sessions.find((s) => s.id === activeSessionId)
    if (!active || active.projectPath !== projectPath) return
    // Prefer the most recently used conversation of ANOTHER project that is
    // still in the list — rolling onto a removed project's session would
    // silently resurrect that project (setActiveSession re-opens its path).
    const removed = new Set(useUIStore.getState().removedProjects)
    // Never-used ghost chats are not real conversations — skip them too.
    const fallback = sessions
      .filter((s) => !isGhostSession(s) && s.projectPath && s.projectPath !== projectPath && !removed.has(s.projectPath))
      .sort((a, b) => sessionLastUserActivity(b) - sessionLastUserActivity(a))[0]
    if (fallback) {
      get().setActiveSession(fallback.id)
    } else {
      // No other project's conversation to roll to — clear the selection (the
      // chat panel shows its empty state). The removed project's sessions stay
      // stored and come back when the project is re-opened.
      localStorage.removeItem(LAST_SESSION_KEY)
      set({ activeSessionId: null, checkpoints: [], revertedFiles: [] })
    }
  },

  renameSession: (sessionId, title) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, title } : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  setActiveSession: (sessionId) => {
    // Sync the provider group so the model selector reflects this session's
    // actual provider (each session remembers its own configGroupId).
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session?.configGroupId) {
      useConfigStore.getState().setActiveConfigGroup(session.configGroupId)
    }
    // Selecting a conversation also syncs the workspace to the one the
    // conversation belongs to (sessions captured their project at creation) —
    // WITHOUT switching the sidebar's project-list ↔ file-tree view. Forcing
    // the tree view here used to hide the session list the moment a
    // conversation was opened, which read as "conversations vanished".
    if (session?.projectPath) {
      const ui = useUIStore.getState()
      if (ui.projectListView === 'tree') {
        ui.enterProject(session.projectPath)
      } else {
        ui.setRootPath(session.projectPath)
      }
    }
    localStorage.setItem(LAST_SESSION_KEY, sessionId)
    // Re-entering a session with a deferred question re-arms its confirm bar
    // ("later" only defers while the user is away — the bar comes back when
    // they switch to the session again).
    if (get().pendingQuestion?.sessionId === sessionId && get().questionGate[sessionId] === 'dismissed') {
      get().setQuestionGate(sessionId, 'confirm')
    }
    set((s) => ({
      activeSessionId: sessionId,
      // 切走时清掉从未用过的幽灵会话（新建后没发消息的空对话）——它们不落盘，
      // 留在内存里只会让列表计数和内存膨胀；首条消息发出后即成为真正会话。
      sessions: s.sessions.filter((x) => x.id === sessionId || !isGhostSession(x)),
    }))
    get().loadCheckpoints(sessionId)
  },

  getActiveSession: () => {
    const { sessions, activeSessionId } = get()
    return sessions.find((s) => s.id === activeSessionId)
  },

  // ───────────── Agent mode / plan / todo ─────────────

  setProjectEditMode: (sessionId, mode) => {
    try { localStorage.setItem(LAST_PROJECT_EDIT_MODE_KEY, mode) } catch { /* ignore */ }
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, projectEditMode: mode, updatedAt: Date.now() } : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  setTargetMode: (sessionId, enabled) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return

    if (enabled) {
      // A session always belongs to one project: sessions created outside a
      // project get bound to the currently opened one when target mode starts.
      const myProject = session.projectPath || getWorkspaceRoot()
      // One target-mode run per project: block when another session of the
      // same project already has it enabled. The run ends when it's turned off.
      const sameProjectRun = get().sessions.some(
        (s) => s.id !== sessionId && s.targetMode === true && s.projectPath && s.projectPath === myProject,
      )
      if (sameProjectRun) {
        useUIStore.getState().showNotification(t('chat.targetModeExclusive'), 'warning')
        return
      }
      if (!session.projectPath && myProject) {
        set((s) => ({
          sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, projectPath: myProject } : x)),
        }))
      }
      // 'auto_edit' / 'plan' are superseded by target mode's own workflow — the
      // mode bar only exposes manual-confirm and full-access while it is on.
      if (session.projectEditMode === 'auto_edit' || session.projectEditMode === 'plan') {
        get().setProjectEditMode(sessionId, 'confirm_before_change')
      }
    }

    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, targetMode: enabled, updatedAt: Date.now() } : sess
      ),
    }))
    get().saveSession(sessionId)
    if (enabled) {
      // Experimental warning — the agent runs autonomously and burns tokens.
      useUIStore.getState().showNotification(t('chat.targetModeFirstHint'), 'info')
      // Bootstrap the skeleton in the session's own project (idempotent) —
      // never the globally opened folder.
      const root = session.projectPath || getWorkspaceRoot()
      if (root) {
        ensureInitialized(root).then(() => get().refreshTargetModeStatus())
      }
    } else {
      set({ targetModeStatus: null })
    }
  },

  refreshTargetModeStatus: async () => {
    const session = get().sessions.find((s) => s.id === get().activeSessionId)
    if (!session?.targetMode) {
      set({ targetModeStatus: null })
      return
    }
    // Always operate on the session's own project — never the globally opened
    // folder, so sessions of different projects can't mix state.
    set({ targetModeStatus: await readStatus(session.projectPath || getWorkspaceRoot()) })
  },

  approvePlan: async (sessionId, opts?: { autoApprove?: boolean }) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    // 'canceled' plans can be re-approved — the plan stays on record after a
    // cancel, so the user can review/adjust and approve it again later.
    if (!session || !session.planContent || (session.planStatus !== 'pending_approval' && session.planStatus !== 'canceled')) return

    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, planStatus: 'approved', updatedAt: Date.now() } : sess
      ),
    }))
    get().saveSession(sessionId)

    const planText = formatPlanText(session.planContent)
    const activeRun = get().activeRuns[sessionId]
    // Plan-approved auto-approval (allowedPrompts-style): when the user opted
    // in on the plan card, the execution phase runs without per-tool dialogs —
    // the same per-run flag target mode uses. It is cleared when the run ends
    // (see the finally in runAgentLoop), so it never leaks into later runs.
    if (opts?.autoApprove) {
      set((s) => ({ batchApprovedBySession: { ...s.batchApprovedBySession, [sessionId]: true } }))
    }
    await runAgentLoop(sessionId, {
      // Every session runs in agent mode; the read-only planning phase is
      // lifted via planApproved. Tool approval follows the project edit mode
      // (confirm / auto_edit / full_access) + target mode.
      agentModeOverride: 'agent',
      extraSystemText: PLAN_APPROVED_PREFIX + planText,
      resumeRunId: activeRun?.sessionId === sessionId ? activeRun.runId : undefined,
      planApproved: true,
    })
  },

  dismissPlan: (sessionId) => {
    // Cancel keeps the plan on record (status 'canceled') instead of wiping it
    // — the user may want to manually adjust or re-approve it, and the chat
    // must still show that a plan existed and was canceled.
    const activeRun = get().activeRuns[sessionId]
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, planStatus: 'canceled', planContent: sess.planContent, updatedAt: Date.now() }
          : sess
      ),
    }))
    if (activeRun?.sessionId === sessionId) {
      get().setRunStatus(activeRun.runId, 'rejected')
    }
    get().saveSession(sessionId)
  },

  setTodos: (sessionId, todos) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, todos, updatedAt: Date.now() } : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  continueGeneration: async (sessionId) => {
    // One loop per session — refuse to double-start a session that is running
    if (!sessionId || get().runningSessionIds.includes(sessionId)) return
    // Target-mode budget fuse (v2 §11.4 / §13.3): the main loop itself is
    // untouched — only the auto-resume path is gated. Normal chat / agent
    // sessions never hit this branch (budget tracks target-mode sessions only).
    // The limit is re-read from budget.md first so a mid-run cap raise works.
    const tmSession = get().sessions.find((s) => s.id === sessionId)
    if (tmSession?.targetMode) {
      await refreshBudgetLimit(sessionId)
      if (budgetExceeded(sessionId)) {
        const { used, limit } = getBudgetUsage(sessionId)
        useUIStore.getState().showNotification(t('chat.targetModeBudgetExceeded'), 'warning')
        get().addMessage(sessionId, {
          role: 'assistant',
          content:
            `[目标模式全局预算已触顶（${used.toLocaleString()} / ${limit.toLocaleString()} tokens），已停止自主续跑。` +
            '可修改 .ourcode/targemode/budget.md 提高上限后点击"继续"。]',
        })
        return
      }
    }
    const resumeRunId = get().activeRuns[sessionId]?.runId
    await runAgentLoop(sessionId, { resumeRunId })
  },

  addMessage: (sessionId, msg) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return

    const newMessage: ChatMessage = {
      id: msg.id || uuidv4(),
      role: msg.role || 'user',
      content: msg.content || '',
      sortOrder: msg.sortOrder ?? session.messages.length,
      contextFiles: msg.contextFiles || [],
      attachments: msg.attachments,
      tokenCount: estimateTokens(msg.content || ''),
      thinking: msg.thinking,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
      error: msg.error,
      createdAt: Date.now(),
      runId: msg.runId,
      requestStartedAt: msg.requestStartedAt,
      requestDurationMs: msg.requestDurationMs,
      ttftMs: msg.ttftMs,
      requestTokensIn: msg.requestTokensIn,
      requestTokensOut: msg.requestTokensOut,
    }

    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: [...sess.messages, newMessage],
              updatedAt: Date.now(),
              // 用户发消息才刷新排序锚点；agent 的 assistant/tool 消息只更新
              // updatedAt，不再影响会话在列表中的位置（避免运行中位置跳动）。
              ...(newMessage.role === 'user' ? { lastUserMessageAt: newMessage.createdAt } : {}),
            }
          : sess
      ),
    }))
  },

  /** Append a tool result to the preceding assistant message (inline display). */
  appendToolResult: (sessionId, assistantMsgId, result) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((msg) =>
                msg.id === assistantMsgId
                  ? {
                      ...msg,
                      toolResults: [...(msg.toolResults || []), result],
                    }
                  : msg
              ),
              updatedAt: Date.now(),
            }
          : sess
      ),
    }))
  },

  editMessage: (sessionId, msgId, content) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((msg) =>
                msg.id === msgId
                  ? { ...msg, content, tokenCount: estimateTokens(content), editedAt: Date.now() }
                  : msg
              ),
              updatedAt: Date.now(),
            }
          : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  deleteMessage: (sessionId, msgId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return
    const msg = session.messages.find((m) => m.id === msgId)
    if (!msg) return

    const now = Date.now()
    // Prune expired undo entries (only keep deletes from the last 5s)
    const freshUndo = get().undoStack.filter((e) => now - e.timestamp < UNDO_WINDOW_MS)

    set((s) => ({
      undoStack: [...freshUndo.slice(-9), { sessionId, messages: [msg], timestamp: now }],
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, messages: reindexMessages(sess.messages.filter((m) => m.id !== msgId)), updatedAt: now }
          : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  deleteMessages: (sessionId, msgIds) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session || msgIds.length === 0) return
    const idSet = new Set(msgIds)
    const deleted = session.messages.filter((m) => idSet.has(m.id))
    if (deleted.length === 0) return

    const now = Date.now()
    // Prune expired undo entries (only keep deletes from the last 5s)
    const freshUndo = get().undoStack.filter((e) => now - e.timestamp < UNDO_WINDOW_MS)

    set((s) => ({
      undoStack: [...freshUndo.slice(-9), { sessionId, messages: deleted, timestamp: now }],
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, messages: reindexMessages(sess.messages.filter((m) => !idSet.has(m.id))), updatedAt: now }
          : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  undoDelete: () => {
    const { undoStack } = get()
    if (undoStack.length === 0) return

    const entry = undoStack[undoStack.length - 1]
    // Only allow undo within the 5s window (the toast is purely visual otherwise)
    if (Date.now() - entry.timestamp > UNDO_WINDOW_MS) {
      set({ undoStack: undoStack.slice(0, -1) })
      return
    }

    set((s) => ({
      undoStack: s.undoStack.slice(0, -1),
      sessions: s.sessions.map((sess) => {
        if (sess.id !== entry.sessionId) return sess
        // Merge restored messages back in their original order and re-index
        const restoredIds = new Set(entry.messages.map((m) => m.id))
        const existing = sess.messages.filter((m) => !restoredIds.has(m.id))
        const merged = [...existing, ...entry.messages].sort((a, b) => a.sortOrder - b.sortOrder)
        return {
          ...sess,
          messages: reindexMessages(merged),
          updatedAt: Date.now(),
        }
      }),
    }))
    get().saveSession(entry.sessionId)
  },

  reorderMessages: (sessionId, fromIndex, toIndex) => {
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== sessionId) return sess
        const messages = [...sess.messages]
        const [moved] = messages.splice(fromIndex, 1)
        messages.splice(toIndex, 0, moved)
        return {
          ...sess,
          messages: messages.map((m, i) => ({ ...m, sortOrder: i })),
          updatedAt: Date.now(),
        }
      }),
    }))
    get().saveSession(sessionId)
  },

  clearMessages: (sessionId) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, messages: [], updatedAt: Date.now() }
          : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  sendMessage: async (sessionId, content, contextFiles = [], attachments = []) => {
    if (!sessionId) return

    // One agent loop per session: while it is generating, type-ahead messages
    // queue instead of starting a second loop (ChatInput already queues via
    // the button state; this guard covers API/plugin callers).
    if (get().runningSessionIds.includes(sessionId)) {
      get().queueMessage(sessionId, content, attachments)
      return
    }

    // Add user message
    get().addMessage(sessionId, {
      role: 'user',
      content,
      contextFiles,
      attachments: attachments.length ? attachments : undefined,
    })

    // Auto-title on the first message — and only then: a title the user renamed
    // (or that was already generated) is never overwritten, and regenerating
    // the first message must not re-truncate the title. The heuristic below is
    // the instant placeholder; the AI summary (when an API is configured)
    // refines it in the background so the sidebar shows a real summary instead
    // of the raw user input.
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session && session.messages.length === 1 && (!session.title || session.title === DEFAULT_SESSION_TITLE)) {
      const autoTitle = generateSessionTitle(content)
      if (autoTitle) get().renameSession(sessionId, autoTitle)
      void (async () => {
        const aiTitle = await generateAiSessionTitle(content, session?.model, session?.configGroupId)
        if (!aiTitle) return
        const s = get().sessions.find((x) => x.id === sessionId)
        // Overwrite only if the user hasn't renamed in the meantime.
        if (s && s.title === (autoTitle || DEFAULT_SESSION_TITLE)) {
          get().renameSession(sessionId, aiTitle)
        }
      })()
    }

    await runAgentLoop(sessionId)
  },

  regenerateFromMessage: async (sessionId, msgId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return

    const msgIndex = session.messages.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return

    const target = session.messages[msgIndex]

    // Determine which user message to re-run and where to cut the history:
    // - Clicked a user message (HistoryEditor rerun) → re-run that message itself.
    // - Clicked an assistant message ("重新生成") → re-run the last user message before it.
    let userMsg: ChatMessage | undefined = target
    let cutIndex = msgIndex
    if (target.role !== 'user') {
      let found = -1
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (session.messages[i].role === 'user') { found = i; break }
      }
      if (found === -1) return
      userMsg = session.messages[found]
      cutIndex = found
    }

    // Truncate the session to just before the user message.
    // sendMessage() re-adds the user message itself, so nothing is duplicated.
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, messages: sess.messages.slice(0, cutIndex) }
          : sess
      ),
    }))

    if (userMsg) {
      await get().sendMessage(sessionId, userMsg.content, userMsg.contextFiles, userMsg.attachments)
    }
  },

  stopGeneration: (sessionId) => {
    // Stop ONLY the given session's generation — parallel conversations must
    // never be stopped by acting on a different session's button.
    get().abortControllers[sessionId]?.abort()
    // If the agent is blocked on a dialog for this session, resolve it so the
    // loop can unwind (each session has its own resolve slot).
    if (_questionResolves.has(sessionId)) {
      _questionResolves.get(sessionId)!('（生成已停止，用户取消了提问）')
      _questionResolves.delete(sessionId)
    }
    if (_batchResolves.has(sessionId)) {
      _batchResolves.get(sessionId)!('reject')
      _batchResolves.delete(sessionId)
    }
    if (_approvalResolves.has(sessionId)) {
      _approvalResolves.get(sessionId)!(false)
      _approvalResolves.delete(sessionId)
    }
    set((s) => {
      const abortControllers = { ...s.abortControllers }
      const questionGate = { ...s.questionGate }
      delete abortControllers[sessionId]
      delete questionGate[sessionId]
      return {
        abortControllers,
        questionGate,
        pendingQuestion: s.pendingQuestion?.sessionId === sessionId ? null : s.pendingQuestion,
        batchApproval: s.batchApproval?.sessionId === sessionId ? null : s.batchApproval,
        pendingApproval: s.pendingApproval?.sessionId === sessionId ? null : s.pendingApproval,
        inlineConfirm: s.inlineConfirm?.sessionId === sessionId ? null : s.inlineConfirm,
      }
    })
  },

  // Branch: fork the conversation into a NEW session. Everything up to and
  // including the clicked message carries over; everything after it is
  // dropped — a fresh chat pre-seeded with the history the user wanted to
  // keep (replaces the old in-session branch tree, which was confusing).
  createBranchFromMessage: (sessionId, messageId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return

    const msgIndex = session.messages.findIndex((m) => m.id === messageId)
    if (msgIndex === -1) return

    const forkMessages = session.messages.slice(0, msgIndex + 1).map((m, i) => ({ ...m, sortOrder: i }))

    const newId = uuidv4()
    const now = Date.now()
    // The fork is a brand-new session that happens to be pre-seeded: same
    // config group / model / project binding, but no branch state, compaction
    // summary, plan, or checkpoints of its own.
    const forkedSession: ChatSession = {
      id: newId,
      title: session.title, // shares the beginning of the conversation
      configGroupId: session.configGroupId,
      model: session.model,
      modelParams: session.modelParams,
      messages: forkMessages,
      createdAt: now,
      updatedAt: now,
      lastUserMessageAt: deriveLastUserMessageAt({ ...session, messages: forkMessages }),
      agentMode: 'agent',
      projectEditMode: session.projectEditMode,
      todos: [],
      planStatus: 'none',
      projectPath: session.projectPath,
      // 分支继承原会话的窗口模式（缺失时按当前窗口）——否则分支会以无 mode 状态
      // 落盘，sqlite 的 saveSession 会把无 mode 一律写成 'main'，办公室窗口里
      // 分叉出的会话就静默流入了普通对话窗口。
      mode: session.mode ?? WINDOW_MODE,
      // Carry over only the agent runs referenced by the carried messages so
      // the token badges on those messages keep working.
      agentRuns: session.agentRuns?.filter((r) => forkMessages.some((m) => m.runId === r.id)),
    }

    set((s) => ({
      sessions: [forkedSession, ...s.sessions],
      activeSessionId: newId,
    }))
    localStorage.setItem(LAST_SESSION_KEY, newId)
    get().saveSession(newId)
  },

  // Pin: toggle pin state
  togglePin: (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return
    const pinnedAt = session.pinnedAt ? undefined : Date.now()
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, pinnedAt, updatedAt: Date.now() } : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  // Archive: toggle archive state
  toggleArchive: (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return
    const archivedAt = session.archivedAt ? undefined : Date.now()
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, archivedAt, updatedAt: Date.now() } : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  exportSession: (sessionId, format) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return ''

    if (format === 'json') {
      return JSON.stringify(session, null, 2)
    }

    let md = `# ${session.title}\n\n`
    md += `创建时间: ${new Date(session.createdAt).toLocaleString()}\n\n---\n\n`

    for (const msg of session.messages) {
      md += `### ${msg.role === 'user' ? '用户' : msg.role === 'tool' ? '工具' : 'AI 助手'}\n\n`
      md += `${msg.content}\n\n`
      if (msg.thinking) {
        md += `<details><summary>思考过程</summary>\n\n${msg.thinking}\n\n</details>\n\n`
      }
      md += `---\n\n`
    }

    return md
  },

  importSession: (data) => {
    try {
      const imported = JSON.parse(data) as ChatSession

      // Assign new IDs to avoid conflicts
      const sessionId = uuidv4()

      // Restore branches if present, assigning new IDs
      const branchIdMap: Record<string, string> = {}
      let branches: ChatBranch[] = []
      let activeBranchId: string | undefined

      if (imported.branches && imported.branches.length > 0) {
        branches = imported.branches.map((b) => {
          const newBranchId = b.id === 'main' ? 'main' : uuidv4()
          branchIdMap[b.id] = newBranchId
          return {
            ...b,
            id: newBranchId,
            messages: b.messages.map((m) => ({ ...m, id: uuidv4() })),
          }
        })

        // Map activeBranchId
        if (imported.activeBranchId) {
          activeBranchId = branchIdMap[imported.activeBranchId] || imported.activeBranchId
        }
      }

      const session: ChatSession = {
        ...imported,
        id: sessionId,
        messages: imported.messages.map((m) => ({ ...m, id: uuidv4() })),
        branches,
        activeBranchId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // 导入的历史保留原消息时间——排序锚点从消息推导，而不是用导入时刻。
        lastUserMessageAt: deriveLastUserMessageAt(imported),
        agentMode: 'agent',
        todos: [],
        planStatus: 'none',
        // 导入的会话必须归属当前窗口模式——备份文件里可能混有另一模式的会话
        // （导出是全量备份），保留文件里的 mode 会让办公室窗口导入的 main 会话
        // 同时出现在两个窗口（SQLite 按原 mode 落盘），正是「一人公司与普通
        // agent 模式交融、对话重复」的来源之一。
        mode: WINDOW_MODE,
      }

      set((s) => ({
        sessions: [session, ...s.sessions],
        activeSessionId: session.id,
      }))

      // 导入是显式操作：直接落盘，并记入已落盘集合（导入的空会话也保持持久化）。
      _persistedSessionIds.add(session.id)
      window.electronAPI.saveSession(session)
    } catch (error) {
      console.error('导入会话失败:', error)
    }
  },

  saveSession: async (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session) return
    // 幽灵会话（新建后没发消息的空对话）不落盘：一旦真正写过一次才持续保存。
    // 见 _persistedSessionIds 注释——这同时堵住了「删除全部消息后重启又回来」
    // 的隐患（已落盘的会话不受影响）。
    if (isGhostSession(session) && !_persistedSessionIds.has(sessionId)) return
    _persistedSessionIds.add(sessionId)
    await window.electronAPI.saveSession(stripDurableAttachments(session))
    // Recorded only after the write resolved — a failed save keeps shipping the
    // attachment payload on the next attempt.
    for (const m of session.messages) {
      if (m.attachments?.length) _durableAttachmentIds.set(m.id, attachmentSignature(m))
    }
  },

  updateSessionModel: (sessionId, model, configGroupId) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, model, ...(configGroupId !== undefined ? { configGroupId } : {}) }
          : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  // Rebinding is what keeps the session's API key/base URL in sync with the
  // provider shown in the UI. Without it a session can end up using a model
  // picked from another config group while still authenticating with the old
  // group's key — which surfaces as a confusing 401 "invalid API key".
  updateSessionConfigGroup: (sessionId, configGroupId) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, configGroupId, updatedAt: Date.now() } : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  updateSessionParams: (sessionId, params) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, modelParams: { ...sess.modelParams, ...params } }
          : sess
      ),
    }))
    get().saveSession(sessionId)
  },

  resetStore: () => {
    if (_gitBranchInterval) {
      clearInterval(_gitBranchInterval)
      _gitBranchInterval = null
    }
    _persistedSessionIds.clear()
    localStorage.removeItem(LAST_SESSION_KEY)
    set({
      sessions: [],
      activeSessionId: null,
      runningSessionIds: [],
      streamingBySession: {},
      streamLastActivityBySession: {},
      abortControllers: {},
      pendingApproval: null,
      pendingQuestion: null,
      questionGate: {},
      queuedMessagesBySession: {},
      inboundQueue: [],
      checkpoints: [],
      revertedFiles: [],
      undoStack: [],
      activeRuns: {},
      agentTraces: {},
      subagentProgress: {},
      batchApprovedBySession: {},
      toolAllowlist: {},
      batchApproval: null,
      inlineConfirm: null,
    })
  },
}))

// ─────────────────────────── Agent loop ───────────────────────────

/** Build a 'llm' usage event for the usage dashboard (tokens from real usage) */
function makeLlmUsageEvent(opts: {
  sessionId: string
  projectPath: string
  model: string
  provider: string
  startedAt: number
  durationMs?: number
  tokensIn?: number
  tokensOut?: number
  ok?: boolean
  error?: string
  /** Client-side cache hit — tokensIn/Out are 0; the saved amounts go in payload. */
  cacheHit?: { savedTokensIn: number; savedTokensOut: number } | null
  /** Server-side prompt-cache tokens reported by the provider. */
  cacheReadTokens?: number
  cacheCreationTokens?: number
}): UsageEvent {
  const payload = opts.cacheHit
    ? { cacheHit: true, savedTokensIn: opts.cacheHit.savedTokensIn, savedTokensOut: opts.cacheHit.savedTokensOut }
    : opts.cacheReadTokens || opts.cacheCreationTokens
      ? { cacheReadTokens: opts.cacheReadTokens || 0, cacheCreationTokens: opts.cacheCreationTokens || 0 }
      : undefined
  return {
    id: uuidv4(),
    category: 'llm',
    name: opts.model,
    sub: opts.provider,
    sessionId: opts.sessionId,
    projectPath: opts.projectPath,
    startedAt: opts.startedAt,
    durationMs: opts.durationMs || 0,
    tokensIn: opts.tokensIn || 0,
    tokensOut: opts.tokensOut || 0,
    ok: opts.ok ?? true,
    error: opts.error,
    payload,
  }
}

/** Flush recorded usage events to the main process + notify the dashboard */
function flushUsageEvents(events: UsageEvent[]): void {
  if (!events || events.length === 0) return
  window.electronAPI.recordUsage(events).catch(() => { /* stats are best-effort */ })
  // Target-mode budget fuse payload (v2 §13.3): per-session token totals for
  // TARGET-MODE sessions only — budget.ts accumulates these; other listeners
  // (usage dashboard) ignore the detail.
  const bySession: Record<string, { tokens: number; projectPath: string }> = {}
  for (const e of events) {
    if (!e.sessionId || !e.projectPath) continue
    if (!useChatStore.getState().sessions.some((s) => s.id === e.sessionId && s.targetMode === true)) continue
    const tokens = (e.tokensIn || 0) + (e.tokensOut || 0)
    if (tokens <= 0) continue
    const prev = bySession[e.sessionId]
    bySession[e.sessionId] = prev
      ? { tokens: prev.tokens + tokens, projectPath: e.projectPath }
      : { tokens, projectPath: e.projectPath }
  }
  window.dispatchEvent(new CustomEvent('ourcode:usage-recorded', {
    detail: Object.keys(bySession).length > 0 ? { bySession } : undefined,
  }))
}

/**
 * Core agent loop: streams the LLM response, executes tool calls with approval,
 * handles plan-mode / todos / questions / checkpoints, and saves the session.
 *
 * `opts.agentModeOverride` lets a plan approval resume the same run in the
 * execution phase of agent mode (read-only planning → approved execution).
 */
async function runAgentLoop(
  sessionId: string,
  opts?: { agentModeOverride?: 'chat' | 'agent'; extraSystemText?: string; resumeRunId?: string; planApproved?: boolean },
): Promise<void> {
  const chatStore = useChatStore.getState()
  const session = chatStore.sessions.find((s) => s.id === sessionId)
  if (!session) return

  const configGroup = useConfigStore.getState().configGroups.find((g) => g.id === session.configGroupId)
  if (!configGroup) return

  const agentMode = opts?.agentModeOverride || 'agent'
  // Target mode: the agent runs the autonomous .ourcode/targemode/ workflow
  const targetMode = session.targetMode === true

  // 一人公司防双跑兜底：新建会话已不再被「同项目存在目标模式会话」拦截（见
  // createSession），同一项目可并存多个目标模式会话（历史 + 新建）。两个监管
  // 同时跑会互相覆盖 .ourcode/targemode 状态文件、预算分别记账——启动前检查
  // 同项目是否已有另一个**正在运行**的目标模式会话，有则阻止本次启动。
  // 仅目标模式路径生效（普通 chat / agent 会话不经过）。
  if (targetMode && session.projectPath) {
    const peerRunning = chatStore.sessions.some(
      (s) =>
        s.targetMode === true &&
        s.projectPath === session.projectPath &&
        s.id !== sessionId &&
        chatStore.runningSessionIds.includes(s.id),
    )
    if (peerRunning) {
      useUIStore.getState().showNotification(t('chat.targetModePeerRunning'), 'warning')
      return
    }
  }

  // Agent mode operates on the workspace, so a *currently selected* project
  // must be open. A session's historical projectPath does NOT count — without a
  // project selected the session must not run tool calls against a stale
  // workspace path. The app-owned default project is ensured at startup, so
  // this only fires when the user removed it without opening another folder.
  if (agentMode === 'agent') {
    const hasProject = Boolean(
      document.getElementById('file-tree-root')?.getAttribute('data-root-path')
      || useUIStore.getState().rootPath
    )
    if (!hasProject) {
      useUIStore.getState().showNotification('Agent 模式需要先打开一个项目文件夹', 'warning')
      return
    }
  }

  // ── Mark the session as running SYNCHRONOUSLY ──
  // All validations above are sync; from here on everything is wrapped in
  // try/finally. Marking before the first await closes the double-send race
  // (a second sendMessage for the same session queues instead of starting a
  // second loop), and the finally always cleans this up.
  const set = useChatStore.setState.bind(useChatStore)
  set((s) => ({
    runningSessionIds: s.runningSessionIds.includes(sessionId)
      ? s.runningSessionIds
      : [...s.runningSessionIds, sessionId],
    streamingBySession: { ...s.streamingBySession, [sessionId]: { content: '', thinking: '' } },
  }))

  // The live stream only carries the CURRENT LLM round. Once that round commits
  // to messages (addMessage below), the committed render takes over — clearing
  // here prevents the same thinking/text from double-rendering below the
  // committed message while its tools execute (the old content/thinking used to
  // linger in streamingBySession until the next round's reset).
  const clearStream = () => {
    set((s) => ({
      streamingBySession: { ...s.streamingBySession, [sessionId]: { content: '', thinking: '' } },
    }))
  }

  // Idle-clock refresh: every visible piece of progress (stream chunk, tool
  // step, approval dialog) resets the "已 X 分钟无响应" timer. It only runs
  // when the agent loop is genuinely silent — e.g. the model thinking before
  // its first chunk.
  const touchActivity = () => {
    set((s) => ({
      streamLastActivityBySession: { ...s.streamLastActivityBySession, [sessionId]: Date.now() },
    }))
  }
  touchActivity()

  // Stage of the agent loop, surfaced in ChatMessages' "正在…" placeholder so
  // a silent wait shows what the app is actually doing instead of a generic
  // codebase-analysis label. `since` anchors the elapsed-seconds counter.
  const setRunPhase = (phase: AgentRunPhase | null, detail?: string) => {
    set((s) => {
      const runPhaseBySession = { ...s.runPhaseBySession }
      if (phase === null) delete runPhaseBySession[sessionId]
      else runPhaseBySession[sessionId] = { phase, since: Date.now(), ...(detail ? { detail } : {}) }
      return { runPhaseBySession }
    })
  }
  // Pre-stream phase: MCP/skill refresh, system-prompt build, codebase retrieval.
  setRunPhase('preparing')
  // 准备阶段的逐步计时（诊断用）：每一步完成后把「步骤 + 耗时」写进 phase
  // 的 detail（UI 的占位行直接显示），进入首 token 等待前在控制台输出完整分解，
  // 用于定位「准备上下文」到底慢在哪一步。
  const prepTimings: string[] = []
  const timePrepStep = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try {
      return await fn()
    } finally {
      const ms = Math.round(performance.now() - t0)
      prepTimings.push(`${label}=${ms}ms`)
      setRunPhase('preparing', `${label} ${ms}ms`)
    }
  }

  const abortController = new AbortController()
  set((s) => ({ abortControllers: { ...s.abortControllers, [sessionId]: abortController } }))

  let runId: string | undefined
  const usageEvents: UsageEvent[] = []
  // 已增量上报的事件数（目标模式每轮 flush 一次，见循环尾部的增量 flush）
  let flushedUsageCount = 0
  // Accumulated real token usage for the agent run record (badge shows it once
  // the run finishes). Providers may omit usage — the totals just stay 0.
  let runTokensIn = 0
  let runTokensOut = 0
  // Per-run request/cache counters — surfaced in the token badge popover.
  let runRequestCount = 0
  let runCacheHits = 0
  let runCacheTokensSaved = 0
  // Server-side prompt-cache tokens reported by the provider (Anthropic
  // cache_read_input_tokens / DeepSeek prompt_cache_hit_tokens).
  let runCacheReadTokens = 0
  let runCacheWriteTokens = 0

  // Tool pipeline disposers — declared OUTSIDE the try (a try body's consts are
  // invisible to its own finally, which is a sibling block scope), so the
  // finally below can unregister this run's approval/checkpoint hooks.
  let disposeApprovalHook: () => void = () => {}
  let disposeCheckpointHook: () => void = () => {}
  let disposeSupervisorGuard: () => void = () => {}

  // 目标模式监管 guard（见 TARGET_MODE_SUPERVISOR_DENIED 注释）：工具清单里
  // 已隐藏禁用工具，这里兜底拦截幻觉调用，并给 write/create/delete 加
  // targemode 路径门禁。拒绝文案要「教它下一步怎么做」→ 改用 run_subagent。
  if (targetMode) {
    disposeSupervisorGuard = toolExecutor.registerGuard((tc, ctx) => {
      if (ctx.sessionId !== sessionId) return undefined
      if (TARGET_MODE_SUPERVISOR_DENIED.has(tc.name)) {
        const dispatch =
          tc.name === 'run_command'
            ? 'tm-developer（实现/构建）或 tm-tester（验证/测试）'
            : 'tm-developer / tm-ui-developer（按改动类型）'
        return (
          `目标模式：监管 Agent 不允许直接${tc.name === 'run_command' ? '执行命令' : tc.name.startsWith('git_') ? '做变更类 git 操作' : '修改业务代码'}（系统已拦截）。` +
          `请改用 run_subagent 派发 ${dispatch}，prompt 按任务信封模板构造（frontmatter 声明 files_to_modify / acceptance）。`
        )
      }
      if ((tc.name === 'write_file' || tc.name === 'create_directory' || tc.name === 'delete_file') && !isTargemodePath(tc.arguments?.path)) {
        return (
          `目标模式：监管 Agent 只能写 .ourcode/targemode/ 下的文档（规划/状态/日志/信封），当前路径越界（系统已拦截）。` +
          `业务代码的新增/修改/删除请通过 run_subagent 派发 tm-developer / tm-ui-developer 完成。`
        )
      }
      return undefined
    })
  }

  try {
    // Refresh dynamic tools (MCP servers + workspace skills) before building the tool list.
    // Skill tools scope to the RUNNING session's project (global skills always
    // included) — the browsing root would leak other projects' skills in.
    await timePrepStep('刷新MCP工具', () => toolExecutor.refreshMcpTools())
    await timePrepStep('刷新技能', () => toolExecutor.refreshSkillTools(session.projectPath || getWorkspaceRoot()))

  // Build the system prompt with memories / rules / skills / retrieved context
  const lastUserMessage = [...session.messages].reverse().find((m) => m.role === 'user')
  const userContent = lastUserMessage?.content || ''
  const baseSystemPrompt = configGroup.systemPrompt || 'You are a helpful AI coding assistant.'
  // Split the prompt into a byte-stable prefix + per-turn dynamic context so
  // provider prefix caches (OpenAI / DeepSeek / Anthropic) keep hitting across
  // turns instead of re-billing the whole history every time.
  const { stable, dynamic } = await timePrepStep('构建提示词', () => buildSystemPrompt(
    baseSystemPrompt, userContent, lastUserMessage?.contextFiles || [],
    session.projectPath,
    // Pure chat mode has no tool loop — auto-retrieval is its most expensive
    // and least useful step there; explicit @-attached files still get read.
    agentMode !== 'agent',
  ))
  let stableSystemPrompt = stable
  let dynamicContext = dynamic
  // Mode instructions are static text → stable prefix. Target-mode workflow
  // status is per-run state → dynamic context (appended to the final user turn).
  if (agentMode === 'agent') {
    if (targetMode) {
      stableSystemPrompt += TARGET_MODE_INSTRUCTION
      // Bootstrap the state skeleton (idempotent) and inject the current
      // status so the agent resumes from the files instead of its memory.
      // Always the session's own project — not the globally opened folder.
      const root = session.projectPath || getWorkspaceRoot()
      if (root) {
        await ensureInitialized(root)
        const statusMd = await readStatusText(root)
        useChatStore.setState({ targetModeStatus: statusMd ? parseStatus(statusMd) : null })
        if (statusMd) {
          dynamicContext += `\n\n<target_mode_status>\n${statusMd}\n</target_mode_status>`
        }
      }
    } else {
      const planningPhase = (session.projectEditMode || DEFAULT_PROJECT_EDIT_MODE) === 'plan' && !opts?.planApproved
      stableSystemPrompt += planningPhase ? PLAN_MODE_INSTRUCTION : AGENT_MODE_INSTRUCTION
    }
  }
  if (opts?.extraSystemText) {
    stableSystemPrompt += '\n\n' + opts.extraSystemText
  }

  let model = (session.model || configGroup.defaultModel || '').trim()

  // 空模型不发请求：provider 必然回 400 "Unsupported model (model=\"\")"，
  // 且用户看到的是一张难以理解的错误卡。这里提前给出可操作的失败提示。
  if (!model) {
    const msg = '未配置模型，无法开始对话。请在「设置 → API 配置」中为当前配置组填写模型，或使用对话顶部的模型选择器选择模型。'
    chatStore.addMessage(sessionId, { role: 'assistant', content: msg, error: { type: 'unknown', message: msg } })
    return
  }

  // 已知模型列表可用时校验：会话里存着的模型名可能已失效（换过提供商/删过
  // 自定义模型），直接发出去就是 400 "Unsupported model"。列表命中不了时回退
  // 到配置组默认模型；默认模型也不在列表则保留原值（列表可能过期，由 API 报错兜底）。
  {
    const configState = useConfigStore.getState()
    const known = Array.from(new Set([
      ...configState.models.map((m) => m.id),
      ...configState.customModels.map((m) => m.id),
      ...(configState.modelsCache[configGroup.id]?.models || []),
    ])).filter((m) => m.trim())
    if (known.length > 0 && !known.includes(model)) {
      const def = (configGroup.defaultModel || '').trim()
      if (def && known.includes(def)) model = def
    }
  }

  // Build messages from full history (system + all session messages). When a
  // compaction summary exists, the pre-boundary history is replaced by it in
  // this REQUEST view — the original messages stay in storage untouched.
  const summarized = session.summary && session.summaryMessageCount
    ? Math.min(session.summaryMessageCount, session.messages.length)
    : 0
  // 元数据明确标为非视觉的模型：把图片从请求里剥掉（文字照常）。硬发出去
  // provider 必然 400，而且每一轮都会重复这个错误。未收录的模型（元数据缺失）
  // 仍带上图片，由 provider 的错误兜底。
  const visionCapable = lookupModelMetadata(model)?.vision !== false
  if (!visionCapable && session.messages.some((m) => toRequestImages(m.attachments))) {
    useUIStore.getState().showNotification(t('chat.modelNoVision'), 'warning')
  }
  let messages: RequestMessage[] = [
    { role: 'system', content: stableSystemPrompt },
    ...(summarized > 0 ? [{ role: 'system' as const, content: buildSummaryBlock(session.summary!) }] : []),
    ...session.messages.slice(summarized).map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
      toolCalls: toRawToolCalls(m.toolCalls),
      toolCallId: m.toolCallId,
      images: visionCapable ? toRequestImages(m.attachments) : undefined,
    })),
  ]

  // Merge the per-turn dynamic context (memories / retrieved files / editor
  // state) into the request's final user message — NOT persisted to history —
  // so the stable system prompt + history prefix stays byte-identical across
  // turns. The model still sees it as the most recent context.
  if (dynamicContext.trim()) {
    const lastIdx = messages.length - 1
    if (lastIdx >= 0 && messages[lastIdx].role === 'user') {
      messages[lastIdx] = {
        ...messages[lastIdx],
        content: dynamicContext + '\n\n' + messages[lastIdx].content,
      }
    } else {
      messages.push({ role: 'user', content: dynamicContext })
    }
  }

  // Compaction's budget check must estimate the request the model ACTUALLY
  // receives, or the trigger fires at the wrong time:
  // - Old oversized tool results are compacted BEFORE the check (the loop's
  //   compactToolResults is idempotent, so proactive and force paths — and the
  //   estimate and the request — all agree on the same compacted view).
  // - Tool schemas ride on the request body OUTSIDE the messages array; without
  //   counting them as overhead the estimate undercounts the real request by
  //   the full schema size, delaying compaction until the provider overflows.
  // - The ratio's headroom covers a plain reply; thinking models can emit far
  //   more, so a thinking session reserves extra output headroom up front.
  messages = compactToolResults(messages)
  const compactionWindow = getContextWindow(model)
  const overheadTokens = estimateTokens(JSON.stringify(
    toolExecutor.getToolDefinitions()
      .filter((d) => useEditorStore.getState().preferences.aiAutoMemory || d.function.name !== 'remember'),
  ))
  // Unified thinking level (thinkingLevel selector, else thinking/reasoningEffort
  // fallback) — a non-off level means this round can produce a long reasoning
  // block, so reserve output headroom the ratio alone doesn't cover.
  const thinkingLevel = resolveThinkingLevel(session.modelParams)
  const outputReserve = thinkingLevel !== 'off'
    ? Math.min(Math.max(
        session.modelParams.maxTokens > 0 ? session.modelParams.maxTokens : Math.floor(compactionWindow * 0.2),
        4096,
      ), Math.floor(compactionWindow * 0.4))
    : 0

  // Context compaction — trigger fires ONLY when the estimate confirms the
  // history exceeds the model's budget (same 80% headroom the trim uses), or
  // when the provider reported a context-overflow error (force, in the catch
  // below). Original messages are never deleted — the summary replaces history
  // only in this request view. Falls back to the lossy trim when compaction is
  // disabled or the summarizer fails.
  const projectPath = session.projectPath || getWorkspaceRoot()
  const compactionPrefs = useEditorStore.getState().preferences
  const compactionEnabled = compactionPrefs.contextCompaction !== false
  // The model actually used for summaries (may be a cheaper override) — used
  // both for the call and for the usage attribution.
  const summarizeModel = (compactionPrefs.contextCompactionModel || model).trim() || model
  const summarizeHistory = async ({ anchor, history }: { anchor: string; history: string }) => {
    const startedAt = Date.now()
    // The summarizer is a real LLM call (its own TTFT) — surface it as a
    // distinct phase instead of a silent "waiting for the model".
    setRunPhase('compacting')
    // Durable lock: persisted to SQLite BEFORE the summarizer starts, so a
    // crash mid-summary leaves the lock behind — the next load clears it and
    // the pre-crash summary (if any) stays valid. Cleared on every exit path.
    setCompactionLock(true)
    try {
      let tokensIn = 0
      let tokensOut = 0
      const summary = await runSummarizer({
        model: summarizeModel,
        anchor,
        history,
        configGroup,
        signal: abortController.signal,
        onUsage: (u) => {
          tokensIn = u.tokensIn
          tokensOut = u.tokensOut
        },
      })
      // Back to the pre-stream stage — the main request is built next.
      setRunPhase('preparing')
      // Compaction is a real LLM call — bill it to the session like any other.
      usageEvents.push(makeLlmUsageEvent({
        sessionId, projectPath, model: summarizeModel, provider: configGroup.provider,
        startedAt, durationMs: Date.now() - startedAt, ok: true, tokensIn, tokensOut,
      }))
      return summary
    } catch (error: any) {
      // Phase self-heals: the 'waiting' marker before the main request
      // overwrites whatever stage we leave behind on the error path.
      usageEvents.push(makeLlmUsageEvent({
        sessionId, projectPath, model: summarizeModel, provider: configGroup.provider,
        startedAt, ok: false, error: error?.message,
      }))
      throw error
    } finally {
      setCompactionLock(false)
    }
  }
  /** Flip the durable compaction lock in the store AND persist it immediately,
   *  so a crash mid-summarizer leaves it set for the next load to clear. */
  const setCompactionLock = (locked: boolean): void => {
    const s = useChatStore.getState().sessions.find((x) => x.id === sessionId)
    if (!s) return
    if (s.compactionInProgress === locked) return
    useChatStore.setState((st) => ({
      sessions: st.sessions.map((x) => (x.id === sessionId ? { ...x, compactionInProgress: locked } : x)),
    }))
    void chatStore.saveSession(sessionId)
  }
  const applyCompaction = async (force: boolean): Promise<boolean> => {
    const compacted = await maybeCompact({
      session,
      messages,
      force,
      signal: abortController.signal,
      contextWindow: compactionWindow,
      ratio: compactionPrefs.contextCompactionRatio ?? DEFAULT_COMPACTION_RATIO,
      overheadTokens,
      outputReserve,
      compactionEnabled,
      estimateTokens,
      summarize: summarizeHistory,
    })
    if (!compacted) return false
    messages = compacted.messages
    // Keep the LOCAL session reference in sync too — the setState below
    // REPLACES the store object, so without this a second compaction in the
    // same run (context-overflow fallback) would read a stale `session` whose
    // summary is missing, losing the first summary entirely (it is also
    // filtered out of the history by isSummaryMessage).
    session.summary = compacted.summary
    session.summaryMessageCount = compacted.boundaryCount
    // Persist the summary metadata — the finally's saveSession reads the store
    // fresh, so a plain setState is enough for durable storage.
    useChatStore.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, summary: compacted.summary, summaryMessageCount: compacted.boundaryCount } : sess
      ),
    }))
    return true
  }
  if (!(await timePrepStep('上下文压缩', () => applyCompaction(false)))) {
    // Context-window management: trim the oldest history when the estimate
    // exceeds the model's budget (keeps the current user turn + a notice).
    messages = trimHistoryForContext(messages, model)
  }

  // Tool-call pairing: a rebuild (or the trim above) can leave an assistant
  // tool_calls message without its tool responses — strip the unpaired side so
  // the provider doesn't reject the whole request with a 400 ("insufficient
  // tool messages following tool_calls message").
  messages = sanitizeToolPairing(messages)

  // 准备阶段结束，即将进入首 token 等待——把分步耗时打出来，方便定位
  // 「准备上下文」慢在哪一步（UI 的占位行只显示最近完成的一步）。
  if (prepTimings.length > 0) {
    console.warn(`[准备阶段耗时] 会话 ${sessionId} — ${prepTimings.join(' | ')}`)
  }

  // Agent mode: start (or resume) the run record + live trace. Also load the
  // persisted per-project "always allow" list for the approval checks below.
  // Attribute tool usage (MCP / skills / subagents) to this session
  toolExecutor.setSessionContext(sessionId, projectPath)
  if (agentMode === 'agent') {
    const st = useChatStore.getState()
    st.loadToolAllowlist(projectPath)
    st.startAgentRun(sessionId, lastUserMessage?.content || 'Agent 任务', {
      resumeRunId: opts?.resumeRunId,
    })
    // Target mode: the agent runs autonomously — all tool calls for this run
    // are auto-approved (supersedes the removed per-run "auto-run" toggle).
    if (targetMode) useChatStore.setState((s) => ({
      batchApprovedBySession: { ...s.batchApprovedBySession, [sessionId]: true },
    }))
    runId = useChatStore.getState().activeRuns[sessionId]?.runId
    // A resumed run (plan approval / continue) keeps its previous token totals
    // — the loop below adds this leg's usage on top instead of starting fresh.
    if (opts?.resumeRunId && runId) {
      const rec = useChatStore.getState().sessions.find((s) => s.id === sessionId)?.agentRuns?.find((r) => r.id === runId)
      if (rec) {
        runTokensIn = rec.tokensIn || 0
        runTokensOut = rec.tokensOut || 0
        runRequestCount = rec.requestCount || 0
        runCacheHits = rec.cacheHits || 0
        runCacheTokensSaved = rec.cacheTokensSaved || 0
        runCacheReadTokens = rec.cacheReadTokens || 0
        runCacheWriteTokens = rec.cacheWriteTokens || 0
      }
    }
  }

  // Whether a tool needs manual approval in this run. Order of exemptions:
  // project edit mode → per-run batch approval → persisted allowlist.
  const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit_file'])
  const needsApproval = (name: string): boolean => {
    let needs = toolExecutor.requiresApproval(name)
    if (agentMode === 'agent') {
      // Read the CURRENT edit mode live — the anti-flail question can switch
      // it mid-run, and approval rules must follow.
      const mode = useChatStore.getState().sessions.find((s) => s.id === sessionId)?.projectEditMode || DEFAULT_PROJECT_EDIT_MODE
      if (mode === 'full_access') needs = false
      else if (mode === 'auto_edit' && FILE_EDIT_TOOLS.has(name)) needs = false
    }
    if (needs && useChatStore.getState().batchApprovedBySession[sessionId]) needs = false
    if (needs && (useChatStore.getState().toolAllowlist[projectPath] || []).includes(name)) needs = false
    return needs
  }

  // ── Tool pipeline hooks (registered per run, disposed in the finally) ──
  // Approval + checkpoint moved out of the tool loop into ToolExecutor
  // pre-hooks, so every tool call funnels through the same pipeline stages.
  // Hooks filter by ctx.sessionId: the executor is module-level and shared by
  // parallel agent loops, so a hook must never prompt for another session.
  const batchRejectedRef: { current: Set<string> } = { current: new Set() }
  const assistantMsgIdRef: { current: string } = { current: '' }

  disposeApprovalHook = toolExecutor.registerPreHook(createApprovalPreHook({
    sessionId,
    batchRejectedRef,
    needsApproval,
    getPreview: (tc) => toolExecutor.getPreview(tc),
    isAborted: () => abortController.signal.aborted,
    // Show the per-tool approval dialog (project edit mode / batch / allowlist
    // exemptions are all folded into needsApproval above). 60s auto-reject so
    // the loop never hangs on a dangling dialog.
    onDialog: async (tc, preview) => {
      touchActivity() // waiting on the user ≠ model silence
      useChatStore.setState({ pendingApproval: { sessionId, toolCall: tc, preview } })

      // Reject any previous pending approval for this session to prevent
      // dangling promises (each session waits on its own resolve slot)
      if (_approvalResolves.has(sessionId)) {
        _approvalResolves.get(sessionId)!(false)
        _approvalResolves.delete(sessionId)
      }

      return new Promise<boolean>((resolve) => {
        _approvalResolves.set(sessionId, resolve)
        setTimeout(() => {
          if (_approvalResolves.get(sessionId) === resolve) {
            _approvalResolves.delete(sessionId)
            resolve(false)
          }
        }, 60000)
      })
    },
  }))

  disposeCheckpointHook = toolExecutor.registerPreHook(async (tc, ctx) => {
    if (ctx.sessionId !== sessionId) return { allow: true }
    // Snapshot the files a write tool is about to touch (revertable edits).
    // Runs AFTER approval — a rejected call changes nothing, so no snapshot.
    if (CHECKPOINT_TOOLS.has(tc.name)) {
      await captureCheckpoint(sessionId, tc, assistantMsgIdRef.current)
    }
    return { allow: true }
  })

  // Agent 工具调用轮数上限（设置里可配，默认 0 = 无限）。主流工具
  // （Cursor/Windsurf/Claude Code）不设常态上限——20 轮对多文件任务
  // （读文件→改文件→跑测试）经常不够，触发后还得手动点「继续」，既打断流程
  // 又让模型带着已压缩的历史重跑。只在用户主动配置时启用这个防死循环安全阀。
  const maxIterations = useEditorStore.getState().preferences.agentMaxIterations ?? 0
  let iterationsLeft = maxIterations > 0 ? maxIterations : Infinity
  // Set when the loop exits via a natural finish (the model stopped calling
  // tools) — distinguishes "completed" from "ran out of iterations".
  let finishedNaturally = false
  // 计划模式防空转：连续纯只读探索的轮数（见 PLAN_MODE_FLAIL_ROUNDS）
  let readOnlyRounds = 0
  // 防空转提问每个 run 只弹一次——用户若坚持「保持计划模式」，不再每 5 轮
  // 重复打扰（避免消息里塞满「用户回答」噪音）
  let flailAsked = false
  // Context-overflow fallback: the provider rejected a request because the
  // history outgrew the model — compact and retry once per run (never loop).
  let overflowCompactionAttempted = false
  // 命令连续失败熔断状态：累计同一 run_command 的连续失败/超时，达到
  // COMMAND_FAIL_BREAK_ROUNDS 时停下提问（详见该常量注释）。每个 run 只问一次。
  let consecutiveCommandFailures = 0
  let lastFailedCommand = ''
  let commandFailBreakAsked = false
  // 打转守卫状态：本 run 内每个 name+arguments 被调用的次数，以及是否已由
  // 守卫停止（停止时不能再报「已达最大轮数」，两者的原因不同）。
  const repeatCallCounts = new Map<string, number>()
  let loopGuardStopped = false

  while (iterationsLeft-- > 0) {
      if (abortController.signal.aborted) break
      touchActivity() // a new request round resets the idle clock
      // 压缩早期的大体积工具结果，避免每轮重发全量历史导致 token 平方级增长
      // （见 compactToolResults 注释）
      messages = compactToolResults(messages)

      // Agent mode with the default 'plan' edit mode exposes only read-only +
      // agent-control tools until a plan is approved (the planning phase is
      // read-only by design). Other edit modes expose all tools but vary
      // approval. Computed PER ITERATION (not once before the loop) so the
      // plan-mode anti-flail question can switch the edit mode mid-run and it
      // takes effect on the very next round.
      const projectEditMode = useChatStore.getState().sessions.find((s) => s.id === sessionId)?.projectEditMode || DEFAULT_PROJECT_EDIT_MODE
      const usePlanTools = agentMode === 'agent' && projectEditMode === 'plan' && !opts?.planApproved && !targetMode
      // The auto-memory tool is opt-in — hide it when the user disabled it
      const toolDefinitions = (usePlanTools
        ? toolExecutor.getToolDefinitions((name) => PLAN_TOOLS.has(name))
        : toolExecutor.getToolDefinitions(targetMode ? (name) => !TARGET_MODE_SUPERVISOR_DENIED.has(name) : undefined))
        .filter((d) => useEditorStore.getState().preferences.aiAutoMemory || d.function.name !== 'remember')

      // Cache-break diagnostics: sign the byte-stable prefix (system + tools)
      // before the request so a later cache miss can name what changed.
      const toolSig = toolSignature(toolDefinitions)
      const requestSignature = {
        systemHash: djb2Hash(stable),
        toolsHash: toolSig.hash,
        perTool: toolSig.perTool,
      }
      const prevSignature = getPreviousSignature(sessionId)
      rememberRequestSignature(sessionId, requestSignature)
      const stablePrefixEstTokens = estimateTokens(stable) + estimateTokens(JSON.stringify(toolDefinitions))

      // 统一思考档位（thinkingLevel）派生请求参数：max 在支持档位的 provider
      // 上调满（Anthropic/Gemini 16384 预算），不支持的归一为 high。
      const thinkingLevel = resolveThinkingLevel(session.modelParams)
      const req = {
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          toolCallId: m.toolCallId,
          images: m.images,
        })),
        stream: true,
        temperature: session.modelParams.temperature,
        maxTokens: session.modelParams.maxTokens,
        topP: session.modelParams.topP,
        frequencyPenalty: session.modelParams.frequencyPenalty,
        presencePenalty: session.modelParams.presencePenalty,
        thinking: thinkingLevel !== 'off',
        reasoningEffort: thinkingLevel !== 'off' ? thinkingLevel : undefined,
        tools: toolDefinitions,
      }

      let fullContent = ''
      let fullThinking = ''
      let toolCalls: any[] = []
      // Tracks whether this round has emitted its first token — flips the phase
      // from 'waiting' (TTFT) to 'streaming' exactly once, so the per-chunk
      // flush below doesn't spam phase updates.
      let roundStreamStarted = false
      // The LLM request is about to go out — from here until the first token
      // the wait is entirely the provider's time-to-first-token.
      setRunPhase('waiting')
      const reqStartedAt = Date.now()
      let reqTokensIn = 0
      let reqTokensOut = 0
      let reqCacheRead = 0
      let reqCacheWrite = 0
      let cacheHit: { savedTokensIn: number; savedTokensOut: number } | null = null
      // finish_reason on the terminal chunk — used for silent-overflow detection
      // (finish_reason 'length' + zero output = input filled the window).
      let finishReason: string | undefined
      // Wall-clock of the first emitted token — used to persist TTFT on the
      // assistant message (0 when the round never emitted a token).
      let firstTokenAt = 0

      // ── Streaming store updates: batch + throttle ─────────────────────────
      // Every SSE chunk used to trigger TWO separate zustand sets (activity +
      // content), so the conversation re-rendered and re-parsed the growing
      // markdown on EVERY token — the main UI stutter while the model streams.
      // Now a single combined set runs at most once per STREAM_FLUSH_MS; the
      // inner finally force-flushes so the abort/error handlers below read the
      // LATEST accumulated content from the store (never a truncated flush).
      let lastStreamFlushAt = 0
      const flushStream = (force = false) => {
        const now = Date.now()
        if (!force && now - lastStreamFlushAt < STREAM_FLUSH_MS) return
        lastStreamFlushAt = now
        set((s) => ({
          streamLastActivityBySession: { ...s.streamLastActivityBySession, [sessionId]: now },
          streamingBySession: {
            ...s.streamingBySession,
            [sessionId]: { content: fullContent, thinking: fullThinking },
          },
        }))
      }

      try {
        try {
          for await (const chunk of sendLLMRequest(req, configGroup)) {
            if (abortController.signal.aborted) break
            // Accumulate first; any data keeps the idle clock reset, batched
            // into the same set as the content below (no set per token).
            if (chunk.thinking) fullThinking += chunk.thinking
            if (chunk.content) fullContent += chunk.content

            // First real token (content or reasoning) — the TTFT wait is over.
            if (!roundStreamStarted && (chunk.content || chunk.thinking)) {
              roundStreamStarted = true
              firstTokenAt = Date.now()
              setRunPhase('streaming')
            }

            if (chunk.toolCalls) {
              toolCalls = chunk.toolCalls
            }

            if (chunk.finishReason) {
              finishReason = chunk.finishReason
            }

            // Real token usage reported by the provider (parsed by the adapters) —
            // persisted into the usage dashboard instead of being dropped.
            // `|| 0` guards against adapters that report partial usage objects.
            if (chunk.usage) {
              reqTokensIn = chunk.usage.promptTokens || 0
              reqTokensOut = chunk.usage.completionTokens || 0
              reqCacheRead = chunk.usage.cacheReadTokens || 0
              reqCacheWrite = chunk.usage.cacheCreationTokens || 0
            }

            // Client-side cache hit: the response was replayed locally, no API
            // call was made — report the saved tokens so the dashboard shows it.
            if (chunk.cacheHit) {
              cacheHit = chunk.cacheHit
            }

            flushStream()
            if (chunk.done) break
          }
        } finally {
          // Always persist whatever accumulated — the abort/error handlers read
          // streamingBySession[sessionId] right after this block.
          flushStream(true)
        }
      } catch (requestError: any) {
        usageEvents.push(makeLlmUsageEvent({
          sessionId, projectPath, model, provider: configGroup.provider,
          startedAt: reqStartedAt, ok: false, error: requestError.message,
        }))
        // Context overflow: the provider rejected the request because the
        // history outgrew the model window. Compact and retry once — with the
        // history shrunk to a summary the next iteration sends a valid request.
        // Never retried as-is (would fail identically); never loops (once per run).
        const info = classifyLLMError(requestError)
        if (info.contextOverflow && compactionEnabled && !overflowCompactionAttempted) {
          overflowCompactionAttempted = true
          if (await applyCompaction(true)) continue
        }
        throw requestError
      }

      // Silent context overflow: the provider ACCEPTED the request but either
      // truncated it (finish_reason 'length' + zero output = no room left to
      // generate) or reported input exceeding our configured window. These never
      // surface as thrown errors (see classify.ts), so detect them from the
      // response shape and run the same compact-and-retry-once path as the error
      // branch above. Local cache replays are skipped — no real API response.
      if (!cacheHit && compactionEnabled && !overflowCompactionAttempted) {
        const cacheIsSeparate = configGroup.provider === 'anthropic' || configGroup.apiFormat === 'anthropic'
        const inputTokens = reqTokensIn + (cacheIsSeparate ? reqCacheRead + reqCacheWrite : 0)
        if (isSilentContextOverflow({ finishReason, inputTokens, outputTokens: reqTokensOut, contextWindow: compactionWindow })) {
          overflowCompactionAttempted = true
          usageEvents.push(makeLlmUsageEvent({
            sessionId, projectPath, model, provider: configGroup.provider,
            startedAt: reqStartedAt, durationMs: Date.now() - reqStartedAt,
            tokensIn: reqTokensIn, tokensOut: reqTokensOut,
            cacheReadTokens: reqCacheRead, cacheCreationTokens: reqCacheWrite,
          }))
          if (await applyCompaction(true)) continue
        }
      }

      usageEvents.push(makeLlmUsageEvent({
        sessionId, projectPath, model, provider: configGroup.provider,
        startedAt: reqStartedAt,
        durationMs: Date.now() - reqStartedAt,
        tokensIn: cacheHit ? 0 : reqTokensIn,
        tokensOut: cacheHit ? 0 : reqTokensOut,
        cacheHit,
        cacheReadTokens: reqCacheRead,
        cacheCreationTokens: reqCacheWrite,
      }))
      // Cache hits billed nothing — only add the real tokens to the run total.
      runTokensIn += cacheHit ? 0 : reqTokensIn
      runTokensOut += cacheHit ? 0 : reqTokensOut
      // Server-side prompt-cache tokens still count as input on the provider
      // (billed at the cached-read rate) — accumulate them for the badge.
      runCacheReadTokens += reqCacheRead
      runCacheWriteTokens += reqCacheWrite
      // Count every LLM request (cache hits included) + accumulated cache savings.
      runRequestCount += 1
      if (cacheHit) {
        runCacheHits += 1
        runCacheTokensSaved += cacheHit.savedTokensIn + cacheHit.savedTokensOut
      }

      // Persist the REAL context size of this API response so the "已使用 X%"
      // indicator baselines on billing-accurate usage (Claude Code-style) and
      // estimates only messages added since. Provider-aware: Anthropic reports
      // cache separately from input_tokens; OpenAI-compatible prompt_tokens
      // (DeepSeek et al.) already include the cached prefix, so adding cache
      // again there would double-count. Skip local cache replays (no API call,
      // usage is 0) so the previous real baseline is kept.
      const cacheIsSeparate = configGroup.provider === 'anthropic' || configGroup.apiFormat === 'anthropic'
      const contextTokens = reqTokensIn + (cacheIsSeparate ? reqCacheRead + reqCacheWrite : 0) + reqTokensOut
      if (contextTokens > 0) {
        // Real API response — note whether the provider reported cache reads
        // (flips the diagnostics' seen-cache flag as soon as it ever does).
        recordCacheRead(sessionId, reqCacheRead)
        useChatStore.setState((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  lastContextTokens: contextTokens,
                  lastContextMessageCount: sess.messages.length,
                  updatedAt: Date.now(),
                }
              : sess
          ),
        }))
      }

      // Cache-break diagnostics (Claude Code promptCacheBreakDetection style):
      // when the stable prefix should have been cache-read but mostly wasn't,
      // diff the previous request's signature to name the culprit — e.g. a tool
      // description/schema that changed every round (MCP / skill tools with
      // dynamic content) silently busts the whole tools segment every turn.
      // Skipped on local replays (no API call) and tiny prefixes. The generic
      // "system+工具未变" cause is only reported once the provider has actually
      // reported cache reads before — relays that drop cache stats always show
      // 0 and would otherwise cry miss on every round.
      if (
        prevSignature &&
        !cacheHit &&
        stablePrefixEstTokens >= 4096 &&
        reqCacheRead < Math.floor(stablePrefixEstTokens * 0.5)
      ) {
        const report = analyzeCacheBreak(prevSignature, requestSignature)
        const causes = hasSeenCacheRead(sessionId)
          ? report.causes
          : report.causes.filter((c) => !c.includes('未变但缓存未命中'))
        if (causes.length > 0) {
          console.warn(`[cache诊断] 会话 ${sessionId} 提示词缓存未命中 — ${causes.join('；')}`)
        }
      }

      // No tool calls - we're done
      if (toolCalls.length === 0) {
        finishedNaturally = true
        chatStore.addMessage(sessionId, {
          role: 'assistant',
          content: fullContent,
          thinking: fullThinking || undefined,
          runId,
          requestStartedAt: reqStartedAt,
          requestDurationMs: Date.now() - reqStartedAt,
          ttftMs: firstTokenAt ? firstTokenAt - reqStartedAt : undefined,
          requestTokensIn: cacheHit ? 0 : reqTokensIn,
          requestTokensOut: cacheHit ? 0 : reqTokensOut,
        })
        clearStream()
        break
      }

      // Has tool calls - show them and execute
      //
      // A response cut off by max_tokens leaves the trailing tool call(s) with
      // half-written arguments. Executing those would run a truncated
      // write_file/edit_file, and replaying the raw string in the next request
      // fails every later turn — so parse defensively, drop the bad JSON from
      // the outbound history, and refuse those calls below.
      const parsedToolCalls: ToolCall[] = []
      const outboundToolCalls: any[] = []
      const truncatedCallIds = new Set<string>()
      for (const tc of toolCalls) {
        const { args, ok } = parseToolArguments(tc.function.arguments)
        parsedToolCalls.push({ id: tc.id, name: tc.function.name, arguments: args })
        outboundToolCalls.push(ok ? tc : { ...tc, function: { ...tc.function, arguments: '{}' } })
        if (!ok) truncatedCallIds.add(tc.id)
      }

      // ── 打转守卫：统计本 run 内重复的 name+arguments ──
      const repeatCountByCallId = new Map<string, number>()
      let roundRepeatsHalt = false
      for (const tc of parsedToolCalls) {
        if (truncatedCallIds.has(tc.id)) continue
        const sig = toolCallSignature(tc)
        const n = (repeatCallCounts.get(sig) || 0) + 1
        repeatCallCounts.set(sig, n)
        if (n >= REPEAT_CALL_NUDGE) repeatCountByCallId.set(tc.id, n)
        if (n >= REPEAT_CALL_HALT && !POLLING_TOOLS.has(tc.name)) roundRepeatsHalt = true
      }

      // ── 计划模式防空转 ──────────────────────────────────────────────────
      // 计划模式只暴露只读工具。若用户请求明显需要写操作/命令（提交/推送/
      // 安装/执行…），agent 却连续多轮纯只读探索（读文件/搜索，无计划、无
      // 提问），与其让它把轮次和 token 烧在空转上，不如强制弹一次提问，让
      // 用户决定切编辑模式继续、保持只读还是停止。此检查必须在 assistant
      // tool_calls 消息持久化之前：跳过本轮执行时不会留下残缺的 tool 配对。
      // `usePlanTools` 在本轮开头已按实时模式算好。
      if (usePlanTools) {
        const allReadOnly = parsedToolCalls.every((tc) => FLAIL_READ_TOOLS.has(tc.name))
        readOnlyRounds = allReadOnly && WRITE_INTENT_RE.test(userContent) ? readOnlyRounds + 1 : 0
        if (readOnlyRounds >= PLAN_MODE_FLAIL_ROUNDS && !flailAsked) {
          readOnlyRounds = 0
          flailAsked = true
          const question =
            '当前是计划模式，只开放了只读工具（读文件/搜索），无法执行写操作或命令。' +
            `检测到你请求"${userContent.slice(0, 60)}"需要写权限，而我已经连续 ${PLAN_MODE_FLAIL_ROUNDS} 轮只读探索仍无法完成。请选择如何继续：`
          const options = ['切换到自动编辑模式继续', '保持计划模式（只读）', '停止']
          touchActivity() // waiting on the user ≠ model silence
          const answer = await new Promise<string>((resolve) => {
            if (_questionResolves.has(sessionId)) { _questionResolves.get(sessionId)!('（用户取消了上一次提问）'); _questionResolves.delete(sessionId) }
            _questionResolves.set(sessionId, resolve)
            const onSession = useChatStore.getState().activeSessionId === sessionId
            useChatStore.setState({
              pendingQuestion: { sessionId, id: `flail-${Date.now()}`, question, options },
              questionGate: {
                ...useChatStore.getState().questionGate,
                [sessionId]: onSession ? 'auto' : 'confirm',
              },
            })
            // 60s 无人应答按「保持计划模式」继续（与批量审批的兜底一致），
            // 避免用户离席时整个 run 无限挂起
            setTimeout(() => {
              if (_questionResolves.get(sessionId) === resolve) {
                _questionResolves.delete(sessionId)
                resolve('保持计划模式（只读）')
              }
            }, 60000)
          })
          // 把用户的决定作为 user 消息回喂给模型（user 消息无配对约束）。
          let note = ''
          if (answer.includes('自动编辑')) {
            useChatStore.getState().setProjectEditMode(sessionId, 'auto_edit')
            note = '\n（已切换到自动编辑模式，本轮只读探索被跳过——现在可以直接执行写操作/命令了）'
          } else if (answer.includes('停止')) {
            note = '\n（用户选择停止本轮任务）'
            abortController.abort()
          }
          messages.push({ role: 'user', content: `用户回答: ${answer}${note}` })
          chatStore.addMessage(sessionId, { role: 'user', content: `用户回答: ${answer}${note}` })
          clearStream()
          // Waiting on the user's answer — a dialog is up; reset the phase so
          // the placeholder doesn't linger on the stale round's 'streaming'.
          setRunPhase('preparing')
          continue // 跳过本轮只读调用；下一轮按用户决定继续
        }
      }

      // Add assistant message with tool calls
      chatStore.addMessage(sessionId, {
        role: 'assistant',
        content: fullContent,
        thinking: fullThinking || undefined,
        toolCalls: parsedToolCalls,
        runId,
        requestStartedAt: reqStartedAt,
        requestDurationMs: Date.now() - reqStartedAt,
        ttftMs: firstTokenAt ? firstTokenAt - reqStartedAt : undefined,
        requestTokensIn: cacheHit ? 0 : reqTokensIn,
        requestTokensOut: cacheHit ? 0 : reqTokensOut,
      })
      // Round committed — the tool rows below render from this message (with
      // live status via appendToolResult), so the stream's copy must not linger.
      clearStream()
      // Tools are about to execute (their own progress renders via ToolStepRow).
      // Reset the phase so the brief gap after the last tool finishes and before
      // the next round's 'waiting' marker shows a truthful stage, not the stale
      // 'streaming' from the round that just committed.
      setRunPhase('preparing')

      // Add assistant message to messages array for next iteration
      messages.push({
        role: 'assistant',
        content: fullContent,
        toolCalls: outboundToolCalls,
        toolCallId: undefined,
      })

      // The message id of the just-added assistant message (used for checkpoints).
      // Read from THIS session — with parallel conversations getActiveSession()
      // may point at a different session the user switched to.
      const assistantMsgId = useChatStore.getState().sessions.find((x) => x.id === sessionId)?.messages.slice(-1)[0]?.id || ''
      // The checkpoint pre-hook attaches this round's snapshots to this message.
      assistantMsgIdRef.current = assistantMsgId

      let planSubmitted = false

      // Agent mode: offer one batch-approval dialog per round (Windsurf/Cursor
      // style) instead of interrupting on every write tool. Choosing "全部批准"
      // sets batchApproved for the rest of this run; "全部拒绝" marks this
      // round's tools as rejected; "逐个确认" falls through to per-tool dialogs
      // (handled by the approval pre-hook in ToolExecutor).
      if (agentMode === 'agent' && !useChatStore.getState().batchApprovedBySession[sessionId]) {
        const batchTools = parsedToolCalls.filter((tc) => needsApproval(tc.name))
        if (batchTools.length > 0) {
          touchActivity() // waiting on the user ≠ model silence
          const decision = await new Promise<'confirm' | 'all' | 'reject'>((resolve) => {
            if (_batchResolves.has(sessionId)) { _batchResolves.get(sessionId)!('reject'); _batchResolves.delete(sessionId) }
            _batchResolves.set(sessionId, resolve)
            useChatStore.setState({ batchApproval: { sessionId, runId: runId || '', tools: batchTools, previews: batchTools.map((tc) => toolExecutor.getPreview(tc)) } })
            // Auto-reject if the user never responds (60s), so the agent loop
            // doesn't hang forever on a dangling batch dialog
            setTimeout(() => {
              if (_batchResolves.get(sessionId) === resolve) {
                _batchResolves.delete(sessionId)
                resolve('reject')
              }
            }, 60000)
          })
          useChatStore.setState((s) => ({
            batchApproval: s.batchApproval?.sessionId === sessionId ? null : s.batchApproval,
          }))
          if (decision === 'all') {
            useChatStore.getState().approveBatchRun(sessionId)
          } else if (decision === 'reject') {
            batchRejectedRef.current = new Set(batchTools.map((t) => t.id))
          }
        }
      }

      // Execute each tool call. run_subagent calls within the same batch are
      // launched concurrently — each subagent is fully isolated (own executor,
      // permission guard, iteration/token budgets, usage recording), so only
      // execution is parallelized; approvals/checkpoints stay sequential above.
      // Deferred results are awaited together and finalized in original order
      // (all providers match tool results by tool_call_id, so order of the
      // tool messages across the batch is irrelevant).
      // NOTE: tasks are LAZY thunks — runWithConcurrency starts them itself.
      // Eagerly calling execute() here (as before) started every subagent at
      // once and made MAX_PARALLEL_SUBAGENTS a dead cap: a batch of 8 subagents
      // fired 8 concurrent LLM requests regardless of the limit.
      const deferredSubagents: Array<{ tc: ToolCall; run: () => Promise<ToolResult> }> = []
      // 普通工具同样先收集为惰性 thunk，批量结束后并发执行（见 MAX_PARALLEL_TOOLS）。
      const pendingExecutions: Array<{ tc: ToolCall; run: () => Promise<ToolResult> }> = []

      // Record a tool result BOTH in the live request history and as a
      // standalone session message. The API requires every assistant tool_calls
      // message to be followed by tool messages answering each tool_call_id —
      // without the persisted copy, a later turn rebuilds a history with an
      // orphaned tool_calls message and the provider rejects it with a 400
      // ("insufficient tool messages following tool_calls message"). The UI
      // still renders results inline via toolResults; the standalone messages
      // are skipped by ChatMessages/ChatMessage and exist only to keep the
      // request history pairing-valid.
      const recordToolMessage = (toolCallId: string, content: string): void => {
        messages.push({ role: 'tool', content, toolCallId, toolCalls: undefined })
        chatStore.addMessage(sessionId, { role: 'tool', content, toolCallId, runId })
      }

      // Wall-clock start of each dispatched tool call, keyed by toolCallId —
      // populated as the batch is dispatched and read back when each result
      // finalizes, so the trajectory view gets a per-tool duration.
      const toolStartedAtById = new Map<string, number>()
      /** Attach wall-clock timing to a tool result before it's persisted. */
      const withToolTiming = (tc: ToolCall, result: ToolResult) => {
        const startedAt = toolStartedAtById.get(tc.id)
        const finishedAt = Date.now()
        return {
          ...result,
          startedAt,
          finishedAt,
          durationMs: startedAt != null ? finishedAt - startedAt : undefined,
        }
      }

      // Images a tool result carries (browser_screenshot) cannot be pushed where
      // the result lands: providers require EVERY tool message of this round's
      // tool_calls before any other role, and finalize runs one result at a time
      // in input order. So they accumulate here and flush after the whole batch.
      const roundImages: Array<{ mimeType: string; dataBase64: string }> = []
      const roundImageNotes: string[] = []

      const finalizeToolResult = (tc: ToolCall, incoming: ToolResult): void => {
        // 打转提醒挂在被重复的那条结果尾部，而不是另插一条消息：provider 对
        // 角色交替和 tool_call_id 配对都有要求，只有 tool 结果是永远合法的。
        const repeats = repeatCountByCallId.get(tc.id)
        const result: ToolResult = repeats
          ? {
              ...incoming,
              result: `${incoming.result}\n\n[系统提醒] 你已第 ${repeats} 次用完全相同的参数调用 ${tc.name}，结果不会改变。请改变做法（换参数/换工具）或直接给出结论，不要重复此调用。`,
            }
          : incoming
        // A user-denied call shows 'rejected' (not 'error') in the trace —
        // the pipeline marks denials via result.rejected.
        useChatStore.getState().setTraceStatus(sessionId, tc.id, result.rejected ? 'rejected' : result.isError ? 'error' : 'success')
        touchActivity() // tool finished — the agent is working, not idle
        // 命令连续失败计数：run_command 失败/超时以 "Error:" 开头的文本返回，
        // ToolExecutor 未必置 isError —— 两种都算，供循环末尾的熔断使用。
        if (tc.name === 'run_command') {
          const failed = result.isError || String(result.result).startsWith('Error:')
          consecutiveCommandFailures = failed ? consecutiveCommandFailures + 1 : 0
          if (failed) lastFailedCommand = String(tc.arguments?.command || '')
        }
        // Persist/display the result WITHOUT its base64: toolResults are
        // JSON.stringify'd into SQLite and re-read on every session load, so a
        // few screenshots would park megabytes in the message and the UI has no
        // use for them (the image goes to the model, not the transcript).
        const { images, ...persistable } = result
        chatStore.appendToolResult(sessionId, assistantMsgId, withToolTiming(tc, persistable))
        recordToolMessage(tc.id, result.result)
        if (images?.length) {
          if (lookupModelMetadata(model)?.vision !== false) roundImages.push(...images)
          // Non-vision model: an image part would be a 400. Say so rather than
          // silently dropping what the tool claimed it attached.
          else roundImageNotes.push(`[${tc.name}] 图片已获取但当前模型不支持图片输入，未送达。请改用文本方式判断（页面文本 / 控制台输出）。`)
        }
        // Write tools changed files on disk — notify open editors to reload.
        // multi_edit_file touches one path per entry in its edits array, so it
        // must notify each of them (its `arguments.path` is undefined).
        if (CHECKPOINT_TOOLS.has(tc.name)) {
          for (const changedPath of writeToolPaths(tc.name, tc.arguments)) notifyFileChanged(changedPath)
        }
      }

      for (const tc of parsedToolCalls) {
        if (abortController.signal.aborted) break
        touchActivity() // tool phase counts as activity, not model silence

        // Execution trace entry (live tool-call status) — record the wall-clock
        // start here so withToolTiming can compute a per-tool duration when the
        // result lands (concurrent tools each finalize on their own timeline).
        const toolStartedAt = Date.now()
        toolStartedAtById.set(tc.id, toolStartedAt)
        useChatStore.getState().appendTrace(sessionId, {
          id: uuidv4(),
          toolCallId: tc.id,
          name: tc.name,
          kind: getToolKind(tc.name),
          status: 'running',
          summary: summarizeToolCall(tc),
          startedAt: toolStartedAt,
        })

        // ── 参数被 max_tokens 截断：拒绝执行，但保留 tool 配对 ──
        if (truncatedCallIds.has(tc.id)) {
          const result = 'Error: 工具参数不完整（响应在 max_tokens 处被截断），本次未执行。请把改动拆小后重试，或先说明还剩下哪些步骤。'
          chatStore.appendToolResult(sessionId, assistantMsgId, withToolTiming(tc, { toolCallId: tc.id, name: tc.name, result, isError: true }))
          recordToolMessage(tc.id, result)
          useChatStore.getState().setTraceStatus(sessionId, tc.id, 'error')
          continue
        }

        // ── manage_todo: update the visible todo list ──
        if (tc.name === 'manage_todo') {
          const todos = normalizeTodos(tc.arguments.todos)
          chatStore.setTodos(sessionId, todos)
          const result = `任务列表已更新 (${todos.length} 项)`
          chatStore.appendToolResult(sessionId, assistantMsgId, withToolTiming(tc, { toolCallId: tc.id, name: tc.name, result }))
          recordToolMessage(tc.id, result)
          useChatStore.getState().setTraceStatus(sessionId, tc.id, 'success')
          continue
        }

        // ── submit_plan: save the plan and pause for approval ──
        if (tc.name === 'submit_plan') {
          const plan = {
            title: String(tc.arguments.title || '执行计划'),
            steps: Array.isArray(tc.arguments.steps) ? tc.arguments.steps : [],
          }
          useChatStore.setState((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId
                ? { ...sess, planContent: JSON.stringify(plan), planStatus: 'pending_approval' as const, updatedAt: Date.now() }
                : sess
            ),
          }))
          if (runId) {
            useChatStore.getState().setRunStatus(runId, 'waiting_plan', { plan: JSON.stringify(plan) })
            useChatStore.getState().setTraceStatus(sessionId, tc.id, 'success')
          }
          const result = '计划已提交，等待用户批准。'
          chatStore.appendToolResult(sessionId, assistantMsgId, withToolTiming(tc, { toolCallId: tc.id, name: tc.name, result }))
          recordToolMessage(tc.id, result)
          planSubmitted = true
          break
        }

        // ── ask_user_question: prompt the user, feed the answer back ──
        if (tc.name === 'ask_user_question') {
          const answer = await new Promise<string>((resolve) => {
            if (_questionResolves.has(sessionId)) { _questionResolves.get(sessionId)!('（用户取消了上一次提问）'); _questionResolves.delete(sessionId) }
            _questionResolves.set(sessionId, resolve)
            // Gate: if the user is already viewing this session the dialog may
            // show immediately ('auto'); otherwise wait until they switch to it
            // and confirm via the QuestionConfirmBar ('confirm').
            const onSession = useChatStore.getState().activeSessionId === sessionId
            touchActivity() // waiting on the user ≠ model silence
            useChatStore.setState({
              pendingQuestion: {
                sessionId,
                id: tc.id,
                question: String(tc.arguments.question || '请确认'),
                options: Array.isArray(tc.arguments.options) ? tc.arguments.options.map(String) : undefined,
                multiSelect: tc.arguments.multiSelect === true,
                preview: Array.isArray(tc.arguments.preview) ? tc.arguments.preview.map(String) : undefined,
              },
              questionGate: {
                ...useChatStore.getState().questionGate,
                [sessionId]: onSession ? 'auto' : 'confirm',
              },
            })
          })
          const result = `用户回答: ${answer}`
          chatStore.appendToolResult(sessionId, assistantMsgId, withToolTiming(tc, { toolCallId: tc.id, name: tc.name, result }))
          recordToolMessage(tc.id, result)
          useChatStore.getState().setTraceStatus(sessionId, tc.id, 'success')
          continue
        }

        // ── Execute the tool (approval + checkpoint live in the ToolExecutor
        // pipeline hooks registered above; denials come back as rejected
        // results with the same '用户拒绝了此操作' text as before). ──
        // run_subagent calls are deferred for parallel execution; 普通工具也
        // 收集为惰性 thunk（不在此处 await），整批收集完统一并发执行：模型在同一
        // 响应里发出的多个独立工具调用（如 git_status + git_diff + 读多个文件）
        // 并行跑，避免逐个串行等待。只有执行阶段并行。
        const runContext = {
          sessionId,
          projectPath,
          // Let run_subagent route its live progress to the UI (keyed by the
          // parent tool call id) and react to the user's Stop button.
          toolCallId: tc.id,
          abortSignal: abortController.signal,
        }
        const runTool = (tc: ToolCall) => () => toolExecutor.execute(tc, runContext).catch((error: any) => ({
          toolCallId: tc.id,
          name: tc.name,
          result: `Error: ${error?.message || String(error)}`,
          isError: true,
        }))
        if (tc.name === 'run_subagent') {
          // Lazy thunk — the actual execution starts inside runWithConcurrency
          // so the concurrency cap actually limits in-flight subagents.
          deferredSubagents.push({ tc, run: runTool(tc) })
          continue
        }

        pendingExecutions.push({ tc, run: runTool(tc) })
      }

      // Run all regular tools from this batch concurrently (capped), finalize
      // in input order. All providers match tool results by tool_call_id, so
      // the order of the tool messages across the batch is irrelevant.
      if (pendingExecutions.length > 0) {
        const settled = await runWithConcurrency(
          pendingExecutions.map((e) => e.run),
          MAX_PARALLEL_TOOLS,
        )
        for (let i = 0; i < pendingExecutions.length; i++) {
          const { tc } = pendingExecutions[i]
          const s = settled[i]
          finalizeToolResult(
            tc,
            s.ok && s.value
              ? s.value
              : {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: `Error: ${String(s.reason ?? '工具执行失败')}`,
                  isError: true,
                },
          )
        }
      }

      // Await the deferred subagents concurrently (capped), finalize in order
      if (deferredSubagents.length > 0) {
        const settled = await runWithConcurrency(
          deferredSubagents.map((d) => d.run),
          MAX_PARALLEL_SUBAGENTS,
        )
        for (let i = 0; i < deferredSubagents.length; i++) {
          const { tc } = deferredSubagents[i]
          const s = settled[i]
          finalizeToolResult(
            tc,
            s.ok && s.value
              ? s.value
              : {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: `Error: ${String(s.reason ?? '子智能体执行失败')}`,
                  isError: true,
                },
          )
        }
      }

      // 工具批全部落库后，才把图片作为一条 user 消息交给模型（role:'tool' 在
      // 这里的 adapter 只承载文本）。放在批尾：任何一条 tool 消息之前插入其他
      // 角色都会让 OpenAI 系以「insufficient tool messages」拒掉整轮。
      if (roundImages.length || roundImageNotes.length) {
        messages.push({
          role: 'user',
          content: roundImageNotes.length
            ? roundImageNotes.join('\n')
            : '以上是本轮工具返回的截图，请据此判断页面状态。',
          images: roundImages.length ? roundImages : undefined,
        })
      }

      // Plan submitted — pause the loop until the user approves
      if (planSubmitted) break

      // ── 打转守卫：提醒后仍原样重复，停下来 ──
      // 与「命令连续失败熔断」不同，这里不打断问用户：同样的调用重复到第
      // REPEAT_CALL_HALT 次已经没有任何信息量，继续跑只会把预算烧光。
      if (roundRepeatsHalt) {
        loopGuardStopped = true
        chatStore.addMessage(sessionId, {
          role: 'assistant',
          content: `[已停止：同一个工具调用以完全相同的参数重复了 ${REPEAT_CALL_HALT} 次，结果不会改变。请补充缺失的信息或调整任务描述后重试。]`,
          runId,
        })
        clearStream()
        break
      }

      // ── 命令连续失败熔断 ──────────────────────────────────────────────
      // 同一 run_command 连续失败/超时达到阈值：停下弹提问让用户决定，而不是
      // 让 agent 无限原样重试或换姿势自救。targetMode 自主运行不打断；每个
      // run 只问一次；60s 无人应答按「跳过验证继续」兜底（与 flail 一致）。
      if (consecutiveCommandFailures >= COMMAND_FAIL_BREAK_ROUNDS && !commandFailBreakAsked && !targetMode) {
        consecutiveCommandFailures = 0
        commandFailBreakAsked = true
        const question =
          `run_command 已连续 ${COMMAND_FAIL_BREAK_ROUNDS} 次执行失败或超时` +
          (lastFailedCommand ? `（最近一次：${lastFailedCommand.slice(0, 80)}）` : '') +
          `。继续原样重试大概率再次失败，请选择如何继续：`
        const options = ['跳过验证，直接完成剩余工作', '加大超时后重试一次', '停止']
        touchActivity() // waiting on the user ≠ model silence
        const answer = await new Promise<string>((resolve) => {
          if (_questionResolves.has(sessionId)) { _questionResolves.get(sessionId)!('（用户取消了上一次提问）'); _questionResolves.delete(sessionId) }
          _questionResolves.set(sessionId, resolve)
          const onSession = useChatStore.getState().activeSessionId === sessionId
          useChatStore.setState({
            pendingQuestion: { sessionId, id: `cmdbreak-${Date.now()}`, question, options },
            questionGate: {
              ...useChatStore.getState().questionGate,
              [sessionId]: onSession ? 'auto' : 'confirm',
            },
          })
          setTimeout(() => {
            if (_questionResolves.get(sessionId) === resolve) {
              _questionResolves.delete(sessionId)
              resolve('跳过验证，直接完成剩余工作')
            }
          }, 60000)
        })
        let note = ''
        if (answer.includes('停止')) {
          note = '\n（用户选择停止）'
          abortController.abort()
        } else if (answer.includes('加大超时')) {
          note = '\n（用户选择加大超时后重试一次：请用 run_command 的 timeoutMs 参数重跑已失败的命令，如 timeoutMs=120000）'
        } else {
          note = '\n（用户选择跳过验证：请直接完成剩余工作，不要重复执行已失败的命令）'
        }
        messages.push({ role: 'user', content: `用户回答: ${answer}${note}` })
        chatStore.addMessage(sessionId, { role: 'user', content: `用户回答: ${answer}${note}` })
        clearStream()
      }

      // 目标模式：每轮增量上报 token 消耗 —— 此前 usage 只在循环结束时统一
      // flush，长跑期间预算看板恒显 0.00M、熔断也看不到消耗。增量 flush 后
      // 预算/触顶熔断实时生效（子 Agent 的消耗本就由 subagentRunner 实时上报）。
      if (targetMode && usageEvents.length > flushedUsageCount) {
        flushUsageEvents(usageEvents.slice(flushedUsageCount))
        flushedUsageCount = usageEvents.length
      }

      // Reset streaming state for next iteration
      set((s) => ({
        streamingBySession: { ...s.streamingBySession, [sessionId]: { content: '', thinking: '' } },
      }))
    }

    // Agent loop exhausted without finishing (last iteration still had tool calls).
    // Notify instead of silently stopping — the UI shows a Continue button.
    // `finishedNaturally` guards the edge where the agent completed on its last
    // allowed iteration: iterationsLeft is 0 there too, but a "[已达最大轮数]"
    // message would be misleading. 无限（默认）时 iterationsLeft 恒为 Infinity，
    // 此分支不会触发。
    if (iterationsLeft <= 0 && maxIterations > 0 && !finishedNaturally && !loopGuardStopped && !abortController.signal.aborted && !planWasSubmitted(sessionId)) {
      chatStore.addMessage(sessionId, {
        role: 'assistant',
        content: `[已达到最大工具调用轮数 (${maxIterations})。点击下方"继续"按钮可继续执行。]`,
        runId,
      })
      // Target mode keeps the agent going after rounds are exhausted — it only
      // stops when the user judges the goal done (or queues their own message,
      // whose intent wins over resuming the old trajectory).
      const queuedPending = (useChatStore.getState().queuedMessagesBySession[sessionId] || []).length > 0
      if (targetMode && !queuedPending) {
        setTimeout(() => { useChatStore.getState().continueGeneration(sessionId) }, 150)
      }
    }
  } catch (error: any) {
    const stream = useChatStore.getState().streamingBySession[sessionId]
    if (error.name === 'AbortError') {
      if (stream?.content) {
        chatStore.addMessage(sessionId, {
          role: 'assistant',
          content: stream.content + '\n\n[生成已停止]',
          thinking: stream.thinking || undefined,
          runId,
        })
      }
    } else {
      // Structured, user-friendly error card instead of dumping the raw
      // upstream error (which may be a JSON body) into the chat as text.
      // Redact with the request's own secrets — a provider error body may echo
      // the API key back (defense in depth on LLMClient's choke-point redact).
      const chatError = parseLLMError(error, {
        redact: {
          apiKey: configGroup.apiKey,
          baseUrl: configGroup.baseUrl,
          customHeaders: configGroup.customHeaders,
        },
      })
      console.error('发送消息失败:', redactSecrets(error instanceof Error ? error.message : 'Unknown error', {
        apiKey: configGroup.apiKey,
        baseUrl: configGroup.baseUrl,
        customHeaders: configGroup.customHeaders,
      }))
      chatStore.addMessage(sessionId, {
        role: 'assistant',
        content: chatError.message,
        error: chatError,
        runId,
      })
      if (runId) {
        useChatStore.getState().setRunStatus(runId, 'error', { lastError: chatError.message })
      }
    }
  } finally {
    // Unregister this run's pipeline hooks — the executor is shared across
    // sessions, so a stale hook would prompt for another run's tool calls.
    disposeApprovalHook()
    disposeCheckpointHook()
    disposeSupervisorGuard()
    // Finalize the agent run record (status / counts) for the tasks panel
    if (runId) {
      // Don't let the finally block downgrade an errored run back to 'done' —
      // the unconditional overwrite used to put a green "已完成" badge next to
      // the red error card the chat just showed.
      const rec = useChatStore.getState().sessions.find((s) => s.id === sessionId)?.agentRuns?.find((r) => r.id === runId)
      const finalStatus: AgentRun['status'] = abortController.signal.aborted
        ? 'stopped'
        : rec?.status === 'error'
          ? 'error'
          : planWasSubmitted(sessionId)
            ? 'waiting_plan'
            : 'done'
      useChatStore.getState().finishAgentRun(sessionId, runId, finalStatus, {
        tokensIn: runTokensIn,
        tokensOut: runTokensOut,
        requestCount: runRequestCount,
        cacheHits: runCacheHits,
        cacheTokensSaved: runCacheTokensSaved,
        cacheReadTokens: runCacheReadTokens,
        cacheWriteTokens: runCacheWriteTokens,
      })
    }
    // Clear ONLY this session's run state — parallel conversations keep their
    // own running flags / controllers / dialogs untouched.
    set((s) => {
      const runningSessionIds = s.runningSessionIds.filter((id) => id !== sessionId)
      const streamingBySession = { ...s.streamingBySession }
      delete streamingBySession[sessionId]
      const runPhaseBySession = { ...s.runPhaseBySession }
      delete runPhaseBySession[sessionId]
      const streamLastActivityBySession = { ...s.streamLastActivityBySession }
      delete streamLastActivityBySession[sessionId]
      const abortControllers = { ...s.abortControllers }
      delete abortControllers[sessionId]
      const batchApprovedBySession = { ...s.batchApprovedBySession }
      delete batchApprovedBySession[sessionId]
      const questionGate = { ...s.questionGate }
      delete questionGate[sessionId]
      return {
        runningSessionIds,
        streamingBySession,
        runPhaseBySession,
        streamLastActivityBySession,
        abortControllers,
        batchApprovedBySession,
        questionGate,
        pendingApproval: s.pendingApproval?.sessionId === sessionId ? null : s.pendingApproval,
        pendingQuestion: s.pendingQuestion?.sessionId === sessionId ? null : s.pendingQuestion,
        batchApproval: s.batchApproval?.sessionId === sessionId ? null : s.batchApproval,
      }
    })
    _approvalResolves.delete(sessionId)
    _batchResolves.delete(sessionId)
    _questionResolves.delete(sessionId)
    chatStore.saveSession(sessionId)

    // Persist this run's token/timing events into the usage dashboard
    // （目标模式下循环内已增量上报过，这里只补 flush 尾差，避免重复累计）
    flushUsageEvents(usageEvents.slice(flushedUsageCount))

    // Process queued messages (type-ahead while the agent was working) — the
    // queue is per session, so a queue drain can never send into the session
    // the user switched to meanwhile.
    const queued = useChatStore.getState().queuedMessagesBySession[sessionId] || []
    if (queued.length > 0) {
      const next = queued[0]
      useChatStore.setState((s) => ({
        queuedMessagesBySession: { ...s.queuedMessagesBySession, [sessionId]: queued.slice(1) },
      }))
      setTimeout(() => { useChatStore.getState().sendMessage(sessionId, next.content, undefined, next.attachments) }, 50)
    }

    // Deliver inbound cross-session messages (send_message from other sessions)
    // that were queued while this session was generating. One per loop end —
    // the relaunched loop's own finally drains the next, so messages for the
    // same session are processed strictly one at a time.
    const inbound = useChatStore.getState().inboundQueue
    const inboundIdx = inbound.findIndex((m) => m.targetSessionId === sessionId)
    if (inboundIdx !== -1) {
      const item = inbound[inboundIdx]
      useChatStore.setState({ inboundQueue: inbound.filter((_, i) => i !== inboundIdx) })
      chatStore.addMessage(sessionId, { role: 'user', content: item.content })
      if (item.hold) {
        void chatStore.saveSession(sessionId)
      } else {
        markInboundLaunch(sessionId)
        void runAgentLoop(sessionId).finally(() => { markInboundSettled(sessionId) })
      }
    }
  }
}

/** Check whether the current session just submitted a plan (avoid double exhausted-message) */
function planWasSubmitted(sessionId: string): boolean {
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  return session?.planStatus === 'pending_approval'
}

/**
 * Snapshot the file(s) a write tool is about to touch so the user can revert.
 * Stored in SQLite via IPC (shared checkpoint service, also used by subagents);
 * mirrored into the renderer's checkpoint list.
 */
async function captureCheckpoint(sessionId: string, tc: ToolCall, messageId: string): Promise<void> {
  try {
    const checkpoint = await captureCheckpointService(sessionId, tc, messageId)
    if (checkpoint) {
      useChatStore.setState((s) => ({ checkpoints: [checkpoint, ...s.checkpoints] }))
    }
  } catch (error) {
    console.error('创建检查点失败:', error)
  }
}

/** Notify open editors that a file changed on disk (via tool execution) */
function notifyFileChanged(path: string): void {
  window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: path }))
}
