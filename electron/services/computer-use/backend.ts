/**
 * Computer Use — backend contract.
 *
 * A backend is whatever can answer the CUA protocol methods: the Windows
 * PowerShell helper today, a native helper later, or the deterministic fake
 * desktop used by unit tests and by non-Windows dev machines.
 *
 * Backends know nothing about approval, states, frames or leasing — that is the
 * service's job. They only translate one method call into one platform action.
 */
import type { CuaBackendId, CuaPermissionStatus } from '../../../shared/computer'

export interface CuaProbeResult {
  protocol: string
  platform: string
  capabilities: string[]
  permission?: CuaPermissionStatus
}

export interface CuaBackend {
  readonly id: CuaBackendId
  /** Handshake + capability probe. Called once per helper start. */
  probe(): Promise<CuaProbeResult>
  /** One protocol method. Rejections must carry a CuaErrorInfo-shaped payload. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  shutdown(): Promise<void>
}

/** Methods classified for timeout purposes (writes never get a soft timeout). */
export const CUA_READ_METHODS = new Set([
  'broker_info',
  'permission_status',
  'list_apps',
  'capture_app',
  'element_at_point',
  'screenshot',
  'controller_status',
])

/** Anything that synthesizes input or can change application state. */
export const CUA_WRITE_METHODS = new Set([
  'click',
  'type_text',
  'press_key',
  'hold_key',
  'set_value',
  'scroll',
  'drag',
  'paste',
  'element_perform_action',
  'select_text',
  'activate_window',
  'launch_app',
])

export function isWriteMethod(method: string): boolean {
  return CUA_WRITE_METHODS.has(method)
}
