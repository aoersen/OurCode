/**
 * 微信 Agent 桥接（对话窗口单例）。
 *
 * 微信不是「微信 → IDE 会话」的管道，而是一个独立的常驻 WeChat Agent：
 *  - 自有状态（WechatAgentState，经主进程 SQLite 持久化）：当前工作区
 *    （初始为沙盒，可随时经 /workspace 切换）、审批模式、模型、记忆；
 *  - 会话映射：微信联系人/群 ↔ 专用会话（mode='wechat'，不进主界面列表，
 *    localStorage 持久化映射）；
 *  - 入站：命令路由（/status /workspace /mode /model /group /memory /reset）
 *    优先 → 决策应答（后台队列，不抢 IDE 焦点）→ 否则作为新任务注入
 *    chatStore.sendMessage 驱动 agent 循环（工作区快照传入）；
 *  - 出站：订阅 chatStore 的流式增量，经 StreamingMarkdownFilter 过滤成
 *    微信可读文本，节流分片回发；
 *  - 决策通知：本会话的审批/提问/批量/作用域/计划决策转成微信选项消息。
 *
 * 微信决策走 chatStore 的后台决策通道（wechatDecisions）：不进 UI 槽位、
 * 不触碰 activeSessionId，与 IDE 会话的槽位机制完全隔离。
 */
import { StreamingMarkdownFilter } from '@tencent-weixin/openclaw-weixin/dist/src/messaging/markdown-filter.js'

import { useChatStore } from '@/stores/chatStore'
import type { ChatState } from '@/stores/chatStore'
import { getLastModelForGroup, useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { useWechatStore } from '@/stores/wechatStore'
import type { OfficeSnapshot, WechatAgentState, WechatGatewayEvent, WechatInboundEvent } from '@/types'
import { IS_OFFICE } from '@/utils/windowMode'
import { switchWechatModel } from './modelSwitch'

const SESSION_MAP_KEY = 'wechat_session_map'
/** 流式外发节流间隔：攒批后统一冲刷，避免每个 token 都发一条微信。 */
const FLUSH_INTERVAL_MS = 1_000
/** 流式阶段攒够多少字符才发第一批。 */
const SEND_BATCH_CHARS = 400
/** 单条微信文本上限（官方通道 textChunkLimit=4000，按其上限分片）。 */
const SEND_CHUNK_CHARS = 4_000

const sessionByContact = new Map<string, string>() // contactId -> sessionId
const contactBySession = new Map<string, string>() // sessionId -> contactId
const filters = new Map<string, StreamingMarkdownFilter>() // sessionId -> 本轮过滤器
const filteredAcc = new Map<string, string>() // sessionId -> 已过滤文本累计
const sentLen = new Map<string, number>() // sessionId -> 已发送字符数
const lastRaw = new Map<string, string>() // sessionId -> 上次看到的流式原文
const runGen = new Map<string, number>() // sessionId -> 轮次代数（beginRun 递增，防跨轮竞态）
const notifiedKinds = new Set<string>() // `${sessionId}:${kind}` 已通知的决策种类
const agentQueue: Array<{ contactId: string; sessionId: string; text: string }> = [] // agent 级忙队列
let pendingWorkspaceSwitch: { path: string; contactId: string } | null = null // 工作区切换信任门
let pendingOfficeInstruction: { instructionId: string; text: string; sessionId: string; contactId: string } | null = null // 总监指令确认
let pendingReset = false // /reset 二次确认
let runningSnapshot = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let unsubs: Array<() => void> = []
let initialized = false

function channelEnabled(): boolean {
  return useEditorStore.getState().preferences.wechatEnabled !== false
}

function agentState(): WechatAgentState | null {
  return useWechatStore.getState().agentState
}

async function saveAgentState(patch: Partial<WechatAgentState>): Promise<void> {
  const cur = agentState()
  if (!cur) return
  await useWechatStore.getState().saveAgentState(patch)
}

/** 当前有效工作区：AgentState.currentWorkspace，null = 沙盒。 */
function currentWorkspacePath(): string {
  const st = agentState()
  if (!st) return ''
  return st.currentWorkspace || st.sandboxPath
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

function isAbsoluteLocalPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')
}

function newMemoryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ── 会话映射 ──────────────────────────────────────────────────────────────
/**
 * 解析微信会话应使用的 API 配置组与模型：优先取 AgentState（对话可调），
 * 回退设置偏好（初始值），再到 IDE 当前组，再到第一个组。
 */
export function resolveWechatConfig(): { configGroupId: string; modelId: string | null } {
  const st = agentState()
  const prefs = useEditorStore.getState().preferences
  const config = useConfigStore.getState()
  const groups = config.configGroups ?? []
  const prefGroup = st?.configGroupId?.trim() || prefs.wechatConfigGroupId?.trim()
  const prefGroupValid = Boolean(prefGroup && groups.some((g) => g.id === prefGroup))
  const configGroupId =
    (prefGroupValid ? prefGroup : '') || config.activeConfigGroupId || groups[0]?.id || ''
  // 模型偏好只在显式组仍存在时生效：组被删除后回退到别的组时，旧组的模型
  // 绑新组的密钥必然 401（见 chatStore.updateSessionConfigGroup 的 rebinding 注释）。
  const modelId = prefGroupValid ? st?.modelId?.trim() || prefs.wechatModelId?.trim() || null : null
  return { configGroupId, modelId }
}

/**
 * 修复历史微信会话：补空配置组、同步当前工作区与审批模式（AgentState 是权威，
 * 会话字段只作记录/运行快照）。
 */
export function repairSession(sessionId: string): void {
  const chat = useChatStore.getState()
  const session = chat.sessions.find((s) => s.id === sessionId)
  if (!session) return
  // 惰性迁移：历史上以 mode='main' 创建的微信会话 → 'wechat'（隔离出主界面，
  // 决策也才会走后台队列）。init 时扫不到尚未加载的会话，这里兜底。
  if (session.mode !== 'wechat') chat.updateSessionMode(sessionId, 'wechat')
  const { configGroupId, modelId } = resolveWechatConfig()
  const groupChanged = Boolean(configGroupId) && session.configGroupId !== configGroupId
  // 换组必须连带换模型：AgentState 的模型已在目标组校验过（switchWechatModel），
  // 未指定时用目标组默认模型——绝不能把旧组模型绑到新组密钥上（400/401）。
  const targetModel = groupChanged
    ? modelId ||
        useConfigStore.getState().configGroups.find((g) => g.id === configGroupId)?.defaultModel ||
        getLastModelForGroup(configGroupId) ||
        session.model
    : modelId && session.model !== modelId
      ? modelId
      : undefined
  if (groupChanged || targetModel) {
    chat.updateSessionModel(sessionId, targetModel ?? session.model, groupChanged ? configGroupId : undefined)
  }
  const ws = currentWorkspacePath()
  if (ws && session.projectPath !== ws) chat.updateSessionProjectPath(sessionId, ws)
  const st = agentState()
  const editMode = st?.approvalMode === 'full_access' ? 'full_access' : 'confirm_before_change'
  if (session.projectEditMode !== editMode) chat.setProjectEditMode(sessionId, editMode, false)
}

/**
 * 桥接先于配置加载初始化；首条微信消息若抢在配置组/AgentState 就绪前到达，
 * 会用空配置组创建会话并被持久化（agent 永远静默失败）。这里最多等 5 秒。
 */
async function waitForConfigGroups(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (useConfigStore.getState().configGroups?.length) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function waitForAgentState(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (agentState()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** 取得（或创建并修复）微信联系人的专用会话。导出供单元测试使用。 */
export function ensureSession(contactId: string): string | null {
  const existing = sessionByContact.get(contactId)
  if (existing && useChatStore.getState().sessions.some((s) => s.id === existing)) {
    repairSession(existing)
    return existing
  }
  const chat = useChatStore.getState()
  const { configGroupId, modelId } = resolveWechatConfig()
  const st = agentState()
  const projectPath = st ? st.currentWorkspace || st.sandboxPath : ''
  const sessionId = chat.createSession(configGroupId, projectPath, { mode: 'wechat' })
  if (!sessionId) return null
  if (modelId) chat.updateSessionModel(sessionId, modelId)
  chat.setProjectEditMode(sessionId, st?.approvalMode === 'full_access' ? 'full_access' : 'confirm_before_change', false)
  sessionByContact.set(contactId, sessionId)
  contactBySession.set(sessionId, contactId)
  persistSessionMap()
  return sessionId
}

// ── 工作区切换（信任门） ──────────────────────────────────────────────────
async function requestWorkspaceSwitch(contactId: string, path: string): Promise<void> {
  // 已信任目录（含沙盒）直接切换；未信任 → 微信侧确认后才授予。
  let trusted = false
  try {
    trusted = Boolean(await window.electronAPI.authorize(path))
  } catch {
    trusted = false
  }
  if (trusted) {
    await applyWorkspace(contactId, path)
    return
  }
  pendingWorkspaceSwitch = { path, contactId }
  ack(
    contactId,
    `🔐 你请求将工作区切换到：${path}\n该目录尚未获得本机信任，确认后微信 Agent 将有权读写该目录。\n回复「批准」切换，「拒绝」取消`,
  )
}

async function applyWorkspace(contactId: string, path: string): Promise<void> {
  const res = await window.electronAPI.wechatGrantWorkspace(path)
  if (!res?.ok) {
    ack(contactId, '❌ 切换失败：目录不存在或无法授予信任')
    return
  }
  await saveAgentState({ currentWorkspace: path })
  ack(contactId, `✅ 已切换到工作区：${path}`)
}

// ── 命令路由 ──────────────────────────────────────────────────────────────
const HELP_TEXT = `可用命令：
/status 查看当前状态（工作区/审批模式/模型）
/workspace [路径] 切换工作区（绝对路径）；/workspace sandbox 回到沙盒
/mode approve | full_access 切换审批模式
/model <模型名> 切换模型
/group <组名或ID> 切换 API 配置组
/memory add <内容> | list | clear 管理长期记忆
/office 查看一人公司运行状态；/office instruct [--task <标题>] <指令> 给总监下指令（需批准）
/reset 重置（回沙盒 + 清记忆，需 /reset confirm 确认）
/help 显示本帮助`

async function statusText(): Promise<string> {
  const st = agentState()
  const groups = useConfigStore.getState().configGroups ?? []
  const group = groups.find((g) => g.id === (st?.configGroupId || ''))
  const workspace = st?.currentWorkspace ? st.currentWorkspace : `沙盒（${st?.sandboxPath ?? '未初始化'}）`
  const lines = [
    `📋 WeChat Agent 状态`,
    `工作区：${workspace}`,
    `审批模式：${st?.approvalMode === 'full_access' ? '免审批' : '逐条审批'}`,
    `模型：${st?.modelId || group?.defaultModel || '跟随组默认'}（${group?.name ?? '未选组'}）`,
    `记忆：${st?.memory?.length ?? 0} 条`,
  ]
  return lines.join('\n')
}

const OFFICE_PHASE_TEXT: Record<string, string> = {
  preparing: '准备上下文',
  compacting: '压缩历史',
  waiting: '等待模型',
  streaming: '执行中',
}

/** 一人公司运行状态 → 微信可读文本（导出供 office_status 工具复用）。 */
export function formatOfficeSnapshotText(snap: OfficeSnapshot | null): string {
  if (!snap) return '🏢 办公室未启动（请先在 IDE 打开一人公司窗口）'
  const lines: string[] = ['🏢 一人公司运行状态']
  if (snap.companies.length === 0) {
    lines.push('公司：无（办公室还没有任务会话）')
  }
  for (const c of snap.companies) {
    const phase = c.phase ? `（${OFFICE_PHASE_TEXT[c.phase] ?? c.phase}）` : ''
    lines.push(`· ${c.title}${c.running ? ' 🔄运行中' : ' 空闲'}${phase}${c.projectPath ? ` — ${c.projectPath}` : ''}`)
  }
  if (snap.workers.length > 0) {
    lines.push(`员工：${snap.workers.map((w) => `${w.role}${w.running ? '·工作中' : '·空闲'}`).join('　')}`)
  }
  if (snap.recentActivity.length > 0) {
    lines.push(`近期活动：${snap.recentActivity.slice(0, 5).map((a) => `${a.label}:${previewText(a.task, 40)}`).join('；')}`)
  }
  return lines.join('\n')
}

async function workspaceStatusText(): Promise<string> {
  const st = agentState()
  if (!st) return '（状态未就绪，请稍后再试）'
  return `当前工作区：${st.currentWorkspace || `沙盒（${st.sandboxPath}）`}\n切换：/workspace <绝对路径>；回到沙盒：/workspace sandbox`
}

/** 命令路由：命中返回 true（已处理并回执）；未命中返回 false（作为任务交给 agent）。 */
async function runCommand(contactId: string, raw: string): Promise<boolean> {
  const text = raw.trim()
  let cmdName = ''
  let rest = ''
  if (text.startsWith('/')) {
    const sp = text.split(/\s+/)
    cmdName = sp[0].slice(1).toLowerCase()
    rest = text.slice(sp[0].length).trim()
  } else {
    // 固定中文短命令（确定性词表）
    if (text === '状态') {
      cmdName = 'status'
    } else if (text === '帮助') {
      cmdName = 'help'
    } else if (text === '沙盒') {
      cmdName = 'workspace'
      rest = 'sandbox'
    } else {
      return false
    }
  }

  const st = agentState()
  switch (cmdName) {
    case 'help':
      ack(contactId, HELP_TEXT)
      return true
    case 'status':
      ack(contactId, await statusText())
      return true
    case 'workspace': {
      if (!rest) {
        ack(contactId, await workspaceStatusText())
        return true
      }
      if (rest.toLowerCase() === 'sandbox') {
        await saveAgentState({ currentWorkspace: null })
        ack(contactId, '✅ 已回到沙盒空间')
        return true
      }
      if (!isAbsoluteLocalPath(rest)) {
        ack(contactId, '❌ 需要绝对路径，例如：/workspace E:\\project')
        return true
      }
      await requestWorkspaceSwitch(contactId, rest)
      return true
    }
    case 'mode': {
      if (rest === 'approve' || rest === 'full_access') {
        await saveAgentState({ approvalMode: rest })
        ack(contactId, rest === 'full_access' ? '✅ 已切换到免审批模式' : '✅ 已切换到逐条审批模式')
      } else {
        ack(contactId, '用法：/mode approve 或 /mode full_access')
      }
      return true
    }
    case 'model': {
      if (!rest) {
        const groups = useConfigStore.getState().configGroups ?? []
        const groupId = st?.configGroupId?.trim() || useConfigStore.getState().activeConfigGroupId || groups[0]?.id
        const group = groups.find((g) => g.id === groupId)
        if (!group) {
          ack(contactId, '没有可用的 API 配置组。请先在 设置→API 配置 添加')
          return true
        }
        let ids: string[] = []
        try {
          ids = (await useConfigStore.getState().fetchModelsForGroup(group)).map((m) => m.id)
        } catch {
          ids = []
        }
        const set = new Set([...(group.defaultModel ? [group.defaultModel] : []), ...ids])
        ack(contactId, `当前：${st?.modelId || '跟随组默认'}（${group.name}）
可用模型：${[...set].join('、') || '（获取失败）'}
切换：/model <模型名>；换组：/group`)
        return true
      }
      // 跨组解析：模型在任何组里都能切过去（当前组优先）。
      const result = await switchWechatModel(rest)
      ack(contactId, result.startsWith('已') ? `✅ ${result}` : `❌ ${result}`)
      return true
    }
    case 'group': {
      const groups = useConfigStore.getState().configGroups ?? []
      if (!rest) {
        ack(contactId, `用法：/group <组名或ID>。可用组：${groups.map((g) => g.name).join('、') || '（无）'}`)
        return true
      }
      const g = groups.find((x) => x.id === rest || x.name === rest)
      if (!g) {
        ack(contactId, '❌ 找不到该配置组')
        return true
      }
      await saveAgentState({ configGroupId: g.id, modelId: null })
      ack(contactId, `✅ 已切换到配置组 ${g.name}（模型跟随组默认）`)
      return true
    }
    case 'memory': {
      const items = st?.memory ?? []
      if (rest.startsWith('add ')) {
        const content = rest.slice(4).trim()
        if (!content) {
          ack(contactId, '用法：/memory add <内容>')
          return true
        }
        await saveAgentState({
          memory: [...items, { id: newMemoryId(), text: content, createdAt: Date.now() }],
        })
        ack(contactId, '✅ 已记住')
      } else if (rest === 'list') {
        if (items.length === 0) {
          ack(contactId, '记忆为空。用 /memory add <内容> 添加')
        } else {
          ack(contactId, `📝 记忆（${items.length} 条）：\n${items.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}`)
        }
      } else if (rest === 'clear') {
        await saveAgentState({ memory: [] })
        ack(contactId, '✅ 已清空记忆')
      } else {
        ack(contactId, '用法：/memory add <内容> | list | clear')
      }
      return true
    }
    case 'office': {
      if (!rest || rest === 'status') {
        const snap = await window.electronAPI.getOfficeSnapshot()
        ack(contactId, formatOfficeSnapshotText(snap))
        return true
      }
      const m = /^instruct(?:\s+--task\s+(.+?))?\s+(.+)$/s.exec(rest)
      if (!m) {
        ack(contactId, '用法：/office 查看状态；/office instruct [--task <公司标题或项目>] <指令>')
        return true
      }
      const taskSel = m[1]?.trim()
      const instructText = m[2].trim()
      const snap = await window.electronAPI.getOfficeSnapshot()
      if (!snap || snap.companies.length === 0) {
        ack(contactId, '❌ 办公室未启动或没有公司会话（请先在 IDE 打开一人公司窗口）')
        return true
      }
      let target: string | undefined
      if (taskSel) {
        const hit = snap.companies.find(
          (c) => c.title.includes(taskSel) || c.projectPath.toLowerCase().includes(taskSel.toLowerCase()),
        )
        if (!hit) {
          ack(contactId, `❌ 找不到匹配的公司（${taskSel}）`)
          return true
        }
        target = hit.sessionId
      } else if (snap.companies.length === 1) {
        target = snap.companies[0].sessionId
      } else {
        const list = snap.companies.map((c) => `· ${c.title}`).join('\n')
        ack(contactId, `有多个公司，请点名目标：
${list}
用法：/office instruct --task <标题> <指令>`)
        return true
      }
      const name = snap.companies.find((c) => c.sessionId === target)?.title ?? ''
      pendingOfficeInstruction = {
        instructionId: `oi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: instructText,
        sessionId: target ?? '',
        contactId,
      }
      ack(contactId, `🔐 将向总监「${name}」下达指令：
${previewText(instructText, 120)}
回复「批准」执行，「拒绝」取消`)
      return true
    }
    case 'reset': {
      pendingReset = true
      ack(contactId, '⚠️ /reset 将回到沙盒并清空记忆。确认请回复 /reset confirm')
      return true
    }
    default:
      return false
  }
}

async function doReset(contactId: string): Promise<void> {
  await saveAgentState({ currentWorkspace: null, memory: [] })
  ack(contactId, '✅ 已重置：回到沙盒、清空记忆')
}

/** 微信回复风格：压缩总字数（结论先行、精炼、不客套），不截断内容。 */
const WECHAT_STYLE_BLOCK = `

## 回复风格（微信用户，手机阅读）
- 结论与要点先行，直接回答，不赘述推导过程
- 普通问题尽量控制在 300 字以内；复杂任务用短要点列表
- 不客套开场（如「好的，我来…」）、不重复用户原话
- 日志、中间步骤、不相关细节一律省略`

/** 记忆注入系统提示（任务开始前由 startTurn 传入 runAgentLoop）。 */
function buildMemoryBlock(): string {
  const items = agentState()?.memory ?? []
  if (items.length === 0) return ''
  const lines = items.map((m) => `- ${m.text}`).join('\n')
  return `\n\n## 长期记忆（来自微信 /memory 命令，属于 WeChat Agent 的状态）\n${lines}\n`
}

// ── 决策应答 ──────────────────────────────────────────────────────────────
const YES_RE = /^(批准|同意|确认|执行|可以|ok|yes|y|1)$/i
const NO_RE = /^(拒绝|否|不|取消|no|n|2)$/i

/**
 * 判断一条微信文本是否为对该会话待决决策的应答；命中则执行应答并回执，
 * 返回 true（消息被消费）。决策来自 chatStore 的微信后台队列（wechatDecisions），
 * 不触碰 IDE 槽位与 activeSessionId。导出供单元测试直接驱动。
 */
export function answerPendingDecision(sessionId: string, contactId: string, rawText: string): boolean {
  const s = useChatStore.getState()
  const wd = s.wechatDecisions
  const text = rawText.trim()

  // 计划审批以 sessionId 为目标（会话字段），不依赖槽位，最先判。
  const session = s.sessions.find((x) => x.id === sessionId)
  if (session?.planStatus === 'pending_approval') {
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

  if (wd.approval?.sessionId === sessionId) {
    if (YES_RE.test(text)) {
      s.wechatAnswerApproval(sessionId, true)
      ack(contactId, '已批准 ✅')
      return true
    }
    if (NO_RE.test(text)) {
      s.wechatAnswerApproval(sessionId, false)
      ack(contactId, '已拒绝')
      return true
    }
    ack(contactId, '待批准中：回复「批准」或「拒绝」')
    return true
  }

  if (wd.batch?.sessionId === sessionId) {
    if (YES_RE.test(text) || /^全部/.test(text)) {
      s.wechatAnswerBatch(sessionId, /^全部/.test(text) ? 'all' : 'confirm')
      ack(contactId, '已批准 ✅')
      return true
    }
    if (NO_RE.test(text)) {
      s.wechatAnswerBatch(sessionId, 'reject')
      ack(contactId, '已拒绝')
      return true
    }
    ack(contactId, '待批准中：回复「批准」（或「全部」）或「拒绝」')
    return true
  }

  if (wd.scope?.sessionId === sessionId) {
    if (/加入计划|add|plan/i.test(text)) {
      s.wechatAnswerScope(sessionId, 'add_to_plan')
      ack(contactId, '已加入计划 ✅')
      return true
    }
    if (/切换|switch/i.test(text)) {
      s.wechatAnswerScope(sessionId, 'switch_mode')
      ack(contactId, '已切换模式 ✅')
      return true
    }
    if (NO_RE.test(text)) {
      s.wechatAnswerScope(sessionId, 'reject')
      ack(contactId, '已拒绝')
      return true
    }
    ack(contactId, '作用域决策：回复「加入计划」/「切换模式」/「拒绝」')
    return true
  }

  if (wd.question?.sessionId === sessionId) {
    const q = wd.question
    const num = /^([0-9]+)$/.exec(text)
    let answer = text
    if (num && q.options?.length) {
      const idx = Number(num[1]) - 1
      if (idx >= 0 && idx < q.options.length) answer = q.options[idx]
    }
    s.wechatAnswerQuestion(sessionId, answer)
    ack(contactId, `已回答：${previewText(answer, 40)}`)
    return true
  }

  return false
}

// ── 入站 ──────────────────────────────────────────────────────────────────
/** 新一轮开始：重置该会话的流式水位。必须在 sendMessage 之前调用。 */
function beginRun(sessionId: string): void {
  runGen.set(sessionId, (runGen.get(sessionId) ?? 0) + 1)
  filters.set(sessionId, new StreamingMarkdownFilter())
  filteredAcc.set(sessionId, '')
  sentLen.set(sessionId, 0)
  lastRaw.set(sessionId, '')
}

/** 微信 Agent 是否正忙：任一微信会话在运行（共享工作区 → 串行）。 */
function wechatBusy(): boolean {
  const cs = useChatStore.getState()
  return cs.runningSessionIds.some((id) => cs.sessions.find((s) => s.id === id)?.mode === 'wechat')
}

/** 启动一轮 agent 处理；若被前置守卫静默拦截（无模型组/工作区不可用）立刻回执指引。 */
function startTurn(sessionId: string, contactId: string, text: string): void {
  const cs = useChatStore.getState()
  if (cs.runningSessionIds.includes(sessionId) || wechatBusy()) {
    agentQueue.push({ contactId, sessionId, text })
    ack(contactId, '⏳ Agent 正在处理其他任务，这条已排队，完成后自动继续')
    return
  }
  const st = agentState()
  // 工作区快照：本轮运行期间切换工作区不影响（runAgentLoop 的轮内快照语义）。
  const workspacePath = st ? st.currentWorkspace || st.sandboxPath : ''
  beginRun(sessionId)
  // 记忆 + 微信回复风格一起注入（压缩总字数靠风格约束，不靠截断）。
  const extraSystemText = (buildMemoryBlock() + WECHAT_STYLE_BLOCK).trim() || undefined
  void cs.sendMessage(sessionId, text, [], [], {
    workspacePath: workspacePath || undefined,
    extraSystemText,
  })
  // runAgentLoop 的前置守卫（无 API 配置组 / 无工作区等）是静默返回的——它
  // 甚至不会把会话标为 running。sendMessage 的同步前缀已执行完守卫判定，
  // 这里同步检查：没进入 running 就立刻给微信一个明确的失败指引。
  if (!useChatStore.getState().runningSessionIds.includes(sessionId)) {
    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    ack(
      contactId,
      session?.configGroupId
        ? '❌ 处理未启动：工作区不可用，请用 /workspace 检查或切换'
        : '❌ 处理未启动：没有可用的 API 模型组。请先在 设置→API 配置 添加模型。',
    )
  }
}

/**
 * Agent 通过 office_instruct 工具提交总监指令：挂起等待该联系人在微信侧
 * 批准/拒绝（与 /office instruct 共用确认流）。导出供工具调用。
 */
export function proposeOfficeInstruction(sessionId: string, text: string, targetSessionId?: string): string {
  const contactId = contactBySession.get(sessionId)
  if (!contactId) return '无法定位微信联系人（会话映射缺失），指令未提交'
  if (!text.trim()) return '指令内容为空，未提交'
  pendingOfficeInstruction = {
    instructionId: `oi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim(),
    sessionId: targetSessionId ?? '',
    contactId,
  }
  ack(contactId, `🔐 Agent 提议向总监下达指令：
${previewText(text, 120)}
回复「批准」执行，「拒绝」取消`)
  return '指令已提交给微信用户确认，等待批准/拒绝'
}

/** 本轮结束后依次处理 agent 级排队消息（startTurn 会再次兜底防并发）。 */
function drainQueue(): void {
  const next = agentQueue.shift()
  if (!next) return
  ack(next.contactId, '继续处理排队消息…')
  startTurn(next.sessionId, next.contactId, next.text)
}

async function onInbound(msg: WechatInboundEvent): Promise<void> {
  if (!channelEnabled() || IS_OFFICE) return
  const contactId = msg.replyTo || msg.from
  if (!contactId) return
  const text = (msg.text ?? '').trim()
  if (!text) return

  console.log(`[wechat-agent] inbound from ${contactId}: ${previewText(text, 80)}`)

  // 1) 工作区切换确认（同一联系人）
  if (pendingWorkspaceSwitch && pendingWorkspaceSwitch.contactId === contactId) {
    const pending = pendingWorkspaceSwitch
    if (YES_RE.test(text)) {
      pendingWorkspaceSwitch = null
      await applyWorkspace(contactId, pending.path)
    } else if (NO_RE.test(text)) {
      pendingWorkspaceSwitch = null
      ack(contactId, '已取消切换')
    } else {
      ack(contactId, '请回复「批准」切换或「拒绝」取消')
    }
    return
  }

  // 2) 总监指令确认（office_instruct 工具或 /office instruct 提交后）
  if (pendingOfficeInstruction && pendingOfficeInstruction.contactId === contactId) {
    const pending = pendingOfficeInstruction
    if (YES_RE.test(text)) {
      pendingOfficeInstruction = null
      const res = await window.electronAPI.sendOfficeInstruction({
        instructionId: pending.instructionId,
        sessionId: pending.sessionId,
        text: pending.text,
      })
      if (res.ok) {
        ack(contactId, res.status === 'started' ? '✅ 指令已转达，总监开始处理' : '✅ 指令已转达，公司正忙，已排队')
      } else {
        ack(contactId, `❌ 指令未送达：${res.message ?? '未知错误'}`)
      }
    } else if (NO_RE.test(text)) {
      pendingOfficeInstruction = null
      ack(contactId, '已取消指令')
    } else {
      ack(contactId, '请回复「批准」执行或「拒绝」取消')
    }
    return
  }

  // 3) /reset 二次确认
  if (pendingReset) {
    pendingReset = false
    if (text.toLowerCase() === '/reset confirm') {
      await doReset(contactId)
    }
    // 非确认输入按普通消息继续处理
  }

  // 3) 命令路由（确定性，不依赖配置/会话状态）
  if (await runCommand(contactId, text)) return

  // 4) 决策应答（审批应答有时效性，优先于任务排队）
  await waitForAgentState()
  const mapped = sessionByContact.get(contactId)
  if (mapped && answerPendingDecision(mapped, contactId, text)) return

  // 5) 新任务：等配置组就绪，避免用空配置组创建坏会话。
  await waitForConfigGroups()
  const sessionId = ensureSession(contactId)
  if (!sessionId) return

  if (useChatStore.getState().runningSessionIds.includes(sessionId) || wechatBusy()) {
    agentQueue.push({ contactId, sessionId, text })
    ack(contactId, '⏳ Agent 正在处理其他任务，这条已排队，完成后自动继续')
    return
  }
  ack(contactId, '已收到，开始处理…')
  startTurn(sessionId, contactId, text)
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
  const gen = runGen.get(sessionId) ?? 0
  const acc = filteredAcc.get(sessionId) ?? ''
  let sent = sentLen.get(sessionId) ?? 0
  for (;;) {
    // 发送期间新一轮已开始 → 立即停止，旧轮内容不再外发（防跨轮重复发送）。
    if ((runGen.get(sessionId) ?? 0) !== gen) return
    const chunk = nextSendChunk(acc, sent, force)
    if (!chunk) break
    const res = await useWechatStore.getState().sendText(contactId, chunk)
    if (!res.ok) break // 发送失败：保留未发部分，下轮重试
    sent += chunk.length
  }
  // 发送期间新一轮已开始（beginRun 重置了水位）→ 不写回旧轮的 sentLen。
  if ((runGen.get(sessionId) ?? 0) === gen) sentLen.set(sessionId, sent)
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
  const gen = runGen.get(sessionId) ?? 0
  const filter = filters.get(sessionId)
  if (filter) {
    const tail = filter.flush()
    if (tail) filteredAcc.set(sessionId, (filteredAcc.get(sessionId) ?? '') + tail)
  }
  await flushFor(contactId, sessionId, true)
  // 冲刷期间新一轮已开始 → 旧轮的「无输出兜底」交给新一轮，避免重复发送。
  if ((runGen.get(sessionId) ?? 0) !== gen) return
  // 本轮没有任何流式输出（agent 中途失败等）：把最后的助手消息（含错误卡）
  // 补发出去，避免微信侧只看到沉默。
  if ((sentLen.get(sessionId) ?? 0) === 0) {
    const state = useChatStore.getState()
    const lastAssistant = [...(state.sessions.find((s) => s.id === sessionId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant')
    if (lastAssistant?.content) {
      const f = new StreamingMarkdownFilter()
      const text = f.feed(lastAssistant.content) + f.flush()
      if (text.trim()) {
        filteredAcc.set(sessionId, text)
        await flushFor(contactId, sessionId, true)
      }
    }
  }
}

// ── 决策通知 ──────────────────────────────────────────────────────────────
/** 把本会话的后台决策（微信队列）转成微信选项消息；计划审批走会话字段。 */
function notifyDecisions(sessionId: string, contactId: string, state: ChatState): void {
  const wd = state.wechatDecisions
  const present = new Set<string>()
  let notice: string | null = null
  let kind: string | null = null

  if (wd.approval?.sessionId === sessionId) {
    kind = 'approval'
    notice = `🔐 微信 Agent 请求批准执行工具\n工具：${wd.approval.toolCall.name}\n${previewText(wd.approval.preview)}\n回复「批准」执行，「拒绝」取消`
  } else if (wd.batch?.sessionId === sessionId) {
    kind = 'batch'
    const names = wd.batch.tools.map((t) => t.name).join('、')
    notice = `🔐 批量批准（${wd.batch.tools.length} 项）：${previewText(names, 120)}\n回复「批准」全部执行，「拒绝」取消`
  } else if (wd.scope?.sessionId === sessionId) {
    kind = 'scope'
    notice = `🔐 作用域决策：${previewText(wd.scope.preview)}\n涉及：${previewText(wd.scope.paths.join('、'), 120)}\n回复「加入计划」/「切换模式」/「拒绝」`
  } else if (wd.question?.sessionId === sessionId) {
    kind = 'question'
    const q = wd.question
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
/** 会话加载完成后的首次 tick 做历史迁移（init 时 sessions 还没加载，扫不到）。 */
let migratedSessionModes = false

function handleChatTick(state: ChatState): void {
  if (!channelEnabled()) return
  if (!migratedSessionModes && state.sessions.length > 0) {
    migratedSessionModes = true
    for (const sessionId of sessionByContact.values()) {
      const s = state.sessions.find((x) => x.id === sessionId)
      if (s && s.mode !== 'wechat') useChatStore.getState().updateSessionMode(sessionId, 'wechat')
    }
  }
  const runningNow = new Set(state.runningSessionIds)
  for (const [contactId, sessionId] of sessionByContact) {
    notifyDecisions(sessionId, contactId, state)
    trackStreaming(sessionId, state)
    if (runningSnapshot.has(sessionId) && !runningNow.has(sessionId)) {
      // 本轮结束：先冲刷剩余输出，再处理 agent 级排队的下一条消息。
      // 串行执行，避免 flushComplete 的异步发送与新一轮的水位重置交错。
      void (async () => {
        await flushComplete(sessionId, contactId)
        drainQueue()
      })()
    }
  }
  runningSnapshot = runningNow
}

function handleGatewayEvent(ev: WechatGatewayEvent): void {
  if (ev.event === 'inbound') void onInbound(ev)
}

/** 应用启动时调用一次（App.tsx）。返回清理函数。 */
export function initWechatBridge(): () => void {
  if (initialized) return () => {}
  // 微信 Agent 只在对话窗口（main）运行；一人公司窗口不重复处理入站消息。
  if (IS_OFFICE) return () => {}
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
  // WeChat Agent 状态与微信会话（mode='wechat'）从主进程拉取；会话并入本窗口
  // 状态供 runAgentLoop 定位，但不显示在主界面列表。
  void useWechatStore.getState().loadAgentState()
  void (async () => {
    try {
      const list = await window.electronAPI.getSessions('wechat')
      useChatStore.getState().loadWechatSessions(list)
    } catch {
      // 拉取失败不阻塞桥接：下一次入站会重建会话映射
    }
  })()
  // 迁移：历史上以 mode='main' 创建的微信会话 → 'wechat'，隔离出主界面。
  for (const sessionId of sessionByContact.values()) {
    const s = useChatStore.getState().sessions.find((x) => x.id === sessionId)
    if (s && s.mode !== 'wechat') useChatStore.getState().updateSessionMode(sessionId, 'wechat')
  }

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
