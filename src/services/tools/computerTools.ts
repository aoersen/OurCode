/**
 * Tool helpers for Computer Use (desktop app control).
 *
 * The renderer side of `computer_*`: turn tool arguments into IPC requests, and
 * turn structured results back into text the model can act on. All policy
 * enforcement lives in the main process — this layer only explains it.
 */
import { getActiveToolContext } from './ToolExecutor'
import type { ToolImageResult } from './types'
import { parseImageDataUrl } from '@/utils/imageAttach'
import {
  renderStateText,
  retryHint,
  type AppRef,
  type CuaActionKind,
  type CuaActionResult,
  type CuaErrorInfo,
  type CuaRunStepsResult,
  type CuaRunStep,
  type CuaState,
  type CuaStatus,
} from '@shared/computer'

function owner(): string {
  return getActiveToolContext()?.sessionId || 'default'
}

/** `记事本` / `pid:1234` / `window:5678` → AppRef. */
export function appRefFrom(input: unknown): AppRef {
  const raw = String(input ?? '').trim()
  const pid = /^pid:(\d+)$/i.exec(raw)
  if (pid) return { pid: Number(pid[1]) }
  const windowId = /^window:(\d+)$/i.exec(raw)
  if (windowId) return { windowId: Number(windowId[1]) }
  return { name: raw }
}

export function formatCuaError(error?: CuaErrorInfo): string {
  if (!error) return 'Error: 未知错误'
  const lines = [`Error: [${error.code}] ${error.message}`]
  const flags = [`retry=${error.retry}`]
  if (error.actionSent) flags.push('action_sent=true（动作可能已下发：先重新观察，不要盲目重放）')
  lines.push(flags.join(' · '))
  if ((error.details as Record<string, unknown> | undefined)?.requiresConfirm) {
    lines.push('该动作被判定为高危。仅在用户明确同意后，再带上 confirm=true 重试。')
  }
  lines.push(`hint: ${retryHint(error.code)}`)
  return lines.join('\n')
}

function formatState(state: CuaState | undefined): string {
  if (!state) return ''
  return renderStateText(state)
}

export async function computerStatusTool(): Promise<string> {
  const res = await window.electronAPI.computerStatus()
  if (!res.ok || !res.status) return formatCuaError(res.error)
  return formatStatus(res.status)
}

export function formatStatus(status: CuaStatus): string {
  const lines = [
    `电脑操控：${status.enabled ? '已开启' : '未开启'}`,
    `运行时：${status.available ? `就绪（${status.backend} / ${status.protocol ?? '?'}）` : `未就绪（${status.lastError ?? '未启动'}）`}`,
    `平台：${status.platform} · 能力：${status.capabilities.join(', ') || '(无)'}`,
  ]
  if (status.permission) {
    const p = status.permission
    lines.push(
      `会话：${p.interactiveSession ? '交互式桌面' : '非交互式（不可用）'} · DPI：${p.dpiAware ? 'v2' : '未感知'} · 截屏：${p.screenCapture ? '可用' : '不可用'}`,
    )
  }
  if (status.stopped) lines.push('状态：已急停（需要用户再发一句话才继续）')
  if (status.controller) lines.push(`控制权：${status.controller}`)
  return lines.join('\n')
}

export async function computerListAppsTool(): Promise<string> {
  const res = await window.electronAPI.computerListApps(owner())
  if (!res.ok) return formatCuaError(res.error)
  if (!res.apps.length) {
    return `没有可操作的应用窗口${res.blocked ? `（另有 ${res.blocked} 个敏感应用被策略屏蔽）` : ''}。`
  }
  const lines = res.apps.map((app) => {
    const flags = [app.minimized ? '最小化' : '', app.visible === false ? '不可见' : ''].filter(Boolean).join('/')
    return `- ${app.name}（pid ${app.pid}${app.windowId ? `, window ${app.windowId}` : ''}）${app.title ? ` — ${app.title}` : ''}${flags ? ` [${flags}]` : ''}`
  })
  if (res.blocked) lines.push(`（另有 ${res.blocked} 个敏感应用被策略屏蔽，不能观察或操作）`)
  return lines.join('\n')
}

export async function computerGetStateTool(args: Record<string, any>): Promise<string | ToolImageResult> {
  const req = {
    owner: owner(),
    app: appRefFrom(args.app),
    includeScreenshot: false,
    maxNodes: typeof args.max_nodes === 'number' ? args.max_nodes : undefined,
    disableDiffing: args.disable_diffing === true,
  }
  const res = await window.electronAPI.computerGetState(req)
  if (!res.ok || !res.state) return formatCuaError(res.error)
  const text = formatState(res.state)
  if (args.include_screenshot !== true) return text
  const shot = await window.electronAPI.computerScreenshot({ owner: owner(), app: req.app })
  if (!shot.ok || !shot.dataUrl) {
    return `${text}\n\n（截图失败：${shot.error?.message ?? '未知原因'}）`
  }
  return {
    text: `${text}\n\n截图已附上（frame ${shot.frame?.frameId ?? '?'}）。坐标点击必须使用这个 frame 的 screenshot_id。`,
    images: [parseImageDataUrl(shot.dataUrl, shot.mimeType || 'image/png')],
  }
}

export async function computerScreenshotTool(args: Record<string, any>): Promise<string | ToolImageResult> {
  const req = {
    owner: owner(),
    app: args.app ? appRefFrom(args.app) : undefined,
    screen: args.screen === true,
    windowId: typeof args.window_id === 'number' ? args.window_id : undefined,
  }
  const res = await window.electronAPI.computerScreenshot(req)
  if (!res.ok || !res.dataUrl) return formatCuaError(res.error)
  const frame = res.frame
  return {
    text: `截图已附上${frame ? `：${frame.width}×${frame.height}，frame=${frame.frameId}（坐标点击时必须带这个 screenshot_id）` : ''}。`,
    images: [parseImageDataUrl(res.dataUrl, res.mimeType || 'image/png')],
  }
}

/** Map tool arguments (snake_case) onto the IPC action request. */
export function actionRequestFrom(kind: CuaActionKind, args: Record<string, any>) {
  const request: Record<string, unknown> = {
    owner: owner(),
    app: appRefFrom(args.app),
    kind,
  }
  if (typeof args.element_index === 'number') request.elementIndex = args.element_index
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    request.x = args.x
    request.y = args.y
  }
  if (typeof args.screenshot_id === 'string') request.screenshotId = args.screenshot_id
  if (args.button) request.button = args.button
  if (args.count) request.count = args.count
  if (args.strategy) request.strategy = args.strategy
  if (typeof args.text === 'string') request.text = args.text
  if (typeof args.value === 'string') request.value = args.value
  if (typeof args.keys === 'string') request.keys = args.keys
  if (typeof args.action_name === 'string') request.action = args.action_name
  if (args.direction) request.direction = args.direction
  if (typeof args.amount === 'number') request.amount = args.amount
  if (args.from && args.to) {
    request.from = args.from
    request.to = args.to
  }
  if (typeof args.target === 'string') request.target = args.target
  if (typeof args.path === 'string') request.path = args.path
  if (args.confirm === true) request.confirm = true
  return request as any
}

export function formatActionResult(result: CuaActionResult): string {
  const head = result.ok
    ? `[${result.kind}] ok · ${result.target ? `${result.target} · ` : ''}action_sent=true · effect_evidence=${result.effectEvidence}`
    : `[${result.kind}] failed`
  const parts = [head]
  if (!result.ok) parts.push(formatCuaError(result.error))
  if (result.effectEvidence === 'unchanged' && result.ok) {
    parts.push('hint: 动作已下发但界面没有变化（应用可能忽略合成事件）。改用元素 action 或 keyboard，不要连点。')
  }
  const state = formatState(result.state)
  if (state) parts.push(state)
  return parts.join('\n')
}

export async function computerActionTool(kind: CuaActionKind, args: Record<string, any>): Promise<string> {
  const result = await window.electronAPI.computerAction(actionRequestFrom(kind, args))
  return formatActionResult(result)
}

export function runStepsFrom(args: Record<string, any>): { steps: CuaRunStep[]; postActionSleepMs?: number; finalState?: boolean } {
  const raw = Array.isArray(args.steps) ? args.steps : []
  const steps: CuaRunStep[] = raw.slice(0, 20).map((step: any) => ({
    kind: String(step?.kind ?? step?.tool ?? 'click') as CuaActionKind,
    args: actionRequestFrom(String(step?.kind ?? step?.tool ?? 'click') as CuaActionKind, { app: args.app, ...(step?.args ?? {}) }),
  }))
  return {
    steps,
    postActionSleepMs: typeof args.post_action_sleep_ms === 'number' ? args.post_action_sleep_ms : undefined,
    finalState: args.final_state === true,
  }
}

export function formatRunSteps(result: CuaRunStepsResult): string {
  const head = result.ok
    ? `[run_steps] 完成 ${result.completed}/${result.total} 步`
    : `[run_steps] 在第 ${(result.failedStep ?? 0) + 1} 步失败（已完成 ${result.completed}/${result.total}）`
  const steps = result.steps.map((step) => {
    const mark = step.ok ? '✓' : '✗'
    const evidence = step.effectEvidence ? ` (${step.effectEvidence})` : ''
    return `${mark} #${step.step + 1} ${step.kind}${step.target ? ` ${step.target}` : ''}${evidence}${step.ok ? '' : ` — ${step.error?.code ?? 'ERROR'}`}`
  })
  const parts = [head, ...steps]
  if (!result.ok) parts.push(formatCuaError(result.error))
  const state = formatState(result.state)
  if (state) parts.push(state)
  return parts.join('\n')
}

export async function computerRunStepsTool(args: Record<string, any>): Promise<string> {
  const built = runStepsFrom(args)
  const result = await window.electronAPI.computerRunSteps({
    owner: owner(),
    steps: built.steps,
    postActionSleepMs: built.postActionSleepMs,
    finalState: built.finalState,
  })
  return formatRunSteps(result)
}

export async function computerStopTool(): Promise<string> {
  await window.electronAPI.computerStop(owner())
  return '已急停：后续桌面动作会被拒绝，直到用户再次发消息确认。'
}
