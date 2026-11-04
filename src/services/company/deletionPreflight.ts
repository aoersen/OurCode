/**
 * 删除预检（C 档：判断风险，不是一律拒绝）。
 *
 * 公司模式不设权限门，但删除是唯一"即使能回退也让人紧张"的动作：
 * 删错项目内的文件可以回退，删到项目外/系统目录就回不来了。所以删除前先
 * 算一遍影响面，把结论讲清楚，再交给工具执行。
 *
 * 处置（宽松优先）：
 *   - 项目内 + 可回退        → 直接删
 *   - 生成目录（rebuildable）→ 直接删
 *   - 项目外 / 客户数据目录   → 提示"无法保证恢复"，缺 reason 时标 questionable
 *   - 盘根 / 系统目录 / 用户主目录根 / AppData 根 / 工作区根 / .git
 *                            → 拒绝（这类删完机器就废，且不在任何快照内）
 *   - 无人值守 + 项目外目录   → 拒绝（不在任何快照内；生成/临时目录除外）
 *
 * 硬拒绝只按**目标**判断，不按路径里出现过的任意段判断：项目里的
 * `src/bin`、`config/etc` 只是普通目录名，不会被当成系统目录。
 */
import type { FileStat } from '@shared/types'
import {
  isAppDataRoot,
  isHomeRoot,
  isInsideProject,
  isRebuildablePath,
  isSystemRoot,
  isTempPath,
  looksLikeUserDataPath,
  protectedDeleteReason,
  resolveAgainst,
} from '@/services/permissions/deletionGuard'

export type DeletionRisk = 'low' | 'medium' | 'high'
export type DeletionNecessity = 'required' | 'likely' | 'questionable'

export interface DeletionPreflight {
  targets: string[]
  isDirectory: boolean
  entryCount: number
  insideWorkspace: boolean
  rebuildable: boolean
  looksLikeUserData: boolean
  systemPath: boolean
  containsGitDir: boolean
  necessity: DeletionNecessity
  risk: DeletionRisk
  reversible: boolean
  /** 拒绝理由；为空表示放行。 */
  blockReason?: string
  /** 给模型/用户看的一段话。 */
  summary: string
}

/** 常识性"必要性"判断：模型自述的理由是否具体到可以执行。 */
const VAGUE_REASONS = /^(clean ?up|cleanup|清理|删掉|删除|不需要了?|无所谓|随便|tidy|remove|delete|n\/a|none|无|待定|todo)[.。!！]*$/i

/** How具体 the model's stated reason is. */
export function classifyNecessity(reason: string | undefined): DeletionNecessity {
  const text = String(reason || '').trim()
  if (!text) return 'questionable'
  if (VAGUE_REASONS.test(text)) return 'questionable'
  return text.length >= 8 ? 'required' : 'likely'
}

/**
 * Evaluate one delete_file call. Never throws: a stat failure degrades the
 * report instead of blocking the tool (the tool itself will surface the error).
 *
 * `unattended` = a company session with no human to confirm: outside-workspace
 * directories are refused because no snapshot can restore them.
 */
export async function preflightDeletion(input: {
  path: string
  projectPath?: string
  reason?: string
  unattended?: boolean
}): Promise<DeletionPreflight> {
  const target = String(input.path || '')
  const projectPath = String(input.projectPath || '')
  const abs = resolveAgainst(projectPath, target)
  const insideWorkspace = !!projectPath && isInsideProject(projectPath, abs)
  const systemPath =
    isSystemRoot(abs) || isHomeRoot(abs) || isAppDataRoot(abs) ||
    isHomeRoot(target) || isAppDataRoot(target)
  const rebuildable = isRebuildablePath(abs)
  const looksLikeUserData = looksLikeUserDataPath(abs)
  const necessity = classifyNecessity(input.reason)

  let stat: FileStat | null = null
  try {
    stat = await window.electronAPI.stat(abs)
  } catch {
    stat = null
  }
  const isDirectory = !!stat?.isDirectory
  let entryCount = 0
  let containsGitDir = false
  if (isDirectory) {
    try {
      const entries = await window.electronAPI.listDir(abs)
      entryCount = Array.isArray(entries) ? entries.length : 0
      containsGitDir = Array.isArray(entries) && entries.some((e) => String(e?.name || '') === '.git')
    } catch {
      entryCount = 0
    }
  }

  // 回退可行性：项目内都在快照体系内；项目外只有"可重建"而没有"可回退"。
  // 包含 .git 的目录例外：影子快照永远不含 .git，删了版本历史回不来。
  const reversible = insideWorkspace && !containsGitDir

  let blockReason = protectedDeleteReason(target, projectPath) || undefined
  if (!blockReason && containsGitDir) {
    blockReason =
      '拒绝删除包含 .git 的目录：该目录里有嵌套仓库，版本历史不在任何快照范围内，删了无法恢复。' +
      '请删除仓库内的具体子路径。'
  }
  if (
    !blockReason &&
    input.unattended &&
    !insideWorkspace &&
    isDirectory &&
    !rebuildable &&
    !isTempPath(abs)
  ) {
    blockReason =
      '拒绝删除工作区外的目录：它不在任何快照范围内，删除后无法恢复；' +
      '生成目录（build/dist/node_modules 等）或临时目录会被放行。'
  }

  let risk: DeletionRisk = 'low'
  if (blockReason || systemPath) risk = 'high'
  else if (!insideWorkspace && (looksLikeUserData || !rebuildable)) risk = 'high'
  else if (!insideWorkspace) risk = 'medium'
  else if (isDirectory && entryCount > 50) risk = 'medium'

  const parts: string[] = []
  parts.push(isDirectory ? `目录${entryCount ? `（顶层 ${entryCount} 项，递归删除）` : '（可能为空）'}` : '单个文件')
  parts.push(insideWorkspace ? '项目内' : '项目外')
  if (rebuildable) parts.push('生成目录/依赖缓存 → 可重建')
  if (looksLikeUserData && !insideWorkspace) parts.push('位于用户数据目录，可能影响客户机器上的其他资料')
  if (containsGitDir) parts.push('包含 .git，版本历史不在快照内')
  if (necessity === 'questionable') parts.push('删除理由过于笼统，建议先说明"删掉后由什么替代"')
  parts.push(
    reversible
      ? '可回退'
      : rebuildable
        ? '不在快照内，但可重建'
        : '不可回退（不在项目快照内）',
  )

  return {
    targets: [target],
    isDirectory,
    entryCount,
    insideWorkspace,
    rebuildable,
    looksLikeUserData,
    systemPath,
    containsGitDir,
    necessity,
    risk,
    reversible,
    blockReason,
    summary: `删除预检：${parts.join('；')}。`,
  }
}
