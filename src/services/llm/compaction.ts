/**
 * Context compaction — replaces the pre-boundary history with an LLM summary
 * when the estimated context confirms the model's window is nearly full.
 *
 * Two invariants keep this side-effect free:
 * - Original messages are NEVER deleted: the summary lives on the session
 *   (ChatSession.summary / summaryMessageCount) and only replaces history in
 *   the REQUEST view. Storage, UI and editable history stay untouched.
 * - Compaction only fires when the estimate CONFIRMS overflow (or the provider
 *   reported a context-overflow error, which forces it). Under the threshold
 *   nothing happens; on summarizer failure the caller falls back to the
 *   existing lossy trim, so behavior degrades to today's exactly.
 */

import { ApiConfigGroup, LLMToolCall } from '@/types'
import { lookupModelMetadata } from '@shared/constants'
import { useConfigStore } from '@/stores/configStore'
import { sendLLMRequest } from './LLMClient'

/** Marker prefix of the summary system message injected into requests. */
export const SUMMARY_MARKER = '[上下文压缩]'

/** Fallback context window when the model has no metadata entry (tokens). */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Resolve a model's context window (tokens), most-specific first:
 *  user-defined custom model window → static metadata table → default.
 * Mirrors configStore.enrichModel's priority so compaction and the history
 * trim agree with what the UI shows — a custom Ollama model with an 8k window
 * must compact at 8k, not wait for the 128k default.
 */
export function getContextWindow(modelId: string): number {
  const custom = useConfigStore.getState().customModels.find((m) => m.id === modelId)
  const meta = lookupModelMetadata(modelId)
  return custom?.contextWindow || meta?.contextWindow || DEFAULT_CONTEXT_WINDOW
}
/** Trigger threshold: compact when the estimate exceeds this fraction of the
 *  model's context window (same 80% headroom trimHistoryForContext uses). */
export const DEFAULT_COMPACTION_RATIO = 0.8
/** Cap on the summarizer's input size (chars) — bounds the cost of the
 *  summarizer call itself on very large contexts (e.g. 2M-token models). */
const MAX_SUMMARIZE_CHARS = 400_000

/** Fraction of the context window kept verbatim after compaction — the "recent
 *  work" tail. Mainstream harnesses (Pi keeps ~20K, Grok compacts at 85%) keep
 *  the most recent N tokens and summarize the older prefix, rather than keeping
 *  everything after the last user message (which in a long agent run is the run
 *  START and leaves the whole run un-compactable). */
export const DEFAULT_KEEP_RECENT_RATIO = 0.2
/** Absolute cap on the retained tail so a small model never keeps a huge tail. */
const MAX_KEEP_RECENT_TOKENS = 24_000

/** Message shape the compaction logic needs (compatible with the request
 *  message type, so the rebuilt array can be assigned back directly). */
export interface CompactMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant tool-call declarations (present on request messages) — used to
   *  extract the read/modified file lists appended to the summary. */
  toolCalls?: LLMToolCall[]
  toolCallId?: string
  /** Assembled onto the request but never stored in the session (the per-turn
   *  dynamic-context message, tool-result screenshots). It is summarized like
   *  anything else, but `summaryMessageCount` counts SESSION messages, so it
   *  must not be included there — over-counting makes every later turn slice
   *  away real history that the UI and SQLite still show. */
  synthetic?: boolean
}

export interface CompactOptions {
  session: { summary?: string; summaryMessageCount?: number }
  /** The request-side message array: [system, ...session messages]. */
  messages: CompactMessage[]
  /** Skip the budget check and always compact (context-overflow fallback). */
  force?: boolean
  signal?: AbortSignal
  contextWindow?: number
  ratio?: number
  /** Tokens of the most-recent tail kept verbatim after compaction. Defaults to
   *  DEFAULT_KEEP_RECENT_RATIO of the context window, capped. */
  keepRecentTokens?: number
  /** Request payload tokens that ride along OUTSIDE the messages array (the
   *  tool definitions/schemas attached to the request body). The message-sum
   *  estimate would otherwise undercount the real request by exactly this
   *  much, delaying compaction until the provider overflows. Default 0. */
  overheadTokens?: number
  /** Headroom reserved for THIS round's reply (including thinking tokens on
   *  reasoning models). The ratio already leaves headroom for a plain answer;
   *  pass a bigger reserve when the model may emit a long reasoning block, so
   *  request + output never exceeds the window. Default 0. */
  outputReserve?: number
  compactionEnabled: boolean
  /** Calibrated token estimator (chatStore's, injected to avoid duplication). */
  estimateTokens: (text: string) => number
  /** Summary generator — injected so tests can fake it; chatStore wires the
   *  real LLM summarizer. Returns '' (or throws) on failure. */
  summarize: (input: { anchor: string; history: string }) => Promise<string>
}

export interface CompactResult {
  /** Rebuilt request array: [system, summary, ...tail] — tail is the most
   *  recent ~keepRecentTokens work kept verbatim. */
  messages: CompactMessage[]
  /** The raw summary text (persist to ChatSession.summary as the next anchor). */
  summary: string
  /** Number of session messages covered by the summary (persist to
   *  ChatSession.summaryMessageCount). */
  boundaryCount: number
}

/** Index of the last user message — everything before it is summarizable, the
 *  current user turn (and anything after it) is always kept verbatim. */
export function findKeepBoundary(messages: CompactMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return 0
}

/**
 * Token-budget cut point for compaction: walk backward from the end, accumulate
 * the token estimate of the tail, and cut at the latest safe boundary (a user
 * or assistant message — never a tool message, which would split an assistant
 * tool_calls → tool round-trip) once the tail meets `keepRecentTokens`.
 *
 * Unlike `findKeepBoundary`, this keeps the most RECENT work verbatim and lets
 * the older prefix be summarized — so a single long agent run (whose only user
 * message sits at the start) can still be compacted mid-way instead of growing
 * past the model window un-trimmable.
 */
export function findCompactionCutPoint(
  messages: CompactMessage[],
  keepRecentTokens: number,
  estimateTokens: (text: string) => number,
): number {
  if (messages.length <= 1) return 0
  let accumulated = 0
  let lastSafeBoundary = -1
  for (let i = messages.length - 1; i >= 1; i--) {
    const role = messages[i].role
    if (role === 'user' || role === 'assistant') lastSafeBoundary = i
    accumulated += estimateTokens(messages[i].content || '')
    // Only cut once we've both met the budget AND found a safe boundary. A tail
    // that ends in tool results must keep walking back to the assistant that
    // owns them (never split a round-trip).
    if (accumulated >= keepRecentTokens && lastSafeBoundary > 0) return lastSafeBoundary
  }
  // History is smaller than the budget — nothing to summarize.
  return 1
}

export function buildSummaryBlock(summary: string): string {
  return `${SUMMARY_MARKER} 较早的对话已压缩为以下摘要，仅作背景参考：\n\n${summary}`
}

/** True for the injected summary system message (filtered from summarizer
 *  input — the previous summary is passed as the anchor instead). */
export function isSummaryMessage(m: CompactMessage): boolean {
  return m.role === 'system' && m.content.startsWith(SUMMARY_MARKER)
}

/** Tools whose calls mark files as read / edited (drives the summary's
 *  deterministic file lists, so the model knows what it already read/edited
 *  even after the raw history is summarized away — no re-read loop). */
const READ_TOOLS = new Set(['read_file', 'read_multiple_files'])
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit_file'])

export interface FileOps {
  read: Set<string>
  edited: Set<string>
}

function parseToolArgs(toolCall: LLMToolCall): Record<string, unknown> {
  try {
    return JSON.parse(toolCall.function?.arguments || '{}')
  } catch {
    return {}
  }
}

/** Extract read/edited file paths from assistant tool calls in a message list —
 *  deterministic, unlike asking the summarizer to recall them. */
export function extractFileOps(messages: CompactMessage[]): FileOps {
  const read = new Set<string>()
  const edited = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      const name = tc.function?.name || ''
      if (READ_TOOLS.has(name)) {
        const args = parseToolArgs(tc)
        if (name === 'read_multiple_files' && Array.isArray(args.paths)) {
          for (const p of args.paths) if (typeof p === 'string' && p) read.add(p)
        } else if (typeof args.path === 'string' && args.path) {
          read.add(args.path)
        }
      } else if (EDIT_TOOLS.has(name)) {
        const args = parseToolArgs(tc)
        if (name === 'multi_edit_file' && Array.isArray(args.edits)) {
          for (const e of args.edits) if (e && typeof (e as { path?: unknown }).path === 'string' && (e as { path: string }).path) edited.add((e as { path: string }).path)
        } else if (typeof args.path === 'string' && args.path) {
          edited.add(args.path)
        }
      }
    }
  }
  return { read, edited }
}

/** Format the deterministic read/edited file lists as a markdown section to
 *  append to the summary. Empty string when there's nothing to list. */
export function formatFileOps(readFiles: string[], editedFiles: string[]): string {
  const parts: string[] = []
  if (readFiles.length > 0) parts.push(`## 已读文件\n${readFiles.map((p) => `- ${p}`).join('\n')}`)
  if (editedFiles.length > 0) parts.push(`## 已改文件\n${editedFiles.map((p) => `- ${p}`).join('\n')}`)
  return parts.join('\n\n')
}

const SUMMARIZE_SYSTEM_PROMPT = `你是对话历史压缩器。把用户提供的对话历史压缩成一段结构化的中文摘要，供后续对话作为背景参考。

要求：
- 保留：用户的核心目标、已完成的修改与决策、涉及的文件路径、未完成事项、todo 进度、计划状态、阻塞点、已知问题
- 忽略：工具执行的中间细节、重复的探索过程、临时的猜测
- 使用固定结构输出：
## 目标
## 关键细节
## 工作状态（Completed / Active / Blocked）
## 下一步
## 相关文件
- 只输出摘要本身，不要任何开场白或解释`

export function buildSummarizePrompt(anchor: string, history: string): { system: string; user: string } {
  const anchorBlock = anchor.trim()
    ? `已有摘要（请基于它更新而非重写，保留仍为真的信息，删除已过时的信息）：\n${anchor.trim()}\n`
    : ''
  return {
    system: SUMMARIZE_SYSTEM_PROMPT,
    user: `${anchorBlock}对话历史：\n${history}`,
  }
}

function renderHistoryEntry(m: CompactMessage): string {
  const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '工具结果'
  return `${label}: ${m.content}`
}

/**
 * Real summarizer backed by sendLLMRequest (non-streaming, bounded output).
 * Returns '' on any failure so callers fall back to the lossy trim.
 */
export async function runSummarizer(input: {
  model: string
  anchor: string
  history: string
  configGroup: ApiConfigGroup
  signal?: AbortSignal
  maxTokens?: number
  /** Called once with the billed tokens when the summarizer call completed. */
  onUsage?: (usage: { tokensIn: number; tokensOut: number }) => void
}): Promise<string> {
  const { system, user } = buildSummarizePrompt(input.anchor, input.history)
  let summary = ''
  let tokensIn = 0
  let tokensOut = 0
  for await (const chunk of sendLLMRequest(
    {
      model: input.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      temperature: 0,
      maxTokens: input.maxTokens ?? 2000,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
    },
    input.configGroup,
  )) {
    if (input.signal?.aborted) break
    if (chunk.usage) {
      tokensIn = chunk.usage.promptTokens || 0
      tokensOut = chunk.usage.completionTokens || 0
    }
    if (chunk.content) summary += chunk.content
    if (chunk.done) break
  }
  input.onUsage?.({ tokensIn, tokensOut })
  return summary.trim()
}

/**
 * Compaction entry point. Returns the rebuilt request array + summary metadata
 * when compaction happened, or null when nothing changed (disabled, under
 * budget, nothing to summarize, summarizer failed, aborted).
 */
export async function maybeCompact(opts: CompactOptions): Promise<CompactResult | null> {
  if (!opts.compactionEnabled) return null
  if (opts.signal?.aborted) return null
  if (opts.messages.length === 0) return null

  const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const keepRecentTokens = opts.keepRecentTokens
    ?? Math.min(MAX_KEEP_RECENT_TOKENS, Math.floor(contextWindow * DEFAULT_KEEP_RECENT_RATIO))

  // Cut point = keep the most recent ~keepRecentTokens verbatim and summarize
  // the older prefix. Using findKeepBoundary (last user message) here would
  // leave a long agent run un-compactable, because its last user message is the
  // run START. The token-budget cut slices mid-run at a safe boundary instead.
  const boundary = findCompactionCutPoint(opts.messages, keepRecentTokens, opts.estimateTokens)
  // Nothing before the cut point (system prompt only) — nothing to summarize.
  if (boundary <= 1) return null

  // Trigger only when the estimate CONFIRMS we're over the budget — under the
  // threshold the history stays untouched. (force skips the check.)
  // The budget reflects the REAL request: the message-sum plus the tool-schema
  // overhead that rides outside the messages array, minus the output headroom
  // reserved for this round's reply (thinking on reasoning models can exceed
  // the ratio's default headroom and overflow the window).
  if (!opts.force) {
    const ratio = opts.ratio ?? DEFAULT_COMPACTION_RATIO
    const budget = Math.floor(contextWindow * ratio) - (opts.outputReserve || 0)
    const total = opts.messages.reduce((sum, m) => sum + opts.estimateTokens(m.content), 0) + (opts.overheadTokens || 0)
    if (total <= budget) return null
  }

  // History to summarize = everything between the system prompt and the cut
  // point. The previous summary message (if any) is excluded — it is passed as
  // the anchor so summaries update instead of rewrite.
  const history = opts.messages.slice(1, boundary).filter((m) => !isSummaryMessage(m))
  if (history.length === 0) return null

  let historyText = history.map(renderHistoryEntry).join('\n\n')
  if (historyText.length > MAX_SUMMARIZE_CHARS) {
    historyText = `…（更早的内容已省略）\n\n${historyText.slice(-MAX_SUMMARIZE_CHARS)}`
  }

  let summary: string
  try {
    summary = (await opts.summarize({ anchor: opts.session.summary || '', history: historyText })) || ''
  } catch {
    // Summarizer failure — leave the decision to the caller (lossy trim).
    return null
  }
  if (!summary.trim()) return null

  // Append the deterministic read/edited file lists so the model keeps knowing
  // what it already touched after the raw tool results are summarized away.
  const fileOps = extractFileOps(history)
  const fileSection = formatFileOps(Array.from(fileOps.read), Array.from(fileOps.edited))
  const finalSummary = summary.trim() + (fileSection ? `\n\n${fileSection}` : '')

  return {
    messages: [opts.messages[0], { role: 'system', content: buildSummaryBlock(finalSummary) }, ...opts.messages.slice(boundary)],
    summary: finalSummary,
    // Total session messages now covered by the summary = the previously
    // summarized count plus the session messages summarized this round (the
    // previous summary block and the request-only messages are excluded).
    boundaryCount:
      (opts.session.summaryMessageCount ?? 0) + history.filter((m) => !m.synthetic).length,
  }
}
