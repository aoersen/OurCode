import { useCallback } from 'react'

import type { ClawChannelId } from '@shared/types'
import { useUIStore } from '@/stores/uiStore'

/**
 * 「去设置」：打开设置面板并把 Claw 区定位到指定渠道。
 *
 * Claw 的渠道凭据与接入控制都在 设置 → 功能 → Claw 渠道接入 里，而面板卡片只是
 * 概览。以前点提示没有任何去处，用户得自己翻三层；这里把「跳到哪里」固定下来，
 * 面板上所有「缺凭据 / 连不上」的提示都走这一个入口。
 *
 * 用 store 里的 settingsTarget 传递目标：设置弹层与 Claw 面板不在同一棵组件树里，
 * 而且弹层可能已经打开着（这时只需要切 tab/渠道）。
 */
export function useChannelSettingsJump(): (id: ClawChannelId) => void {
  const openSettings = useUIStore((s) => s.openSettings)
  return useCallback((id: ClawChannelId) => openSettings({ tab: 'features', clawChannel: id }), [openSettings])
}
