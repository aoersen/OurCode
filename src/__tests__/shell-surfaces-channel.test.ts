import { describe, expect, it } from 'vitest'
import type { ClawChannelConfig, ClawChannelStatus } from '@/types'
import {
  CHANNEL_LAST_MESSAGE_UNAVAILABLE,
  CHANNEL_LOG_UNAVAILABLE,
  buildChannelRows,
  channelActionLabel,
  channelCounts,
  channelStateWord,
} from '@/shell/agent/surfaces/channel/channelModel'

function config(id: ClawChannelConfig['id'], enabled: boolean): ClawChannelConfig {
  return { id, enabled, values: {}, policy: {} as ClawChannelConfig['policy'], updatedAt: 1 }
}

function status(over: Partial<ClawChannelStatus> & { id: ClawChannelStatus['id'] }): ClawChannelStatus {
  return { state: 'stopped', enabled: false, configured: true, ...over } as ClawChannelStatus
}

describe('channelModel · 状态词', () => {
  it('未启用优先，其次未配置，再看运行态', () => {
    expect(channelStateWord('connected', false, true)).toBe('已停止')
    expect(channelStateWord('connected', true, false)).toBe('待配置')
    expect(channelStateWord('connected', true, true)).toBe('已连接')
    expect(channelStateWord('loggingIn', true, true)).toBe('登录中')
    expect(channelStateWord('disconnected', true, true)).toBe('连接中断')
    expect(channelStateWord('idle', true, true)).toBe('闲置')
    expect(channelStateWord('stopped', true, true)).toBe('未运行')
  })

  it('动作是「点它做什么」', () => {
    expect(channelActionLabel(true)).toBe('停止')
    expect(channelActionLabel(false)).toBe('启动')
  })

  it('缺失能力固定是「未接入」', () => {
    expect(CHANNEL_LAST_MESSAGE_UNAVAILABLE).toBe('未接入')
    expect(CHANNEL_LOG_UNAVAILABLE).toBe('未接入')
  })
})

describe('channelModel · 渠道行', () => {
  const rows = buildChannelRows({
    configs: [config('wechat', true), config('feishu', false)],
    statuses: [
      status({ id: 'wechat', state: 'connected', enabled: true, accountId: 'wx-1' }),
      status({ id: 'feishu', state: 'stopped', enabled: false }),
      status({ id: 'wecom', state: 'loggingIn', enabled: true, configured: false }),
    ],
    ui: { wechat: { state: 'connected' }, wecom: { lastError: '凭据无效' } },
  })

  it('目录顺序固定为微信 / 企微 / QQ / 飞书 / Telegram', () => {
    expect(rows.map((row) => row.id)).toEqual(['wechat', 'wecom', 'qq', 'feishu', 'telegram'])
    expect(rows.map((row) => row.label)).toEqual(['微信', '企业微信', 'QQ', '飞书', 'Telegram'])
  })

  it('状态、动作、账号都来自 store 快照', () => {
    const wechat = rows[0]
    expect(wechat.stateWord).toBe('已连接')
    expect(wechat.action).toBe('停止')
    expect(wechat.accountId).toBe('wx-1')
    expect(wechat.lastMessage).toBe('未接入')

    const feishu = rows[3]
    expect(feishu.stateWord).toBe('已停止')
    expect(feishu.action).toBe('启动')
    expect(feishu.accountId).toBeNull()
  })

  it('缺凭据的渠道提示待配置，并带出主进程错误', () => {
    const wecom = rows[1]
    expect(wecom.configured).toBe(false)
    expect(wecom.stateWord).toBe('待配置')
    expect(wecom.error).toBe('凭据无效')
  })

  it('没有状态快照的渠道降级成未启用 / 未运行', () => {
    const qq = rows[2]
    expect(qq.enabled).toBe(false)
    expect(qq.stateWord).toBe('已停止')
    expect(qq.configured).toBe(true)
    expect(qq.error).toBeNull()
  })

  it('计数', () => {
    expect(channelCounts(rows)).toEqual({ total: 5, enabled: 2, connected: 1 })
    expect(channelCounts([])).toEqual({ total: 0, enabled: 0, connected: 0 })
  })
})
