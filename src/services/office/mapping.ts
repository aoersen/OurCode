/**
 * 3D 办公室 × 目标模式：纯函数映射层（无副作用，便于单测）。
 *
 * 职责：把 IDE 侧真实状态（目标模式子 Agent 进度）映射为 3D 场景 / 看板可消费的
 * 指令载荷 —— 角色→工位槽位分配、子 Agent 状态→场景状态、任务进度估计、
 * 8 工位常驻状态（看板团队状态栏与 3D 场景共用同一套槽位池）。
 */
import type { OfficeAgentState, OfficeStatus, SubAgentProgress } from '@shared/types'

/** 8 个工位的静态基础信息（与 office-v3 src/data/agentsData.js 对齐）。 */
export const OFFICE_SLOTS: Array<{ id: number; role: string; codeName: string }> = [
  { id: 1, role: '架构总监', codeName: 'Director-01' },
  { id: 2, role: '需求分析师', codeName: 'PM-02' },
  { id: 3, role: 'UI/UX 设计师', codeName: 'Design-03' },
  { id: 4, role: '核心架构师', codeName: 'Dev-04' },
  { id: 5, role: '业务研发-1', codeName: 'Dev-05' },
  { id: 6, role: '业务研发-2', codeName: 'Dev-06' },
  { id: 7, role: '自动化测试-1', codeName: 'QA-07' },
  { id: 8, role: '性能测试-2', codeName: 'QA-08' },
]

/** 角色名 → 可用的工位槽位组（按优先级排序）。支持 tm- 前缀与内建名。 */
const ROLE_SLOTS: Record<string, number[]> = {
  'tm-requirement-analyst': [2],
  'tm-ui-developer': [3],
  'tm-developer': [4, 5, 6],
  'tm-tester': [7, 8],
  'requirement-analyst': [2],
  'ui-developer': [3],
  'developer': [4, 5, 6],
  'tester': [7, 8],
  'code-reviewer': [8, 7],
  'test-generator': [7, 8],
  'researcher': [6, 5],
}

/** 构造 8 槽初始状态（全空闲）。 */
export function buildInitialOfficeAgents(): OfficeAgentState[] {
  return OFFICE_SLOTS.map((s) => ({
    ...s,
    status: 'idle' as OfficeStatus,
    task: '待命中 · 等待监管派发任务',
    progress: 0,
    logs: [],
  }))
}

/** 子 Agent 结束态 → 场景状态。 */
export function subagentStatusToOffice(status: SubAgentProgress['status']): OfficeStatus {
  switch (status) {
    case 'running':
      return 'working'
    case 'done':
      return 'completed'
    case 'error':
    case 'stopped':
      return 'error'
    default:
      return 'idle'
  }
}

/** 看板 4 态(与团队状态栏状态药片对齐:工作中/已完成/失败/空闲)。 */
export type SlotStatus = 'working' | 'completed' | 'error' | 'idle'

/** 子任务态 → 看板 4 态(仅子 Agent 状态能收敛到的 4 种,无场景专属态)。 */
function toSlotStatus(s: SubAgentProgress['status']): SlotStatus {
  return s === 'running' ? 'working' : s === 'done' ? 'completed' : 'error'
}

/** 8 工位常驻分配结果:占位的子任务 key + 看板状态;无任务为 null + idle。 */
export interface SlotAssignment {
  key: string | null
  status: SlotStatus
}

/** 槽位抢占排序:运行中 → 失败/停止 → 完成(同优先级按启动时间先后)。 */
const rankSlotTask = (s: SubAgentProgress['status']) => (s === 'running' ? 0 : s === 'error' || s === 'stopped' ? 1 : 2)

/**
 * 8 工位常驻状态(看板团队状态栏):子任务按角色槽位池占位——运行中优先抢位,
 * 失败次之,完成后到;槽位池占满后其余子任务不占位(保持空闲)。与 3D 场景
 * 共用 ROLE_SLOTS 槽位池与 assignSlot 语义,保证看板与场景的角色/状态对得上。
 * 1 号监管槽不参与子任务占位(监管状态由主循环相位单独驱动,见组件层)。
 */
export function computeSlotAssignments(tasks: Array<{ key: string; p: SubAgentProgress }>): SlotAssignment[] {
  const out: SlotAssignment[] = OFFICE_SLOTS.map(() => ({ key: null, status: 'idle' }))
  const occupied = new Set<number>()
  const ordered = [...tasks].sort(
    (a, b) => rankSlotTask(a.p.status) - rankSlotTask(b.p.status) || a.p.startedAt - b.p.startedAt,
  )
  for (const { key, p } of ordered) {
    const role = envelopeRole(p.task) || p.name
    const slot = assignSlot(role, occupied)
    if (slot == null) continue
    occupied.add(slot)
    out[slot - 1] = { key, status: toSlotStatus(p.status) }
  }
  return out
}

/** 8 工位 → 看板角色组(点击槽位卡切换右侧工作记录;1 号监管不在子任务池内)。 */
export const SLOT_GROUP: Record<number, RoleGroup> = {
  2: '产品',
  3: '设计',
  4: '研发',
  5: '研发',
  6: '研发',
  7: '测试',
  8: '测试',
}

/**
 * 为某个角色分配一个空闲工位。返回 null 表示该角色池已满（调用方走溢出
 * 处理，不强行占位）。occupied 为当前已被活跃子 Agent 占用的槽位集合。
 */
export function assignSlot(name: string, occupied: Set<number>): number | null {
  const preferred = ROLE_SLOTS[name] || []
  for (const slot of preferred) {
    if (!occupied.has(slot)) return slot
  }
  return null
}

/** 子 Agent 无真实百分比，用工具调用步数做粗略进度估计（0-100）。 */
export function estimateProgress(p: SubAgentProgress): number {
  if (p.status === 'done' || p.status === 'error' || p.status === 'stopped') return 100
  if (p.toolCallCount >= 8) return 85
  if (p.toolCallCount >= 4) return 60
  if (p.toolCallCount >= 1) return 40
  return 25
}

/** 任务信封 prompt 往往很长，抽屉展示时截断到一行可读长度。 */
export function summarizeTask(task: string, max = 60): string {
  if (!task) return '（无任务描述）'
  const single = task.replace(/\s+/g, ' ').trim()
  return single.length > max ? single.slice(0, max) + '…' : single
}

/** 从任务信封 frontmatter 中提取 to 角色（如 tm-developer），失败返回原值。 */
export function envelopeRole(task: string): string | null {
  const m = /^---[\s\S]*?^to:\s*(\S+)\s*$/m.exec(task || '')
  return m ? m[1] : null
}

/** 子 Agent 角色名 → 友好中文标签（内置角色表；其余剥离 tm- 前缀与连字符）。 */
const ROLE_LABELS: Record<string, string> = {
  'tm-requirement-analyst': '需求分析',
  'requirement-analyst': '需求分析',
  'tm-ui-developer': 'UI 开发',
  'ui-developer': 'UI 开发',
  'tm-developer': '研发',
  developer: '研发',
  'tm-tester': '测试',
  tester: '测试',
  'code-reviewer': '代码审查',
  'test-generator': '测试生成',
  researcher: '调研',
}

export function roleLabel(task: string, name: string): string {
  const raw = envelopeRole(task) || name || ''
  if (ROLE_LABELS[raw]) return ROLE_LABELS[raw]
  if (!raw) return '子任务'
  return raw.replace(/^tm-/, '').replace(/[-_]/g, ' ')
}

/**
 * 看板「团队」格：按运行中的子 Agent 角色推导 8 工位状态。
 * 与 3D 场景共用同一套 ROLE_SLOTS 槽位池（assignSlot）：监管（Director-01）
 * 在目标模式会话生成中时视为 working；运行中角色按传入顺序占各自池里的
 * 空闲工位；其余工位保持 idle。纯函数，无副作用。
 */
export function computeSlotStates(runningRoles: string[], supervisorActive: boolean): OfficeStatus[] {
  const states: OfficeStatus[] = Array(8).fill('idle')
  const occupied = new Set<number>()
  if (supervisorActive) {
    states[0] = 'working'
    occupied.add(1)
  }
  for (const name of runningRoles) {
    const slot = assignSlot(name, occupied)
    if (slot != null) {
      states[slot - 1] = 'working'
      occupied.add(slot)
    }
  }
  return states
}

/** 看板 4 大角色组的展示顺序与固定成员(产品/设计/研发/测试)。 */
export const ROLE_GROUPS = ['产品', '设计', '研发', '测试'] as const
export type RoleGroup = (typeof ROLE_GROUPS)[number]

/** 角色标签/角色名 → 看板角色组(聚合 8 工位为 4 张角色卡)。 */
const ROLE_GROUP_MAP: Record<string, RoleGroup> = {
  产品: '产品',
  需求分析: '产品',
  'tm-requirement-analyst': '产品',
  'requirement-analyst': '产品',
  设计: '设计',
  'UI 开发': '设计',
  'tm-ui-developer': '设计',
  'ui-developer': '设计',
  研发: '研发',
  developer: '研发',
  'tm-developer': '研发',
  测试: '测试',
  '测试生成': '测试',
  tester: '测试',
  'tm-tester': '测试',
  'test-generator': '测试',
}

/** 子 Agent → 看板角色组;无法识别时按名称/标签兜底到「研发」。 */
export function roleGroup(task: string, name: string): RoleGroup {
  const label = roleLabel(task, name)
  return ROLE_GROUP_MAP[label] ?? ROLE_GROUP_MAP[name] ?? '研发'
}
