/**
 * 产物面板的导航模型（纯函数）。
 *
 * 面板有两种导航：
 *  1. 四个模式页签：计划 / 变更 / 文件 / 浏览器（纯文字 + 1px ink 下划线）；
 *  2. 「已打开的产物」横向条：计划、浏览器、以及 editorStore.openFiles 里最近
 *     打开的至多 6 个文件（对应功能盘点 §6「多标签」）。
 *
 * 这里只负责「列表长什么样 / 方向键往哪走 / 路径怎么取名字」，状态与副作用都
 * 留在组件里，方便 node 环境下单测。
 */

export type ArtifactTab = 'plan' | 'changes' | 'file' | 'browser'

export type ArtifactKind = 'plan' | 'browser' | 'file'

export interface ArtifactEntry {
  /** 稳定 key：`plan` / `browser` / `file:<绝对路径>` */
  key: string
  kind: ArtifactKind
  /** 点它时切到的页签 */
  tab: ArtifactTab
  /** 展示文案（文件名 / 计划 / 浏览器） */
  label: string
  /** 仅 kind==='file' 时有值 */
  path?: string
}

export const ARTIFACT_TABS: ReadonlyArray<{ id: ArtifactTab; label: string }> = [
  { id: 'plan', label: '计划' },
  { id: 'changes', label: '变更' },
  { id: 'file', label: '文件' },
  { id: 'browser', label: '浏览器' },
]

/** 一次最多保留多少个文件产物（设计约束：多标签不无限增长）。 */
export const MAX_FILE_ARTIFACTS = 6

export const PLAN_ARTIFACT: ArtifactEntry = { key: 'plan', kind: 'plan', tab: 'plan', label: '计划' }
export const BROWSER_ARTIFACT: ArtifactEntry = { key: 'browser', kind: 'browser', tab: 'browser', label: '浏览器' }

/** 最后一个路径段。`C:\a\b.ts` → `b.ts`。 */
export function baseName(path: string): string {
  if (!path) return ''
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

export function tabIndexOf(tab: ArtifactTab): number {
  const index = ARTIFACT_TABS.findIndex((item) => item.id === tab)
  return index < 0 ? 0 : index
}

/**
 * 方向键切换页签（循环）。Home/End 跳到首尾。
 * 返回 null 表示不是导航键，调用方保持原样。
 */
export function tabForNavKey(current: ArtifactTab, key: string): ArtifactTab | null {
  const index = tabIndexOf(current)
  const last = ARTIFACT_TABS.length - 1
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return ARTIFACT_TABS[(index + 1) % ARTIFACT_TABS.length].id
    case 'ArrowLeft':
    case 'ArrowUp':
      return ARTIFACT_TABS[(index - 1 + ARTIFACT_TABS.length) % ARTIFACT_TABS.length].id
    case 'Home':
      return ARTIFACT_TABS[0].id
    case 'End':
      return ARTIFACT_TABS[last].id
    default:
      return null
  }
}

export function fileArtifact(path: string): ArtifactEntry {
  return { key: `file:${path}`, kind: 'file', tab: 'file', label: baseName(path), path }
}

/**
 * 从 editorStore.openFiles 推出「最近打开的文件」产物。
 * 活动文件排第一，其余按打开顺序倒序（openFiles 是打开顺序，越靠后越新）。
 * 未命名缓冲区（/untitled/）不参与——它们没有磁盘路径可预览。
 */
export function deriveFileArtifacts(
  openFiles: ReadonlyArray<{ path: string }>,
  activeFilePath: string | null,
  max: number = MAX_FILE_ARTIFACTS
): ArtifactEntry[] {
  const picked: string[] = []
  const push = (path: string | null) => {
    if (!path || path.startsWith('/untitled/')) return
    if (picked.includes(path) || picked.length >= max) return
    picked.push(path)
  }

  push(activeFilePath)
  for (let i = openFiles.length - 1; i >= 0; i--) push(openFiles[i].path)
  return picked.map(fileArtifact)
}

/**
 * 面板内部维护的产物列表：计划（有内容时）+ 浏览器 + 文件。
 * 计划/浏览器各自唯一，文件按最近打开排序。
 */
export function deriveArtifacts(
  session: { planContent?: string } | null | undefined,
  files: ReadonlyArray<ArtifactEntry>
): ArtifactEntry[] {
  const entries: ArtifactEntry[] = []
  if (session?.planContent) entries.push(PLAN_ARTIFACT)
  entries.push(BROWSER_ARTIFACT)
  entries.push(...files)
  return entries
}

/**
 * 只在「不止一个产物」时才画那条产物列表：单一产物用页签就够了。
 * 计划/浏览器/文件都算产物 —— 列表的职责是让你在多个文件之间切换。
 */
export function shouldShowArtifactStrip(entries: ReadonlyArray<ArtifactEntry>): boolean {
  return entries.length > 1
}

/**
 * 插入/前移一个产物（用于「+」选择器选中的文件、以及切换页签时的记录）。
 * 文件最多保留 `max` 个；非文件产物按 key 去重后放在最前面。
 */
export function upsertArtifact(
  list: ReadonlyArray<ArtifactEntry>,
  entry: ArtifactEntry,
  max: number = MAX_FILE_ARTIFACTS
): ArtifactEntry[] {
  const without = list.filter((item) => item.key !== entry.key)
  if (entry.kind !== 'file') return [entry, ...without]
  const files = [entry, ...without.filter((item) => item.kind === 'file')].slice(0, max)
  return [...without.filter((item) => item.kind !== 'file'), ...files]
}

/** 子序列模糊匹配（`ashtsx` 能命中 `AgentShell.tsx`）。 */
function matchesSubsequence(needle: string, haystack: string): boolean {
  let cursor = 0
  for (let i = 0; i < haystack.length && cursor < needle.length; i++) {
    if (haystack[i] === needle[cursor]) cursor++
  }
  return cursor === needle.length
}

/**
 * 「+」选择器的候选列表：去重、跳过未命名缓冲区、按文件名优先排序。
 * 输入为空时返回最近的若干条（调用方传入的顺序即优先级）。
 */
export function filterArtifactCandidates(
  paths: ReadonlyArray<string>,
  query: string,
  max = 12
): string[] {
  const unique: string[] = []
  for (const path of paths) {
    if (!path || path.startsWith('/untitled/')) continue
    if (!unique.includes(path)) unique.push(path)
  }

  const needle = query.trim().toLowerCase()
  if (!needle) return unique.slice(0, max)

  const scored: Array<{ path: string; score: number }> = []
  for (const path of unique) {
    const name = baseName(path).toLowerCase()
    const full = path.replace(/\\/g, '/').toLowerCase()
    let score = -1
    if (name.startsWith(needle)) score = 0
    else if (name.includes(needle)) score = 1
    else if (matchesSubsequence(needle, full)) score = 2
    if (score >= 0) scored.push({ path, score })
  }

  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, max)
    .map((entry) => entry.path)
}

/**
 * 绝对路径 → 相对项目根（git 用）。不在根内返回 null。
 * Windows 上前缀比较不区分大小写（盘符/目录大小写经常不一致）。
 */
export function relativePathOf(path: string, root: string | null | undefined): string | null {
  if (!path || !root) return null
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = normalize(path)
  const base = normalize(root)
  const targetLower = target.toLowerCase()
  const baseLower = base.toLowerCase()
  if (targetLower === baseLower) return ''
  if (targetLower.startsWith(`${baseLower}/`)) return target.slice(base.length + 1)
  return null
}
