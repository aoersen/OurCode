import { create } from 'zustand'

import type { WechatChannelState, WechatGatewayEvent, WechatSentEvent } from '@/types'

/**
 * 微信通道 UI 状态。主进程（网关子进程）是唯一事实来源，事件经
 * `window.electronAPI.onWechatEvent` 推入；本 store 把它们翻译成
 * 设置面板可直接渲染的状态。消息处理逻辑不在这里（见 services/wechat/wechatBridge.ts）。
 */
interface WechatStoreState {
  /** 通道状态（idle / loggingIn / connected / …）。 */
  state: WechatChannelState
  /** 当前登录二维码链接（扫码用，浏览器打开或复制）。 */
  qrUrl: string | null
  /** 手机已扫码，等待确认。 */
  scanned: boolean
  /** 服务端要求输入配对验证码。 */
  needVerifyCode: boolean
  /** 验证码被拒绝（二维码已刷新）。 */
  verifyBlocked: boolean
  /** 登录失败 / 会话过期 / 通道错误等一次性提示。 */
  notice: string | null
  initialized: boolean

  /** 一次性接线：拉取初始状态并订阅主进程事件；返回取消函数。 */
  init: () => () => void
  startLogin: () => Promise<void>
  submitVerifyCode: (code: string) => Promise<void>
  logout: () => Promise<void>
  sendText: (to: string, text: string) => Promise<WechatSentEvent>
  clearNotice: () => void
}

export const useWechatStore = create<WechatStoreState>((set, get) => ({
  state: 'stopped',
  qrUrl: null,
  scanned: false,
  needVerifyCode: false,
  verifyBlocked: false,
  notice: null,
  initialized: false,

  init: () => {
    if (get().initialized) return () => {}
    set({ initialized: true })

    const off = window.electronAPI.onWechatEvent((ev: WechatGatewayEvent) => {
      switch (ev.event) {
        case 'status':
          set({ state: ev.state })
          if (ev.state === 'loggingIn') {
            set({ scanned: false, needVerifyCode: false, verifyBlocked: false, notice: null })
          }
          if (ev.state === 'connected') {
            set({ qrUrl: null, scanned: false, needVerifyCode: false, verifyBlocked: false, notice: null })
          }
          break
        case 'qr':
          set({ qrUrl: ev.qrcodeUrl, scanned: false, needVerifyCode: false, verifyBlocked: false })
          break
        case 'scanned':
          set({ scanned: true })
          break
        case 'needVerifyCode':
          set({ needVerifyCode: true })
          break
        case 'verifyBlocked':
          set({ needVerifyCode: false, verifyBlocked: true })
          break
        case 'loginFailed':
        case 'sessionExpired':
        case 'error':
          set({ notice: ev.message, qrUrl: null, scanned: false, needVerifyCode: false })
          break
        default:
          break
      }
    })

    void window.electronAPI.getWechatStatus().then(({ state }) => {
      set({ state })
    })

    return () => {
      off()
      set({ initialized: false })
    }
  },

  startLogin: async () => {
    set({ notice: null, verifyBlocked: false })
    await window.electronAPI.wechatStartLogin()
  },

  submitVerifyCode: async (code: string) => {
    if (!code.trim()) return
    set({ needVerifyCode: false })
    await window.electronAPI.wechatSubmitVerifyCode(code)
  },

  logout: async () => {
    await window.electronAPI.wechatLogout()
    set({ qrUrl: null, scanned: false, needVerifyCode: false, verifyBlocked: false, notice: null })
  },

  sendText: (to, text) => window.electronAPI.wechatSendText(to, text),

  clearNotice: () => set({ notice: null }),
}))
