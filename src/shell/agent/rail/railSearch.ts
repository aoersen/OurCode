import type { ChatSession } from '@shared/types'

/**
 * 会话栏搜索：一处匹配「项目名 / 路径 / 会话标题 / 消息正文」，统一在这里收口。
 *
 * 纯函数、零依赖 —— 派生逻辑要能被单测（`src/__tests__/shell-rail-*.test.ts`），
 * 组件只负责把结果画出来。
 */

/** 命中点前后各保留的字符数（片段太长会撑破单行行高）。 */
export const SNIPPET_RADIUS = 24

/** 归一化查询串：去首尾空白 + 小写（空串 = 未搜索）。 */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * 从一段文本里截出命中点附近的一行片段。
 * - 未命中返回 null（调用方据此决定「这条会话是否算命中」）；
 * - 换行 / 制表 / 连续空白折成单个空格 —— 片段必须是单行；
 * - 首尾用 `…` 标出截断。
 */
export function buildSnippet(text: string, query: string, radius: number = SNIPPET_RADIUS): string | null {
  const q = query.trim()
  if (!text || !q) return null
  const flat = text.replace(/\s+/g, ' ')
  const idx = flat.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return null
  const start = Math.max(0, idx - radius)
  const end = Math.min(flat.length, idx + q.length + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export interface SessionMatch {
  /** 标题 / 项目路径命中（此时行内不显示正文片段）。 */
  inTitle: boolean
  /** 正文命中时的一行片段；未命中为 null。 */
  snippet: string | null
}

/**
 * 一条会话是否命中查询。标题优先（标题命中不再显示片段，避免一行两处噪声），
 * 其次从**最新**消息往回找正文 —— 用户要找的是刚聊过的那句。
 */
export function matchSession(
  session: Pick<ChatSession, 'title' | 'messages'>,
  query: string,
): SessionMatch {
  const q = query.trim()
  if (!q) return { inTitle: false, snippet: null }
  const lower = q.toLowerCase()
  if ((session.title || '').toLowerCase().includes(lower)) return { inTitle: true, snippet: null }
  const messages = session.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const snippet = buildSnippet(messages[i]?.content ?? '', q)
    if (snippet) return { inTitle: false, snippet }
  }
  return { inTitle: false, snippet: null }
}

/** 项目名 / 路径是否命中（搜索时项目行自身的匹配规则）。 */
export function matchProject(label: string, path: string, query: string): boolean {
  const q = normalizeQuery(query)
  if (!q) return true
  return label.toLowerCase().includes(q) || path.toLowerCase().includes(q)
}
