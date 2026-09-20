/**
 * Cross-session knowledge — reading OTHER chat sessions from inside a run.
 *
 * Sessions live in the renderer store (SQLite-backed, loaded per window mode),
 * so the search/transcript logic below is pure over that in-memory data — no
 * new IPC surface. Three consumers share it:
 *   - the `read_session` tool (bounded transcript of another session),
 *   - the `search_sessions` tool (keyword hits across all sessions),
 *   - `#sess_<id>` references in user messages, expanded into the request's
 *     dynamic context before the prompt is built.
 *
 * Every output is capped: transcripts and snippets are character/消息数 bounded
 * so a referenced session can never flood the context window.
 */
import type { ChatMessage, ChatSession } from '@/types'

/** Tail messages pulled into a reference block / transcript. */
export const MAX_REFERENCE_MESSAGES = 12
/** Per-message character cap in transcripts and reference blocks. */
export const MAX_MESSAGE_CHARS = 1200
/** Reference block budget — at most this many distinct sessions per turn. */
export const MAX_REFERENCES_PER_TURN = 3
/** Snapshot character budget per search snippet (around the first hit). */
export const SNIPPET_CHARS_BEFORE = 120
export const SNIPPET_CHARS_AFTER = 240

/** Extract the session ids referenced via `#sess_<id>` (deduped, ordered). */
export function parseSessionReferences(text: string): string[] {
  const ids: string[] = []
  for (const m of text.matchAll(/#sess_([A-Za-z0-9._-]+)/g)) {
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

/** Resolve a session by id (exact or unique prefix), or by exact title. */
export function findSessionByIdOrTitle(
  sessions: ChatSession[],
  id?: string,
  title?: string,
): ChatSession | undefined {
  if (id) {
    const exact = sessions.find((s) => s.id === id)
    if (exact) return exact
    const prefix = sessions.filter((s) => s.id.startsWith(id))
    if (prefix.length === 1) return prefix[0]
    return undefined
  }
  if (title) {
    const t = title.trim()
    return sessions.find((s) => s.title === t || (s.title && s.title.includes(t)))
  }
  return undefined
}

/** Render one message as a compact transcript line (bounded). */
function renderMessage(m: ChatMessage, includeTools: boolean): string | null {
  const body = (m.content || '').trim()
  const toolNote =
    includeTools && (m.toolCalls?.length || 0) > 0
      ? ` [调用了 ${m.toolCalls!.length} 个工具${m.toolCalls!.length > 3 ? `：${m.toolCalls!.slice(0, 3).map((c) => c.name).join('、')} 等` : `：${m.toolCalls!.map((c) => c.name).join('、')}`}]`
      : ''
  if (!body && !toolNote) return null
  const capped = body.length > MAX_MESSAGE_CHARS ? `${body.slice(0, MAX_MESSAGE_CHARS)}…(截断)` : body
  return `${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role}：${capped}${toolNote}`
}

/**
 * Bounded transcript of a session's tail — the payload of read_session and
 * the per-session content of a #sess_ reference block.
 */
export function formatSessionTranscript(target: ChatSession, maxMessages = 20): string {
  const tail = target.messages.slice(-maxMessages)
  const lines = tail
    .map((m) => renderMessage(m, false))
    .filter((l): l is string => l !== null)
  const head = `会话「${target.title}」(id: ${target.id}) 共 ${target.messages.length} 条消息，以下为最近 ${tail.length} 条：`
  return [head, ...lines].join('\n')
}

/** The #sess_ reference block injected into the request's dynamic context. */
export function buildReferenceBlock(target: ChatSession): string {
  const tail = target.messages.slice(-MAX_REFERENCE_MESSAGES)
  const lines = tail
    .map((m) => renderMessage(m, true))
    .filter((l): l is string => l !== null)
  return `\n\n<referenced_session id="${target.id}" title="${target.title}">\n以下是引用会话「${target.title}」的最近消息转录（供参考，勿逐字复述）：\n${lines.join('\n')}\n</referenced_session>`
}

export interface SessionKnowledgeHit {
  sessionId: string
  title: string
  role: string
  snippet: string
}

/**
 * First-hit keyword search across every session's message content. One hit
 * per session (the newest), capped at `limit` sessions. `sessions` is the
 * renderer store's in-memory list — no IPC involved.
 */
export function searchSessionsForQuery(
  sessions: ChatSession[],
  query: string,
  limit = 5,
): SessionKnowledgeHit[] {
  const kw = query.trim().toLowerCase()
  if (!kw) return []
  const cap = Math.min(Math.max(limit, 1), 10)
  const hits: SessionKnowledgeHit[] = []
  for (const s of sessions) {
    // Newest messages first — the most recent hit is the most relevant one.
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i]
      const content = m.content || ''
      if (!content) continue
      const idx = content.toLowerCase().indexOf(kw)
      if (idx < 0) continue
      const start = Math.max(0, idx - SNIPPET_CHARS_BEFORE)
      const end = Math.min(content.length, idx + kw.length + SNIPPET_CHARS_AFTER)
      const snippet = `${start > 0 ? '…' : ''}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${end < content.length ? '…' : ''}`
      hits.push({ sessionId: s.id, title: s.title, role: m.role, snippet })
      break
    }
    if (hits.length >= cap) break
  }
  return hits
}
