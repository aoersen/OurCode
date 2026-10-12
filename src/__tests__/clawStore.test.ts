import { describe, it, expect, beforeEach, vi } from 'vitest'

import { useClawStore } from '@/stores/clawStore'
import type { ClawGatewayEvent, ClawHubStatus } from '@/types'

type GatewayListener = (ev: ClawGatewayEvent) => void

const gatewayListeners: GatewayListener[] = []

const HUB: ClawHubStatus = {
  channels: [
    { id: 'wechat', state: 'idle', enabled: true, configured: true, webhookUrl: null },
    { id: 'wecom', state: 'stopped', enabled: false, configured: false, webhookUrl: 'http://127.0.0.1:8790/claw/wecom/tok' },
    { id: 'qq', state: 'stopped', enabled: false, configured: false, webhookUrl: 'http://127.0.0.1:8791/claw/qq/tok' },
    { id: 'feishu', state: 'stopped', enabled: false, configured: false, webhookUrl: 'http://127.0.0.1:8792/claw/feishu/tok' },
    { id: 'telegram', state: 'stopped', enabled: false, configured: false, webhookUrl: null },
  ],
}

const electronApi = {
  getClawStatus: vi.fn(async () => HUB),
  getClawChannels: vi.fn(async () => []),
  clawStartLogin: vi.fn(async () => ({ ok: true })),
  clawSubmitVerifyCode: vi.fn(async () => ({ ok: true })),
  clawLogout: vi.fn(async () => ({ ok: true })),
  clawSendText: vi.fn(async () => ({ event: 'sent' as const, ok: true })),
  setClawChannelEnabled: vi.fn(async () => ({ ok: true })),
  onClawEvent: vi.fn((cb: GatewayListener) => {
    gatewayListeners.push(cb)
    return () => {
      const i = gatewayListeners.indexOf(cb)
      if (i >= 0) gatewayListeners.splice(i, 1)
    }
  }),
}

vi.stubGlobal('window', { electronAPI: electronApi })

const initialState = useClawStore.getState()

beforeEach(() => {
  useClawStore.setState({ ...initialState })
  gatewayListeners.length = 0
  vi.clearAllMocks()
})

const push = (ev: ClawGatewayEvent) => gatewayListeners.forEach((cb) => cb(ev))

describe('clawStore', () => {
  it('init：拉取渠道状态并订阅网关事件', async () => {
    const off = useClawStore.getState().init()
    await vi.waitFor(() => expect(useClawStore.getState().hub?.channels.length).toBe(5))
    expect(electronApi.onClawEvent).toHaveBeenCalledTimes(1)
    expect(useClawStore.getState().initialized).toBe(true)
    // 主进程给的连接状态落到对应渠道上，互不串台
    expect(useClawStore.getState().channels.wechat.state).toBe('idle')
    expect(useClawStore.getState().channels.wecom.webhookUrl).toContain('/claw/wecom/')
    off()
    expect(useClawStore.getState().initialized).toBe(false)
  })

  it('事件按 channel 分流：其中一个渠道的二维码不影响其他渠道', async () => {
    useClawStore.getState().init()

    push({ event: 'qr', channel: 'wechat', qrcodeUrl: 'https://wx/qr1' })
    expect(useClawStore.getState().channels.wechat.qrUrl).toBe('https://wx/qr1')
    expect(useClawStore.getState().channels.telegram.qrUrl).toBeNull()

    push({ event: 'scanned', channel: 'wechat' })
    expect(useClawStore.getState().channels.wechat.scanned).toBe(true)

    push({ event: 'status', channel: 'wechat', state: 'connected', accountId: 'a-im-bot' })
    expect(useClawStore.getState().channels.wechat.state).toBe('connected')
    expect(useClawStore.getState().channels.wechat.qrUrl).toBeNull()
    expect(useClawStore.getState().channels.wechat.scanned).toBe(false)
  })

  it('needVerifyCode / verifyBlocked / loginFailed 通知（按渠道隔离）', async () => {
    useClawStore.getState().init()

    push({ event: 'needVerifyCode', channel: 'telegram' })
    expect(useClawStore.getState().channels.telegram.needVerifyCode).toBe(true)
    expect(useClawStore.getState().channels.wechat.needVerifyCode).toBe(false)

    push({ event: 'verifyBlocked', channel: 'telegram' })
    expect(useClawStore.getState().channels.telegram.needVerifyCode).toBe(false)
    expect(useClawStore.getState().channels.telegram.verifyBlocked).toBe(true)

    push({ event: 'loginFailed', channel: 'telegram', message: 'Bot Token 无效' })
    expect(useClawStore.getState().channels.telegram.notice).toBe('Bot Token 无效')
    expect(useClawStore.getState().channels.telegram.lastError).toBe('Bot Token 无效')

    useClawStore.getState().clearNotice('telegram')
    expect(useClawStore.getState().channels.telegram.notice).toBeNull()
    // 清掉提示不该抹掉 lastError（渠道卡片上的常驻错误另有出口）
    expect(useClawStore.getState().channels.telegram.lastError).toBe('Bot Token 无效')
  })

  it('接入控制拦截记录进面板（最近 20 条，最新在前）', () => {
    useClawStore.getState().init()
    push({ event: 'policyDrop', channel: 'feishu', reason: 'need_mention', from: 'oc_group_1' })
    push({ event: 'policyDrop', channel: 'qq', reason: 'blocked', from: 'user-9' })
    const drops = useClawStore.getState().drops
    expect(drops).toHaveLength(2)
    expect(drops[0]).toMatchObject({ channel: 'qq', reason: 'blocked', from: 'user-9' })
    expect(drops[1].reason).toBe('need_mention')

    useClawStore.getState().clearDrops()
    expect(useClawStore.getState().drops).toHaveLength(0)
  })

  it('startLogin / submitVerifyCode / logout 带上渠道', async () => {
    await useClawStore.getState().startLogin('wechat')
    expect(electronApi.clawStartLogin).toHaveBeenCalledWith('wechat')

    await useClawStore.getState().submitVerifyCode('wechat', '123456')
    expect(electronApi.clawSubmitVerifyCode).toHaveBeenCalledWith('wechat', '123456')

    await useClawStore.getState().logout('wechat')
    expect(electronApi.clawLogout).toHaveBeenCalledWith('wechat')
  })

  it('sendText 把渠道与回执令牌一起交给主进程', async () => {
    await useClawStore.getState().sendText('qq', 'group:g1', '你好', 'msg-1')
    expect(electronApi.clawSendText).toHaveBeenCalledWith('qq', 'group:g1', '你好', undefined, 'msg-1')
  })

  it('setChannelEnabled 先更新本地配置再回主进程（开关手感即时）', async () => {
    const stored: Array<{ id: string; enabled: boolean }> = [{ id: 'wechat', enabled: true }]
    electronApi.getClawChannels.mockImplementation(async () =>
      stored.map((c) => ({
        id: c.id as never,
        enabled: c.enabled,
        values: {},
        policy: {} as never,
        webhookToken: '',
        updatedAt: 0,
      })),
    )
    electronApi.setClawChannelEnabled.mockImplementation(async (id: string, enabled: boolean) => {
      const row = stored.find((c) => c.id === id)
      if (row) row.enabled = enabled
      return { ok: true }
    })
    useClawStore.setState({ configs: [{ id: 'wechat', enabled: true }] as never })

    await useClawStore.getState().setChannelEnabled('wechat', false)
    expect(electronApi.setClawChannelEnabled).toHaveBeenCalledWith('wechat', false)
    // 主进程是权威：刷新后本地配置与它一致
    expect(useClawStore.getState().configs[0].enabled).toBe(false)
    expect(stored[0].enabled).toBe(false)
  })
})
