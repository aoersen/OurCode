/**
 * 右栏「管理」面注册表 —— 纯函数，node 环境可单测。
 *
 * 管理面不是弹窗、不是侧栏，而是产物面板里的第二层导航：页签行末尾多一个
 * 「管理」入口，点开后先出现一条纯文字的六项选择（记忆 / 技能 / MCP / 工作流 /
 * 用量 / 渠道），选中哪一项就在面板 body 里渲染哪一项。
 *
 * 这里只负责「有哪几项 / 方向键怎么走 / 路径怎么显示 / 长列表怎么截断」，
 * 状态、副作用与 store 全部留在组件里。
 */

export type SurfaceId = 'memory' | 'skills' | 'mcp' | 'workflow' | 'usage' | 'channel'

export interface SurfaceEntry {
  id: SurfaceId
  /** 选择条上的文字（纯排版，不加图标/胶囊） */
  label: string
  /** 读屏与 title 用的补充说明 */
  title: string
}

export const SURFACES: ReadonlyArray<SurfaceEntry> = [
  { id: 'memory', label: '记忆', title: '项目与全局长期记忆' },
  { id: 'skills', label: '技能', title: '已安装技能与启停' },
  { id: 'mcp', label: 'MCP', title: 'MCP 服务器连接与配置' },
  { id: 'workflow', label: '工作流', title: '可复用的提示词模板' },
  { id: 'usage', label: '用量', title: 'Token 用量、模型排行与近期活动' },
  { id: 'channel', label: '渠道', title: '微信 / 飞书 / 企微等渠道接入' },
]

/** 每个列表一次最多渲染多少行；超出给一条「显示更多」。 */
export const ROW_PAGE_SIZE = 100

export function isSurfaceId(value: unknown): value is SurfaceId {
  return typeof value === 'string' && SURFACES.some((entry) => entry.id === value)
}

export function surfaceLabel(id: SurfaceId): string {
  return SURFACES.find((entry) => entry.id === id)?.label ?? id
}

export function surfaceIndexOf(id: SurfaceId): number {
  const index = SURFACES.findIndex((entry) => entry.id === id)
  return index < 0 ? 0 : index
}

/**
 * 选择条的方向键（循环）。↑/↓ 留给列表，选择条只吃 ←/→ 与 Home/End。
 * 返回 null 表示不是导航键，调用方保持原样。
 */
export function surfaceForNavKey(current: SurfaceId, key: string): SurfaceId | null {
  const index = surfaceIndexOf(current)
  switch (key) {
    case 'ArrowRight':
      return SURFACES[(index + 1) % SURFACES.length].id
    case 'ArrowLeft':
      return SURFACES[(index - 1 + SURFACES.length) % SURFACES.length].id
    case 'Home':
      return SURFACES[0].id
    case 'End':
      return SURFACES[SURFACES.length - 1].id
    default:
      return null
  }
}

/** 最后一个路径段（`E:\a\b` → `b`）；用于项目名而不是整条绝对路径。 */
export function lastPathSegment(path: string | null | undefined): string {
  if (!path) return ''
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/** `E:\ls\ideUtil\OurCode-ide` → `…/ideUtil/OurCode-ide`（只保留末 `keep` 段）。 */
export function shortenPath(path: string, keep = 2): string {
  if (!path) return ''
  const parts = path.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= keep) return path
  return `…/${parts.slice(-keep).join('/')}`
}

/** 大小写不敏感的子串匹配（各面的搜索共用一套口径）。 */
export function matchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return text.toLowerCase().includes(needle)
}

export interface RowWindow<T> {
  rows: T[]
  /** 还有多少行没渲染（>0 时界面给一条「显示更多」） */
  hidden: number
}

/** 长列表截断：默认最多 100 行，剩下的交给「显示更多」。 */
export function rowWindow<T>(rows: ReadonlyArray<T>, limit: number = ROW_PAGE_SIZE): RowWindow<T> {
  const safeLimit = Math.max(0, limit)
  return {
    rows: rows.slice(0, safeLimit),
    hidden: Math.max(0, rows.length - safeLimit),
  }
}

export function nextRowLimit(current: number, page: number = ROW_PAGE_SIZE): number {
  return Math.max(0, current) + Math.max(1, page)
}
