/**
 * 权限模式行为矩阵（纯函数，无 UI / 无 store 依赖，可单测）。
 *
 * 四种编辑模式（projectEditMode）下，工具按「操作类别」得到三种处置：
 *   auto    — 免审批直接执行
 *   confirm — 弹审批卡片，用户逐条决定
 *   block   — 拒绝执行（计划模式只读期 / 计划外写入），走对应的拦截路径
 *
 * 优先级（在 approvalHook 中落实）：危险命令 > 黑名单 > 会话白名单 >
 * 项目白名单 > 本矩阵。
 */
import type { ToolCall } from '@/services/tools/types'

export type EditMode = 'confirm_before_change' | 'auto_edit' | 'plan' | 'full_access'

export type ToolKind =
  | 'read'          // 读文件/搜索/列出/只读 git/网页浏览读/技能
  | 'file_write'    // write_file / edit_file / multi_edit_file / create_directory / delete_file
  | 'command'       // run_command
  | 'git_write'     // git_commit / git_push / git_split_commit
  | 'browser_write' // browser_act / create_pull_request
  | 'mcp'           // mcp__*（非内置打包服务器）
  | 'delegate'      // run_subagent
  | 'interactive'   // 提问/计划/todo/记忆/会话间消息 —— 永远免审

const KIND_SETS: Record<Exclude<ToolKind, 'read' | 'interactive' | 'mcp'>, readonly string[]> = {
  file_write: ['write_file', 'edit_file', 'multi_edit_file', 'create_directory', 'delete_file'],
  command: ['run_command'],
  git_write: ['git_commit', 'git_push', 'git_split_commit'],
  browser_write: ['browser_act', 'create_pull_request'],
  delegate: ['run_subagent'],
}

const INTERACTIVE_TOOLS = new Set([
  'ask_user_question', 'submit_plan', 'manage_todo', 'remember', 'send_message',
  'list_agents', 'read_session', 'search_sessions',
])

export function kindOf(toolName: string): ToolKind {
  if (toolName.startsWith('mcp__')) return 'mcp'
  if (toolName.startsWith('skill__')) return 'read'
  if (INTERACTIVE_TOOLS.has(toolName)) return 'interactive'
  for (const kind of Object.keys(KIND_SETS) as Array<keyof typeof KIND_SETS>) {
    if ((KIND_SETS[kind] as readonly string[]).includes(toolName)) return kind
  }
  // 其余内置工具（read_terminal_output、stop_terminal、只读 git、web、browser 读等）
  return 'read'
}

export interface PlanScope {
  /** 计划已批准（执行期）；false = 只读调研期 */
  approved: boolean
}

/** 计划模式两阶段与其余模式的矩阵。inScope 仅对 file_write 生效：
 *  批准后只写计划声明的最终产物；未声明 → block（由 scopeGate 拦截）。 */
export function resolveApproval(
  kind: ToolKind,
  mode: EditMode,
  plan: PlanScope,
  inScope: boolean,
): 'auto' | 'confirm' | 'block' {
  if (kind === 'read' || kind === 'interactive') return 'auto'

  switch (mode) {
    case 'full_access':
      return 'auto'
    case 'auto_edit':
      return kind === 'file_write' ? 'auto' : 'confirm'
    case 'plan':
      if (!plan.approved) return 'block'
      // 批准后：本地交付动作自动（文件写入按声明范围），远端/外部仍确认
      switch (kind) {
        case 'file_write':
          return inScope ? 'auto' : 'block'
        case 'command':
        case 'git_write':
        case 'delegate':
          return 'auto'
        default: // browser_write / mcp
          return 'confirm'
      }
    case 'confirm_before_change':
    default:
      return 'confirm'
  }
}

/** Shift+Tab 循环顺序（与 ZCode 一致）；目标模式开启时只轮换前两者。 */
export const MODE_CYCLE: EditMode[] = ['confirm_before_change', 'auto_edit', 'plan', 'full_access']

/** 提取一次写工具调用的目标路径（可多个，multi_edit_file 一组 edits）。 */
export function targetPathsOf(tc: Pick<ToolCall, 'name' | 'arguments'>): string[] {
  const a = tc.arguments || {}
  switch (tc.name) {
    case 'multi_edit_file': {
      const edits = Array.isArray(a.edits) ? a.edits : []
      return edits
        .map((e: unknown) => (e && typeof e === 'object' ? String((e as Record<string, unknown>).path || '') : ''))
        .filter(Boolean)
    }
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'create_directory':
      return [String(a.path || '')].filter(Boolean)
    default:
      return []
  }
}

/** 归一化：反斜杠→斜杠、小写。比较用，不动真实文件系统。 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 是否命中计划声明的交付文件。deliverables 可为绝对/相对路径；相对路径以
 *  projectPath 为基准拼成绝对路径再比较（目录声明覆盖其下所有文件）。 */
export function isPathInScope(paths: string[], deliverables: string[], projectPath: string): boolean {
  if (!paths.length) return false
  if (!deliverables.length) return false
  const base = normalizePath(projectPath || '').replace(/\/+$/, '')
  const abs = (p: string): string => {
    const n = normalizePath(p)
    if (/^[a-z]:\//.test(n) || n.startsWith('/')) return n.replace(/\/+$/, '')
    return `${base}/${n}`.replace(/\/+/g, '/')
  }
  const scoped = deliverables.map(abs)
  return paths.some((p) => {
    const target = abs(p)
    return scoped.some((d) => d === target || target.startsWith(d + '/'))
  })
}
