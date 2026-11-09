/**
 * 审批 / 决策区的纯视图模型。
 *
 * 底栏决策区只有一种卡片解剖（`DecisionCard`：标题行 → 一行为说明 → 可折叠/
 * 可滚动的正文 → 常驻操作条），但承载四种载荷：单条工具审批、批量审批、
 * 澄清提问、计划审批；范围拦截、重新生成、回退全部三种确认复用同一解剖只换文案。
 *
 * 这个文件不 import React、不碰 store —— 载荷（store 槽位里的原始对象）进，
 * 视图模型（标题/说明/风险词/选项顺序/操作 id/键盘映射）出，因此可以单测。
 * 组件的职责只剩「把视图模型画出来 + 把操作 id 映射回 store action」。
 */
import type { ToolCall } from '@/services/tools/types'
import { analyzeDangerousCommand } from '@/services/tools/dangerousCommands'
import { kindOf } from '@/services/permissions/modePolicy'
import { oneLine, stepTarget, toolLabel } from '../run/runModel'

// ─────────────────────────── 卡片操作 ───────────────────────────

/** 操作条的三种语气：ink 实心主操作 / 纯文字次要操作 / 红色危险操作。 */
export type CardTone = 'primary' | 'plain' | 'danger'

export interface CardAction {
  /** 组件把它映射回具体的 store action；模型里只有字符串。 */
  id: string
  label: string
  /** 每个操作按钮都必须有（无障碍硬要求）。 */
  ariaLabel: string
  tone: CardTone
  /** 右侧键盘提示，纯展示（如 ↵ / ⌘⇧↵）。 */
  kbd?: string
  disabled?: boolean
}

// ─────────────────────────── 风险词 ───────────────────────────

export type RiskLevel = 'danger' | 'write' | 'command' | 'read'

export interface RiskWord {
  level: RiskLevel
  /** 单行、2–4 个字的汉语词，右侧灰字（danger 用红令牌）。 */
  word: string
}

export type ToolCallLike = Pick<ToolCall, 'name' | 'arguments'>

/**
 * 一行风险词：按工具类别 + run_command 的静态危险分析得出。
 * `dangerous` 是 store 已经判过的结论（approvalHook 里 dangerous=true），
 * 给了就以它为准——卡片不能和审批管线的判定打架。
 */
export function riskOf(tc: ToolCallLike, opts?: { dangerous?: boolean }): RiskWord {
  if (opts?.dangerous) return { level: 'danger', word: '危险命令' }
  if (tc.name === 'run_command') {
    const command = String((tc.arguments || {}).command || '')
    if (analyzeDangerousCommand(command)) return { level: 'danger', word: '危险命令' }
    return { level: 'command', word: '执行命令' }
  }
  switch (kindOf(tc.name)) {
    case 'file_write':
      return tc.name === 'delete_file'
        ? { level: 'write', word: '删除文件' }
        : { level: 'write', word: '写入文件' }
    case 'git_write':
      return { level: 'write', word: '改动 git 历史' }
    case 'browser_write':
      return { level: 'write', word: '浏览器操作' }
    case 'computer_write':
      return { level: 'write', word: '桌面操控' }
    case 'mcp':
      return { level: 'write', word: '外部工具' }
    case 'delegate':
      return { level: 'write', word: '子代理' }
    default:
      return { level: 'read', word: '只读' }
  }
}

/**
 * 一行目标描述：优先结构化字段（路径 / 命令 / 模式），
 * 退而求其次用 store 生成的 preview 首行。
 */
export function toolTarget(tc: ToolCallLike, preview?: string): string {
  const structured = stepTarget(tc.arguments || {})
  if (structured) return structured
  return oneLine(preview || '', 72)
}

// ─────────────────────────── 参数 / 差异预览 ───────────────────────────

/** 参数 JSON 井的最大字符数：再长就截断并标注总长度（正文另有滚动兜底）。 */
export const PARAMS_MAX_CHARS = 4000
/** edit_file 红删绿增预览每侧的最大字符数（与旧审批卡保持一致）。 */
export const EDIT_PREVIEW_MAX_CHARS = 200

export interface ArgsPreview {
  /** 格式化后的 JSON（等宽井里直接渲染）。 */
  text: string
  /** 是否因过长被截断。 */
  truncated: boolean
  /** 原始字符数（截断时用于「共 N 字符」提示）。 */
  totalChars: number
}

/** 参数 → 缩进 JSON 文本（截断时保留 JSON 的合法前缀感觉，不做二次解析）。 */
export function argsPreview(args: Record<string, unknown> | undefined, max = PARAMS_MAX_CHARS): ArgsPreview {
  let raw: string
  try {
    raw = JSON.stringify(args || {}, null, 2) ?? '{}'
  } catch {
    raw = '{}'
  }
  const totalChars = raw.length
  if (totalChars <= max) return { text: raw, truncated: false, totalChars }
  return { text: `${raw.slice(0, max)}\n…`, truncated: true, totalChars }
}

export interface EditPreview {
  removed: string
  added: string
  removedTruncated: boolean
  addedTruncated: boolean
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}…`, truncated: true }
}

/**
 * edit_file / multi_edit_file 的改动预览：取第一处带 oldText/newText 的编辑。
 * 其它工具返回 null（卡片不画红绿块）。
 */
export function editPreviewOf(tc: ToolCallLike): EditPreview | null {
  const a = (tc.arguments || {}) as Record<string, unknown>
  let oldText: string | null = null
  let newText: string | null = null
  if (typeof a.oldText === 'string' || typeof a.newText === 'string') {
    oldText = typeof a.oldText === 'string' ? a.oldText : ''
    newText = typeof a.newText === 'string' ? a.newText : ''
  } else if (Array.isArray(a.edits)) {
    for (const edit of a.edits) {
      if (!edit || typeof edit !== 'object') continue
      const rec = edit as Record<string, unknown>
      const oldV = typeof rec.oldText === 'string' ? rec.oldText : typeof rec.old_string === 'string' ? rec.old_string : null
      const newV = typeof rec.newText === 'string' ? rec.newText : typeof rec.new_string === 'string' ? rec.new_string : null
      if (oldV === null && newV === null) continue
      oldText = oldV ?? ''
      newText = newV ?? ''
      break
    }
  }
  if (oldText === null && newText === null) return null
  const removed = clip(oldText ?? '', EDIT_PREVIEW_MAX_CHARS)
  const added = clip(newText ?? '', EDIT_PREVIEW_MAX_CHARS)
  return {
    removed: removed.text,
    added: added.text,
    removedTruncated: removed.truncated,
    addedTruncated: added.truncated,
  }
}

// ─────────────────────────── 单条工具审批 ───────────────────────────

/** 单条审批的操作 id —— 组件按它映射到 store action。 */
export const TOOL_ACTION = {
  approve: 'tool:approve',
  alwaysAllowProject: 'tool:always-allow-project',
  reject: 'tool:reject',
} as const

export interface ToolApprovalView {
  ariaLabel: string
  title: string
  toolName: string
  /** 无衬线展示名（Edit / Bash / Read …）。 */
  label: string
  /** 一行目标描述（路径 / 命令…）。 */
  target: string
  risk: RiskWord
  args: ArgsPreview
  /** store 生成的预览文本（参数井里作为次选内容）。 */
  preview: string
  edit: EditPreview | null
  actions: CardAction[]
}

export const TOOL_APPROVAL_TITLE = '需要你确认下一步'
export const DANGEROUS_APPROVAL_TITLE = '需要你确认这条危险命令'

/**
 * 单条工具审批的视图模型。
 * 危险命令只给 批准 / 拒绝 —— 危险命令不可加入任何白名单（approvalHook 的
 * 硬规则，卡片不能提供 store 会拒绝的选项）。
 */
export function toolApprovalView(
  payload: { toolCall: ToolCallLike; preview: string; dangerous?: boolean },
): ToolApprovalView {
  const { toolCall, preview, dangerous } = payload
  const label = toolLabel(toolCall.name)
  const risk = riskOf(toolCall, { dangerous })
  const actions: CardAction[] = [
    {
      id: TOOL_ACTION.approve,
      label: '批准',
      ariaLabel: `批准 ${label} 的这次调用`,
      tone: 'primary',
      kbd: '↵',
    },
  ]
  if (!dangerous) {
    actions.push({
      id: TOOL_ACTION.alwaysAllowProject,
      label: '始终允许（本项目）',
      ariaLabel: `始终允许本项目使用 ${label}`,
      tone: 'plain',
      kbd: '⌘⇧↵',
    })
  }
  actions.push({
    id: TOOL_ACTION.reject,
    label: '拒绝',
    ariaLabel: `拒绝 ${label} 的这次调用`,
    tone: 'danger',
    kbd: 'Esc',
  })
  return {
    ariaLabel: dangerous ? '工具审批：危险命令' : '工具审批',
    title: dangerous ? DANGEROUS_APPROVAL_TITLE : TOOL_APPROVAL_TITLE,
    toolName: toolCall.name,
    label,
    target: toolTarget(toolCall, preview),
    risk,
    args: argsPreview(toolCall.arguments as Record<string, unknown> | undefined),
    preview,
    edit: editPreviewOf(toolCall),
    actions,
  }
}

// ─────────────────────────── 批量审批 ───────────────────────────

export interface BatchToolLike {
  id: string
  name: string
  arguments?: Record<string, unknown>
}

export interface BatchItemView {
  id: string
  toolName: string
  label: string
  target: string
  risk: RiskWord
}

export type ItemDecision = 'approve' | 'reject'
export type BatchDecisions = Record<string, ItemDecision>

export const BATCH_ACTION = {
  approveAll: 'batch:approve-all',
  confirmEach: 'batch:confirm-each',
  applyItems: 'batch:apply-items',
  rejectAll: 'batch:reject-all',
} as const

/** 面包屑：N 个操作待批准。 */
export function batchTitle(count: number): string {
  return `${count} 个操作待批准`
}

/** 一项一行：工具（等宽）+ 目标 + 风险词。顺序严格跟载荷一致（不排序）。 */
export function batchItems(tools: readonly BatchToolLike[], previews?: readonly string[]): BatchItemView[] {
  return tools.map((tc, i) => ({
    id: tc.id,
    toolName: tc.name,
    label: toolLabel(tc.name),
    target: toolTarget(
      { name: tc.name, arguments: (tc.arguments || {}) as ToolCall['arguments'] },
      previews?.[i],
    ),
    risk: riskOf({ name: tc.name, arguments: (tc.arguments || {}) as ToolCall['arguments'] }),
  }))
}

export interface BatchView {
  ariaLabel: string
  title: string
  description: string
  items: BatchItemView[]
  expanded: boolean
  actions: CardAction[]
}

/**
 * 批量审批：收起态只列清单 + 三个纯文字操作；
 * 展开态（逐条确认）每行多出 批准 / 拒绝 两个文字操作，操作条换成「应用」。
 */
export function batchView(
  payload: { tools: readonly BatchToolLike[]; previews?: readonly string[] },
  opts?: { expanded?: boolean; decisions?: BatchDecisions },
): BatchView {
  const expanded = opts?.expanded === true
  const items = batchItems(payload.tools, payload.previews)
  const decided = items.filter((it) => !!opts?.decisions?.[it.id]).length
  const actions: CardAction[] = expanded
    ? [
        {
          id: BATCH_ACTION.applyItems,
          label: decided >= items.length ? '应用逐条选择' : `还需选择 ${items.length - decided} 项`,
          ariaLabel: '应用逐条批准或拒绝的选择',
          tone: 'primary',
          disabled: decided === 0 || decided < items.length,
        },
        {
          id: BATCH_ACTION.rejectAll,
          label: '全部拒绝',
          ariaLabel: `全部拒绝这 ${items.length} 个操作`,
          tone: 'danger',
        },
      ]
    : [
        {
          id: BATCH_ACTION.approveAll,
          label: '全部批准',
          ariaLabel: `全部批准这 ${items.length} 个操作`,
          tone: 'primary',
        },
        {
          id: BATCH_ACTION.confirmEach,
          label: '逐条确认',
          ariaLabel: '逐条确认这批操作',
          tone: 'plain',
        },
        {
          id: BATCH_ACTION.rejectAll,
          label: '全部拒绝',
          ariaLabel: `全部拒绝这 ${items.length} 个操作`,
          tone: 'danger',
        },
      ]
  return {
    ariaLabel: '批量审批',
    title: batchTitle(items.length),
    description: '这批操作被合并成一张卡，避免逐个弹卡。',
    items,
    expanded,
    actions,
  }
}

export interface BatchApplyPlan {
  /** 交给 store 的粗粒度决定（store 只认这三个值）。 */
  decision: 'all' | 'confirm' | 'reject'
  /** 逐条勾成「批准」的工具名（去重）——组件把它们写进会话白名单。 */
  allowNames: string[]
  rejectedCount: number
  decided: number
  total: number
}

/**
 * 逐条选择 → store 可执行的最小映射。
 *
 * store 的 `decideBatchApproval` 只有 all/confirm/reject 三档（没有逐条决定的
 * 入口），所以：全批准 = all；全拒绝 = reject；混合 = confirm（= 让管线逐个
 * 弹卡），并把已批准的**工具名**写进会话白名单，使它们不再弹卡；
 * 已拒绝的名字没有任何 store 入口，只能靠随后的单卡再拒一次。
 */
export function batchApplyPlan(
  tools: readonly BatchToolLike[],
  decisions: BatchDecisions,
): BatchApplyPlan {
  const total = tools.length
  const approved = tools.filter((t) => decisions[t.id] === 'approve')
  const rejected = tools.filter((t) => decisions[t.id] === 'reject')
  const decided = approved.length + rejected.length
  const allowNames = Array.from(new Set(approved.map((t) => t.name)))
  const decision: BatchApplyPlan['decision'] = total > 0 && rejected.length === total
    ? 'reject'
    : total > 0 && approved.length === total
      ? 'all'
      : 'confirm'
  return { decision, allowNames, rejectedCount: rejected.length, decided, total }
}

// ─────────────────────────── 澄清提问 ───────────────────────────

export interface QuestionLike {
  question: string
  options?: string[]
  multiSelect?: boolean
  preview?: string[]
}

export interface QuestionOptionView {
  /** 载荷里的原下标（回答要按它取文本）。 */
  index: number
  label: string
  preview?: string
}

export const QUESTION_ACTION = {
  submit: 'question:submit',
  skip: 'question:skip',
} as const

/** 跳过的回答原文（与旧提问卡一致，agent 能看懂「用户没答」）。 */
export const SKIP_ANSWER = '（用户跳过了此问题）'
/** 空输入直接发送时的兜底（与旧卡一致）。 */
export const EMPTY_ANSWER = '（无输入）'

export interface QuestionView {
  ariaLabel: string
  question: string
  multiSelect: boolean
  options: QuestionOptionView[]
  freeTextPlaceholder: string
  /** 多选才有「提交选择」；单选点选项即提交。 */
  actions: CardAction[]
}

/**
 * 提问卡片视图模型。选项顺序 = 载荷顺序（模型给的顺序就是它想让你比较的顺序，
 * 不能排序）；空选项被剔除但保留下标，preview 按下标对齐。
 *
 * multiSelect 只在真有选项时生效：模型常常发 multiSelect=true 却漏了 options，
 * 那种载荷必须退化成「单选 + 自由文本」，否则用户会看到一张没有任何可点项的卡。
 */
export function questionView(q: QuestionLike): QuestionView {
  const rawOptions = Array.isArray(q.options) ? q.options : []
  const previews = Array.isArray(q.preview) ? q.preview : []
  const options: QuestionOptionView[] = []
  rawOptions.forEach((opt, index) => {
    const label = typeof opt === 'string' ? opt.trim() : ''
    if (!label) return
    const preview = previews[index]
    options.push({ index, label, preview: preview && preview.trim() ? preview : undefined })
  })
  const multiSelect = q.multiSelect === true && options.length > 0
  const actions: CardAction[] = []
  if (multiSelect) {
    actions.push({
      id: QUESTION_ACTION.submit,
      label: '提交选择',
      ariaLabel: '提交已选的选项',
      tone: 'primary',
    })
  }
  actions.push({
    id: QUESTION_ACTION.skip,
    label: '跳过',
    ariaLabel: '跳过这个问题',
    tone: 'plain',
  })
  return {
    ariaLabel: '澄清提问',
    question: q.question || '',
    multiSelect,
    options,
    freeTextPlaceholder: options.length > 0 ? '或输入自定义回答…' : '输入回答…',
    actions,
  }
}

/**
 * 组装要回喂给 agent 的回答：自由文本优先；否则按选中顺序用「；」拼接
 * （与旧提问卡的回喂格式一致）。都为空时返回 ''，由调用方决定兜底。
 */
export function composeAnswer(q: QuestionLike, selected: readonly number[], freeText: string): string {
  const text = freeText.trim()
  if (text) return text
  const options = Array.isArray(q.options) ? q.options : []
  const picked = [...new Set(selected)]
    .sort((a, b) => a - b)
    .map((i) => (typeof options[i] === 'string' ? options[i].trim() : ''))
    .filter(Boolean)
  return picked.join('；')
}

// ─────────────────────────── 计划审批 ───────────────────────────

export type PlanState = 'pending' | 'approved' | 'canceled'

export interface PlanLike {
  planContent?: string
  planStatus?: 'none' | 'pending_approval' | 'approved' | 'canceled'
  planDeliverables?: string[]
}

export const PLAN_ACTION = {
  approve: 'plan:approve',
  revise: 'plan:revise',
  cancel: 'plan:cancel',
  reapprove: 'plan:reapprove',
} as const

export const PLAN_SUMMARY_MAX_LINES = 3

export interface PlanView {
  state: PlanState
  ariaLabel: string
  title: string
  /** 收起态摘要：最多 3 行。 */
  lines: string[]
  /** 摘要没显示出来的步数（0 = 全显示了）。 */
  hiddenSteps: number
  deliverables: string[]
  /** 已批准 / 已取消时的那一条 muted 记录。 */
  recordLine: string
  actions: CardAction[]
}

export interface PlanParse {
  title: string
  steps: string[]
}

/** planContent（submit_plan 存的 JSON，或纯文本兜底）→ 标题 + 每步一行。 */
export function parsePlan(planContent: string): PlanParse {
  const fallbackTitle = '执行计划'
  if (!planContent) return { title: fallbackTitle, steps: [] }
  try {
    const parsed = JSON.parse(planContent) as Record<string, unknown>
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallbackTitle
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : []
    const steps: string[] = []
    for (const step of rawSteps) {
      if (typeof step === 'string') {
        if (step.trim()) steps.push(step.trim())
        continue
      }
      if (!step || typeof step !== 'object') continue
      const rec = step as Record<string, unknown>
      const summary = typeof rec.summary === 'string' ? rec.summary.trim() : ''
      const detail = typeof rec.detail === 'string' ? rec.detail.trim() : ''
      const line = summary || detail
      if (line) steps.push(line)
    }
    return { title, steps }
  } catch {
    const lines = planContent.split('\n').map((l) => l.trim()).filter(Boolean)
    const first = lines[0] || fallbackTitle
    return { title: oneLine(first.replace(/^#+\s*/, ''), 60), steps: lines.slice(1) }
  }
}

/**
 * 计划卡片视图模型。null = 这个会话没有计划可展示（不画卡）。
 * pending 给三个操作；approved 收成一条 muted 记录；canceled 的记录带「重新批准」。
 */
export function planView(plan: PlanLike | null | undefined, maxLines = PLAN_SUMMARY_MAX_LINES): PlanView | null {
  const status = plan?.planStatus
  if (!plan?.planContent || !status || status === 'none') return null
  const { title, steps } = parsePlan(plan.planContent)
  const lines = steps.slice(0, Math.max(0, maxLines))
  const hiddenSteps = Math.max(0, steps.length - lines.length)
  const deliverables = Array.isArray(plan.planDeliverables) ? plan.planDeliverables.filter(Boolean) : []
  const state: PlanState = status === 'pending_approval' ? 'pending' : status === 'approved' ? 'approved' : 'canceled'

  const actions: CardAction[] =
    state === 'pending'
      ? [
          { id: PLAN_ACTION.approve, label: '批准计划', ariaLabel: '批准计划并开始执行', tone: 'primary' },
          { id: PLAN_ACTION.revise, label: '要求修改', ariaLabel: '要求修改这份计划', tone: 'plain' },
          { id: PLAN_ACTION.cancel, label: '取消', ariaLabel: '取消这份计划', tone: 'plain' },
        ]
      : state === 'canceled'
        ? [{ id: PLAN_ACTION.reapprove, label: '重新批准', ariaLabel: '重新批准这份计划', tone: 'primary' }]
        : []

  const stepCount = steps.length
  const recordLine =
    state === 'approved'
      ? `计划已批准 · ${stepCount} 步${deliverables.length ? ` · ${deliverables.length} 个文件` : ''}`
      : `计划已取消 · ${stepCount} 步 · 可重新批准`

  return {
    state,
    ariaLabel: title,
    title,
    lines,
    hiddenSteps,
    deliverables,
    recordLine,
    actions,
  }
}

// ─────────────────────────── 重新生成 / 回退全部 ───────────────────────────

export const CONFIRM_ACTION = {
  regenerateRevert: 'confirm:regenerate-revert',
  regenerateKeep: 'confirm:regenerate-keep',
  revertAll: 'confirm:revert-all',
  revertAllKeep: 'confirm:revert-all-keep',
  dismiss: 'confirm:dismiss',
} as const

export interface FileConfirmView {
  ariaLabel: string
  title: string
  body: string
  files: string[]
  actions: CardAction[]
}

/** 去重 + 去空，保持出现顺序（回退按路径集合，重复没有意义）。 */
export function uniquePaths(paths: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths || []) {
    const path = (p || '').trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

export function regenerateConfirmView(filePaths: readonly string[] | undefined): FileConfirmView {
  const files = uniquePaths(filePaths)
  return {
    ariaLabel: '重新生成确认',
    title: '重新生成这条回复？',
    body: `这条回复修改了 ${files.length} 个文件。回退这些改动后再重新生成，或保留改动直接重来。`,
    files,
    actions: [
      { id: CONFIRM_ACTION.dismiss, label: '取消', ariaLabel: '取消重新生成', tone: 'plain' },
      {
        id: CONFIRM_ACTION.regenerateRevert,
        label: '回退并重新生成',
        ariaLabel: '回退这些改动并重新生成',
        tone: 'danger',
      },
      {
        id: CONFIRM_ACTION.regenerateKeep,
        label: '保留并重新生成',
        ariaLabel: '保留这些改动并重新生成',
        tone: 'primary',
      },
    ],
  }
}

export function revertAllConfirmView(filePaths: readonly string[] | undefined): FileConfirmView {
  const files = uniquePaths(filePaths)
  return {
    ariaLabel: '回退全部改动',
    title: '把本次改动全部回退？',
    body: `本次会话有 ${files.length} 个文件被改过。回退后这些改动会回到 AI 动手前。`,
    files,
    actions: [
      { id: CONFIRM_ACTION.revertAllKeep, label: '保留改动', ariaLabel: '保留这些改动', tone: 'primary' },
      { id: CONFIRM_ACTION.revertAll, label: '回退全部', ariaLabel: '回退全部改动', tone: 'danger' },
    ],
  }
}

// ─────────────────────────── 计划外写入拦截 ───────────────────────────

export const SCOPE_ACTION = {
  addToPlan: 'scope:add-to-plan',
  switchMode: 'scope:switch-mode',
  reject: 'scope:reject',
} as const

export interface ScopeView {
  ariaLabel: string
  title: string
  body: string
  paths: string[]
  actions: CardAction[]
}

/** 越界路径的一行摘要：最多列 3 个，其余「等 N 个路径」。 */
export function scopePathsLine(paths: readonly string[]): string {
  const list = uniquePaths(paths)
  if (list.length === 0) return '（未声明路径）'
  const head = list.slice(0, 3).join('、')
  return list.length > 3 ? `${head} 等 ${list.length} 个路径` : head
}

export function scopeView(toolName: string, paths: readonly string[]): ScopeView {
  const list = uniquePaths(paths)
  return {
    ariaLabel: '计划外写入被拦截',
    title: '计划外写入被拦截',
    body: `${scopePathsLine(list)} 不在批准的计划内，未写入任何内容。`,
    paths: list,
    actions: [
      { id: SCOPE_ACTION.addToPlan, label: '加入计划并执行', ariaLabel: '把这些路径加入计划并执行', tone: 'primary' },
      { id: SCOPE_ACTION.switchMode, label: '切换模式继续', ariaLabel: '切换到自动编辑模式继续', tone: 'plain' },
      { id: SCOPE_ACTION.reject, label: '拒绝', ariaLabel: `拒绝 ${toolLabel(toolName)} 的这次写入`, tone: 'danger' },
    ],
  }
}

// ─────────────────────────── 键盘映射 ───────────────────────────

/** 一份最小键盘事件形状（React 的 KeyboardEvent 结构上兼容）。 */
export interface ApprovalKeyEvent {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

export type ApprovalKeyAction = 'primary' | 'always-allow' | 'reject-focus'

/**
 * 决策卡的键盘契约：
 *   Enter          → 主操作（批准 / 全部批准 / 提交选择）
 *   ⌘⇧Enter（Ctrl⇧Enter）→ 始终允许（本项目）
 *   Esc            → 把焦点送到「拒绝」上（二次 Esc 才真的拒绝，防误触）
 * ⌘/Ctrl+Enter（不带 Shift）不映射：它是 composer 的「发送」，在决策卡上留空。
 */
export function resolveApprovalKey(e: ApprovalKeyEvent): ApprovalKeyAction | null {
  if (e.key === 'Escape') return 'reject-focus'
  if (e.key !== 'Enter') return null
  if (e.altKey) return null
  const mod = !!(e.metaKey || e.ctrlKey)
  if (mod && e.shiftKey) return 'always-allow'
  if (mod) return null
  return 'primary'
}

/**
 * 在文本输入里按 Enter 是「换行/输入」而不是「批准」——决策卡的键盘映射必须
 * 让开输入框，否则用户在自定义回答里打字会顺手把工具批准掉。
 */
export function isTextEntry(tagName: string | undefined, isContentEditable = false): boolean {
  if (isContentEditable) return true
  const tag = (tagName || '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
