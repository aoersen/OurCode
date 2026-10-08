/**
 * 一人公司窗口 × 微信 Agent：观察与干预的中继（office 渲染层）。
 *
 * 观察：把公司运行状态（公司列表/运行相位、员工工位、近期子智能体活动）
 * 打成紧凑快照，节流推给主进程缓存（微信侧经 wechat:getOfficeSnapshot 读取）。
 * 干预：接收主进程路由来的微信指令（OfficeInstructionRequest），校验目标
 * 公司（总监会话）后以 sendMessage 注入——等同用户在办公室右下角发消息，
 * 公司自身的排队/审批/派发语义完全不变；结果经回执原路返回微信侧。
 *
 * 只在 office 窗口初始化（App.tsx 按 IS_OFFICE 调用）。
 */
import { useChatStore } from '@/stores/chatStore'
import type { OfficeActivitySnapshot, OfficeInstructionRequest, OfficeInstructionResult, OfficeSnapshot } from '@/types'

const SNAPSHOT_PUSH_DELAY_MS = 800 // 变更后节流推送间隔

/** 组装公司运行状态快照（纯函数，导出供单元测试）。 */
export function buildOfficeSnapshot(): OfficeSnapshot {
  const st = useChatStore.getState()
  const companies = st.sessions
    .filter((s) => !s.workerRole && !s.hidden)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => ({
      sessionId: s.id,
      title: s.title,
      projectPath: s.projectPath || '',
      running: st.runningSessionIds.includes(s.id),
      phase: st.runPhaseBySession[s.id]?.phase ?? null,
    }))
  const workers = st.sessions
    .filter((s) => s.workerRole && s.workerSlot)
    .map((s) => {
      const lastInbound = [...s.messages].reverse().find((m) => m.role === 'user')
      const task = lastInbound
        ? lastInbound.content.replace(/^\[来自会话「.+?」的会话间消息\]\n\n?/, '').slice(0, 80)
        : '待命中 · 等待总监派发'
      return {
        sessionId: s.id,
        role: s.workerRole ?? '',
        slot: s.workerSlot ?? 0,
        running: st.runningSessionIds.includes(s.id),
        task,
      }
    })
  const activities: OfficeActivitySnapshot[] = Object.values(st.subagentProgress)
    .map((p) => ({
      label: p.name,
      task: p.task.slice(0, 80),
      status: p.status === 'running' ? ('running' as const) : p.status === 'done' ? ('done' as const) : ('failed' as const),
      startedAt: p.startedAt,
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
  return { companies, workers, recentActivity: activities, updatedAt: Date.now() }
}

/** 解析指令目标公司：显式 sessionId → 唯一运行中的公司 → 最近更新的公司。 */
function resolveTargetCompany(req: OfficeInstructionRequest): ReturnType<typeof useChatStore.getState>['sessions'][number] | undefined {
  const st = useChatStore.getState()
  const candidates = st.sessions.filter((s) => !s.workerRole && !s.hidden)
  if (req.sessionId) {
    const byId = candidates.find((s) => s.id === req.sessionId)
    if (byId) return byId
  }
  const running = candidates.filter((s) => st.runningSessionIds.includes(s.id))
  return running[0] ?? candidates[0]
}

function handleInstruction(req: OfficeInstructionRequest): void {
  const st = useChatStore.getState()
  const result: OfficeInstructionResult = { instructionId: req.instructionId, ok: false }
  const target = resolveTargetCompany(req)
  if (!target) {
    result.status = 'failed'
    result.message = '办公室没有可用的公司会话'
    window.electronAPI.replyOfficeWechatInstruction(result)
    return
  }
  const wasRunning = st.runningSessionIds.includes(target.id)
  void st.sendMessage(target.id, req.text)
  const nowRunning = useChatStore.getState().runningSessionIds.includes(target.id)
  if (nowRunning) {
    result.ok = true
    result.status = wasRunning ? 'queued' : 'started'
  } else if (wasRunning) {
    // 极窄竞态（run 恰在注入瞬间结束）：已由 chatStore 队列消费，视为已排队。
    result.ok = true
    result.status = 'queued'
  } else {
    result.status = 'failed'
    result.message = '总监未启动处理（请检查办公室的 API 配置组）'
  }
  window.electronAPI.replyOfficeWechatInstruction(result)
}

let initialized = false
let unsubscribe: (() => void) | null = null
let offInstruction: (() => void) | null = null
let lastDigest = ''
let pendingSnapshot: OfficeSnapshot | null = null
let pushTimer: number | null = null

function handleStoreChange(): void {
  const snap = buildOfficeSnapshot()
  // 只按「状态变化」推送：标题/进度文本抖动不触发，避免高频刷主进程。
  const digest = JSON.stringify([
    snap.companies.map((c) => `${c.sessionId}:${c.running ? 1 : 0}:${c.phase ?? ''}`),
    snap.workers.map((w) => `${w.sessionId}:${w.running ? 1 : 0}`),
    snap.recentActivity.map((a) => `${a.label}:${a.status}`),
  ])
  if (digest === lastDigest) return
  lastDigest = digest
  pendingSnapshot = snap
  if (pushTimer == null) {
    pushTimer = window.setTimeout(() => {
      pushTimer = null
      if (pendingSnapshot) {
        try {
          window.electronAPI.pushOfficeStatus(pendingSnapshot)
        } catch {
          // 窗口销毁竞态：忽略
        }
      }
      pendingSnapshot = null
    }, SNAPSHOT_PUSH_DELAY_MS)
  }
}

/** office 窗口启动时调用一次（App.tsx）。返回清理函数。 */
export function initOfficeWechatRelay(): () => void {
  if (initialized) return () => {}
  initialized = true

  unsubscribe = useChatStore.subscribe(handleStoreChange)
  // 初始推送：窗口刚打开时主进程缓存是空的，先立即可用。
  handleStoreChange()
  offInstruction = window.electronAPI.onOfficeWechatInstruction(handleInstruction)

  return () => {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    if (offInstruction) {
      offInstruction()
      offInstruction = null
    }
    if (pushTimer != null) {
      window.clearTimeout(pushTimer)
      pushTimer = null
    }
    initialized = false
  }
}
