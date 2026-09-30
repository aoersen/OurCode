import { describe, it, expect, beforeEach, vi } from 'vitest'

import { useWechatStore } from '@/stores/wechatStore'
import type { WechatGatewayEvent } from '@/types'

type GatewayListener = (ev: WechatGatewayEvent) => void

const gatewayListeners: GatewayListener[] = []

const electronApi = {
  getWechatStatus: vi.fn(async () => ({ state: 'idle' as const })),
  wechatStartLogin: vi.fn(async () => ({ ok: true })),
  wechatSubmitVerifyCode: vi.fn(async () => ({ ok: true })),
  wechatLogout: vi.fn(async () => ({ ok: true })),
  wechatSendText: vi.fn(async () => ({ event: 'sent' as const, ok: true })),
  wechatSetEnabled: vi.fn(async () => ({ ok: true })),
  onWechatEvent: vi.fn((cb: GatewayListener) => {
    gatewayListeners.push(cb)
    return () => {
      const i = gatewayListeners.indexOf(cb)
      if (i >= 0) gatewayListeners.splice(i, 1)
    }
  }),
}

vi.stubGlobal('window', { electronAPI: electronApi })

const initialState = useWechatStore.getState()

beforeEach(() => {
  useWechatStore.setState({ ...initialState })
  gatewayListeners.length = 0
  vi.clearAllMocks()
})

describe('wechatStore', () => {
  it('init：拉取初始状态并订阅网关事件', async () => {
    const off = useWechatStore.getState().init()
    await vi.waitFor(() => expect(useWechatStore.getState().state).toBe('idle'))
    expect(electronApi.onWechatEvent).toHaveBeenCalledTimes(1)
    expect(useWechatStore.getState().initialized).toBe(true)
    off()
    expect(useWechatStore.getState().initialized).toBe(false)
  })

  it('qr → scanned → connected 状态流转', async () => {
    useWechatStore.getState().init()
    const push = (ev: WechatGatewayEvent) => gatewayListeners.forEach((cb) => cb(ev))

    push({ event: 'qr', qrcodeUrl: 'https://wx/qr1' })
    expect(useWechatStore.getState().qrUrl).toBe('https://wx/qr1')

    push({ event: 'scanned' })
    expect(useWechatStore.getState().scanned).toBe(true)

    push({ event: 'status', state: 'connected', accountId: 'a-im-bot' })
    expect(useWechatStore.getState().state).toBe('connected')
    expect(useWechatStore.getState().qrUrl).toBeNull()
    expect(useWechatStore.getState().scanned).toBe(false)
  })

  it('needVerifyCode / verifyBlocked / loginFailed 通知', async () => {
    useWechatStore.getState().init()
    const push = (ev: WechatGatewayEvent) => gatewayListeners.forEach((cb) => cb(ev))

    push({ event: 'needVerifyCode' })
    expect(useWechatStore.getState().needVerifyCode).toBe(true)

    push({ event: 'verifyBlocked' })
    expect(useWechatStore.getState().needVerifyCode).toBe(false)
    expect(useWechatStore.getState().verifyBlocked).toBe(true)

    push({ event: 'loginFailed', message: '登录超时' })
    expect(useWechatStore.getState().notice).toBe('登录超时')
    expect(useWechatStore.getState().qrUrl).toBeNull()

    useWechatStore.getState().clearNotice()
    expect(useWechatStore.getState().notice).toBeNull()
  })

  it('startLogin / submitVerifyCode / logout 走主进程通道', async () => {
    await useWechatStore.getState().startLogin()
    expect(electronApi.wechatStartLogin).toHaveBeenCalledTimes(1)

    await useWechatStore.getState().submitVerifyCode('123456')
    expect(electronApi.wechatSubmitVerifyCode).toHaveBeenCalledWith('123456')

    await useWechatStore.getState().logout()
    expect(electronApi.wechatLogout).toHaveBeenCalledTimes(1)
  })
})
