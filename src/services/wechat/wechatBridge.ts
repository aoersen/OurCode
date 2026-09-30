/**
 * 微信 ↔ agent 管道桥接（渲染层）。
 *
 * 微信消息经主进程广播（WechatGatewayEvent['inbound']）到达这里，桥接层负责：
 *  - 会话映射：微信联系人/群 ↔ 专用会话（localStorage 持久化）；
 *  - 入站：审批应答优先（批准/拒绝/选项编号），否则作为新消息注入
 *    chatStore.sendMessage 驱动同一个 agent 循环；
 *  - 出站：订阅 chatStore 的流式增量，经 StreamingMarkdownFilter 过滤成
 *    微信可读文本，节流分片回发；
 *  - 决策通知：本会话的审批/提问/批量/作用域/计划决策转成微信选项消息。
 *
 * 前置约束（chatStore 的决策槽机制）：决策只有在该会话为 activeSessionId 时
 * 才会入槽（offerDecision），否则停入 decisionBacklog；因此应答前先
 * setActiveSession + rebalanceDecisions 把决策提回槽位。
 */
import { StreamingMarkdownFilter } from '@tencent-weixin/openclaw-weixin/dist/src/messaging/markdown-filter.js'

import { useChatStore } from '@/stores/chatStore'
import type { ChatState } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { useWechatStore } from '@/stores/wechatStore'
import type { WechatGatewayEvent, WechatInboundEvent } from '@/types'

const SESSION_MAP_KEY = 'wechat_session_map'
/** 流式外发节流间隔：攒批后统一冲刷，避免每个 token 都发一条微信。 */
const FLUSH_INTERVAL_MS = 1_000
/** 流式阶段攒够多少字符才发第一批。 */
const SEND_BATCH_CHARS = 400
/** 单条微信文本上限（保守值，远低于服务端限制，避免多字节超限）。 */
const SEND_CHUNK_CHARS = 1_700

const sessionByContact = new Map<string, string>() // contactId -> sessionId
const contactBySession = new Map<string, string>() // sessionId -> contactId
const filters = new Map<string, StreamingMarkdownFilter>() // sessionId -> 本轮过滤器
const filteredAcc = new Map<string, string>() // sessionId -> 已过滤文本累计
const sentLen = new Map<string, number>() // sessionId -> 已发送字符数
const lastRaw = new Map<string, string>() // sessionId -> 上次看到的流式原文
const notifiedKinds = new Set<string>() // `${sessionId}:${kind}` 已通知的决策种类
let runningSnapshot = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let unsubs: Array<() => void> = []
let initialized = false

function channelEnabled(): boolean {
  return useEditorStore.getState().preferences.wechatEnabled !== false
}

function persistSessionMap(): void {
  try {
    localStorage.setItem(SESSION_MAP_KEY, JSON.stringify(Object.fromEntries(sessionByContact)))
  } catch {
    // localStorage 不可用时静默降级：仅本次会话有效
  }
}

function ack(contactId: string, text: string): void {
  void useWechatStore.getState().sendText(contactId, text).catch(() => {})
}

function previewText(raw: string | undefined, max = 150): string {
  if (!raw) return ''
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

// ── 会话映射 ──────────────────────────────────────────────────────────────
function ensureSession(contactId: string): string | null {
  const existing = sessionByContact.get(contactId)
  if (existing && useChatStore.getState().sessions.some((s) => s.id === existing)) {
    return existing
  }
  const prefs = useEditorStore.getState().preferences
  const config = useConfigStore.getState()
  const configGroupId = config.activeConfigGroupId ?? config.configGroups?.[0]?.id ?? ''
  const chat = useChatStore.getState()
  const projectPath =
    prefs.wechatWorkspaceDir?.trim() ||
    chat.sessions.find((s) => s.id === chat.activeSessionId)?.projectPath ||
    useUIStore.getState().rootPath ||
    ''
  const sessionId = chat.createSession(configGroupId, projectPath)
  if (!sessionId) return null
  if (prefs.wechatApprovalMode === 'full_access') {
    chat.setProjectEditMode(sessionId, 'full_access')
  }
  sessionByContact.set(contactId, sessionId)
  contactBySession.set(sessionId, contactId)
  persistSessionMap()
  return sessionId
}

// ── 决策应答 ──────────────────────────────────────────────────────────────
function collectPendingKinds(sessionId: string): string[] {
  const cs = useChatStore.getState()
  const kinds: string[] = []
  if (cs.pendingApproval?.sessionId === sessionId) kinds.push('approval')
  if (cs.pendingQuestion?.sessionId === sessionId) kinds.push('question')
  if (cs.batchApproval?.sessionId === sessionId) kinds.push('batch')
  if (cs.pendingScope?.sessionId === sessionId) kinds.push('scope')
  if (cs.decisionBacklog.some((d) => d.sessionId === sessionId)) kinds.push('backlog')
  if (cs.sessions.find((s) => s.id === sessionId)?.planStatus === 'pending_approval') kinds.push('plan')
  return kinds
}

const YES_RE = /^(批准|同意|确认|执行|可以|ok|yes|y|1)$/i
const NO_RE = /^(拒绝|否|不|取消|no|n|2)$/i

/**
 * 判断一条微信文本是否为对该会话待决决策的应答；命中则执行应答并回执，
 * 返回 true（消息被消费）。导出供单元测试直接驱动。
 */
export function answerPendingDecision(sessionId: string, contactId: string, rawText: string): boolean {
  const kinds = collectPendingKinds(sessionId)
  if (kinds.length === 0) return false

  const cs = useChatStore.getState()
  if (cs.activeSessionId !== sessionId) {
    cs.setActiveSession(sessionId)
    cs.rebalanceDecisions()
  }
  const s = useChatStore.getState()
  const text = rawText.trim()

  // 计划审批以 sessionId 为目标，不依赖槽位，最先判。
  if (s.sessions.find((x) => x.id === sessionId)?.planStatus === 'pending_approval') {
    if (YES_RE.test(text)) {
      void s.approvePlan(sessionId)
      ack(contactId, '计划已批准，开始执行 ✅')
      return true
    }
    if (NO_RE.test(text) || /^放弃/.test(text)) {
      s.dismissPlan(sessionId)
      ack(contactId, '计划已放弃')
      return true
    }
    ack(contactId, '计划待批准：回复「批准计划」开始执行，或「放弃计划」取消')
    return true
  }

  if (s.pendingApproval?.sessionId === sessionId) {
    if (YES_RE.test(text)) {
      s.approveToolCall()
      ack(contactId, '已批准 ✅')
      return true
    }
    if (NO_RE.test(text)) {
      s.rejectToolCall()
      ack(contactId, '已拒绝')
      return true
    }
    ack(contactId, '待批准中：回复「批准」或「拒绝」')
    return true
  }

  if (s.batchApproval?.sessionId === sessionId) {
    if (YES_RE.test(text) || /^全部/.test(text)) {
      s.decideBatchApproval(/^全部/.test(text) ? 'all' : 'confirm')
      ack(contactId, '已批准 ✅')
      return true
    }
    if (NO_RE.test(text)) {
      s.decideBatchApproval('reject')
      ack(contactId, '已拒绝')
      return true
    }
    ack(contactId, '待批准中：回复「批准」（或「全部」）或「拒绝」')
    return true
  }

  if (s.pendingScope?.sessionId === sessionId) {
    if (/加入计划|add|plan/i.test(text)) {
      s.resolveScopeDecision('add_to_plan')
      ack(contactId, '已加入计划 ✅')
      return true
    }
    if (/切换|switch/i.test(text)) {
      s.resolveScopeDecision('switch_mode')
      ack(contactId, '已切换模式 ✅')
      return true
    }
    if (NO_RE.test(text)) {
      s.resolveScopeDecision('reject')
      ack(contactId, '已拒绝')
      return true
    }
    ack(contactId, '作用域决策：回复「加入计划」/「切换模式」/「拒绝」')
    return true
  }

  if (s.pendingQuestion?.sessionId === sessionId) {
    const q = s.pendingQuestion
    const num = /^([0-9]+)$/.exec(text)
    let answer = text
    if (num && q.options?.length) {
      const idx = Number(num[1]) - 1
      if (idx >= 0 && idx < q.options.length) answer = q.options[idx]
    }
    s.answerQuestion(answer)
    ack(contactId, `已回答：${previewText(answer, 40)}`)
    return true
  }

  if (kinds.includes('backlog')) {
    ack(contactId, '有条决策正在排队处理，请稍候再回复')
    return true
  }
  return false
}

// ── 入站 ──────────────────────────────────────────────────────────────────
function onInbound(msg: WechatInboundEvent): void {
  if (!channelEnabled()) return
  const contactId = msg.replyTo || msg.from
  if (!contactId) return
  const text = (msg.text ?? '').trim()
  if (!text) return

  const sessionId = ensureSession(contactId)
  if (!sessionId) return

  // 优先当作对当前待决决策的应答；命中则不再作为新消息。
  if (answerPendingDecision(sessionId, contactId, text)) return

  const cs = useChatStore.getState()
  if (cs.activeSessionId !== sessionId) {
    cs.setActiveSession(sessionId)
    cs.rebalanceDecisions()
  }
  // 新一轮：重置该会话的流式水位（过滤器、已发长度、原文快照）。
  filters.set(sessionId, new StreamingMarkdownFilter())
  filteredAcc.set(sessionId, '')
  sentLen.set(sessionId, 0)
  lastRaw.set(sessionId, '')
  ack(contactId, '已收到，开始处理…')
  void cs.sendMessage(sessionId, text)
}

// ── 出站（流式） ──────────────────────────────────────────────────────────
function trackStreaming(sessionId: string, state: ChatState): void {
  const raw = state.streamingBySession[sessionId]?.content
  if (!raw) return
  const last = lastRaw.get(sessionId) ?? ''
  if (raw === last) return
  if (raw.length < last.length) {
    // 流被清空（停止/换轮）：重置快照，下一轮重新开始。
    lastRaw.set(sessionId, '')
    return
  }
  const filter = filters.get(sessionId) ?? new StreamingMarkdownFilter()
  filters.set(sessionId, filter)
  const out = filter.feed(raw.slice(last.length))
  if (out) filteredAcc.set(sessionId, (filteredAcc.get(sessionId) ?? '') + out)
  lastRaw.set(sessionId, raw)
  scheduleFlush()
}

/**
 * 计算下一片可发送文本（纯函数，供测试与 flushFor 共用）。
 * 流式阶段（force=false）攒够 SEND_BATCH_CHARS 才发；完成阶段（force=true）
 * 无条件发送剩余内容。返回 null 表示当前无可发内容。
 */
export function nextSendChunk(acc: string, sent: number, force: boolean): string | null {
  const unsent = acc.slice(sent)
  if (!unsent) return null
  if (force || unsent.length >= SEND_BATCH_CHARS) return unsent.slice(0, SEND_CHUNK_CHARS)
  return null
}

async function flushFor(contactId: string, sessionId: string, force: boolean): Promise<void> {
  const acc = filteredAcc.get(sessionId) ?? ''
  let sent = sentLen.get(sessionId) ?? 0
  for (;;) {
    const chunk = nextSendChunk(acc, sent, force)
    if (!chunk) break
    const res = await useWechatStore.getState().sendText(contactId, chunk)
    if (!res.ok) break // 发送失败：保留未发部分，下轮重试
    sent += chunk.length
  }
  sentLen.set(sessionId, sent)
}

function flushAll(force: boolean): void {
  flushTimer = null
  const tasks: Promise<void>[] = []
  for (const [contactId, sessionId] of sessionByContact) {
    tasks.push(flushFor(contactId, sessionId, force))
  }
  void Promise.all(tasks)
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => flushAll(false), FLUSH_INTERVAL_MS)
}

/** 本轮结束时把过滤器滞留字符冲刷干净并强制发出剩余文本。 */
async function flushComplete(sessionId: string, contactId: string): Promise<void> {
  const filter = filters.get(sessionId)
  if (filter) {
    const tail = filter.flush()
    if (tail) filteredAcc.set(sessionId, (filteredAcc.get(sessionId) ?? '') + tail)
  }
  await flushFor(contactId, sessionId, true)
}

// ── 决策通知 ──────────────────────────────────────────────────────────────
function notifyDecisions(sessionId: string, contactId: string, state: ChatState): void {
  const present = new Set<string>()
  let notice: string | null = null
  let kind: string | null = null

  const approval = state.pendingApproval
  if (approval?.sessionId === sessionId) {
    kind = 'approval'
    notice = `🔐 微信会话请求批准执行工具\n工具：${approval.toolCall.name}\n${previewText(approval.preview)}\n回复「批准」执行，「拒绝」取消`
  } else if (state.batchApproval?.sessionId === sessionId) {
    kind = 'batch'
    const names = state.batchApproval.tools.map((t) => t.name).join('、')
    notice = `🔐 批量批准（${state.batchApproval.tools.length} 项）：${previewText(names, 120)}\n回复「批准」全部执行，「拒绝」取消`
  } else if (state.pendingScope?.sessionId === sessionId) {
    kind = 'scope'
    notice = `🔐 作用域决策：${previewText(state.pendingScope.preview)}\n涉及：${previewText(state.pendingScope.paths.join('、'), 120)}\n回复「加入计划」/「切换模式」/「拒绝」`
  } else if (state.pendingQuestion?.sessionId === sessionId) {
    kind = 'question'
    const q = state.pendingQuestion
    const opts = q.options?.length
      ? `\n${q.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
      : ''
    notice = `❓ ${q.question}${opts}\n直接回复答案${q.options?.length ? '或编号' : ''}`
  }

  const sess = state.sessions.find((s) => s.id === sessionId)
  if (sess?.planStatus === 'pending_approval') {
    kind = 'plan'
    notice = `📋 计划待批准\n${previewText(sess.planContent, 300)}\n回复「批准计划」开始执行，或「放弃计划」取消`
  }

  // backlog 里的决策（会话未激活）不单独通知——把会话切到前台后
  // rebalanceDecisions 会提回槽位，下个 tick 走上面的分支。
  if (kind) present.add(`${sessionId}:${kind}`)

  // 清理已消失的决策种类，让同类新决策可以再次通知。
  for (const key of [...notifiedKinds]) {
    const [sid] = key.split(':')
    if (sid === sessionId && !present.has(key)) notifiedKinds.delete(key)
  }

  if (notice && kind && !notifiedKinds.has(`${sessionId}:${kind}`)) {
    notifiedKinds.add(`${sessionId}:${kind}`)
    ack(contactId, notice)
  }
}

// ── 主循环 ────────────────────────────────────────────────────────────────
function handleChatTick(state: ChatState): void {
  if (!channelEnabled()) return
  const runningNow = new Set(state.runningSessionIds)
  for (const [contactId, sessionId] of sessionByContact) {
    notifyDecisions(sessionId, contactId, state)
    trackStreaming(sessionId, state)
    if (runningSnapshot.has(sessionId) && !runningNow.has(sessionId)) {
      void flushComplete(sessionId, contactId)
    }
  }
  runningSnapshot = runningNow
}

function handleGatewayEvent(ev: WechatGatewayEvent): void {
  if (ev.event === 'inbound') onInbound(ev)
}

/** 应用启动时调用一次（App.tsx）。返回清理函数。 */
export function initWechatBridge(): () => void {
  if (initialized) return () => {}
  initialized = true

  try {
    const saved = localStorage.getItem(SESSION_MAP_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as Record<string, string>
      for (const [contactId, sessionId] of Object.entries(parsed)) {
        if (typeof sessionId === 'string') {
          sessionByContact.set(contactId, sessionId)
          contactBySession.set(sessionId, contactId)
        }
      }
    }
  } catch {
    // 忽略损坏的映射
  }

  const offStore = useWechatStore.getState().init()
  const offGateway = window.electronAPI.onWechatEvent(handleGatewayEvent)
  const offChat = useChatStore.subscribe(handleChatTick)
  runningSnapshot = new Set(useChatStore.getState().runningSessionIds)
  unsubs = [offStore, offGateway, offChat]

  return () => {
    unsubs.forEach((u) => u())
    unsubs = []
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    initialized = false
  }
}
