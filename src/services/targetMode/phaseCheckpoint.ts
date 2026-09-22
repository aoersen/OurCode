/**
 * 阶段级 checkpoint（git tag）与回滚 —— 目标模式 SPEC 第十章落地。
 *
 * 每次子 Agent 完成（officeBridge 收到 done）自动打 tag；任务行提供「回滚到
 * 此」入口。回滚 = 从该 tag 新建工作分支并切过去（非破坏：原分支与后续改动
 * 全部保留，符合 SPEC「后续改动保留在工作区/分支，不删除」语义）。
 *
 * 非 git 仓库优雅降级：所有函数返回 null/false，UI 据此隐藏回滚入口。
 * 所有调用走 window.electronAPI.gitExec（主进程 assertPathAllowed 限制在
 * 已授权根目录内）。
 */

const TAG_PREFIX = 'ourcode/tm-'
const ROLLBACK_PREFIX = 'ourcode/rb-'

export interface PhaseCheckpoint {
  tag: string
  /** tag 名里的角色/阶段标签（去掉时间后缀）。 */
  label: string
  /** git tag 创建时间（ISO 字符串），读取失败为 null。 */
  createdAt: string | null
}

export interface RollbackResult {
  ok: boolean
  branch?: string
  error?: string
}

/** 执行 git 命令；成功返回输出（可为空串），失败/异常返回 null。 */
async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const r = await window.electronAPI.gitExec(root, args)
    return r.success ? r.output : null
  } catch {
    return null
  }
}

/** 把角色/阶段标签清洗成 tag 可用片段（保留中英文与 .-_，限长）。 */
export function sanitizeLabel(label: string): string {
  const cleaned = label
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return cleaned || 'phase'
}

/** 项目是否为 git 仓库（决定是否展示回滚入口）。 */
export async function isGitRepo(root: string): Promise<boolean> {
  if (!root) return false
  return (await git(root, ['rev-parse', '--is-inside-work-tree'])) === 'true'
}

/**
 * 为当前工作区打一个 checkpoint tag（指向当前 HEAD）。
 * 成功返回 tag 名；失败返回 null（非 git 仓库/命令失败）。
 */
export async function createPhaseCheckpoint(root: string, label: string): Promise<string | null> {
  if (!root) return null
  const tag = `${TAG_PREFIX}${sanitizeLabel(label)}-${Date.now().toString(36)}`
  const out = await git(root, ['tag', tag, '-m', label])
  if (out === null) return null
  return tag
}

/** 列出全部 checkpoint tag（按创建时间倒序）。 */
export async function listPhaseCheckpoints(root: string): Promise<PhaseCheckpoint[]> {
  if (!root) return []
  const out = await git(root, ['tag', '-l', `${TAG_PREFIX}*`, '--sort=-creatordate'])
  if (!out) return []
  const tags = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const items: PhaseCheckpoint[] = []
  for (const tag of tags) {
    // 时间后缀为 base36（\w+ 结尾段）；无法解析时保留完整 tag 名
    const label = tag.slice(TAG_PREFIX.length).replace(/-\w+$/, '') || tag
    let createdAt: string | null = null
    const date = await git(root, ['log', '-1', '--format=%cI', tag])
    if (date) createdAt = date.trim()
    items.push({ tag, label, createdAt })
  }
  return items
}

/**
 * 回滚到指定 checkpoint：从该 tag 新建分支并切换（原分支保留）。
 * 失败时返回错误信息（多为工作区存在冲突改动——提示先提交/暂存）。
 */
export async function rollbackToPhase(root: string, tag: string): Promise<RollbackResult> {
  if (!root) return { ok: false, error: '无项目根目录' }
  const branch = `${ROLLBACK_PREFIX}${Date.now().toString(36)}`
  const out = await git(root, ['switch', '-c', branch, tag])
  if (out === null) {
    return {
      ok: false,
      error: '回滚失败：git switch 未成功（工作区可能有未提交改动，请先提交或暂存后再试）',
    }
  }
  return { ok: true, branch }
}
