import { create } from 'zustand'
import {
  DEFAULT_NO_LIMITS_CONFIG,
  normalizeNoLimitsConfig,
  sanitizePromptText,
  type NoLimitsConfig,
  type NoLimitsLayer,
  type NoLimitsPresetId,
} from '@/services/noLimits/policy'
import { getPresetText } from '@/services/noLimits/presets'

/**
 * no-limits（无限制模式）状态 —— 从 dsh-purge 接进来的破甲能力开关。
 *
 * 硬要求：**默认不开启**。出厂 `DEFAULT_NO_LIMITS_CONFIG.enabled === false`，
 * 读取存储时任何字段坏掉都回落到默认值，所以「没显式开过」一定是关闭态。
 *
 * 持久化用 localStorage（与 configStore / shortcutStore 一致，走渲染进程），
 * 不落 electron-store：这是纯前端行为开关，不涉及密钥或跨窗口状态。
 */

export const NO_LIMITS_STORAGE_KEY = 'ourcode.noLimits.v1'

export interface NoLimitsState {
  config: NoLimitsConfig
  /** 总开关。关闭后三层一起失效，不修改各层已勾选值（下次打开沿用）。 */
  setEnabled: (enabled: boolean) => void
  /** 单层开关。 */
  setLayer: (layer: NoLimitsLayer, on: boolean) => void
  /** 提示词预设（dsh-purge 原版 / 自定义）。 */
  setPreset: (id: NoLimitsPresetId) => void
  /** 自定义提示词正文（自动去聊天模板标记 + 截断）。 */
  setCustomPrompt: (text: string) => void
  /** 整个 no-limits 回到出厂状态（关闭）。 */
  reset: () => void
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 从 localStorage 读配置；读不到 / 坏掉一律返回默认（关闭）。 */
export function loadNoLimitsConfig(): NoLimitsConfig {
  const s = storage()
  if (!s) return { ...DEFAULT_NO_LIMITS_CONFIG }
  try {
    const raw = s.getItem(NO_LIMITS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_NO_LIMITS_CONFIG }
    return normalizeNoLimitsConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_NO_LIMITS_CONFIG }
  }
}

function persist(config: NoLimitsConfig): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(NO_LIMITS_STORAGE_KEY, JSON.stringify(config))
  } catch {
    /* 存储满 / 被禁用：功能照常在本进程内生效，只是重启后回默认 */
  }
}

export const useNoLimitsStore = create<NoLimitsState>((set, get) => ({
  config: loadNoLimitsConfig(),

  setEnabled: (enabled) => {
    const config: NoLimitsConfig = { ...get().config, enabled }
    persist(config)
    set({ config })
  },

  setLayer: (layer, on) => {
    const config: NoLimitsConfig = { ...get().config, [layer]: on }
    persist(config)
    set({ config })
  },

  setPreset: (id) => {
    const config: NoLimitsConfig = { ...get().config, presetId: id }
    persist(config)
    set({ config })
  },

  setCustomPrompt: (text) => {
    const config: NoLimitsConfig = { ...get().config, customPrompt: sanitizePromptText(text) }
    persist(config)
    set({ config })
  },

  reset: () => {
    const config: NoLimitsConfig = { ...DEFAULT_NO_LIMITS_CONFIG }
    persist(config)
    set({ config })
  },
}))

/** 给非 React 调用方（chatStore / 命令）用的实时快照。 */
export function readNoLimitsConfig(): NoLimitsConfig {
  return useNoLimitsStore.getState().config
}

/**
 * 该配置实际使用的提示词正文：
 * - 任一内置预设（dsh-purge-zh / keyijiang-zh）→ presets 层对应正文
 * - presetId === 'custom'                      → 用户正文
 * 返回值未净化，交给 policy.composeNoLimitsPrompt 统一处理。
 */
export function getNoLimitsPresetText(config: NoLimitsConfig): string {
  return config.presetId === 'custom' ? config.customPrompt : getPresetText(config.presetId)
}

/** 命令面板 / 快捷键入口：总开关取反（保持三层已勾选值）。 */
export function toggleNoLimits(): boolean {
  const next = !readNoLimitsConfig().enabled
  useNoLimitsStore.getState().setEnabled(next)
  return next
}
