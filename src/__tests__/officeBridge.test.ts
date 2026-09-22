import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SubAgentProgress } from '@shared/types'

/**
 * officeBridge 状态机回归测试。
 *
 * 覆盖「已完成子 Agent 复活」缺陷（releaseSlot 释放槽位后，chatStore 里的
 * 终态条目仍在——任何后续 store 变化都会被 diff 误判为「新启动任务」，
 * 重新占位 + 重放交接动画 + 永久卡在 receiving）。
 *
 * chatStore 以可控假对象模拟（getState 返回可变 state，subscribe 捕获
 * 监听器，测试手动触发）；时间用 fake timers 推进 release 与交接动画。
 */
const h = vi.hoisted(() => {
  const state: {
    sessions: Array<{ id: string; targetMode?: boolean; projectPath?: string }>
    subagentProgress: Record<string, SubAgentProgress>
    runPhaseBySession: Record<string, unknown>
  } = {
    sessions: [{ id: 's1', targetMode: true, projectPath: '/proj' }],
    subagentProgress: {},
    runPhaseBySession: {},
  }
  let listener: ((state: unknown) => void) | null = null
  return {
    state,
    setProgress: (p: Record<string, SubAgentProgress>) => {
      state.subagentProgress = p
    },
    trigger: () => listener?.(state),
    subscribe: (fn: (state: unknown) => void) => {
      listener = fn
      return () => {
        listener = null
      }
    },
  }
})

vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => h.state,
    subscribe: (fn: (state: unknown) => void) => h.subscribe(fn),
  },
}))

// officeBridge 用 window.setTimeout 做合并节流 / 交接动画 / 槽位释放，
// phaseCheckpoint（任务完成时调用）需要 electronAPI 在场（gitExec 缺失时
// 内部 catch 吞掉失败，不影响流程）。
vi.stubGlobal('window', {
  electronAPI: {},
  setTimeout: (fn: TimerHandler, ms?: number, ...args: unknown[]) =>
    globalThis.setTimeout(fn, ms, ...args),
  clearTimeout: (id?: number) => globalThis.clearTimeout(id),
})

import { attachOfficeBridge, detachOfficeBridge } from '@/services/office/officeBridge'
import type { OfficeDriver } from '@/services/office/officeBridge'

function makeDriver(): { driver: OfficeDriver; calls: string[] } {
  const calls: string[] = []
  const driver: OfficeDriver = {
    applyInit: (agents) => calls.push(`init:${agents.length}`),
    applyStatus: (id, status) => calls.push(`status:${id}:${status}`),
    applyTask: (id, _task, progress) => calls.push(`task:${id}:${progress}`),
    applyTransfer: (from, to) => calls.push(`transfer:${from}->${to}`),
    applyReset: () => calls.push('reset'),
  }
  return { driver, calls }
}

/** 一条 tm-developer 子任务（信封声明 to，槽位池 4/5/6 首个空闲 = 4 号）。 */
function makeProgress(over: Partial<SubAgentProgress> = {}): SubAgentProgress {
  return {
    status: 'running',
    sessionId: 's1',
    name: 'tm-developer',
    task: '---\nto: tm-developer\nfiles_to_modify: [src/a.ts]\n---\n实现待办列表',
    startedAt: 1000,
    thinking: '',
    steps: [],
    toolCallCount: 0,
    tokenCount: 0,
    ...over,
  }
}

let calls: string[] = []
let driver: OfficeDriver | null = null

beforeEach(() => {
  vi.useFakeTimers()
  h.state.sessions = [{ id: 's1', targetMode: true, projectPath: '/proj' }]
  h.state.subagentProgress = {}
  h.state.runPhaseBySession = {}
  const d = makeDriver()
  driver = d.driver
  calls = d.calls
  attachOfficeBridge(driver)
  calls.length = 0
})

afterEach(() => {
  detachOfficeBridge()
  driver = null
  calls = []
  vi.useRealTimers()
})

describe('officeBridge 子 Agent 生命周期', () => {
  it('running 任务正常进场景：交接 → 落桌 working → 完成 completed → 释放 idle', () => {
    // 带工具步骤的进度：落桌后 realStatus 为 working（无步骤时为 thinking）
    h.setProgress({
      keyA: makeProgress({
        steps: [{ id: 'st1', name: 'read_file', arguments: { path: 'src/a.ts' }, status: 'running' }],
      }),
    })
    h.trigger()

    // 启动：监管(1) → 4 号槽 交接 + receiving 姿态
    expect(calls).toContain('transfer:1->4')
    expect(calls).toContain('status:4:receiving')

    // 飞递落桌（RECEIVE_POSE_MS=1500）→ working；期间合并队列 flush 任务文本
    vi.advanceTimersByTime(2000)
    expect(calls).toContain('status:4:working')
    expect(calls).toContain('task:4:25')

    // 完成：completed + 交回监管 + 释放槽位（COMPLETED_HOLD_MS=3000）
    calls.length = 0
    h.setProgress({ keyA: makeProgress({ status: 'done', toolCallCount: 3 }) })
    h.trigger()
    expect(calls).toContain('status:4:completed')
    expect(calls).toContain('transfer:4->1')

    vi.advanceTimersByTime(3000)
    expect(calls).toContain('status:4:idle')
  })

  it('已完成任务释放后不会被后续 store 变化“复活”成 receiving 僵尸', () => {
    // 跑完一个完整生命周期（done → 释放）
    h.setProgress({ keyA: makeProgress() })
    h.trigger()
    vi.advanceTimersByTime(2000)
    h.setProgress({ keyA: makeProgress({ status: 'done', toolCallCount: 3 }) })
    h.trigger()
    vi.advanceTimersByTime(3000)
    expect(calls).toContain('status:4:idle')

    // 释放后任意一次 store 变化（其他任务进度推送 / runPhase 更新等）——
    // 终态条目仍在 chatStore 里，diff 曾把它误判为新任务重新占位。
    calls.length = 0
    h.trigger()
    expect(calls).toEqual([])
  })

  it('attach 时已存在的终态任务不进入场景', () => {
    detachOfficeBridge()
    h.setProgress({
      keyA: makeProgress({ status: 'done' }),
      keyB: makeProgress({
        status: 'error',
        name: 'tm-tester',
        task: '---\nto: tm-tester\n---\n执行测试',
        startedAt: 2000,
      }),
    })
    const d = makeDriver()
    driver = d.driver
    calls = d.calls
    attachOfficeBridge(driver)

    // 只有初始快照 init：终态条目不得触发交接/接收姿态
    expect(calls).toEqual(['init:8'])
  })

  it('attach 时运行中的任务仍正常进场景', () => {
    detachOfficeBridge()
    h.setProgress({ keyA: makeProgress() })
    const d = makeDriver()
    driver = d.driver
    calls = d.calls
    attachOfficeBridge(driver)

    expect(calls).toContain('transfer:1->4')
    expect(calls).toContain('status:4:receiving')
  })
})
