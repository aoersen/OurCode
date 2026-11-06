/**
 * 一人公司角色员工（M4）：8 工位动态编制。
 *
 * 编制模型（2026-09-24 定稿）：
 * - 固定：总监（用户只与他对话）、需求分析师、UI 研发；
 * - 动态：业务研发 N 名（最少 1）、测试 N 名（最少 1），按任务量增删；
 * - 每名研发/测试是独立会话（独立上下文、独立运行），研发1 干活时研发2
 *   可以并行领互不冲突的任务，也可以空闲。
 *
 * 员工会话 = ChatSession（workerRole/workerSlot/hidden），对用户隐藏；总监
 * 通过 send_message 派活，员工完成后（含出错/停止）主动 send_message 回报，
 * 回报入站触发总监续跑。员工创建的子智能体（run_subagent readonly）只读。
 */
import type { ChatSession } from '@shared/types'

export interface WorkerDef {
  slot: number
  role: string
  title: string
}

/** 工位 → 默认员工（一人公司开张时的最低编制）。 */
export const WORKER_ROSTER: WorkerDef[] = [
  { slot: 2, role: 'tm-requirement-analyst', title: '需求分析师' },
  { slot: 3, role: 'tm-ui-developer', title: 'UI 研发' },
  { slot: 4, role: 'tm-developer', title: '业务研发-1' },
  { slot: 7, role: 'tm-tester', title: '测试-1' },
]

/** 研发工位池（4/5/6）与测试工位池（7/8）——动态增员时按序取空位。 */
export const DEV_SLOTS = [4, 5, 6]
export const TEST_SLOTS = [7, 8]

/** 增员岗位（研发 / 测试）。 */
export type WorkerKind = 'dev' | 'test'

/** 岗位 → 工位池（容量即池长度：研发 3、测试 2）。 */
export function workerPool(kind: WorkerKind): number[] {
  return kind === 'test' ? TEST_SLOTS : DEV_SLOTS
}

/**
 * 在岗位池里取第一个空位；满员返回 null。
 * 增员的成败判定单独抽成纯函数：调用方（store）据此区分「满员」和「没有模型」
 * 两种失败，看板按钮才能给出准确反馈，而不是一律弹「满员」。
 */
export function pickFreeSlot(kind: WorkerKind, occupied: Iterable<number>): number | null {
  const used = new Set(occupied)
  return workerPool(kind).find((n) => !used.has(n)) ?? null
}

/** 增员时可选的动态角色（研发/测试各自按池取号）。 */
export function roleForSlot(slot: number): string {
  if (DEV_SLOTS.includes(slot)) return 'tm-developer'
  if (TEST_SLOTS.includes(slot)) return 'tm-tester'
  return 'tm-developer'
}

export function titleForSlot(slot: number): string {
  if (DEV_SLOTS.includes(slot)) return `业务研发-${slot - 3}`
  if (TEST_SLOTS.includes(slot)) return `测试-${slot - 6}`
  if (slot === 2) return '需求分析师'
  if (slot === 3) return 'UI 研发'
  return `员工-${slot}`
}

/** 员工会话的运行时规则（拼在角色定义 systemPrompt 之后）。 */
export const WORKER_RULES = `
你是一家「一人公司」的员工，工位与角色见你的身份定义。以下规则必须遵守：

1. 你的老板是总监：他通过会话间消息（以「[来自会话「总监…」的会话间消息]」开头）给你派活。
2. 接到任务后自主执行：规划 → 干活（写代码/写测试/写文档）→ 自检（typecheck/测试）→ 回报。
3. 完成任务、或出错、或被停止时，都必须调用 send_message 向总监会话回报——
   回报要包含：结论（完成/失败/阻塞）+ 改了哪些文件 + 验证输出摘要。不要等任何人催。
   回报控制在 8 行以内：只写结论、文件、验证结果和阻塞点，不要复述过程。
4. 如果需要调研，可以创建子智能体（run_subagent 带 readonly: true）——子智能体
   只能读不能改，一切写操作必须由你本人执行。
5. 你只与总监对话；不直接与用户对话。
6. 若任务需要改动信封 files_to_modify 之外的文件，先停下回报，不要擅自扩大范围。
7. 不要反复读取已经读过且没有变化的内容；需要局部细节时用 read_file 的
   startLine/endLine 分页读取，不要整文件重读。改完代码后优先用 git_diff
   确认改动，而不是把整个文件再读一遍。
8. MCP 工具由公司按角色分配：用户在公司看板 →「MCP 分配」为每个角色挑选可用的
   MCP 服务器（未分配的角色默认可用全部，存储在 .ourcode/company.json）。你需要
   某个未授权的 MCP、或上下文出现 mcp_grant_warning（授权清单里的服务器已失效）时，
   停下并在回报里写明「请在公司看板为角色 <你的角色> 分配/修复 MCP 服务器 <名>」，
   由用户处理；不要反复调用不存在的工具。
9. 如果改错文件、测试失败或误删了东西，先调用 restore_changes 恢复自己最近的改动
   （scope=last/file/path），再继续修；不要用整文件重写来“覆盖”错误。
   不要恢复其他员工或其他任务的改动，更不要在未确认的情况下恢复整个任务。
`

/**
 * 员工会话的系统提示词（角色人设 + 员工规则）。角色定义（tools 白名单、
 * 读写路径、温度）走 loadAgentDefinition；这里只组装文本。
 */
export async function buildWorkerSystemPrompt(
  role: string,
  rolePrompt: string,
): Promise<string> {
  // loadAgentDefinition 失败时（角色定义被删）仍给出可用的兜底人设。
  const persona =
    rolePrompt?.trim() ||
    `你是「${role}」员工，负责按总监派发的任务完成工作并回报。`
  return `${persona}\n\n${WORKER_RULES}`
}

/** 员工会话是否为研发类（用于 UI 归组/槽位池判断）。 */
export function isDevWorker(s: ChatSession): boolean {
  return !!s.workerRole && DEV_SLOTS.includes(s.workerSlot ?? 0)
}

/** 员工会话是否为测试类。 */
export function isTestWorker(s: ChatSession): boolean {
  return !!s.workerRole && TEST_SLOTS.includes(s.workerSlot ?? 0)
}
