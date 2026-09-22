/**
 * Subagent runner — executes a nested, self-contained agent task on behalf of
 * the main agent (the run_subagent tool, mirroring Windsurf's TaskSubagentTool).
 *
 * The subagent runs autonomously (no approval dialogs — it inherits the parent
 * run's authority), with a bounded iteration budget, and returns a structured
 * summary to the parent. Every AI file mutation is captured as a checkpoint so
 * it stays revertable. Usage is recorded into the dashboard (category
 * 'subagent'). Execution is serial (nested inside the parent's tool call);
 * parallel subagents are future work.
 *
 * The role/limits come from a definition (`.ourcode/agents/<name>.md` with
 * frontmatter, or a built-in archetype). Permission isolation is enforced by
 * SubagentGuard — monotonic decay: the subagent only sees/uses the tools,
 * paths and commands its definition allows.
 */
import { v4 as uuidv4 } from 'uuid'
import { sendLLMRequest } from '@/services/llm/LLMClient'
import { ToolExecutor } from '@/services/tools'
import type { ToolCall, ToolResult } from '@/services/tools/types'
import { captureCheckpoint } from '@/services/checkpointService'
import { buildSkillIndex, listSkills } from '@/services/skills/skillManager'
import { loadAgentDefinition, SubagentGuard, resolveAllowedRoot } from '@/services/subagents/subagentDefinitions'
import { subagentStatusLabel, mergeWriteScopes, resolveSubagentModel, sanitizeModelName } from '@/services/subagents/subagentReport'
import { useChatStore, setWireContextForRun } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { getFileContent } from '@/editor/modelRegistry'
import type { LLMToolCall, SubAgentProgress, SubAgentProgressStep, UsageEvent } from '@/types'
import { resolveThinkingLevel, DEFAULT_MODEL_PARAMS } from '@/types'

const MAX_SUBAGENT_ITERATIONS = 10
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory', 'multi_edit_file'])

/** Compact a tool call's arguments for the transient progress record — write
 *  payloads (file contents) can be huge, and the panel only needs the shape
 *  plus key fields to render. */
function compactArgs(args: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length > 2000) out[k] = v.slice(0, 2000) + '…'
    else if (Array.isArray(v) && v.length > 50) out[k] = v.slice(0, 50)
    else out[k] = v
  }
  return out
}

export interface SubAgentOptions {
  sessionId: string
  projectPath: string
  /** Role name, e.g. 'code-reviewer' / 'researcher' (shown in stats + logs) */
  name: string
  /** The concrete task given to the subagent */
  task: string
  /** Why the main agent spawned it (short, for the summary header) */
  description?: string
  /** Parent run_subagent tool call id — live progress is routed to the UI
   *  (SubAgentProgressBlock) keyed by it. Absent ⇒ no progress UI. */
  toolCallId?: string
  /** Abort signal of the parent run — the user's Stop button cancels the
   *  subagent (checked between stream chunks and tool executions). */
  abortSignal?: AbortSignal
  // ── Target-mode envelope overrides (v2, §13.2) ──
  // All optional — absent ⇒ the run behaves exactly like a plain run_subagent.
  // The ToolRegistry target-mode fork is the only caller that sets them.
  /** Model override (role model declared by the task envelope). */
  model?: string
  /** Write the full report to this path and return a short summary instead. */
  reportPath?: string
  /** Extra write scopes for this run (envelope files_to_modify → hard isolation). */
  writePaths?: string[]
  /** Prepend a machine-readable `状态: ...` first line to the returned report. */
  statusLine?: boolean
}

/** Build the subagent's system prompt: definition role + environment + current file + skills */
async function buildSubSystemPrompt(opts: SubAgentOptions, defSystemPrompt: string): Promise<string> {
  const rootPath = opts.projectPath
  let prompt = defSystemPrompt
  prompt += `\n\n<subagent_environment>
工作区路径: ${rootPath || '(无)'}
平台: ${navigator.platform}
当前日期: ${new Date().toLocaleDateString()}
</subagent_environment>`

  // Current open file (live from the editor model), so the subagent can work
  // on what the user is looking at
  const editorState = useEditorStore.getState()
  const activeFile = editorState.openFiles.find((f) => f.path === editorState.activeFilePath)
  if (activeFile) {
    const liveContent = getFileContent(activeFile.path, activeFile.content)
    const lines = liveContent.split('\n')
    const content = lines.length > 200 ? lines.slice(0, 200).join('\n') + '\n... (truncated)' : liveContent
    prompt += `\n\n<subagent_current_file path="${activeFile.path}">\n${content}\n</subagent_current_file>`
  }

  // Skills are available to subagents too
  prompt += await buildSkillIndex(rootPath)

  prompt += `\n\n<subagent_rules>
- 自主完成任务：使用工具（读取/搜索/编辑文件、执行命令）推进，不要向用户请求确认。
- 不要调用 submit_plan、ask_user_question、manage_todo、run_subagent 等控制类工具。
- 修改文件时用 edit_file 尽量精确，不要破坏无关代码。
- 任务完成后，以简洁的结构化摘要报告：完成了什么、修改了哪些文件、遗留问题。报告不超过 8 行，只写结论与关键事实，不要复述过程。
</subagent_rules>`
  return prompt
}

/**
 * Execute the subagent task and return a human-readable report for the parent.
 */
export async function runSubAgent(opts: SubAgentOptions): Promise<string> {
  const startedAt = Date.now()

  // ── Live progress → chatStore (SubAgentProgressBlock in the transcript) ──
  // The sub-agent runs autonomously inside the parent's run_subagent tool call;
  // without these pushes the UI would show only a spinning pill until the whole
  // task finishes. Every event is routed by the parent tool call id.
  const toolCallId = opts.toolCallId
  const pushProgress = (patch: Partial<SubAgentProgress>) => {
    if (!toolCallId) return
    useChatStore.getState().updateSubagentProgress(toolCallId, patch)
  }
  const currentSteps = (): SubAgentProgressStep[] =>
    useChatStore.getState().subagentProgress[toolCallId || '']?.steps || []

  const session = useChatStore.getState().sessions.find((s) => s.id === opts.sessionId)
  const configGroup = useConfigStore.getState().configGroups.find((g) => g.id === session?.configGroupId)
  // Model override (v2 §13.2): the target-mode envelope may pin a per-role
  // model; otherwise resolve from the session exactly as before. 最后一道保险：
  // 传入该配置组已知的可用模型列表——信封里写错的模型名会被跳过，回退到会话
  // /默认模型，而不是直接发给 API 拿 400 "Unsupported model"。
  const configState = useConfigStore.getState()
  // knownModels 只取「会话所属配置组」自己的域：该组的模型列表缓存
  // + （活动组恰好就是该组时的）已拉取列表 + 同 provider 的自定义模型
  // + 会话/默认模型本身（用户配置即已知可用）。
  // 不能用全局 configState.models —— 那是「当前活动配置组」的列表，
  // 一人公司等独立窗口里常为空或属于另一组；把其他组/其他 provider 的名字
  // 混进来只会让校验形同虚设（看似合法、实际 400 "Unsupported model"）。
  const knownModels = Array.from(new Set([
    ...(configState.modelsCache[configGroup?.id || '']?.models || []),
    ...(configState.activeConfigGroupId === configGroup?.id ? configState.models.map((m) => m.id) : []),
    ...configState.customModels.filter((m) => !configGroup || m.provider === configGroup.provider).map((m) => m.id),
    ...[session?.model, configGroup?.defaultModel].filter((m): m is string => !!m),
  ])).map((m) => m.trim()).filter(Boolean)
  const model = resolveSubagentModel(opts.model, session?.model, configGroup?.defaultModel, knownModels.length > 0 ? knownModels : undefined)
  // 透明度：信封指定的模型名清洗后存在、但没被采用（不在该组已知列表/无法验证），
  // 在报告里写明实际用了哪个模型，方便排查「角色怎么没用我指定的模型」。
  const requestedModel = sanitizeModelName(opts.model)
  const ignoredEnvelopeModel = requestedModel && requestedModel !== model ? requestedModel : undefined

  const executor = new ToolExecutor()
  await executor.refreshMcpTools()
  // Scope skill tools to the subagent's project (global skills always included)
  // so its tool list matches the project-scoped skill index below.
  await executor.refreshSkillTools(opts.projectPath)
  executor.setSessionContext(opts.sessionId, opts.projectPath)

  /** Execute one subagent tool with the parent run's abort signal. On abort the
   *  call settles at once with a synthetic stopped result (the in-flight tool
   *  may keep running in the background, but its result is discarded). */
  const executeToolWithAbort = (tc: ToolCall): Promise<{ result: ToolResult; aborted: boolean }> => {
    const ctx = {
      sessionId: opts.sessionId,
      projectPath: opts.projectPath,
      toolCallId: tc.id,
      abortSignal: opts.abortSignal,
      // Subagents inherit the parent session's edit mode for read-permission
      // dialogs (advisory — only native dialogs can grant).
      projectEditMode: session?.projectEditMode,
    }
    const signal = opts.abortSignal
    if (!signal) return executor.execute(tc, ctx).then((result) => ({ result, aborted: false }))
    if (signal.aborted) {
      return Promise.resolve({ result: { toolCallId: tc.id, name: tc.name, result: '[子智能体已停止]', isError: true }, aborted: true })
    }
    return new Promise((resolve) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort)
      const onAbort = () => {
        cleanup()
        resolve({ result: { toolCallId: tc.id, name: tc.name, result: '[子智能体已停止]', isError: true }, aborted: true })
      }
      signal.addEventListener('abort', onAbort)
      executor.execute(tc, ctx).then(
        (result) => {
          cleanup()
          resolve({ result, aborted: false })
        },
        (error) => {
          cleanup()
          resolve({
            result: { toolCallId: tc.id, name: tc.name, result: `Error: ${error?.message || String(error)}`, isError: true },
            aborted: false,
          })
        },
      )
    })
  }

  const recordEvent = (event: Partial<UsageEvent>, tokens = 0) => {
    const full: UsageEvent = {
      id: uuidv4(),
      category: 'subagent',
      name: opts.name,
      sub: opts.description || '',
      sessionId: opts.sessionId,
      projectPath: opts.projectPath,
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: true,
      ...event,
    }
    window.electronAPI.recordUsage([full]).catch(() => { /* stats are best-effort */ })
    // Target-mode budget fuse payload (v2 §13.3): per-session tokens for
    // TARGET-MODE sessions only — budget.ts accumulates these; other listeners
    // (usage dashboard) ignore the detail.
    const tmSession = tokens > 0
      ? useChatStore.getState().sessions.some((s) => s.id === opts.sessionId && s.targetMode === true)
      : false
    window.dispatchEvent(new CustomEvent('ourcode:usage-recorded', {
      detail: tmSession ? { bySession: { [opts.sessionId]: { tokens, projectPath: opts.projectPath } } } : undefined,
    }))
  }

  // No config group / model → cannot run
  if (!configGroup || !model) {
    recordEvent({ ok: false, error: '未配置模型，无法运行子智能体', durationMs: Date.now() - startedAt })
    // 也要留下一条 FAILED 进度记录：此前这里直接 return，任务在项目栏 / 看板的
    // 「活动任务」里完全不可见——派发发生后 UI 像「没刷新」一样毫无变化。
    pushProgress({
      status: 'error',
      sessionId: opts.sessionId,
      name: opts.name,
      task: opts.task,
      description: opts.description,
      startedAt,
      error: '未配置模型：会话未绑定有效的 API 配置或模型',
    })
    return `Error: 无法运行子智能体「${opts.name}」— 会话未绑定有效的 API 配置或模型。`
  }

  // Progress record goes live BEFORE the fallible setup below — a failure
  // while resolving the definition lands in the panel as an error instead of
  // leaving a forever-spinning running record.
  pushProgress({ status: 'running', sessionId: opts.sessionId, name: opts.name, task: opts.task, description: opts.description, startedAt })

  try {
    // Resolve the agent definition (workspace .md → global → builtin) and its
    // permission guard. The definition drives role, tool allowlist, path scope,
    // iteration budget and token budget.
    const def = await loadAgentDefinition(opts.name, opts.projectPath)
    // Envelope hard-isolation (v2 §11.2 / §13.2): files_to_modify from the task
    // envelope becomes the write scope for THIS run, on top of the definition's
    // own allowedWritePaths. Absent writePaths → the guard sees the definition
    // exactly as-is (plain runs keep their original permission boundary).
    const mergedWritePaths = mergeWriteScopes(def.allowedWritePaths, opts.writePaths)
    const guardDef = mergedWritePaths !== def.allowedWritePaths ? { ...def, allowedWritePaths: mergedWritePaths } : def
    const guard = new SubagentGuard(guardDef, opts.projectPath)

    const systemPrompt = await buildSubSystemPrompt(opts, def.systemPrompt)
    const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: LLMToolCall[]; toolCallId?: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: opts.task },
    ]

    let iterationsLeft = def.maxIterations ?? MAX_SUBAGENT_ITERATIONS
    let finalText = ''
    let toolCallCount = 0
    let tokensUsed = 0
    const changedPaths = new Set<string>()
    let lastError = ''
    let hitTokenBudget = false

    // 思考档位统一从 thinkingLevel 派生（旧会话回退，无会话时按默认 off）。
    const thinkingLevel = resolveThinkingLevel(session?.modelParams ?? DEFAULT_MODEL_PARAMS)

    // Only the subagent's allowlisted tools reach its LLM (monotonic decay);
    // the auto-memory tool additionally respects the user's settings toggle.
    let toolDefinitions = executor.getToolDefinitions((name) => guard.toolAllowed(name))
    if (!useEditorStore.getState().preferences.aiAutoMemory) {
      toolDefinitions = toolDefinitions.filter((d) => d.function.name !== 'remember')
    }

    while (iterationsLeft-- > 0 && !opts.abortSignal?.aborted) {
      const req = {
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          toolCallId: m.toolCallId,
        })),
        stream: true,
        temperature: def.temperature ?? session?.modelParams.temperature ?? 0.2,
        maxTokens: session?.modelParams.maxTokens ?? 0,
        topP: session?.modelParams.topP ?? 1.0,
        frequencyPenalty: session?.modelParams.frequencyPenalty ?? 0,
        presencePenalty: session?.modelParams.presencePenalty ?? 0,
        // 思考档位统一从 thinkingLevel 派生（无会话时按默认 off/关闭）。
        thinking: thinkingLevel !== 'off',
        reasoningEffort: thinkingLevel !== 'off' ? thinkingLevel : undefined,
        tools: toolDefinitions,
      }

      let fullContent = ''
      let toolCalls: LLMToolCall[] = []
      let roundThinking = ''
      let lastThinkingPush = 0

      try {
        // Attribute the subagent's model requests to the parent session so
        // they land in the same wire-log file as the main loop's.
        setWireContextForRun({ sessionId: opts.sessionId })
        // The user's Stop button aborts the request itself (outer signal), not
        // just the chunk loop — a stalled provider can't hold the subagent run
        // hostage until the idle timeout.
        for await (const chunk of sendLLMRequest(req, configGroup, undefined, opts.abortSignal)) {
          if (opts.abortSignal?.aborted) break
          if (chunk.thinking) {
            roundThinking += chunk.thinking
            // Throttle live thinking pushes (~150ms) so a long reasoning
            // stream doesn't re-render the progress panel per chunk
            const now = Date.now()
            if (now - lastThinkingPush > 150) {
              lastThinkingPush = now
              pushProgress({ thinking: roundThinking.slice(-4000) })
            }
          }
          if (chunk.content) fullContent += chunk.content
          if (chunk.toolCalls) toolCalls = chunk.toolCalls
          // Usage is the request's cumulative total (providers repeat it on
          // the final chunk) — overwrite, don't accumulate, or the count
          // inflates when usage arrives on every chunk.
          if (chunk.usage) tokensUsed = (chunk.usage.promptTokens || 0) + (chunk.usage.completionTokens || 0)
          if (chunk.done) break
        }
      } catch (error: any) {
        // User hit Stop — the parent run's signal fired; don't record it as a
        // failure, just unwind (the final status below reads the signal).
        if (opts.abortSignal?.aborted) break
        lastError = error.message
        break
      }

      // Flush this round's thinking + latest usage counters (throttle may have
      // skipped the tail, and tokens arrive with the final chunk)
      if (roundThinking) pushProgress({ thinking: roundThinking.slice(-4000) })
      pushProgress({ tokenCount: tokensUsed })

      // User hit Stop — the parent run was aborted; stop promptly
      if (opts.abortSignal?.aborted) break

      // Token budget exceeded — stop and report what was completed
      if (def.maxTokensBudget && tokensUsed >= def.maxTokensBudget) {
        hitTokenBudget = true
        if (!fullContent && toolCalls.length === 0) break
      }

      // No tool calls — the subagent is done
      if (toolCalls.length === 0) {
        finalText = fullContent
        break
      }

      messages.push({ role: 'assistant', content: fullContent, toolCalls })

      for (const raw of toolCalls) {
        const tc: ToolCall = {
          id: raw.id,
          name: raw.function.name,
          arguments: (() => {
            try { return JSON.parse(raw.function.arguments || '{}') } catch { return {} }
          })(),
        }

        // Permission gate (defense in depth — beyond tool visibility filtering):
        // block control tools, off-allowlist tools and out-of-scope paths.
        const blocked = guard.checkCall(tc.name, tc.arguments)
        if (blocked) {
          messages.push({ role: 'tool', content: `Error: ${blocked}`, toolCallId: tc.id })
          continue
        }

        // Snapshot files before write tools so the subagent's edits stay revertable
        if (WRITE_TOOLS.has(tc.name)) {
          await captureCheckpoint(opts.sessionId, tc).catch(() => {})
        }

        // Live step — the progress panel shows the subagent's own tool calls
        // (read_file / edit_file / ...) as they start and complete
        pushProgress({
          steps: [...currentSteps(), { id: tc.id, name: tc.name, arguments: compactArgs(tc.arguments), status: 'running' }],
        })

        // Execute with the parent run's abort signal threaded through the
        // pipeline, and settle IMMEDIATELY when the user hits Stop — even a
        // long run_command (build/test) that ignores the signal can't keep the
        // run (and the whole office task) looking stuck for its full timeout.
        const execution = await executeToolWithAbort(tc)
        if (execution.aborted) break
        const result = execution.result
        toolCallCount++
        pushProgress({ toolCallCount })
        if (result.isError) lastError = result.result
        // multi_edit_file touches several files — collect them all for the
        // change report and the open-editor reload notifications below.
        const touchedPaths = tc.name === 'multi_edit_file'
          ? (Array.isArray(tc.arguments.edits) ? tc.arguments.edits : []).map((e: any) => String(e?.path || '')).filter(Boolean)
          : tc.arguments?.path ? [tc.arguments.path] : []
        for (const p of touchedPaths) changedPaths.add(p)

        // Write tools changed files on disk — notify open editors to reload
        if (WRITE_TOOLS.has(tc.name)) {
          for (const p of touchedPaths) {
            window.dispatchEvent(new CustomEvent('ourcode:file-changed', { detail: p }))
          }
        }

        // Mark the step finished (result text attached for the expandable view)
        pushProgress({
          steps: currentSteps().map((st) =>
            st.id === tc.id
              ? { ...st, status: result.isError ? 'error' : 'success', result: result.result }
              : st
          ),
        })

        messages.push({ role: 'tool', content: result.result, toolCallId: tc.id })
      }

      // Budget hit — process the batch, then stop instead of requesting more
      if (hitTokenBudget) break
    }

    const aborted = !!opts.abortSignal?.aborted
    if (!finalText) {
      finalText = aborted
        ? '[子智能体已停止]'
        : hitTokenBudget
          ? `[子智能体达到 token 预算上限 (${tokensUsed} tokens)，任务可能未完全完成]`
          : iterationsLeft <= 0 && !lastError
            ? '[子智能体达到最大工具调用轮数，任务可能未完全完成]'
            : lastError
    }

    recordEvent({
      // A run is only "ok" when no error surfaced — finalText falling back to
      // lastError made a hard failure (network/timeout) record as ok=true.
      ok: !lastError && !aborted,
      error: lastError || undefined,
      durationMs: Date.now() - startedAt,
      payload: { toolCallCount, fileChangeCount: changedPaths.size, tokensUsed, summary: finalText.slice(0, 500) },
    }, tokensUsed)

    // Final progress state — the panel switches from the spinner to a
    // terminal status (✓ done / ✗ error / ⏹ stopped) but stays viewable.
    pushProgress({
      status: aborted ? 'stopped' : lastError ? 'error' : 'done',
      error: lastError || undefined,
      tokenCount: tokensUsed,
    })

    // Machine-readable first line (v2 §11.3 / §13.2): generated by the runner's
    // own state machine, never parsed from LLM text. Only when statusLine is
    // enabled (target-mode envelope) — plain runs keep the original format.
    const statusLabel = subagentStatusLabel({
      aborted, finalText, lastError, hitTokenBudget, iterationsLeft,
    })
    const statusLineText = opts.statusLine ? `状态: ${statusLabel}` : ''

    const fullReport = [
      `## 子智能体「${opts.name}」执行报告`,
      opts.description ? `**任务背景**: ${opts.description}` : '',
      `**工具调用**: ${toolCallCount} 次 · **修改文件**: ${changedPaths.size} 个${tokensUsed ? ` · **消耗 token**: ${tokensUsed}` : ''}`,
      ignoredEnvelopeModel ? `**模型说明**: 信封指定的 \`${ignoredEnvelopeModel}\` 未通过该配置组的可用模型校验，本次实际使用 \`${model}\`` : '',
      changedPaths.size > 0 ? `**涉及文件**:\n${Array.from(changedPaths).map((p) => `- ${p}`).join('\n')}` : '',
      '',
      `**结果**:`,
      finalText,
    ].filter((l) => l !== '').join('\n')

    // Full report to disk + short summary to the parent (v2 §10.3): the parent
    // only needs the status line, a one-line summary and the file pointer.
    // The envelope's report_path is resolved against the project root — the
    // main-process path guard rejects relative paths.
    if (opts.reportPath) {
      const resolved = resolveAllowedRoot(opts.projectPath, opts.reportPath)
      await window.electronAPI.writeFile(resolved, fullReport, 'utf-8').catch((err) => {
        console.error('子智能体报告落盘失败:', resolved, err)
      })
      return [
        statusLineText,
        `**摘要**: 子智能体「${opts.name}」任务${statusLabel === '完成' ? '完成' : `未完全完成（${statusLabel}）`}，工具调用 ${toolCallCount} 次，修改 ${changedPaths.size} 个文件${tokensUsed ? `，消耗 ${tokensUsed} tokens` : ''}。`,
        ignoredEnvelopeModel ? `**模型**: 信封指定的 \`${ignoredEnvelopeModel}\` 未通过该配置组的可用模型校验，已改用 \`${model}\`；后续派发请省略 model 字段（默认用会话模型）。` : '',
        `**报告全文**: ${resolved}`,
      ].filter((l) => l !== '').join('\n')
    }

    return [statusLineText, fullReport].filter((l) => l !== '').join('\n')
  } catch (error: any) {
    recordEvent({ ok: false, error: error.message, durationMs: Date.now() - startedAt })
    pushProgress({ status: 'error', error: error.message })
    return `Error: 子智能体「${opts.name}」执行失败: ${error.message}`
  }
}

/** Available skill names (for the subagent role prompt / debugging) */
export async function listSkillNames(): Promise<string[]> {
  return (await listSkills()).map((s) => s.name)
}
