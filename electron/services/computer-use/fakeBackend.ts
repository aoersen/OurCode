/**
 * Computer Use — deterministic fake backend.
 *
 * Why it exists: every non-Windows dev machine, CI job and unit test needs the
 * full pipeline (observe → act → settle → state) without a real desktop. The
 * fake exposes one classic Win32-ish app and one file-explorer-ish app, with the
 * same method surface the PowerShell helper implements.
 *
 * It is intentionally NOT a simulator of every edge case: policy, leases and
 * frames are exercised by the service tests, not here.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CuaAppInfo, CuaElementInfo, CuaPermissionStatus, CuaStateMode, CuaWindowInfo } from '../../../shared/computer'
import type { CuaBackend, CuaProbeResult } from './backend'

/** What every capture method returns on the wire. */
export interface CuaCaptureResponse {
  app: { pid: number; name: string; aumid?: string }
  window: CuaWindowInfo
  elements: CuaElementInfo[]
  nodeCount?: number
  truncated?: boolean
  /** Screenshot landing path when the caller asked for one. */
  image?: { path: string; width: number; height: number; scale: number }
}

/** 1×1 transparent PNG — enough for the screenshot path to be exercised. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

interface FakeApp {
  pid: number
  windowId: number
  name: string
  title: string
  document: string
  kind: 'notepad' | 'explorer'
}

export class FakeCuaBackend implements CuaBackend {
  readonly id = 'fake' as const
  private apps: FakeApp[] = [
    { pid: 4242, windowId: 5150, name: '记事本', title: '无标题 - 记事本', document: '', kind: 'notepad' },
    { pid: 5252, windowId: 6161, name: '文件资源管理器', title: '文档 - 文件资源管理器', document: '', kind: 'explorer' },
  ]
  private frameSeq = 0
  private stopped = false

  constructor(private readonly frameDir: string) {}

  async probe(): Promise<CuaProbeResult> {
    const permission: CuaPermissionStatus = {
      interactiveSession: true,
      dpiAware: true,
      screenCapture: true,
      accessibility: 'not_required',
      screenRecording: 'not_required',
    }
    return { protocol: 'cua-ips/1', platform: process.platform, capabilities: ['uia', 'sendinput', 'gdi', 'clipboard', 'fake'], permission }
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const result = await this.dispatch(method, params)
    return result as T
  }

  async shutdown(): Promise<void> {
    this.stopped = true
  }

  private app(ref: Record<string, unknown> | undefined): FakeApp {
    if (this.stopped) throw { code: 'RUNTIME_NOT_READY', message: 'fake backend stopped' }
    const name = String(ref?.name ?? '')
    const pid = Number(ref?.pid ?? 0)
    const windowId = Number(ref?.windowId ?? 0)
    const found = this.apps.find(
      (a) =>
        (pid && a.pid === pid) ||
        (windowId && a.windowId === windowId) ||
        (name && (a.name.includes(name) || a.title.includes(name))),
    )
    if (!found) throw { code: 'WINDOW_NOT_FOUND', message: `找不到应用/窗口：${name || pid || windowId || '(未指定)'}` }
    return found
  }

  private elementsOf(app: FakeApp): CuaElementInfo[] {
    const win: CuaElementInfo = {
      index: 0,
      role: 'window',
      name: app.title,
      enabled: true,
      actions: [],
      bounds: [0, 0, 1280, 800],
    }
    if (app.kind === 'notepad') {
      return [
        win,
        { index: 1, role: 'menubar', enabled: true, actions: [], bounds: [0, 0, 1280, 24] },
        { index: 2, role: 'menuitem', name: '文件', enabled: true, actions: ['press'], bounds: [0, 0, 40, 24] },
        { index: 3, role: 'document', name: '文本编辑器', value: app.document, enabled: true, actions: ['set_value', 'select_text'], bounds: [8, 32, 1264, 720] },
        { index: 4, role: 'button', name: '保存', enabled: true, actions: ['press'], bounds: [1180, 760, 80, 28] },
      ]
    }
    return [
      win,
      { index: 1, role: 'pane', name: '导航窗格', enabled: true, actions: [], bounds: [0, 32, 240, 700] },
      { index: 2, role: 'list', name: '项目视图', enabled: true, actions: [], bounds: [240, 32, 1000, 700] },
      { index: 3, role: 'edit', name: '地址栏', value: 'C:\\Users', enabled: true, actions: ['set_value'], bounds: [240, 0, 900, 28] },
      { index: 4, role: 'button', name: '删除', enabled: true, actions: ['press'], bounds: [1180, 64, 60, 28] },
    ]
  }

  private windowOf(app: FakeApp, elements: CuaElementInfo[]): CuaWindowInfo {
    const bounds = elements[0]?.bounds ?? [0, 0, 1280, 800]
    return {
      windowId: app.windowId,
      title: app.title,
      className: app.kind === 'notepad' ? 'Notepad' : 'CabinetWClass',
      main: true,
      focused: true,
      visible: true,
      minimized: false,
      bounds,
    }
  }

  private requireElement(app: FakeApp, index: unknown): CuaElementInfo {
    const parsed = Number(index)
    const el = this.elementsOf(app).find((e) => e.index === parsed)
    if (!el) throw { code: 'TARGET_STALE', message: `元素索引 ${String(index)} 不属于该应用的最新观察` }
    return el
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'broker_info':
        return this.probe()
      case 'permission_status':
        return (await this.probe()).permission
      case 'list_apps':
        return {
          apps: this.apps.map<CuaAppInfo>((a) => ({
            pid: a.pid,
            name: a.name,
            windowId: a.windowId,
            title: a.title,
            visible: true,
            minimized: false,
            bounds: [0, 0, 1280, 800],
          })),
        }
      case 'capture_app': {
        const app = this.app(params.app as Record<string, unknown> | undefined)
        const elements = this.elementsOf(app)
        const out: CuaCaptureResponse = {
          app: { pid: app.pid, name: app.name },
          window: this.windowOf(app, elements),
          elements,
          nodeCount: elements.length,
          truncated: false,
        }
        if (params.includeScreenshot === true) {
          const image = this.writeFrame()
          out.image = { path: image.path, width: 1, height: 1, scale: 1 }
        }
        return out
      }
      case 'screenshot': {
        const image = this.writeFrame()
        return { path: image.path, width: 1, height: 1, scale: 1 }
      }
      case 'set_value': {
        const app = this.app(params.app as Record<string, unknown> | undefined)
        const el = this.requireElement(app, params.elementIndex)
        if (!el.actions.includes('set_value')) throw { code: 'NOT_SETTABLE', message: `元素 [${el.index}] 不可赋值` }
        app.document = String(params.value ?? '')
        return { ok: true }
      }
      case 'type_text': {
        const app = this.app(params.app as Record<string, unknown> | undefined)
        app.document = `${app.document}${String(params.text ?? '')}`
        return { ok: true }
      }
      case 'press_key':
      case 'click':
      case 'scroll':
      case 'drag':
      case 'paste':
      case 'element_perform_action':
      case 'select_text':
      case 'activate_window':
        if (params.app) this.app(params.app as Record<string, unknown>)
        return { ok: true }
      case 'launch_app':
        return { app: { pid: 4242, name: '记事本', windowId: 5150, title: '无标题 - 记事本' } }
      case 'controller_stop':
        return { ok: true }
      default:
        throw { code: 'UNSUPPORTED', message: `fake backend 不支持方法 ${method}` }
    }
  }

  private writeFrame(): { path: string } {
    mkdirSync(this.frameDir, { recursive: true })
    const path = join(this.frameDir, `frame-${++this.frameSeq}.png`)
    writeFileSync(path, TINY_PNG)
    return { path }
  }
}

export type { CuaStateMode }
