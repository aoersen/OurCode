/**
 * 右侧产物面板的「文档标签」模型 —— 纯函数，不碰 store / React / IPC。
 *
 * 这一版把面板的导航从「四个类型页签（计划 / 变更 / 文件 / 浏览器）」改成
 * **按文档排列**：每个打开的文件就是一条标签，类型由扩展名自动判定（TS / MD /
 * JSON / PNG …），计划 / 变更 / 浏览器退化成「会话视图」这一组，排在文件后面。
 *
 * 为什么不按类型分组：
 *  - 用户关心的是「我刚打开的那几个文件」，不是「哪些文件是 Markdown」；
 *  - 一类型一页签时，切文件要先进「文件」页签再挑，多一层；
 *  - 关掉一个文件后旧实现会退回到「第一个产物」，视觉上像是自己跳了。
 *
 * 所有上限（MAX_FILE_DOCS）与排序都在这里收口，单测直接跑（`src/__tests__`）。
 */

/** 一条标签是文件，还是会话视图（计划 / 变更 / 浏览器）。 */
export type DocKind = 'file' | 'plan' | 'changes' | 'browser'

/** 文件大类 —— 决定用哪个视图渲染（编辑器 / 预览 / 二进制提示）。 */
export type FileTone = 'code' | 'markup' | 'style' | 'data' | 'doc' | 'image' | 'binary' | 'other'

/** 文件在面板里的打开方式。 */
export type FileView = 'text' | 'image' | 'binary'

export interface FileTypeInfo {
  /** 标签上显示的短类型（≤3 字符）：TS / TSX / MD / JSN / PNG … */
  label: string
  tone: FileTone
  view: FileView
  /** 人类可读的类型名（标题 / 状态栏用）：TypeScript、Markdown、图片 … */
  name: string
}

export interface DocTab {
  /** 稳定 id：`file:<绝对路径>` / `plan` / `changes` / `browser` */
  id: string
  kind: DocKind
  /** 标签上的文字（文件名 / 计划 / 变更 / 浏览器） */
  label: string
  /** 标签上更短的名字（去掉扩展名，同名时退回全名）；不传则用 label */
  shortLabel?: string
  /** 悬停标题（绝对路径 / 说明） */
  title: string
  /** 短类型标记（文件才有） */
  typeLabel?: string
  tone?: FileTone
  /** 仅 kind==='file' */
  path?: string
  /** 有未保存修改 */
  dirty?: boolean
  /** 是否可关闭（会话视图常驻，不可关） */
  closable: boolean
}

/** 一次最多保留多少个文件标签（多余的最旧文件被挤掉，避免标签条无限长）。 */
export const MAX_FILE_DOCS = 12

export const PLAN_DOC_ID = 'plan'
export const CHANGES_DOC_ID = 'changes'
export const BROWSER_DOC_ID = 'browser'

/** `C:\a\b.ts` → `b.ts`。 */
export function baseName(path: string): string {
  if (!path) return ''
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

/** 扩展名（小写、不含点）。`.gitignore` 这类点开头名字返回空串。 */
export function fileExtension(path: string): string {
  const name = baseName(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

export function docIdOfFile(path: string): string {
  return `file:${path}`
}

export function pathOfDocId(id: string): string | null {
  return id.startsWith('file:') ? id.slice(5) : null
}

// ── 类型自动识别 ────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'cs', 'fs', 'fsx', 'vb',
  'php', 'pl', 'pm', 'lua', 'dart', 'ex', 'exs', 'erl', 'hrl', 'hs', 'lhs',
  'clj', 'cljs', 'jl', 'r', 'sql', 'graphql', 'gql', 'proto', 'tf', 'gradle',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'vim',
])

const MARKUP_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'xml', 'xsl', 'xsd', 'plist'])
const STYLE_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'styl', 'pcss', 'postcss'])
const DATA_EXTENSIONS = new Set([
  'json', 'jsonc', 'json5', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'csv', 'tsv', 'lock', 'map', 'sqlite', 'db',
])
const DOC_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt', 'text', 'log', 'rst', 'adoc', 'tex', 'org'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const BINARY_EXTENSIONS = new Set([
  'pdf', 'zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'bz2', 'xz',
  'exe', 'dll', 'so', 'dylib', 'node', 'wasm', 'bin', 'class', 'jar', 'apk', 'dmg', 'iso', 'msi',
  'mp3', 'wav', 'flac', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'ttf', 'otf', 'woff', 'woff2',
  'psd', 'ai', 'sketch', 'fig',
])

/** 特殊文件名（没有扩展名或扩展名不足以判断）的精确匹配。 */
const FILENAME_TYPES: Record<string, FileTypeInfo> = {
  dockerfile: { label: 'DKR', tone: 'code', view: 'text', name: 'Dockerfile' },
  makefile: { label: 'MAK', tone: 'code', view: 'text', name: 'Makefile' },
  '.gitignore': { label: 'GIT', tone: 'data', view: 'text', name: 'Git 忽略规则' },
  '.gitattributes': { label: 'GIT', tone: 'data', view: 'text', name: 'Git 属性' },
  '.npmrc': { label: 'NPM', tone: 'data', view: 'text', name: 'npm 配置' },
  '.env': { label: 'ENV', tone: 'data', view: 'text', name: '环境变量' },
  '.env.local': { label: 'ENV', tone: 'data', view: 'text', name: '环境变量' },
  license: { label: 'LIC', tone: 'doc', view: 'text', name: '许可证' },
  readme: { label: 'MD', tone: 'doc', view: 'text', name: '说明' },
}

/** 扩展名 → 人类可读类型名（标签只取前三字符，这里给标题与状态栏用）。 */
const EXTENSION_NAMES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript JSX', js: 'JavaScript', jsx: 'JavaScript JSX',
  mjs: 'JavaScript', cjs: 'CommonJS', mts: 'TypeScript', cts: 'TypeScript',
  json: 'JSON', jsonc: 'JSON with comments', json5: 'JSON5', yaml: 'YAML', yml: 'YAML',
  toml: 'TOML', ini: 'INI', env: '环境变量变量', csv: 'CSV', tsv: 'TSV',
  md: 'Markdown', markdown: 'Markdown', mdx: 'MDX', txt: '纯文本', log: '日志',
  html: 'HTML', htm: 'HTML', xml: 'XML', svg: 'SVG',
  css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
  png: 'PNG 图片', jpg: 'JPEG 图片', jpeg: 'JPEG 图片', gif: 'GIF 图片', webp: 'WebP 图片',
  bmp: 'BMP 图片', ico: '图标', avif: 'AVIF 图片', pdf: 'PDF', zip: '压缩包',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin',
  swift: 'Swift', c: 'C', h: 'C 头文件', cpp: 'C++', hpp: 'C++ 头文件', cs: 'C#',
  php: 'PHP', sh: 'Shell', bash: 'Bash', zsh: 'Zsh', ps1: 'PowerShell', bat: '批处理',
  sql: 'SQL', vue: 'Vue', svelte: 'Svelte', lock: '锁文件',
}

/** 兜底：用扩展名前三位大写当短标签。 */
function shortLabelFromExtension(ext: string): string {
  if (!ext) return 'TXT'
  return ext.slice(0, 3).toUpperCase()
}

/**
 * 根据路径自动判定类型、视图方式与短标签。
 * 这是面板「类型自动分辨」的唯一实现 —— 文件树、标签条、状态栏都调它。
 */
export function detectFileType(path: string): FileTypeInfo {
  const name = baseName(path)
  const lower = name.toLowerCase()
  const exact = FILENAME_TYPES[lower]
  if (exact) return exact

  const ext = fileExtension(path)
  const nameOf = EXTENSION_NAMES[ext] ?? (ext ? `${ext.toUpperCase()} 文件` : '文本文件')

  if (IMAGE_EXTENSIONS.has(ext)) {
    return { label: shortLabelFromExtension(ext), tone: 'image', view: 'image', name: nameOf }
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    return { label: shortLabelFromExtension(ext), tone: 'binary', view: 'binary', name: nameOf }
  }
  if (MARKUP_EXTENSIONS.has(ext)) {
    return { label: shortLabelFromExtension(ext), tone: 'markup', view: 'text', name: nameOf }
  }
  if (STYLE_EXTENSIONS.has(ext)) {
    return { label: shortLabelFromExtension(ext), tone: 'style', view: 'text', name: nameOf }
  }
  if (DATA_EXTENSIONS.has(ext)) {
    return { label: shortLabelFromExtension(ext), tone: 'data', view: 'text', name: nameOf }
  }
  if (DOC_EXTENSIONS.has(ext)) {
    return { label: shortLabelFromExtension(ext), tone: 'doc', view: 'text', name: nameOf }
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return { label: shortLabelFromExtension(ext), tone: 'code', view: 'text', name: nameOf }
  }
  return { label: ext ? shortLabelFromExtension(ext) : 'TXT', tone: 'other', view: 'text', name: nameOf }
}

/** 未命名缓冲区（没有磁盘路径）不参与标签条。 */
export function isTransientBuffer(path: string | null | undefined): boolean {
  return !path || path.startsWith('/untitled/')
}

// ── 标签组装 ────────────────────────────────────────────────────────────────

export interface OpenFileLike {
  path: string
  isDirty?: boolean
}

/** 单个文件 → 标签。`shortLabel` 由 buildFileDocs 统一算（同名冲突时退回全名）。 */
export function fileDocTab(file: OpenFileLike, shortLabel?: string): DocTab {
  const type = detectFileType(file.path)
  return {
    id: docIdOfFile(file.path),
    kind: 'file',
    label: baseName(file.path),
    shortLabel,
    title: file.path,
    typeLabel: type.label,
    tone: type.tone,
    path: file.path,
    dirty: file.isDirty === true,
    closable: true,
  }
}

/** 去掉扩展名（`.env` 这类点开头名字原样返回）。 */
export function stemOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(0, index) : name
}

/**
 * 打开的文件 → 标签（按打开顺序，稳定排序）。
 *
 * 标签文字用「去掉扩展名的名字」：类型已经由图标表达，再带 `.png` 既占宽又重复
 * （旧版更糟：`PNG 取通知书2.png`）。同名不同扩展名时退回全名，避免 a.ts / a.tsx
 * 看起来一模一样。
 */
export function buildFileDocs(files: ReadonlyArray<OpenFileLike>, max = MAX_FILE_DOCS): DocTab[] {
  const picked: string[] = []
  for (const file of files) {
    if (isTransientBuffer(file.path)) continue
    if (!picked.includes(file.path)) picked.push(file.path)
  }
  const kept = picked.length > max ? picked.slice(picked.length - max) : picked
  const byPath = new Map(files.map((file) => [file.path, file]))

  const stems = new Map<string, number>()
  for (const path of kept) {
    const stem = stemOf(baseName(path))
    stems.set(stem, (stems.get(stem) ?? 0) + 1)
  }
  return kept.map((path) => {
    const name = baseName(path)
    const stem = stemOf(name)
    const short = stems.get(stem) === 1 && stem ? stem : name
    return fileDocTab(byPath.get(path) ?? { path }, short)
  })
}

/** 会话视图（计划 / 变更 / 浏览器）：常驻、不可关。 */
export function buildViewDocs(options: { hasPlan: boolean }): DocTab[] {
  const docs: DocTab[] = [
    {
      id: PLAN_DOC_ID,
      kind: 'plan',
      label: '计划',
      title: options.hasPlan ? '当前会话的计划' : '当前会话还没有计划',
      closable: false,
    },
    {
      id: CHANGES_DOC_ID,
      kind: 'changes',
      label: '变更',
      title: '本次会话的文件变更时间线',
      closable: false,
    },
    {
      id: BROWSER_DOC_ID,
      kind: 'browser',
      label: '浏览器',
      title: '内嵌浏览器预览',
      closable: false,
    },
  ]
  return docs
}

/** 全部标签：文件在前，会话视图在后。 */
export function buildDocTabs(
  files: ReadonlyArray<OpenFileLike>,
  options: { hasPlan: boolean; max?: number },
): { fileDocs: DocTab[]; viewDocs: DocTab[]; all: DocTab[] } {
  const fileDocs = buildFileDocs(files, options.max)
  const viewDocs = buildViewDocs({ hasPlan: options.hasPlan })
  return { fileDocs, viewDocs, all: [...fileDocs, ...viewDocs] }
}

/**
 * 关闭一个标签后该选中谁：优先它左边那条，其次右边，最后退回会话视图。
 * 返回值保证一定是列表里存在的 id（列表非空时）。
 */
export function docIdAfterClose(all: ReadonlyArray<DocTab>, closedId: string): string | null {
  if (all.length === 0) return null
  const index = all.findIndex((doc) => doc.id === closedId)
  if (index === -1) return all[0].id
  const remaining = all.filter((doc) => doc.id !== closedId)
  if (remaining.length === 0) return null
  // 左邻居优先（关掉的那条右边内容不跳），没有左邻居就落到右边第一条
  const nextIndex = index > 0 ? index - 1 : 0
  return remaining[Math.min(nextIndex, remaining.length - 1)].id
}

/** 方向键在标签间移动（循环）。Home/End 跳首尾。 */
export function docIdForNavKey(
  all: ReadonlyArray<DocTab>,
  currentId: string | null,
  key: string,
): string | null {
  if (all.length === 0) return null
  const index = currentId ? all.findIndex((doc) => doc.id === currentId) : -1
  const at = index < 0 ? 0 : index
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return all[(at + 1) % all.length].id
    case 'ArrowLeft':
    case 'ArrowUp':
      return all[(at - 1 + all.length) % all.length].id
    case 'Home':
      return all[0].id
    case 'End':
      return all[all.length - 1].id
    default:
      return null
  }
}

/** 活动标签的回退链：本地选中 → 编辑器活动文件 → 计划（有内容）→ 变更。 */
export function resolveActiveDocId(
  all: ReadonlyArray<DocTab>,
  preferred: string | null,
  activeFilePath: string | null,
): string | null {
  const exists = (id: string | null): id is string => !!id && all.some((doc) => doc.id === id)
  if (exists(preferred)) return preferred
  const fromEditor = activeFilePath ? docIdOfFile(activeFilePath) : null
  if (exists(fromEditor)) return fromEditor
  if (all.some((doc) => doc.id === 'plan')) {
    // 有文件就优先文件，否则退到第一个会话视图
    return all.some((doc) => doc.kind === 'file') ? all.find((doc) => doc.kind === 'file')!.id : 'plan'
  }
  return all[0]?.id ?? null
}

/** 文件标签的分类统计（面板标题用：3 个代码 / 1 个图片 …）。 */
export function docSummary(docs: ReadonlyArray<DocTab>): string {
  const files = docs.filter((doc) => doc.kind === 'file')
  if (files.length === 0) return '还没有打开文件'
  const dirty = files.filter((doc) => doc.dirty).length
  const suffix = dirty > 0 ? ` · ${dirty} 个未保存` : ''
  return `${files.length} 个文件${suffix}`
}
