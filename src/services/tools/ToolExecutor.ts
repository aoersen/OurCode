/**
 * Tool Executor - handles running tools and managing approval flow
 */
import { v4 as uuidv4 } from 'uuid'
import { Tool, ToolCall, ToolResult, ToolDefinition } from './types'
import { createToolRegistry, toToolDefinitions } from './ToolRegistry'
import { toSkillToolDefinitions, loadSkillContent, getWorkspaceRoot } from '@/services/skills/skillManager'
import type { UsageEvent, UsageEventCategory } from '@/types'
import { truncateToolOutput, ToolOutputLimits, shouldSpill, buildSpillPreview } from './truncate'
import { runWithTimeout } from './withTimeout'
import { redactSecrets, type RedactSecretsOptions } from '@/services/llm/redact'
import { writeToolPaths } from './writePaths'

/** Execution context for one tool call (falls back to the shared session context) */
export interface ToolExecuteContext {
  sessionId?: string
  projectPath?: string
  /** The id of the tool call being executed — forwarded into the tool's own
   *  context so run_subagent can route its live progress to the UI. */
  toolCallId?: string
  /** Abort signal of the enclosing agent run — forwarded into the tool's own
   *  context so long-running tools can be cancelled by the user's Stop button. */
  abortSignal?: AbortSignal
}

// Tool-output truncation limits (wired from chatStore so every executor
// instance — main loop + subagents — shares the user's preferences).
let toolOutputLimits: () => ToolOutputLimits = () => ({})
export function configureToolOutput(limits: () => ToolOutputLimits): void {
  toolOutputLimits = limits
}

// Secret redaction for tool-error text and usage telemetry. Wired from
// chatStore with a lazy accessor over the active config group — the request
// path itself is already redacted at LLMClient's choke point; this covers the
// tool-error surfaces that never see the request (MCP errors, usage events).
let secretRedaction: () => RedactSecretsOptions | undefined = () => undefined
export function configureSecretRedaction(getSecrets: () => RedactSecretsOptions | undefined): void {
  secretRedaction = getSecrets
}

// ── Tool pipeline hooks ──────────────────────────────────────────────
// Execution flows through five stages, each extensible from outside the class:
//   guards → pre hooks → around hooks + core → post hooks → result observers.
// Guards are MONOTONIC: they can only deny (return a reason); nothing later
// may re-grant a denied call. Pre hooks may allow or deny (deny is terminal).
// Around hooks wrap core execution. Post hooks rewrite the result. Result
// observers receive the final result and must not throw.

/** Pre-hook outcome: allow, or deny (terminal — nothing later re-grants). */
export type PreHookOutcome = { allow: true } | { deny: true; reason: string }
/** Guard: returns a denial reason string, or undefined to allow. Deny-only. */
export type ToolGuard = (toolCall: ToolCall, ctx: ToolExecuteContext) => string | undefined | Promise<string | undefined>
/** Pre hook: allow or deny (approval dialogs, checkpoint capture). */
export type ToolPreHook = (toolCall: ToolCall, ctx: ToolExecuteContext) => PreHookOutcome | Promise<PreHookOutcome>
/** Around hook: wraps the core execution (timeout, retry, metrics). `next`
 *  may be called with a ctx override (e.g. a composed AbortSignal). */
export type ToolAroundHook = (
  toolCall: ToolCall,
  ctx: ToolExecuteContext,
  next: (ctxOverride?: ToolExecuteContext) => Promise<ToolResult>,
) => Promise<ToolResult>
/** Post hook: rewrites the result (spill/truncate, redaction). */
export type ToolPostHook = (toolCall: ToolCall, result: ToolResult, ctx: ToolExecuteContext) => ToolResult | Promise<ToolResult>
/** Result observer: fire-and-forget notification (usage recording). */
export type ToolResultObserver = (toolCall: ToolCall, result: ToolResult, ctx: ToolExecuteContext) => void

/** File-write tools gated by the read-before-write guard below. */
const READ_GUARD_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'multi_edit_file'])

/**
 * Native git tools built into the registry. When present they shadow the same
 * tools from the bundled git MCP server (`mcp__git__git_status` etc.) so the
 * model never sees two overlapping sets of git tools.
 */
const NATIVE_GIT_TOOLS = new Set([
  'git_status', 'git_diff', 'git_log', 'git_branch', 'git_add', 'git_commit', 'git_push', 'git_split_commit',
])

/** Normalize a path for read-tracking comparisons — Windows paths differ only
 *  in case and slash direction, and the model may not spell them identically. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

export class ToolExecutor {
  private tools: Tool[]
  private toolMap: Map<string, Tool>
  /** Dynamic tools from MCP servers (fetched via IPC, merged into definitions) */
  private dynamicTools: ToolDefinition[] = []
  /** Dynamic skill tools (skill__<name>) from the workspace skill manager */
  private skillTools: ToolDefinition[] = []
  /** Session context for usage attribution (set by the agent loop) */
  private sessionContext: ToolExecuteContext | null = null
  /** Files each session has already seen — read_file successes plus files it
   *  just created. Keyed per session so parallel agent loops stay isolated;
   *  subagents get their own executor instance, so they must read before
   *  writing within their own scope. */
  private readFilesBySession = new Map<string, Set<string>>()
  /** Five-stage pipeline registries (see the hook types above). */
  private guards: ToolGuard[] = []
  private preHooks: ToolPreHook[] = []
  private aroundHooks: ToolAroundHook[] = []
  private postHooks: ToolPostHook[] = []
  private resultObservers: ToolResultObserver[] = []
  /** Per-call start time for usage attribution (observers run after the result
   *  is known, so the timing is captured at execute() entry). */
  private startedAtByCall = new Map<string, number>()

  constructor() {
    this.tools = createToolRegistry()
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]))
    this.registerBuiltinPipeline()
  }

  /** Register a deny-only guard (monotonic: once denied, nothing re-grants).
   *  Returns a dispose function. */
  registerGuard(guard: ToolGuard): () => void {
    return this.pushDisposable(this.guards, guard)
  }

  /** Register a pre hook (allow / deny). Denials short-circuit the pipeline. */
  registerPreHook(hook: ToolPreHook): () => void {
    return this.pushDisposable(this.preHooks, hook)
  }

  /** Register an around hook wrapping core execution (timeout, retry, metrics). */
  registerAroundHook(hook: ToolAroundHook): () => void {
    return this.pushDisposable(this.aroundHooks, hook)
  }

  /** Register a post hook that rewrites the result (spill/truncate, redaction). */
  registerPostHook(hook: ToolPostHook): () => void {
    return this.pushDisposable(this.postHooks, hook)
  }

  /** Register a result observer (usage recording, telemetry). Never throws. */
  registerResultObserver(observer: ToolResultObserver): () => void {
    return this.pushDisposable(this.resultObservers, observer)
  }

  private pushDisposable<T>(list: T[], item: T): () => void {
    list.push(item)
    return () => {
      const i = list.indexOf(item)
      if (i !== -1) list.splice(i, 1)
    }
  }

  /** Built-in pipeline stages — the class's own safety net, present on every
   *  executor (main loop + subagents): read-before-write guard, cooperative
   *  deadline, read-tracking + output cap/spill, usage recording. */
  private registerBuiltinPipeline(): void {
    // Guard: read-before-write (deny-only, monotonic). Runs BEFORE approval so
    // a call that is doomed anyway (file never read) never pops an approval
    // dialog. Only existing files are gated (a brand-new file can't be read);
    // multi_edit_file checks every target path in its edits array. Only
    // enforced when a session context exists.
    this.registerGuard(async (toolCall, ctx) => {
      if (!READ_GUARD_TOOLS.has(toolCall.name) || !ctx.sessionId) return undefined
      const targets = writeToolPaths(toolCall.name, toolCall.arguments)
      for (const targetPath of targets) {
        if (targetPath && !this.hasReadFile(ctx.sessionId, targetPath) && await this.fileExists(targetPath)) {
          return `Error: File has not been read yet. Read it first before writing to it.（文件尚未读取，请先调用 read_file 读取后再写入）: ${targetPath}`
        }
      }
      return undefined
    })

    // Around: cooperative deadline for tools that declare timeoutMs. The
    // composed signal (budget + the enclosing run's Stop) is threaded into the
    // core execution; the hard race settles even if the tool ignores it.
    this.registerAroundHook(async (toolCall, ctx, next) => {
      const timeoutMs = this.toolMap.get(toolCall.name)?.timeoutMs ?? 0
      return runWithTimeout(
        (signal) => next({ ...ctx, abortSignal: signal }),
        timeoutMs,
        ctx.abortSignal,
      )
    })

    // Post: read-tracking (a successful read/write makes the path known).
    this.registerPostHook((toolCall, result, ctx) => {
      if (toolCall.name === 'read_file' || toolCall.name === 'write_file') {
        this.markRead(ctx.sessionId, String(toolCall.arguments?.path || ''))
      } else if (toolCall.name === 'read_multiple_files') {
        const paths = Array.isArray(toolCall.arguments?.paths) ? toolCall.arguments.paths : []
        for (const p of paths) this.markRead(ctx.sessionId, String(p || ''))
      }
      return result
    })

    // Post: cap / spill oversized outputs (spill needs the session for the dir).
    this.registerPostHook(async (toolCall, result, ctx) => {
      result.result = await this.capResult(result.result, ctx.sessionId)
      return result
    })

    // Result observer: usage recording for skill / MCP calls (built-in tools
    // are not tracked in the dashboard's tool categories — unchanged).
    this.registerResultObserver((toolCall, result, ctx) => {
      const startedAt = this.startedAtByCall.get(toolCall.id) ?? Date.now()
      this.startedAtByCall.delete(toolCall.id)
      if (toolCall.name.startsWith('skill__')) {
        const skillName = toolCall.name.slice('skill__'.length)
        this.recordUsage('skill', skillName, startedAt, { ok: !result.isError, error: result.isError ? result.result : undefined, context: ctx })
      } else if (toolCall.name.startsWith('mcp__')) {
        const rest = toolCall.name.slice('mcp__'.length)
        const sep = rest.indexOf('__')
        const server = sep === -1 ? rest : rest.slice(0, sep)
        const toolName = sep === -1 ? rest : rest.slice(sep + 2)
        this.recordUsage('mcp', `${server}__${toolName}`, startedAt, { sub: server, ok: !result.isError, error: result.isError ? result.result : undefined, context: ctx })
      }
    })
  }

  /** Get all static tools */
  getTools(): Tool[] {
    return this.tools
  }

  /** Attribute usage events to the running session */
  setSessionContext(sessionId: string, projectPath: string): void {
    this.sessionContext = { sessionId, projectPath }
  }

  /** Drop a deleted session's read-tracking (wired from chatStore.deleteSession) */
  forgetSession(sessionId: string): void {
    this.readFilesBySession.delete(sessionId)
  }

  /** Mark a path as "known" to a session (read_file success, or a file the
   *  model just created via write_file — it authored the content, so it may
   *  edit it afterwards without a separate read). */
  private markRead(sessionId: string | undefined, path: string): void {
    if (!sessionId || !path) return
    let set = this.readFilesBySession.get(sessionId)
    if (!set) {
      set = new Set()
      this.readFilesBySession.set(sessionId, set)
    }
    set.add(normalizePath(path))
  }

  private hasReadFile(sessionId: string | undefined, path: string): boolean {
    if (!sessionId || !path) return false
    return this.readFilesBySession.get(sessionId)?.has(normalizePath(path)) ?? false
  }

  /** True when the path exists on disk. Missing files (or stat errors — never
   *  block a write on a transient failure) are treated as "new file". */
  private async fileExists(path: string): Promise<boolean> {
    try {
      return !!(await window.electronAPI.stat(path))
    } catch {
      return false
    }
  }

  /** Refresh MCP tool definitions from the main process */
  async refreshMcpTools(): Promise<void> {
    try {
      this.dynamicTools = await window.electronAPI.mcpToolDefinitions()
    } catch {
      this.dynamicTools = []
    }
  }

  /** Refresh skill tool definitions from the workspace SkillManager. `projectPath`
   *  scopes them to that project (global skills always included); without it the
   *  browsing root is used as the fallback. */
  async refreshSkillTools(projectPath?: string): Promise<void> {
    try {
      this.skillTools = await toSkillToolDefinitions(false, projectPath)
    } catch {
      this.skillTools = []
    }
  }

  /** Get tool definitions for LLM, optionally filtered by name (plan mode) */
  getToolDefinitions(filter?: (name: string) => boolean): ToolDefinition[] {
    let defs = toToolDefinitions(this.tools)
    if (filter) defs = defs.filter((d) => filter(d.function.name))
    const dynamic = this.dynamicTools.filter((d) => {
      if (filter && !filter(d.function.name)) return false
      // 内置原生 git 工具存在时，隐藏内置 git-server MCP 的同名工具
      // （mcp__git__git_status → 已有 git_status），避免模型同时看到两套。
      const m = /^mcp__git__(.+)$/.exec(d.function.name)
      if (m && NATIVE_GIT_TOOLS.has(m[1])) return false
      return true
    })
    const skills = this.skillTools.filter((d) => !filter || filter(d.function.name))
    // Deterministic order (by tool name) — the exact array is part of the
    // request sent every turn, and provider prefix caches (OpenAI / DeepSeek /
    // Anthropic) only hit when it stays byte-identical. Order carries no
    // meaning for the model, so sorting keeps it stable even when MCP/skill
    // tool lists reload in a different sequence.
    return [...defs, ...dynamic, ...skills].sort((a, b) =>
      a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0
    )
  }

  /** Check if a tool requires user approval */
  requiresApproval(toolName: string): boolean {
    // MCP tools are user-configured servers — their calls run without extra approval
    if (toolName.startsWith('mcp__')) return false
    // Skill tools are read-only (they only load instructions)
    if (toolName.startsWith('skill__')) return false
    const tool = this.toolMap.get(toolName)
    return tool?.requiresApproval ?? false
  }

  /** Single exit funnel for every tool result: outputs over the inline budget
   *  are spilled to disk (full text saved; preview + locator returned) when a
   *  session is known, else capped at the configured limits. Built-in tools
   *  self-cap below the defaults, so existing behavior is untouched. */
  private async capResult(result: string, sessionId?: string): Promise<string> {
    const limits = toolOutputLimits()
    if (sessionId && shouldSpill(result, limits)) {
      try {
        const locator = await window.electronAPI.spillSave(sessionId, result)
        if (locator) return buildSpillPreview(result, locator, limits)
      } catch {
        // spill unavailable → fall through to plain truncation
      }
    }
    return truncateToolOutput(result, limits)
  }

  /** Mask API keys / header secrets that an error text may echo back. */
  private redact(text: string): string {
    return redactSecrets(text, secretRedaction())
  }

  /** Persist one usage event (skills / subagents / MCP) into the dashboard */
  private recordUsage(
    category: UsageEventCategory,
    name: string,
    startedAt: number,
    opts: { sub?: string; ok: boolean; error?: string; context?: { sessionId?: string; projectPath?: string } },
  ): void {
    const ctx = opts.context || this.sessionContext || {}
    const event: UsageEvent = {
      id: uuidv4(),
      category,
      name,
      sub: opts.sub,
      sessionId: ctx.sessionId,
      projectPath: ctx.projectPath,
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: opts.ok,
      error: opts.error ? this.redact(opts.error) : undefined,
    }
    window.electronAPI.recordUsage([event]).catch(() => { /* stats are best-effort */ })
    window.dispatchEvent(new CustomEvent('ourcode:usage-recorded'))
  }

  /** Execute a tool call through the five-stage pipeline. `context` attributes
   *  usage to a specific session — with parallel agent loops the shared
   *  setSessionContext slot is racy, so the agent loop passes the per-call
   *  context explicitly. */
  async execute(toolCall: ToolCall, context?: ToolExecuteContext): Promise<ToolResult> {
    const ctx = context || this.sessionContext || {}
    this.startedAtByCall.set(toolCall.id, Date.now())

    // Stage 1 — guards (deny-only, monotonic). First denial is terminal; no
    // later stage can re-grant. Read-before-write lives here, before approval,
    // so a doomed call never pops an approval dialog.
    for (const guard of this.guards) {
      const reason = await guard(toolCall, ctx)
      if (reason) {
        this.startedAtByCall.delete(toolCall.id)
        return this.deniedResult(toolCall, reason)
      }
    }

    // Stage 2 — pre hooks (approval, checkpoint). Deny is terminal.
    for (const hook of this.preHooks) {
      const outcome = await hook(toolCall, ctx)
      if ('deny' in outcome && outcome.deny) {
        this.startedAtByCall.delete(toolCall.id)
        return this.deniedResult(toolCall, outcome.reason, { rejected: true })
      }
    }

    // Stages 3–5 — around + core, post, observers. The finally guarantees the
    // per-call timing entry is released on EVERY exit path (the usage observer
    // only covers skill/mcp), and post-hook failures are isolated: a failing
    // result rewrite must never turn a tool call into an exception.
    let result: ToolResult
    try {
      try {
        result = await this.runAround(toolCall, ctx)
      } catch (error: any) {
        // Safety net for around-hook / core throws (core itself returns errors).
        result = {
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: this.redact(`Error executing ${toolCall.name}: ${error.message}`),
          isError: true,
        }
      }

      // Stage 4 — post hooks (read-tracking, cap/spill).
      for (const post of this.postHooks) {
        try {
          result = await post(toolCall, result, ctx)
        } catch (error: any) {
          console.error(`Tool post hook 失败 (${toolCall.name}):`, error)
        }
      }

      // Stage 5 — result observers (usage recording). Observers never break the
      // loop.
      for (const observer of this.resultObservers) {
        try {
          observer(toolCall, result, ctx)
        } catch { /* observer failure is non-fatal */ }
      }
    } finally {
      this.startedAtByCall.delete(toolCall.id)
    }
    return result
  }

  /** Run the around-hook chain, ending at core execution. */
  private runAround(toolCall: ToolCall, ctx: ToolExecuteContext): Promise<ToolResult> {
    const chain = async (i: number, c: ToolExecuteContext): Promise<ToolResult> => {
      if (i >= this.aroundHooks.length) return this.executeCore(toolCall, c)
      return this.aroundHooks[i](toolCall, c, (override) => chain(i + 1, override ?? c))
    }
    return chain(0, ctx)
  }

  /** Core execution: route skill / MCP / builtin tools and return the raw
   *  result (cap/spill, usage recording and markRead happen in pipeline stages,
   *  not here). */
  private async executeCore(toolCall: ToolCall, ctx: ToolExecuteContext): Promise<ToolResult> {
    // Skill dynamic tool: skill__<name> — loads the skill's instructions
    if (toolCall.name.startsWith('skill__')) {
      const skillName = toolCall.name.slice('skill__'.length)
      try {
        // Load from the RUNNING session's project first — with parallel agent
        // loops the workspace follows each conversation, not the folder being
        // browsed in the sidebar file tree.
        const content = await loadSkillContent(skillName, ctx.projectPath || getWorkspaceRoot())
        if (content == null) {
          return { toolCallId: toolCall.id, name: toolCall.name, result: this.redact(`Error: 技能 "${skillName}" 不存在`), isError: true }
        }
        return { toolCallId: toolCall.id, name: toolCall.name, result: content }
      } catch (error: any) {
        return { toolCallId: toolCall.id, name: toolCall.name, result: this.redact(`Error: ${error.message}`), isError: true }
      }
    }

    // MCP dynamic tool: mcp__<server>__<toolName>
    if (toolCall.name.startsWith('mcp__')) {
      const rest = toolCall.name.slice('mcp__'.length)
      const sep = rest.indexOf('__')
      if (sep === -1) {
        return { toolCallId: toolCall.id, name: toolCall.name, result: 'Error: malformed MCP tool name', isError: true }
      }
      const server = rest.slice(0, sep)
      const toolName = rest.slice(sep + 2)
      try {
        const res = await window.electronAPI.mcpCallTool(server, toolName, toolCall.arguments || {})
        if (res.ok) {
          return { toolCallId: toolCall.id, name: toolCall.name, result: res.result || '(空结果)' }
        }
        return { toolCallId: toolCall.id, name: toolCall.name, result: this.redact(`Error: ${res.error}`), isError: true }
      } catch (error: any) {
        return { toolCallId: toolCall.id, name: toolCall.name, result: this.redact(`Error: ${error.message}`), isError: true }
      }
    }

    const tool = this.toolMap.get(toolCall.name)
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: `Error: Unknown tool "${toolCall.name}"`,
        isError: true,
      }
    }

    try {
      // The around-hook stage already composed the deadline + Stop signal into
      // ctx.abortSignal for tools with a timeoutMs; forward it unchanged.
      const raw = await tool.execute(toolCall.arguments, {
        sessionId: ctx.sessionId,
        projectPath: ctx.projectPath,
        toolCallId: ctx.toolCallId ?? toolCall.id,
        abortSignal: ctx.abortSignal,
      })
      // A tool may return { text, images } instead of a string (browser_screenshot).
      if (typeof raw === 'string') {
        return { toolCallId: toolCall.id, name: toolCall.name, result: raw }
      }
      return { toolCallId: toolCall.id, name: toolCall.name, result: raw.text, images: raw.images }
    } catch (error: any) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: this.redact(`Error executing ${toolCall.name}: ${error.message}`),
        isError: true,
      }
    }
  }

  /** Build the result for a denied call (guard reason / user rejection). */
  private deniedResult(toolCall: ToolCall, reason: string, opts?: { rejected?: boolean }): ToolResult {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: truncateToolOutput(reason, toolOutputLimits()),
      isError: true,
      rejected: opts?.rejected,
    }
  }

  /** Get a preview of what a tool call will do (for approval dialog) */
  getPreview(toolCall: ToolCall): string {
    const args = toolCall.arguments
    switch (toolCall.name) {
      case 'write_file':
        return `Write to: ${args.path}\nContent length: ${(args.content || '').length} chars`
      case 'edit_file':
        return `Edit: ${args.path}\nReplace: "${(args.oldText || '').slice(0, 100)}${(args.oldText || '').length > 100 ? '...' : ''}"\nWith: "${(args.newText || '').slice(0, 100)}${(args.newText || '').length > 100 ? '...' : ''}"${args.replaceAll ? '\n(替换所有匹配项)' : ''}`
      case 'read_multiple_files':
        return `Read ${Array.isArray(args.paths) ? args.paths.length : 0} files:\n${(Array.isArray(args.paths) ? args.paths : []).map((p: any, i: number) => `${i + 1}. ${p}`).join('\n')}`
      case 'multi_edit_file': {
        const edits = Array.isArray(args.edits) ? args.edits : []
        return `批量编辑 ${edits.length} 处:\n${edits
          .map((e: any, i: number) => `${i + 1}. ${String(e?.path || '')} — replace "${String(e?.oldText || '').slice(0, 60)}${String(e?.oldText || '').length > 60 ? '…' : ''}"${e?.replaceAll ? ' (全部)' : ''}`)
          .join('\n')
          .slice(0, 1200)}`
      }
      case 'create_directory':
        return `Create directory: ${args.path}`
      case 'delete_file':
        return `Delete: ${args.path}`
      case 'run_command':
        return `Run: ${args.command}\nIn: ${args.cwd || '(project root)'}${args.background ? '\n（在集成终端后台运行，不会等待它退出）' : ''}`
      case 'git_add':
        return `git add ${args.path ? `-- ${args.path}` : '-A (全部变更)'}`
      case 'git_commit':
        return `git commit -m "${(args.message || '').slice(0, 120)}"${args.all ? ' (先 git add -A)' : ''}`
      case 'git_split_commit':
        return `按功能分组提交：${Array.isArray(args.groups) ? args.groups.length : 0} 组\n${
          Array.isArray(args.groups)
            ? args.groups.map((g: any, i: number) => `${i + 1}. ${String(g?.message || '').slice(0, 80)} (${Array.isArray(g?.files) ? g.files.length : 0} 文件)`).join('\n')
            : ''
        }`
      case 'git_push':
        return `git push ${[args.remote, args.branch].filter(Boolean).join(' ') || '(当前分支到 origin)'}`
      case 'web_search':
        return `Web search: ${args.query}`
      case 'read_url':
        return `Read URL: ${args.url}`
      case 'manage_todo':
        return `Update todo list (${Array.isArray(args.todos) ? args.todos.length : 0} items)`
      case 'submit_plan':
        return `提交计划: ${args.title || '(未命名)'}`
      case 'ask_user_question':
        return `提问: ${args.question}`
      case 'run_subagent':
        return `子智能体 "${args.name || ''}": ${args.prompt || ''}`
      default:
        if (toolCall.name.startsWith('skill__')) {
          return `加载技能: ${toolCall.name.slice('skill__'.length)}`
        }
        if (toolCall.name.startsWith('mcp__')) {
          return `MCP 工具: ${toolCall.name}\n${JSON.stringify(args, null, 2).slice(0, 500)}`
        }
        return `${toolCall.name}: ${JSON.stringify(args, null, 2)}`
    }
  }
}
