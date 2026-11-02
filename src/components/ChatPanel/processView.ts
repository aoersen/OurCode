/**
 * 「思考与执行过程」折叠块的纯视图模型。
 *
 * 折叠块的渲染规则集中在这里，抽成纯函数是为了能在 Node 环境（vitest）里
 * 直接单测，不必挂载 React：
 *   - 一个 turn 内的多条 assistant 消息 → 轮次（thinking / 中间正文 / 工具调用）
 *   - 折叠状态下的表头摘要（几轮 / 几步）
 *   - 运行中的实时状态（正在执行哪个工具 / 处于哪个阶段）
 *   - 工具执行已耗时（秒）
 *
 * 关键产品约束：**折叠只收「思考 + 工具调用」，正文永不进折叠区**。
 * 曾经把中间轮次的正文也塞进折叠块，导致用户在 AI 还在输出时点一下「收起」，
 * 整条气泡只剩一行表头——正在写的内容看起来像是被全部折叠掉了。
 */
import type { AgentRunPhase, ChatMessage } from '@/types'
import type { TranslationKey } from '@/i18n'

export type ProcessToolCall = NonNullable<ChatMessage['toolCalls']>[number]
export type ProcessToolResult = NonNullable<ChatMessage['toolResults']>[number]

export interface ProcessRound {
  id: string
  /** 该轮的思考独白（进折叠区） */
  thinking?: string
  /** 该轮写出的正文（最终回答之外的中间轮次）—— 折叠时仍然显示 */
  prose: string
  /** 该轮的工具调用（进折叠区） */
  toolCalls: ProcessToolCall[]
  toolResults: ProcessToolResult[]
}

export interface ProcessSummary {
  /** 有思考或正文的轮次数 */
  rounds: number
  /** 工具调用总次数 */
  tools: number
}

export interface PendingTool {
  name: string
  startedAt?: number
}

export interface ProcessStatus {
  key: TranslationKey
  vars?: Record<string, string | number>
}

/**
 * 把 turn 内的消息折算成可渲染的轮次。
 * 最后一条消息的正文是「最终回答」，由调用方渲染在折叠块下方，这里留空，
 * 避免正文出现两次。
 */
export function buildProcessRounds(messages: ChatMessage[]): ProcessRound[] {
  const last = messages.length - 1
  return messages
    .map((m, i) => ({
      id: m.id,
      thinking: m.thinking,
      prose: i < last ? m.content ?? '' : '',
      toolCalls: m.toolCalls ?? [],
      toolResults: m.toolResults ?? [],
    }))
    .filter((r) => !!r.thinking || r.prose.trim().length > 0 || r.toolCalls.length > 0)
}

/** 折叠状态下表头右侧的一行摘要来源。 */
export function summarizeProcess(rounds: ProcessRound[]): ProcessSummary {
  let roundCount = 0
  let toolCount = 0
  for (const r of rounds) {
    if (r.thinking || r.prose.trim().length > 0) roundCount += 1
    toolCount += r.toolCalls.length
  }
  return { rounds: roundCount, tools: toolCount }
}

/**
 * 「已发出、还没有结果」的工具调用 —— 从最后一条 assistant 消息往回找，
 * 并行调用时可能不止一个。命中即为当前正在执行的动作。
 */
export function pendingToolsOf(messages: ChatMessage[]): PendingTool[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const results = m.toolResults ?? []
    return (m.toolCalls ?? [])
      .filter((tc) => !results.some((r) => r.toolCallId === tc.id))
      .map((tc) => ({ name: tc.name, startedAt: tc.startedAt }))
  }
  return []
}

/**
 * 折叠表头的状态文案。
 * 运行中：优先报「正在执行什么工具」，否则按阶段报（准备上下文 / 压缩历史 /
 * 等待模型 / 思考中），保证折叠起来也不是一片空白。
 * 结束后：报「N 轮 · M 步」摘要；没有任何过程时返回 null（表头不挂噪音）。
 */
export function describeProcessStatus(input: {
  running: boolean
  phase?: AgentRunPhase
  pendingTools: PendingTool[]
  summary: ProcessSummary
}): ProcessStatus | null {
  const { running, phase, pendingTools, summary } = input
  if (running) {
    if (pendingTools.length === 1) return { key: 'chat.processStatusTool', vars: { name: pendingTools[0].name } }
    if (pendingTools.length > 1) return { key: 'chat.processStatusTools', vars: { count: pendingTools.length } }
    if (phase === 'preparing') return { key: 'chat.processStatusPreparing' }
    if (phase === 'compacting') return { key: 'chat.processStatusCompacting' }
    if (phase === 'waiting') return { key: 'chat.processStatusWaiting' }
    return { key: 'chat.processStatusThinking' }
  }
  if (summary.rounds === 0 && summary.tools === 0) return null
  return { key: 'chat.processSummary', vars: { rounds: summary.rounds, tools: summary.tools } }
}

/** 运行中工具已耗时（秒）—— 取最早开始的 pending 工具，无时间戳返回 0。 */
export function elapsedSinceStart(pendingTools: PendingTool[], now: number): number {
  let earliest = Number.POSITIVE_INFINITY
  for (const t of pendingTools) {
    if (typeof t.startedAt === 'number' && t.startedAt < earliest) earliest = t.startedAt
  }
  if (!Number.isFinite(earliest)) return 0
  return Math.max(0, Math.floor((now - earliest) / 1000))
}
