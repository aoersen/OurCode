/**
 * 「待决中心」的数据整理（纯函数，便于单测）。
 *
 * 背景（真实缺陷）：`finalGoal_v{N}.md` 是目标模式为**目标修订**保留的历史快照
 * ——见 targetMode/spec.ts「所有目标变更历史均备份：原 finalGoal.md 复制为
 * finalGoal_v{N}.md 并更新索引」。当前生效目标始终是 `finalGoal.md`，备份文件
 * 没有任何「等用户确认才继续」的语义。
 *
 * 旧看板把每个快照都塞进待决中心，而「已看过」只记在组件内存里（useRef）：
 * 切走再回来、重开窗口都会把同一份备份重新报成待办，于是「每次点进来都叫你
 * 处理」。现在快照只做「新出现时一次性提示」，并用持久化签名去重。
 */

/** listDir 返回条目的最小形状（FileEntry 的子集，便于测试构造）。 */
export interface DirEntryLike {
  name: string
  isDirectory?: boolean
  size?: number
  modifiedAt?: number
}

/** 目标修订快照文件名：finalGoal_v1.md、finalGoal_v12.md… */
export const GOAL_REVISION_RE = /^finalGoal_v(\d+)\.md$/

/** 目标修订快照文件名，按版本号升序（v2 在 v10 之前）。 */
export function listGoalRevisions(entries: DirEntryLike[]): string[] {
  return entries
    .filter((e) => !e.isDirectory && GOAL_REVISION_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const va = Number(a.match(GOAL_REVISION_RE)?.[1] ?? 0)
      const vb = Number(b.match(GOAL_REVISION_RE)?.[1] ?? 0)
      return va - vb
    })
}

/**
 * 修订的稳定标识：项目 + 文件名 + mtime/size。
 * 同名文件被重写（内容变了 → mtime/size 变）也算一次新修订，不会因为「名字
 * 见过」而漏掉提示。
 */
export function revisionSignature(projectPath: string, entry: DirEntryLike): string {
  const root = projectPath.replace(/[\\/]+$/, '')
  return `${root}|${entry.name}|${entry.modifiedAt ?? 0}|${entry.size ?? 0}`
}

/** 本次扫描里还没提示过的修订（保持版本号升序）。 */
export function collectFreshRevisions(
  projectPath: string,
  entries: DirEntryLike[],
  seen: ReadonlySet<string>,
): DirEntryLike[] {
  const byName = new Map(entries.map((e) => [e.name, e]))
  return listGoalRevisions(entries)
    .map((name) => byName.get(name))
    .filter((e): e is DirEntryLike => !!e && !seen.has(revisionSignature(projectPath, e)))
}

/** 已提示记录的保留上限：localStorage 不能无限增长。 */
export const SEEN_REVISION_CAP = 200

/** 合并「已提示」记录并裁到上限（保留最近的）。 */
export function mergeSeenRevisions(
  seen: Iterable<string>,
  added: Iterable<string>,
  cap: number = SEEN_REVISION_CAP,
): string[] {
  const out: string[] = []
  const push = (k: string) => {
    if (k && !out.includes(k)) out.push(k)
  }
  for (const k of seen) push(k)
  for (const k of added) push(k)
  return out.slice(-Math.max(1, cap))
}
