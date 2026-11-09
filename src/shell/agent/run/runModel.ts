/**
 * 运行可视化切片的纯推导层（run summary / 步骤行 / 思考行 / 子任务行）。
 *
 * 这里不碰 React、不碰 store、不碰 DOM —— 只吃「消息里的工具调用长什么样」，
 * 吐出一份可以直接渲染的视图模型。抽成纯函数的原因很直接：颜色/间距靠肉眼
 * 看不出对错，但「哪一步算失败」「+/- 怎么数」「摘要里该出现哪几段」必须能被
 * 单测钉死（见 src/__tests__/shell-run-model.test.ts）。
 *
 * 数据来源（只读，不改 store）：
 *   - ChatMessage.toolCalls / toolResults —— 步骤与结果（结果可能落在后面的消息上）
 *   - ChatMessage.thinking + ttftMs      —— 思考行（ttft 是真实的首 token 延迟）
 *   - chatStore.subagentProgress         —— 子任务实时进度（按父工具调用 id 索引）
 *   - AgentRun                            —— 步数 / 耗时 / token 摘要
 */

/** 一条步骤的状态：完成 / 失败 / 正在跑 / 排队（含「永远不会再有结果」）。 */
export type RunStepState = 'done' | 'failed' | 'running' | 'pending'

/** 一步工具调用的渲染模型。 */
export interface RunStep {
  /** 工具调用 id（React key + 重试定位） */
  id: string
  /** 原始工具名，例如 read_file */
  tool: string
  /** 无衬线展示名，例如 Read / Edit / Bash */
  label: string
  /** 等宽展示目标，例如 src/shell/AgentShell.tsx（已截断） */
  target: string
  state: RunStepState
  /** 墙钟耗时（ms）；没有可信时间戳时不填，界面就不显示 */
  durationMs?: number
  /** 编辑类步骤的新增 / 删除行数（+28 −15）；非编辑步骤不填 */
  added?: number
  removed?: number
  /** 失败步骤的一行错误文本（已压成单行） */
  error?: string
}

/** 步骤计数。 */
export interface RunStepCounts {
  total: number
  done: number
  failed: number
  running: number
  pending: number
}

/** 一条嵌套子任务行。 */
export interface SubAgentRow {
  id: string
  name: string
  task: string
  state: 'running' | 'done' | 'error' | 'stopped'
  durationMs?: number
}

/** 行级 +/- 计数。 */
export interface LineDelta {
  added: number
  removed: number
}

/** 消息的最小结构（便于测试里用字面量造数据，不依赖完整 ChatMessage）。 */
export interface RunToolCallLike {
  id: string
  name: string
  arguments?: Record<string, any>
  startedAt?: number
}

export interface RunToolResultLike {
  toolCallId: string
  name?: string
  result?: string
  isError?: boolean
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface RunMessageLike {
  id: string
  role?: string
  runId?: string
  thinking?: string
  ttftMs?: number
  tokenCount?: number
  toolCalls?: ReadonlyArray<RunToolCallLike>
  toolResults?: ReadonlyArray<RunToolResultLike>
}

/** run 摘要需要的字段子集（AgentRun 结构上兼容）。 */
export interface RunMetaLike {
  status?: string
  startedAt?: number
  finishedAt?: number
  stepCount?: number
  tokensIn?: number
  tokensOut?: number
  lastError?: string
}

/** 子任务进度的字段子集（SubAgentProgress 结构上兼容）。 */
export interface SubAgentProgressLike {
  status: 'running' | 'done' | 'error' | 'stopped'
  name?: string
  task?: string
  description?: string
  startedAt?: number
}

/** 上/下箭头（总结行、思考行共用）。 */
export const RUN_TOOL_LABELS: Record<string, string> = {
  read_file: 'Read',
  read_multiple_files: 'Read',
  read_files: 'Read',
  read_file_range: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'Edit',
  multi_edit_file: 'Edit',
  apply_patch: 'Edit',
  list_dir: 'List',
  list_directory: 'List',
  get_directory_tree: 'List',
  create_directory: 'Mkdir',
  delete_file: 'Delete',
  search_files: 'Search',
  search_in_files: 'Grep',
  grep: 'Grep',
  glob: 'Glob',
  run_command: 'Bash',
  execute_command: 'Bash',
  terminal: 'Bash',
  web_search: 'Search',
  fetch_url: 'Fetch',
  read_url: 'Fetch',
  ask_user_question: 'Ask',
  submit_plan: 'Plan',
  manage_todo: 'Plan',
  update_plan: 'Plan',
  todo_write: 'Plan',
  run_subagent: 'Sub-agent',
  send_message: 'Message',
}

const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'multi_edit_file', 'write_file', 'apply_patch'])

const TARGET_KEYS = [
  'path',
  'file_path',
  'filePath',
  'command',
  'pattern',
  'query',
  'url',
  'title',
  'description',
] as const

const TARGET_MAX = 56

/** 工具名 → 无衬线展示名。未知工具名把下划线换成空格，MCP 工具取最后一段。 */
export function toolLabel(name: string): string {
  const known = RUN_TOOL_LABELS[name]
  if (known) return known
  if (name.startsWith('mcp__')) {
    const tail = name.split('__').filter(Boolean).pop() || name
    return tail.replace(/[_-]+/g, ' ')
  }
  return name.replace(/[_-]+/g, ' ')
}

/** 是否编辑类步骤（需要 +/- 计数）。 */
export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name)
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 压成单行并截断 —— 目标/错误/任务都走这一条，避免行高被撑开。 */
export function oneLine(text: string | null | undefined, max = 72): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1))}…`
}

/** 步骤行的等宽目标文本：路径 / 命令 / 匹配模式 / url / 文件数。 */
export function stepTarget(args?: Record<string, any> | null): string {
  if (!args) return ''
  const paths = args.paths
  if (Array.isArray(paths) && paths.length > 0) return `${paths.length} 个文件`
  const edits = args.edits
  if (Array.isArray(edits) && edits.length > 0) return `${edits.length} 处编辑`
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      return oneLine(value, TARGET_MAX)
    }
  }
  return ''
}

/** 按行切分；末尾换行只是结束符，不算一个空行。 */
export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 一次文本替换的新增/删除行数。
 * 只剥公共前缀/后缀（编辑几乎都是局部的），不做 LCS：这里要的是给步骤行一个
 * 稳定的 +/- 量级，不是精确 diff（精确 diff 属于产物面板的 checkpoint 统计）。
 */
export function countLineDelta(before: string, after: string): LineDelta {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  return {
    added: Math.max(0, endB - start + 1),
    removed: Math.max(0, endA - start + 1),
  }
}

/**
 * 编辑类工具调用的 +/- 计数，来自**调用参数**（不是猜的结果文本）：
 *   edit_file        → diff(oldText, newText)
 *   multi_edit_file  → 逐条累加
 *   write_file       → content 的行数（无删除行可比）
 * 没有可用参数时返回 null，界面就不画计数（宁缺毋造）。
 */
export function editLineDelta(name: string, args?: Record<string, any> | null): LineDelta | null {
  if (!args) return null
  if (name === 'edit_file') {
    const before = asText(args.oldText) ?? asText(args.old_string)
    const after = asText(args.newText) ?? asText(args.new_string)
    if (before === null && after === null) return null
    return countLineDelta(before ?? '', after ?? '')
  }
  if (name === 'multi_edit_file' || name === 'multi_edit') {
    const edits = Array.isArray(args.edits) ? args.edits : null
    if (!edits || edits.length === 0) return null
    let added = 0
    let removed = 0
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue
      const before = asText((edit as Record<string, any>).oldText) ?? ''
      const after = asText((edit as Record<string, any>).newText) ?? ''
      const delta = countLineDelta(before, after)
      added += delta.added
      removed += delta.removed
    }
    return { added, removed }
  }
  if (name === 'write_file') {
    const content = asText(args.content)
    if (content === null) return null
    return { added: splitLines(content).length, removed: 0 }
  }
  return null
}

/**
 * 工具自己回报的 +/-（例如结果文本里的 `+142 −0`）。
 * 编辑参数拿不到行数时（历史消息没存 oldText/newText、或工具做了归一化匹配）
 * 用它兜底 —— 数字是工具写的，不是这里编的。
 */
export function resultLineDelta(result?: string | null): LineDelta | null {
  if (!result) return null
  const match = /\+(\d+)\s*[−–-]\s*(\d+)/.exec(result)
  if (!match) return null
  return { added: Number(match[1]), removed: Number(match[2]) }
}

/** 单步状态：有结果就是完成/失败；没结果且会话在跑就是 running，否则 pending。 */export function deriveStepState(result: RunToolResultLike | undefined, running: boolean): RunStepState {
  if (result) return result.isError ? 'failed' : 'done'
  return running ? 'running' : 'pending'
}

/** 从结果文本里取一行错误（设计稿只要一行，多的留给轨迹视图）。 */
export function stepErrorLine(result: RunToolResultLike | undefined): string | undefined {
  if (!result || !result.isError) return undefined
  const text = (result.result ?? '').trim()
  if (!text) return '执行失败'
  const first = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  return oneLine(first ?? text, 160) || '执行失败'
}

function stepDuration(result: RunToolResultLike | undefined): number | undefined {
  if (!result) return undefined
  if (typeof result.durationMs === 'number' && result.durationMs >= 0) return result.durationMs
  if (typeof result.startedAt === 'number' && typeof result.finishedAt === 'number') {
    return Math.max(0, result.finishedAt - result.startedAt)
  }
  return undefined
}

/** 把一组消息里的工具调用折成按执行顺序排列的步骤行。 */
export function deriveRunSteps(
  messages: readonly RunMessageLike[],
  opts: { running?: boolean } = {},
): RunStep[] {
  const running = opts.running === true
  const resultsById = new Map<string, RunToolResultLike>()
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      if (result?.toolCallId) resultsById.set(result.toolCallId, result)
    }
  }

  const steps: RunStep[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!call?.id || seen.has(call.id)) continue
      seen.add(call.id)
      const result = resultsById.get(call.id)
      const state = deriveStepState(result, running)
      const step: RunStep = {
        id: call.id,
        tool: call.name,
        label: toolLabel(call.name),
        target: stepTarget(call.arguments),
        state,
      }
      const duration = stepDuration(result)
      if (duration !== undefined) step.durationMs = duration
      if (isEditTool(call.name)) {
        const delta = editLineDelta(call.name, call.arguments) ?? resultLineDelta(result?.result)
        if (delta && (delta.added > 0 || delta.removed > 0)) {
          step.added = delta.added
          step.removed = delta.removed
        }
      }
      const error = stepErrorLine(result)
      if (error) step.error = error
      steps.push(step)
    }
  }
  return steps
}

/** 计数（气泡与摘要共用）。 */
export function countStepStates(steps: readonly RunStep[]): RunStepCounts {
  const counts: RunStepCounts = { total: steps.length, done: 0, failed: 0, running: 0, pending: 0 }
  for (const step of steps) {
    if (step.state === 'done') counts.done += 1
    else if (step.state === 'failed') counts.failed += 1
    else if (step.state === 'running') counts.running += 1
    else counts.pending += 1
  }
  return counts
}

/** 进度百分比：没有任何步骤时，运行中给 6%（不是 0，也不是假 100%）。 */
export function runProgressPercent(counts: RunStepCounts, running: boolean): number {
  if (counts.total === 0) return running ? 6 : 100
  const settled = counts.done + counts.failed
  return Math.min(100, Math.max(0, Math.round((settled / counts.total) * 100)))
}

const RUNNING_STATUSES = new Set(['running', 'approved_running', 'creating_plan'])
const FAILED_STATUSES = new Set(['error', 'rejected'])

/** 单行摘要的状态：失败 > 运行中 > 完成。 */
export function runSummaryState(input: {
  run?: RunMetaLike | null
  steps: readonly RunStep[]
  running?: boolean
}): 'running' | 'failed' | 'done' {
  if (input.run?.status && FAILED_STATUSES.has(input.run.status)) return 'failed'
  if (input.steps.some((step) => step.state === 'failed')) return 'failed'
  if (input.running) return 'running'
  if (input.run?.status && RUNNING_STATUSES.has(input.run.status)) return 'running'
  return 'done'
}

/** run 的墙钟耗时；只有跑完才有值（运行中不显示跳动秒数，避免整列重排）。 */
export function runDurationMs(run?: RunMetaLike | null): number | null {
  if (!run) return null
  if (typeof run.startedAt !== 'number') return null
  if (typeof run.finishedAt !== 'number') return null
  const delta = run.finishedAt - run.startedAt
  return Number.isFinite(delta) && delta >= 0 ? delta : null
}

/** run 的 token 合计（输入+输出）。 */
export function runTokens(run?: RunMetaLike | null): number {
  if (!run) return 0
  return Math.max(0, (run.tokensIn ?? 0) + (run.tokensOut ?? 0))
}

/** 1.2k / 512 / 3.4M —— 与旧界面的 token 格式化保持一致。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** 摘要行里的耗时：6s / 1m42s / 480ms。 */
export function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`
}

/** 步骤行的耗时：120ms / 1.4s / 1m 05s。 */
export function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * 单行 run 摘要：`已处理 18 步 · 1m42s · 12k tok`。
 * 缺什么就少什么；一段都没有时返回 null（不画空行）。
 */
export function summarizeRunLine(input: {
  run?: RunMetaLike | null
  steps: readonly RunStep[]
  message?: { tokenCount?: number } | null
}): string | null {
  const { run } = input
  const stepCount = run?.stepCount && run.stepCount > 0 ? run.stepCount : input.steps.length
  const parts: string[] = []
  if (stepCount > 0) parts.push(`已处理 ${stepCount} 步`)

  const duration = runDurationMs(run)
  if (duration !== null && duration > 0) parts.push(formatRunDuration(duration))

  const tokens = runTokens(run) || Math.max(0, input.message?.tokenCount ?? 0)
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`)

  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * 思考行的文案。
 * 耗时取 ttft（首 token 延迟 = 真正在推理的那段时间），没有就只说「推理」。
 */
export function thinkingLabel(input: { streaming?: boolean; ttftMs?: number }): string {
  if (input.streaming) return '推理中'
  const seconds = Math.round((input.ttftMs ?? 0) / 1000)
  return seconds > 0 ? `推理 ${seconds} s` : '推理'
}

/** 这条消息是否属于同一次 run（runId 相同），没有 runId 时只保留自己。 */
export function pickRunMessages<T extends RunMessageLike>(
  messages: readonly T[],
  anchor: T,
): T[] {
  if (!anchor.runId) return [anchor]
  const related = messages.filter(
    (message) => (message.runId === anchor.runId || message.id === anchor.id) && message.role !== 'tool',
  )
  return related.length > 0 ? related : [anchor]
}

/** 本轮（最后一个 user 消息之后）的消息 —— 状态气泡只关心当前这一轮。 */
export function pickCurrentTurnMessages<T extends RunMessageLike>(messages: readonly T[]): T[] {
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      start = i
      break
    }
  }
  return messages.slice(start).filter((message) => message.role !== 'tool')
}

/**
 * 子任务行。数据只来自 run_subagent 调用 + store 里的实时进度：
 * 没有进度记录 → 整行不画（绝不靠参数编造状态）。
 */
export function deriveSubAgentRows(
  messages: readonly RunMessageLike[],
  progress: Record<string, SubAgentProgressLike | undefined> | undefined,
  opts: { now?: number } = {},
): SubAgentRow[] {
  if (!progress) return []
  const resultsById = new Map<string, RunToolResultLike>()
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      if (result?.toolCallId) resultsById.set(result.toolCallId, result)
    }
  }

  const rows: SubAgentRow[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call?.name !== 'run_subagent' || seen.has(call.id)) continue
      seen.add(call.id)
      const live = progress[call.id]
      if (!live) continue
      const result = resultsById.get(call.id)
      const args = call.arguments ?? {}
      const name = (live.name || asText(args.name) || '子任务').trim()
      const task = oneLine(live.task || live.description || asText(args.description) || asText(args.prompt) || '', 64)
      const row: SubAgentRow = {
        id: call.id,
        name,
        task,
        state: live.status ?? 'running',
      }
      const duration =
        stepDuration(result) ??
        (live.status === 'running' && typeof live.startedAt === 'number' && typeof opts.now === 'number'
          ? Math.max(0, opts.now - live.startedAt)
          : undefined)
      if (duration !== undefined) row.durationMs = duration
      rows.push(row)
    }
  }
  return rows
}
