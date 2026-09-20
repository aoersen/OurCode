/**
 * `git status --porcelain=v1` 解析 —— 纯函数，与 UI / Electron 解耦，便于单测。
 *
 * 修复三个已知缺陷：
 * 1. 重命名条目 `R  old -> new`：porcelain v1 把新旧路径合并为一个字段，
 *    取新路径作为 file，旧路径存入 oldFile。
 * 2. 未跟踪目录条目 `?? dir/`（status.showUntrackedFiles=normal 时 git 只报目录）：
 *    面板不应把目录当文件，直接跳过。
 * 3. 部分暂存文件（MM / AM / AD …）：index 与 worktree 各有一份改动，
 *    拆成 staged + unstaged 两条目，两个分组各显示一次。
 */

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface GitStatusEntry {
  /** Repo-relative path（rename 时为「新」路径）。 */
  file: string
  status: GitFileStatus
  /** True = 改动已暂存（index 侧）。 */
  staged: boolean
  /** rename 前的旧路径（非 rename 时省略）。 */
  oldFile?: string
  /** 合并/变基冲突未解决（UU / AA / DD / AU / UA）。冲突条目只出一条——
   *  它不是「两份改动」，而是要用户先处理的一个文件。 */
  conflict?: boolean
}

/** 由 porcelain 的 X（index）/Y（worktree）状态列推导展示状态。 */
const statusOf = (index: string, work: string): GitFileStatus => {
  if (index === '?' || work === '?') return 'untracked'
  if (index === 'A' || work === 'A' || index === 'C') return 'added'
  if (index === 'D' || work === 'D') return 'deleted'
  if (index === 'R' || work === 'R') return 'renamed'
  return 'modified'
}

/** 去掉 porcelain 的 C 风格引号（git 对含特殊字符的路径加引号并转义）。 */
function unquote(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    return path
      .slice(1, -1)
      .replace(/\\(["\\])/g, '$1')
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n')
  }
  return path
}

/** 冲突状态对（porcelain 的 XY 两列）。 */
const CONFLICT_PAIRS = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'])

export function parseGitStatusPorcelain(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line) continue

    const indexStatus = line[0] ?? ' '
    const workStatus = line[1] ?? ' '
    const pathPart = line.slice(3)

    // 未跟踪目录（`?? dir/`）：跳过，避免把目录当文件打开。
    // 用解引号后的路径判断——git 会把含特殊字符的目录名也加引号。
    if (indexStatus === '?' && workStatus === '?' && /[\\/]$/.test(unquote(pathPart))) continue

    // 重命名 `R  old -> new`：先按 ` -> ` 拆分，再对两侧分别解引号——
    // 若先对整个 pathPart 解引号，`"a" -> "b"` 会被误当单个引号串，两侧各残留引号。
    let file = unquote(pathPart)
    let oldFile: string | undefined
    const isRename = indexStatus === 'R' || workStatus === 'R' || indexStatus === 'C'
    if (isRename) {
      const arrow = pathPart.indexOf(' -> ')
      if (arrow >= 0) {
        oldFile = unquote(pathPart.slice(0, arrow))
        file = unquote(pathPart.slice(arrow + 4))
      }
    }

    const indexChanged = indexStatus !== ' ' && indexStatus !== '?'
    const workChanged = workStatus !== ' ' && workStatus !== '?'

    if (CONFLICT_PAIRS.has(indexStatus + workStatus)) {
      // 冲突：git 两侧都标了改动，但它既不该进「已暂存」列表（`git commit` 会拒绝），
      // 也不该拆成两条（用户要处理的是这一个文件）。
      entries.push({ file, status: statusOf(indexStatus, workStatus), staged: false, oldFile, conflict: true })
      continue
    }

    if (indexChanged && workChanged) {
      // 部分暂存（MM / AM / AD / RM …）：一条 staged + 一条 unstaged。
      entries.push({ file, status: statusOf(indexStatus, ' '), staged: true, oldFile })
      entries.push({ file, status: statusOf(' ', workStatus), staged: false, oldFile })
    } else {
      entries.push({ file, status: statusOf(indexStatus, workStatus), staged: indexChanged, oldFile })
    }
  }
  return entries
}

/** 未解决冲突的文件列表。 */
export function conflictedFiles(entries: GitStatusEntry[]): string[] {
  return entries.filter((e) => e.conflict).map((e) => e.file)
}

/** `git commit`（不带 -a）实际会提交的文件 —— 提交按钮据此判断有没有东西可提，
 *  而不是先跑一次 `add -A` 把工作区里所有未跟踪文件都塞进这次提交。 */
export function committableFiles(entries: GitStatusEntry[]): string[] {
  return entries.filter((e) => e.staged && !e.conflict).map((e) => e.file)
}
