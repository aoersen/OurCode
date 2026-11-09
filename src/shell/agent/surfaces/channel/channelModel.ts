/**
 * 「渠道」面的视图模型（纯函数）。
 *
 * 事实来源：clawStore（hub.channels 是主进程推来的运行状态，configs 是每渠道
 * 的连接配置与启停）+ shared/claw 的渠道目录。
 *
 * 诚实边界：clawStore 里**没有**「最后一条消息时间」，也没有渠道日志接口，所以
 * 这两处一律渲染成灰色的「未接入」，不编造时间与假按钮。
 */
import { CLAW_CHANNELS } from '@shared/claw'
import type { ClawChannelConfig, ClawChannelId, ClawChannelState, ClawChannelStatus } from '@/types'
import type { ClawChannelMeta } from '@shared/claw'

export interface ChannelUiStateLike {
  state?: ClawChannelState
  lastError?: string | null
}

export interface ChannelUiRow {
  id: ClawChannelId
  label: string
  description: string
  state: ClawChannelState
  stateWord: string
  enabled: boolean
  configured: boolean
  loginMode: ClawChannelMeta['loginMode']
  accountId: string | null
  error: string | null
  /** 纯文字动作：启动 / 停止 */
  action: '启动' | '停止'
  /** 永远显示「未接入」——store 不记录消息时间 */
  lastMessage: string
}

/** 渠道侧没有日志通道，这一列固定是「未接入」。 */
export const CHANNEL_LOG_UNAVAILABLE = '未接入'
export const CHANNEL_LAST_MESSAGE_UNAVAILABLE = '未接入'

export function channelStateWord(state: ClawChannelState, enabled: boolean, configured: boolean): string {
  if (!enabled) return '已停止'
  if (!configured) return '待配置'
  switch (state) {
    case 'connected':
      return '已连接'
    case 'loggingIn':
      return '登录中'
    case 'disconnected':
      return '连接中断'
    case 'idle':
      return '闲置'
    default:
      return '未运行'
  }
}

export function channelActionLabel(enabled: boolean): '启动' | '停止' {
  return enabled ? '停止' : '启动'
}

export interface BuildChannelRowsInput {
  configs: ReadonlyArray<ClawChannelConfig>
  statuses: ReadonlyArray<ClawChannelStatus>
  ui?: Partial<Record<ClawChannelId, ChannelUiStateLike>>
  catalog?: ReadonlyArray<ClawChannelMeta>
}

/** 目录顺序固定（与 shared/claw 一致），缺状态/缺配置都按「未启动/未配置」降级。 */
export function buildChannelRows(input: BuildChannelRowsInput): ChannelUiRow[] {
  const catalog = input.catalog ?? CLAW_CHANNELS
  const configById = new Map(input.configs.map((config) => [config.id, config]))
  const statusById = new Map(input.statuses.map((status) => [status.id, status]))

  return catalog.map((meta) => {
    const config = configById.get(meta.id)
    const status = statusById.get(meta.id)
    const ui = input.ui?.[meta.id]
    const enabled = config?.enabled ?? status?.enabled ?? false
    const configured = status?.configured ?? true
    const state: ClawChannelState = ui?.state ?? status?.state ?? 'stopped'
    return {
      id: meta.id,
      label: meta.label,
      description: meta.description,
      state,
      stateWord: channelStateWord(state, enabled, configured),
      enabled,
      configured,
      loginMode: meta.loginMode,
      accountId: status?.accountId ?? null,
      error: ui?.lastError ?? status?.lastError ?? null,
      action: channelActionLabel(enabled),
      lastMessage: CHANNEL_LAST_MESSAGE_UNAVAILABLE,
    }
  })
}

export function channelCounts(rows: ReadonlyArray<ChannelUiRow>): {
  total: number
  enabled: number
  connected: number
} {
  let enabled = 0
  let connected = 0
  for (const row of rows) {
    if (row.enabled) enabled += 1
    if (row.state === 'connected') connected += 1
  }
  return { total: rows.length, enabled, connected }
}
