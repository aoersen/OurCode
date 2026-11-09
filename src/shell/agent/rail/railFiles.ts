import type { FileEntry } from '@/types'

/**
 * 会话栏「文件」模式的派生逻辑 —— 纯函数，不碰 store、不碰 React、不发 IPC。
 *
 * 与 railModel 同一套约定：组件只负责把结果画出来，排序 / 过滤 / 可见性 /
 * 路径 → 打开方式 全部在这里收口，单测直接跑（`src/__tests__/shell-rail-files-*.test.ts`）。
 *
 * 目录树是**懒加载**的：`listDir` 一次只回一层，子目录的 children 要等展开后才由
 * useRailFiles 填进来。因此这里的过滤只作用于「已经加载到的节点」——未展开的目录
 * 里有什么名字，前端还不知道，不能假装能搜到。
 */

/** 文件模式里的一行：entry 本身 + 缩进深度（扁平列表，便于窗口化与键盘移动）。 */
export interface RailFileRow {
  entry: FileEntry
  depth: number
  /** loading / error 是目录展开后的占位行，不对应真实文件。 */
  kind: 'entry' | 'loading' | 'error'
}

/** 「显示隐藏文件」关闭时永远不出现的名字（大小写不敏感）。 */
export const HIDDEN_FILE_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
])

/** 可预览扩展名 —— 点它们会打开产物面板的「文件」页签；其余走编辑器。 */
const PREVIEW_EXTENSIONS: Record<'markdown' | 'html' | 'image', readonly string[]> = {
  markdown: ['md', 'markdown'],
  html: ['html', 'htm'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
}

/** 路径最后一段（两种分隔符都认）。 */
export function fileBaseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

/** 上级目录；盘符根（`C:\`）与 POSIX 根（`/`）保留分隔符。 */
export function parentDirOf(path: string): string | null {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx < 0) return null
  if (idx === 0) return path.slice(0, 1)
  const parent = path.slice(0, idx)
  // Windows 盘符根：C:\a.ts → C:\（不能退化成 C:）
  if (parent.length === 2 && /^[a-zA-Z]:$/.test(parent)) return parent + path.slice(idx, idx + 1)
  return parent
}

/** 用目录自身的分隔符拼子项，避免 Windows 项目里混出 `C:\a/b`。 */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  if (!dir) return name
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`
}

/** 扩展名（小写、不含点）；没有扩展名（含 `.env` 这类点开头名字）返回空串。 */
export function fileExtension(path: string): string {
  const base = fileBaseName(path)
  const idx = base.lastIndexOf('.')
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : ''
}

export function isHiddenFileName(name: string): boolean {
  if (!name) return true
  if (name.startsWith('.')) return true
  return HIDDEN_FILE_NAMES.has(name.toLowerCase())
}

export function isHiddenEntry(entry: Pick<FileEntry, 'name' | 'isHidden'>): boolean {
  return entry.isHidden === true || isHiddenFileName(entry.name)
}

/**
 * 同一层内的顺序：目录在前、文件在后，各自按名字（大小写不敏感）升序。
 * 名字只差大小写时用原名兜底，再相同用完整路径兜底 —— 保证排序稳定，
 * 不随 listDir 的返回顺序抖动。
 */
export function compareFileEntries(a: FileEntry, b: FileEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  const an = a.name.toLowerCase()
  const bn = b.name.toLowerCase()
  if (an !== bn) return an < bn ? -1 : 1
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.path === b.path) return 0
  return a.path < b.path ? -1 : 1
}

/** 返回排好序的新数组（不改入参）。 */
export function sortFileEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort(compareFileEntries)
}

export interface FileTreeFilter {
  /** 过滤后的树（层级保留；目录的子项同样已排序）。 */
  entries: FileEntry[]
  /**
   * 因「后代命中」而必须保持展开的目录路径。
   * 目录自己命中时不算 —— 那种情况整棵子树都保留，展开与否交给用户。
   */
  forceOpen: ReadonlySet<string>
}

/**
 * 按名字过滤，保留命中项的层级：
 *  - 文件命中 → 自己留下；
 *  - 目录自己命中 → 整个目录（含已加载子树）留下；
 *  - 只有后代命中 → 目录以「只剩命中后代」的副本留下，并记入 forceOpen。
 * 隐藏项（`isHiddenEntry`）在 showHidden=false 时整支剪掉。
 */
export function filterFileTree(
  entries: readonly FileEntry[],
  query: string,
  showHidden = false,
): FileTreeFilter {
  const q = query.trim().toLowerCase()

  if (!q) return { entries: normalizeLevel(entries, showHidden), forceOpen: new Set<string>() }

  const forceOpen = new Set<string>()
  const walk = (list: readonly FileEntry[]): FileEntry[] => {
    const out: FileEntry[] = []
    for (const entry of sortFileEntries(list.filter((item) => showHidden || !isHiddenEntry(item)))) {
      const selfHit = entry.name.toLowerCase().includes(q)
      if (!entry.isDirectory) {
        if (selfHit) out.push(entry)
        continue
      }
      const kids = entry.children ? walk(entry.children) : []
      if (kids.length > 0) {
        forceOpen.add(entry.path)
        out.push(kids === entry.children ? entry : { ...entry, children: kids })
      } else if (selfHit) {
        // 目录名命中：保留它已有的子树（没加载过就等展开），不强制展开；
        // 但子树里该隐藏的仍然要隐藏（搜索不该把 .env / node_modules 翻出来）。
        out.push(normalizeEntry(entry, showHidden))
      }
    }
    return out
  }

  return { entries: walk(entries), forceOpen }
}

/**
 * 按「默认可见性 + 同层排序」规范化一整层；递归处理已加载子树。
 * 内容没变时尽量返回原引用（行组件 memo 依赖它）。
 */
function normalizeLevel(entries: readonly FileEntry[], showHidden: boolean): FileEntry[] {
  let changed = false
  const kept: FileEntry[] = []
  for (const entry of entries) {
    if (!showHidden && isHiddenEntry(entry)) {
      changed = true
      continue
    }
    const next = normalizeEntry(entry, showHidden)
    if (next !== entry) changed = true
    kept.push(next)
  }
  const sorted = sortFileEntries(kept)
  if (!changed && sorted.every((entry, index) => entry === kept[index])) {
    return entries as FileEntry[]
  }
  return sorted
}

function normalizeEntry(entry: FileEntry, showHidden: boolean): FileEntry {
  if (!entry.isDirectory || !entry.children) return entry
  const kids = normalizeLevel(entry.children, showHidden)
  return kids === entry.children ? entry : { ...entry, children: kids }
}

export interface FlattenFileTreeOptions {
  expanded?: ReadonlySet<string>
  query?: string
  showHidden?: boolean
  /** 正在读取子项、还没回来的目录（渲染成灰色占位行）。 */
  loading?: ReadonlySet<string>
  /** 读取失败、等用户「重试」的目录。 */
  errors?: ReadonlySet<string>
}

/**
 * 把树压成可见行。只下钻「用户展开的目录」与「过滤命中必须展开的目录」，
 * 展开中但子项还没回来的目录补一行 loading / error 占位。
 *
 * 排序、隐藏、过滤都在这里一次做完，组件拿到的就是最终行序 —— 这也让
 * 键盘 ↑↓ 可以直接按行数组移动，不必再和 DOM 对账。
 */
export function flattenFileTree(
  entries: readonly FileEntry[],
  options: FlattenFileTreeOptions = {},
): RailFileRow[] {
  const expanded = options.expanded ?? new Set<string>()
  const loading = options.loading ?? new Set<string>()
  const errors = options.errors ?? new Set<string>()
  const filtered = filterFileTree(entries, options.query ?? '', options.showHidden ?? false)

  const rows: RailFileRow[] = []
  const walk = (list: readonly FileEntry[], depth: number) => {
    for (const entry of list) {
      rows.push({ entry, depth, kind: 'entry' })
      if (!entry.isDirectory) continue
      const open = filtered.forceOpen.has(entry.path) || expanded.has(entry.path)
      if (!open) continue
      if (entry.children && entry.children.length > 0) {
        walk(entry.children, depth + 1)
      } else if (loading.has(entry.path)) {
        rows.push({ entry, depth: depth + 1, kind: 'loading' })
      } else if (errors.has(entry.path)) {
        rows.push({ entry, depth: depth + 1, kind: 'error' })
      }
    }
  }
  walk(filtered.entries, 0)
  return rows
}

/**
 * 把 `path → 已加载子项` 贴回树里（不可变更新：没变化的节点保持原引用，
 * memo 过的行不会因为别处展开了一个目录而重渲染）。
 */
export function attachLoadedChildren(
  entries: readonly FileEntry[],
  children: ReadonlyMap<string, readonly FileEntry[]>,
): FileEntry[] {
  let changed = false
  const next = entries.map((entry) => {
    if (!entry.isDirectory) return entry
    const loaded = children.get(entry.path)
    const base = loaded ?? entry.children
    if (!base) return entry
    const kids = attachLoadedChildren(base, children)
    if (loaded === undefined && kids === entry.children) return entry
    changed = true
    return { ...entry, children: kids }
  })
  return changed ? next : (entries as FileEntry[])
}

/** 可预览类型；`null` = 代码文件（只开编辑器）。 */
export function previewKindOf(path: string): 'markdown' | 'html' | 'image' | null {
  const ext = fileExtension(path)
  if ((PREVIEW_EXTENSIONS.markdown as readonly string[]).includes(ext)) return 'markdown'
  if ((PREVIEW_EXTENSIONS.html as readonly string[]).includes(ext)) return 'html'
  if ((PREVIEW_EXTENSIONS.image as readonly string[]).includes(ext)) return 'image'
  return null
}

/** 点击文件的打开方式（路径 → 模式）：预览类走产物面板，其余只开编辑器。 */
export function fileOpenMode(path: string): 'preview' | 'editor' {
  return previewKindOf(path) ? 'preview' : 'editor'
}
