import { IS_OFFICE } from '@/utils/windowMode'

/**
 * 会话栏的两种模式（左上角「会话 / 文件」）。
 *
 * 这是纯 UI 偏好，不进 uiStore：
 *  - 会话模式 = 项目 → 对话两级（railModel 那套）；
 *  - 文件模式 = 当前项目根的文件树（见 FileTreeRail）。
 *
 * 持久化按窗口隔离（办公室窗口与对话窗口互不干扰），key 前缀固定
 * `ourcode.shell.rail.` —— 与项目其它偏好（`modeKey`）同一套约定，
 * 只是这一栏自己收口，store 里不再多一个字段。
 */

export type RailMode = 'sessions' | 'files'

export const RAIL_STORAGE_PREFIX = 'ourcode.shell.rail.'

/** 按窗口模式拼一个持久化 key（办公室窗口带 `:office` 后缀）。 */
export function railStorageKey(name: string, office: boolean = IS_OFFICE): string {
  return `${RAIL_STORAGE_PREFIX}${name}${office ? ':office' : ''}`
}

/** localStorage 里的原始值 → 模式（非法值一律退回「会话」）。 */
export function parseRailMode(raw: unknown): RailMode {
  return raw === 'files' ? 'files' : 'sessions'
}

/** 读本窗口上次的模式；默认会话。localStorage 不可用时同样默认会话。 */
export function readRailMode(): RailMode {
  try {
    return parseRailMode(localStorage.getItem(railStorageKey('mode')))
  } catch {
    return 'sessions'
  }
}

export function writeRailMode(mode: RailMode): void {
  try {
    localStorage.setItem(railStorageKey('mode'), mode)
  } catch {
    /* 隐私模式 / 存储写满：模式只在本次会话内生效 */
  }
}

/** 「显示隐藏文件」是文件模式自己的视图开关，也按窗口记住。 */
export function readShowHiddenFiles(): boolean {
  try {
    return localStorage.getItem(railStorageKey('showHidden')) === 'true'
  } catch {
    return false
  }
}

export function writeShowHiddenFiles(show: boolean): void {
  try {
    localStorage.setItem(railStorageKey('showHidden'), show ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

/**
 * 会话栏的状态筛选（全部 / 进行中 / 异常 / 结束）。
 * 同样是纯 UI 偏好：不进 store，按窗口记住，非法值一律退回「全部」。
 */
export type RailStateFilterId = 'all' | 'active' | 'error' | 'done'

export function parseStateFilter(raw: unknown): RailStateFilterId {
  return raw === 'active' || raw === 'error' || raw === 'done' ? raw : 'all'
}

export function readRailStateFilter(): RailStateFilterId {
  try {
    return parseStateFilter(localStorage.getItem(railStorageKey('stateFilter')))
  } catch {
    return 'all'
  }
}

export function writeRailStateFilter(filter: RailStateFilterId): void {
  try {
    localStorage.setItem(railStorageKey('stateFilter'), filter)
  } catch {
    /* ignore */
  }
}
