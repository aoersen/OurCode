/**
 * 「一人公司 / Office」面的纯视图模型层。
 *
 * 这里只做「真实状态 → 排版数据」的换算，不碰 React、不碰 DOM、不读文件，
 * 因此可以直接单测（`src/__tests__/shell-office-model.test.ts`）。
 *
 * 数据口径全部沿用旧看板的真实来源，没有任何编造值：
 *  - 角色 / 工位 = 角色员工会话（workerRole/workerSlot）+ 最低编制（WORKER_ROSTER）；
 *  - 任务流 = services/office/taskRequests.buildDirectorActivities 的产物
 *    （总监派发 / 员工子智能体 / 总监本会话子智能体）；
 *  - 待决中心 = chatStore 的审批槽 + 提问槽（单槽，一次一件事）；
 *  - 目标检查清单 = .ourcode/targemode/finalGoal.md + comparison.md；
 *  - 工时 / 产能 = 会话里真实的时间戳与活动状态，不是估算出来的「经营数字」。
 *
 * 没有数据源的能力（营收）在 buildMetrics 里显式标 wired=false，UI 显示「未接入」。
 */
import type { AgentRun, ChatSession } from '@shared/types'
import {
  INBOUND_RE,
  isUserRequestMessage,
  type DirectorActivity,
  type RoleActivityStatus,
} from '@/services/office/taskRequests'
import { WORKER_ROSTER, type WorkerDef } from '@/services/office/workers'
import {
  computeCoverage,
  type GoalItemState,
} from '@/services/targetMode/goalChecklist'

// ── 文案与格式 ────────────────────────────────────────────────────────────

/** 总监（工位 1）的固定角色名。 */
export const DIRECTOR_ROLE = '总监'

/** 一行「当前任务」的最大字符数。 */
const TASK_LINE_MAX = 34

/** 「待命中」这句话在三处复用，抽出来避免文案漂移。 */
export const IDLE_TASK_LINE = '待命中 · 等待派发'
export const DIRECTOR_IDLE_TASK_LINE = '待命中 · 等待你下目标'

/** 公司名兜底（项目目录名为空时）。 */
export const COMPANY_FALLBACK_NAME = '一人公司'

/** `E:\work\ourcode` → `ourcode`；空路径返回空串。 */
export function basename(path: string): string {
  const trimmed = (path || '').replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/** 公司名：项目目录名；没连项目时给兜底名。 */
export function companyName(projectPath: string | null): string {
  return basename(projectPath || '') || COMPANY_FALLBACK_NAME
}

/** `HH:mm`（当天）/ `M月D日 HH:mm`（跨天）；0 返回空串（不造时间）。 */
export function formatClock(at: number, now = Date.now()): string {
  if (!at || !Number.isFinite(at) || at <= 0) return ''
  const d = new Date(at)
  const n = new Date(now)
  const pad = (v: number) => String(v).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? time : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

/** 毫秒 → { 数值, 单位 }（工时指标拆成 24px 数字 + 12px 单位两段）。 */
export function formatHours(ms: number): { value: string; suffix: string } {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const minutes = safe / 60_000
  if (minutes < 1) return { value: '0', suffix: '分' }
  if (minutes < 60) return { value: String(Math.round(minutes)), suffix: '分' }
  const hours = minutes / 60
  return { value: hours >= 100 ? String(Math.round(hours)) : hours.toFixed(1), suffix: '小时' }
}

/** 毫秒 → 一行人话（tooltip / 说明用）。 */
export function formatDuration(ms: number): string {
  const { value, suffix } = formatHours(ms)
  return `${value} ${suffix}`
}

/** token 数 → `1.2M` / `320k` / `12`（预算说明用，与旧顶栏同口径）。 */
export function formatTokens(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}

/** 单行截断（去换行 / 压空白），空串返回 fallback。 */
export function oneLine(text: string | null | undefined, max = TASK_LINE_MAX, fallback = ''): string {
  const single = (text || '').replace(/\s+/g, ' ').trim()
  if (!single) return fallback
  return single.length > max ? `${single.slice(0, max)}…` : single
}

// ── 公司 / 状态词 ────────────────────────────────────────────────────────

export type CompanyStatus = 'disconnected' | 'running' | 'deciding' | 'idle'

export interface CompanyStatusInput {
  /** 是否选中了公司项目（有项目根 = 已连接）。 */
  connected: boolean
  /** 公司里是否有任何会话在跑（总监 / 员工）。 */
  running: boolean
  /** 待决中心条目数。 */
  pending: number
}

/** 顶栏状态词。优先级：未连接 → 待决策 → 运行中 → 空闲。 */
export function companyStatus(input: CompanyStatusInput): { key: CompanyStatus; word: string } {
  if (!input.connected) return { key: 'disconnected', word: '未连接' }
  if (input.pending > 0) return { key: 'deciding', word: `待决策 ${input.pending}` }
  if (input.running) return { key: 'running', word: '运行中' }
  return { key: 'idle', word: '空闲' }
}

// ── 角色 / 工位 ──────────────────────────────────────────────────────────

export interface OfficeRoleRow {
  /** 稳定 key（工位号决定，跨刷新不变）。 */
  key: string
  /** 工位号 1..8（1 = 总监）。 */
  slot: number
  role: string
  /** 当前任务一行。 */
  taskLine: string
  /** 运行点（6px，ink）。 */
  running: boolean
  /** 待处理点计数（该工位的审批 / 提问）。 */
  pending: number
  /** 该工位是否有员工（false = 编制内但空缺）。 */
  staffed: boolean
  /** 状态词：运行中 / 待处理 / 失败 / 空闲 / 空缺。 */
  statusWord: string
  /** 工位会话 id（总监或员工）；空缺为 null。 */
  sessionId: string | null
}

/** 最新一次 agent run 是否失败（真实记录，不猜）。 */
export function lastRunFailed(session: ChatSession | null | undefined): boolean {
  const runs = session?.agentRuns
  if (!runs || runs.length === 0) return false
  const latest = runs.reduce<AgentRun>((a, b) => (b.startedAt > a.startedAt ? b : a), runs[0])
  return latest.status === 'error' || latest.status === 'rejected'
}

/** 单行状态词（永不只有颜色，永远带文字）。 */
export function roleStatusWord(input: {
  staffed: boolean
  running: boolean
  pending: number
  failed: boolean
}): string {
  if (!input.staffed) return '空缺'
  if (input.running) return '运行中'
  if (input.failed) return '失败'
  if (input.pending > 0) return '待处理'
  return '空闲'
}

/** 员工会话的当前任务 = 最后一条总监派发（去掉会话间前缀）。 */
export function workerTaskLine(session: ChatSession): string {
  const last = [...session.messages].reverse().find((m) => m.role === 'user' && !!m.content?.trim())
  if (!last) return IDLE_TASK_LINE
  return oneLine(last.content.replace(INBOUND_RE, ''), TASK_LINE_MAX, IDLE_TASK_LINE)
}

/** 总监会话的当前任务 = 最后一条用户真实要求（回报类消息不算）。 */
export function directorTaskLine(session: ChatSession): string {
  const last = [...session.messages].reverse().find((m) => isUserRequestMessage(m) && !!m.content?.trim())
  if (!last) return DIRECTOR_IDLE_TASK_LINE
  return oneLine(last.content, TASK_LINE_MAX, DIRECTOR_IDLE_TASK_LINE)
}

/** 从一组会话里挑「当前总监」：目标模式、非员工、最近更新。 */
export function pickDirector(sessions: ReadonlyArray<ChatSession>): ChatSession | null {
  let best: ChatSession | null = null
  for (const s of sessions) {
    if (s.targetMode !== true || s.workerRole) continue
    if (!best || (s.updatedAt || 0) > (best.updatedAt || 0)) best = s
  }
  return best
}

/** 公司项目根：总监会话绑定的项目优先，其次激活会话的项目。 */
export function resolveProjectPath(
  sessions: ReadonlyArray<ChatSession>,
  activeSessionId: string | null,
  fallbackRoot: string | null,
): string | null {
  const active = sessions.find((s) => s.id === activeSessionId) ?? null
  if (active?.projectPath) return active.projectPath
  const director = pickDirector(sessions.filter((s) => !!s.projectPath))
  if (director?.projectPath) return director.projectPath
  const firstOffice = sessions.find((s) => (s.targetMode === true || !!s.workerRole) && s.projectPath)
  return firstOffice?.projectPath ?? fallbackRoot ?? null
}

export interface RoleRowsInput {
  sessions: ReadonlyArray<ChatSession>
  projectPath: string | null
  runningSessionIds: ReadonlyArray<string>
  /** sessionId → 该会话上的待处理条数（审批 / 提问）。 */
  pendingBySession: ReadonlyMap<string, number>
}

/**
 * 角色 / 工位列表（左栏）。
 *
 * 排序：工位号升序（总监 1 → 需求分析 2 → UI 研发 3 → 研发 4..6 → 测试 7..8），
 * 动态增员的岗位才追加进列表；编制内没有员工的工位保留为「空缺」行
 * ——「没人」和「人在空闲」必须能区分（旧看板的教训）。
 */
export function buildRoleRows(input: RoleRowsInput): OfficeRoleRow[] {
  const root = input.projectPath
  if (!root) return []
  const running = new Set(input.runningSessionIds)
  const scoped = input.sessions.filter((s) => s.projectPath === root)
  const director = pickDirector(scoped)
  const workerBySlot = new Map<number, ChatSession>()
  for (const s of scoped) {
    if (!s.workerRole || typeof s.workerSlot !== 'number') continue
    // 同一工位出现两条（历史残留）时保留最近更新的那条。
    const prev = workerBySlot.get(s.workerSlot)
    if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) workerBySlot.set(s.workerSlot, s)
  }
  const pendingOf = (id: string | null): number => (id ? (input.pendingBySession.get(id) ?? 0) : 0)

  const rows: OfficeRoleRow[] = []
  const push = (slot: number, role: string, session: ChatSession | null) => {
    const staffed = !!session
    const isRunning = !!session && running.has(session.id)
    const pending = pendingOf(session?.id ?? null)
    const failed = lastRunFailed(session)
    rows.push({
      key: `slot:${slot}`,
      slot,
      role,
      taskLine: session
        ? session.workerRole
          ? workerTaskLine(session)
          : directorTaskLine(session)
        : '编制内暂无员工',
      running: isRunning,
      pending,
      staffed,
      statusWord: roleStatusWord({ staffed, running: isRunning, pending, failed }),
      sessionId: session?.id ?? null,
    })
  }

  if (director) push(1, DIRECTOR_ROLE, director)

  for (const def of WORKER_ROSTER as ReadonlyArray<WorkerDef>) {
    push(def.slot, def.title, workerBySlot.get(def.slot) ?? null)
  }

  const rosterSlots = new Set(WORKER_ROSTER.map((d) => d.slot))
  const extra = [...workerBySlot.entries()]
    .filter(([slot]) => !rosterSlots.has(slot))
    .sort((a, b) => a[0] - b[0])
  for (const [slot, session] of extra) push(slot, session.title || `员工-${slot}`, session)

  return rows.sort((a, b) => a.slot - b.slot)
}

/** 左栏里「有活的工位」数（运行中 / 待处理），用于顶栏状态说明。 */
export function activeRoleCount(rows: ReadonlyArray<OfficeRoleRow>): number {
  return rows.filter((r) => r.staffed && (r.running || r.pending > 0)).length
}

// ── 任务流 ────────────────────────────────────────────────────────────────

export type OfficeTaskStatus = RoleActivityStatus

export interface OfficeTaskRow {
  key: string
  /** 角色标签（需求分析师 / UI 研发 / 业务研发-1 …）。 */
  role: string
  task: string
  status: OfficeTaskStatus
  /** 状态词：运行中 / 待回报 / 已完成 / 失败。 */
  statusWord: string
  /** 启动时间（毫秒时间戳，展示时再格式化）。 */
  at: number
  /** 打开会话的目标（员工会话对用户隐藏，统一打开总监会话）。 */
  sessionId: string | null
}

/** 活动状态 → 状态词（5 态收敛成 4 个词，每一态都有文字）。 */
export function taskStatusWord(status: OfficeTaskStatus): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'pending':
      return '待回报'
    case 'done':
      return '已完成'
    default:
      return '失败'
  }
}

/** 活动 → 任务流行（新的在上面：任务流是「刚刚发生了什么」）。 */
export function buildTaskRows(
  activities: ReadonlyArray<DirectorActivity>,
  directorSessionId: string | null,
): OfficeTaskRow[] {
  return activities
    .map((a) => ({
      key: a.key,
      role: a.label || '子任务',
      task: oneLine(a.task, 46, '（无任务描述）'),
      status: a.status,
      statusWord: taskStatusWord(a.status),
      at: a.startedAt,
      sessionId: directorSessionId,
    }))
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
}

export interface TaskCounts {
  running: number
  waiting: number
  done: number
  failed: number
  total: number
}

/** 任务分组计数（指标卡「产能」与空态文案共用）。 */
export function groupTaskCounts(rows: ReadonlyArray<OfficeTaskRow>): TaskCounts {
  const counts: TaskCounts = { running: 0, waiting: 0, done: 0, failed: 0, total: rows.length }
  for (const row of rows) {
    if (row.status === 'running') counts.running += 1
    else if (row.status === 'pending') counts.waiting += 1
    else if (row.status === 'done') counts.done += 1
    else counts.failed += 1
  }
  return counts
}

// ── 指标卡 ────────────────────────────────────────────────────────────────

export type MetricId = 'revenue' | 'throughput' | 'backlog' | 'hours'

export interface OfficeMetric {
  key: MetricId
  label: string
  /** 24px ink 的主体（未接入时是「未接入」三个字）。 */
  value: string
  /** 12px muted 的尾缀（`/ 12`、`小时`）。 */
  suffix?: string
  /** 有真实数据源吗；false 时 UI 用灰字显示「未接入」。 */
  wired: boolean
  /** 悬停说明。 */
  title?: string
}

export interface MetricsInput {
  counts: TaskCounts
  /** 待决中心条目数。 */
  pending: number
  /** 公司会话里所有 agent run 的累计时长（毫秒）。 */
  busyMs: number
}

/**
 * 指标卡（营收 / 产能 / 待办 / 工时）。
 *
 * 营收没有任何数据源（旧看板也没有真数字）→ wired=false，显示「未接入」，
 * 绝不填假数据。其余三个都由真实时间戳 / 活动状态算出。
 */
export function buildMetrics(input: MetricsInput): OfficeMetric[] {
  const { counts, pending, busyMs } = input
  const hours = formatHours(busyMs)
  return [
    {
      key: 'revenue',
      label: '营收',
      value: '未接入',
      wired: false,
      title: '还没有营收数据源：一人公司目前不记账',
    },
    {
      key: 'throughput',
      label: '产能',
      value: String(counts.done),
      ...(counts.total > 0 ? { suffix: `/ ${counts.total}` } : {}),
      wired: true,
      title: counts.total > 0 ? `已完成 ${counts.done} / 共 ${counts.total} 条角色活动` : '还没有角色活动',
    },
    {
      key: 'backlog',
      label: '待办',
      value: String(pending),
      wired: true,
      title: pending > 0 ? `${pending} 件需要你决定` : '没有需要你决定的事',
    },
    {
      key: 'hours',
      label: '工时',
      value: hours.value,
      suffix: hours.suffix,
      wired: true,
      title: `公司会话累计运行 ${formatDuration(busyMs)}`,
    },
  ]
}

/**
 * 公司会话里所有 agent run 的累计时长。
 * 已结束的取 finishedAt-startedAt；仍在跑的取 now-startedAt（有真实开始时间才算）。
 */
export function busyMsOf(sessions: ReadonlyArray<ChatSession>, now = Date.now()): number {
  let total = 0
  for (const session of sessions) {
    for (const run of session.agentRuns ?? []) {
      const start = run.startedAt ?? 0
      if (!start || start <= 0) continue
      const end = run.finishedAt && run.finishedAt > start ? run.finishedAt : now
      if (end > start) total += end - start
    }
  }
  return total
}

// ── 待决中心 ──────────────────────────────────────────────────────────────

export type PendingKind = 'approval' | 'question' | 'budget'

export interface PendingDescriptor {
  key: string
  kind: PendingKind
  /** 会话 id（审批 / 提问）；预算条目是项目级 → null。 */
  sessionId: string | null
  title: string
  detail: string
  /** 主行动文案（批准 / 第一个选项）。 */
  primaryLabel: string
  /** 次行动文案（拒绝 / 稍后 / 忽略）。 */
  secondaryLabel?: string
}

export interface PendingInput {
  approval: { sessionId: string; toolName: string; preview: string } | null
  question: { sessionId: string; question: string; options: string[]; dismissed: boolean } | null
  budget: { exceeded: boolean; used: number; limit: number } | null
}

/** 待决条目 → 纯描述（动作回调由 hook 绑定，模型层不产生副作用）。 */
export function buildPendingDescriptors(input: PendingInput): PendingDescriptor[] {
  const out: PendingDescriptor[] = []
  if (input.approval) {
    out.push({
      key: 'approval',
      kind: 'approval',
      sessionId: input.approval.sessionId,
      title: `工具审批：${input.approval.toolName}`,
      detail: oneLine(input.approval.preview, 90, '（无预览）'),
      primaryLabel: '批准',
      secondaryLabel: '拒绝',
    })
  }
  if (input.question && !input.question.dismissed) {
    // 选项回答属于「对话里的事」：这里只把用户送到那场对话，不在摘要行里
    // 替用户选第一个选项（旧待决中心的教训：一键替用户做决定的入口不可信）。
    out.push({
      key: 'question',
      kind: 'question',
      sessionId: input.question.sessionId,
      title: oneLine(input.question.question, 60, '（提问）'),
      detail: oneLine(input.question.options.join(' / '), 90, '（无选项）'),
      primaryLabel: '去回答',
      secondaryLabel: '稍后',
    })
  }
  if (input.budget?.exceeded) {
    out.push({
      key: 'budget',
      kind: 'budget',
      sessionId: null,
      title: '预算触顶',
      detail: `${formatTokens(input.budget.used)} / ${formatTokens(input.budget.limit)} · 总监与员工合计`,
      primaryLabel: '知道了',
      secondaryLabel: '忽略',
    })
  }
  return out
}

/** 待决条目 → 归属到工位会话的计数表（左栏待处理点）。 */
export function pendingCountBySession(descriptors: ReadonlyArray<PendingDescriptor>): Map<string, number> {
  const map = new Map<string, number>()
  for (const d of descriptors) {
    if (!d.sessionId) continue
    map.set(d.sessionId, (map.get(d.sessionId) ?? 0) + 1)
  }
  return map
}

// ── 目标检查清单 ──────────────────────────────────────────────────────────

export type ChecklistMark = '✓' | '…' | '○'

export interface OfficeChecklistRow {
  key: string
  index: number
  mark: ChecklistMark
  text: string
  state: GoalItemState
}

/** 条目状态 → 勾选符号（只在文字层表达，不用彩色徽章）。 */
export function checklistMark(state: GoalItemState): ChecklistMark {
  if (state === 'done') return '✓'
  if (state === 'waiting') return '…'
  return '○'
}

/** 清单条目 → 行（顺序即 finalGoal.md 的顺序）。 */
export function buildChecklistRows(
  items: ReadonlyArray<{ text: string; state: GoalItemState }>,
): OfficeChecklistRow[] {
  return items.map((item, index) => ({
    key: `${index}:${item.text.slice(0, 24)}`,
    index,
    mark: checklistMark(item.state),
    text: oneLine(item.text, 120, '（未命名条目）'),
    state: item.state,
  }))
}

export interface ChecklistProgress {
  done: number
  waiting: number
  todo: number
  total: number
  /** 加权覆盖率 0–100（与 services/targetMode/goalChecklist 同口径）。 */
  percent: number
}

/** n/m 计数 + 加权百分比。 */
export function checklistProgress(
  items: ReadonlyArray<{ state: GoalItemState }>,
): ChecklistProgress {
  const progress: ChecklistProgress = { done: 0, waiting: 0, todo: 0, total: items.length, percent: 0 }
  for (const item of items) {
    if (item.state === 'done') progress.done += 1
    else if (item.state === 'waiting') progress.waiting += 1
    else progress.todo += 1
  }
  progress.percent = items.length > 0 ? computeCoverage([...items]) : 0
  return progress
}

/** `n/m`（清单通过数 / 总数）。 */
export function checklistCountText(progress: ChecklistProgress): string {
  return `${progress.done}/${progress.total}`
}

export interface StageStatusLike {
  round: number | null
  stageCurrent: number | null
  stageTotal: number | null
}

/** 阶段行文案：`阶段 3/5`（有阶段）→ `第 2 轮`（只有轮次）→ 空串。 */
export function stageLine(status: StageStatusLike | null): string {
  if (!status) return ''
  if (status.stageCurrent != null && status.stageTotal != null) {
    return `阶段 ${status.stageCurrent}/${status.stageTotal}`
  }
  if (status.round != null) return `第 ${status.round} 轮`
  return ''
}

/** 阶段行的辅助文本：轮次（阶段行已经用了阶段号时才有意义）。 */
export function roundLine(status: StageStatusLike | null): string {
  if (!status || status.round == null) return ''
  if (status.stageCurrent != null && status.stageTotal != null) return `第 ${status.round} 轮`
  return ''
}

// ── 键盘选择（列表 ↑/↓/Home/End）────────────────────────────────────────

export type SelectionKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

export function isSelectionKey(key: string): key is SelectionKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End'
}

/**
 * 选择位移动（闭环绕回，空列表返回 -1）：
 * ↓ 到底回第一条、↑ 到顶回最后一条 —— 键盘用户不会「卡死在列表边缘」。
 */
export function moveSelection(index: number, key: SelectionKey, length: number): number {
  if (length <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  const current = index < 0 || index >= length ? (key === 'ArrowUp' ? 0 : -1) : index
  if (key === 'ArrowDown') return current + 1 >= length ? 0 : current + 1
  return current - 1 < 0 ? length - 1 : current - 1
}

/** 列表选择初始化：优先沿用已选 key，否则第一条。 */
export function initialSelectionIndex(keys: ReadonlyArray<string>, selectedKey: string | null): number {
  if (keys.length === 0) return -1
  if (!selectedKey) return 0
  const index = keys.indexOf(selectedKey)
  return index >= 0 ? index : 0
}
