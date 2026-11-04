import { create } from 'zustand'

import { CLAW_CHANNEL_IDS } from '@shared/claw'
import type {
  ClawAgentState,
  ClawChannelConfig,
  ClawChannelId,
  ClawChannelState,
  ClawGatewayEvent,
  ClawHubStatus,
  ClawSentEvent,
} from '@/types'

/**
 * Claw 渠道接入的 UI 状态。主进程（每渠道一个网关子进程 + 接入控制）是唯一事实
 * 来源，事件经 `window.electronAPI.onClawEvent` 推入；本 store 把它们翻译成面板
 * 与设置页可直接渲染的状态。消息处理逻辑不在这里（见 services/claw/clawBridge.ts）。
 *
 * Claw Agent 状态（agentState）：独立常驻 agent 的运行期状态（当前工作区/审批模式/
 * 模型/记忆），**所有渠道共享**；渠道差异只在 configs（凭据/启停/接入策略）里。
 */
export interface ClawChannelUiState {
  state: ClawChannelState
  /** 扫码登录二维码链接（仅二维码渠道）。 */
  qrUrl: string | null
  scanned: boolean
  needVerifyCode: boolean
  verifyBlocked: boolean
  /** 登录失败 / 会话过期 / 通道错误等一次性提示。 */
  notice: string | null
  /** 主进程记录的最后一条错误（用于渠道卡片上的常驻提示）。 */
  lastError: string | null
}

/** 一条被接入控制拦截的入站消息（面板用来解释「为什么没回」）。 */
export interface ClawDropRecord {
  channel: ClawChannelId
  reason: string
  from: string
  at: number
}

const EMPTY_CHANNEL_UI: ClawChannelUiState = {
  state: 'stopped',
  qrUrl: null,
  scanned: false,
  needVerifyCode: false,
  verifyBlocked: false,
  notice: null,
  lastError: null,
}

function emptyChannelMap(): Record<ClawChannelId, ClawChannelUiState> {
  const out = {} as Record<ClawChannelId, ClawChannelUiState>
  for (const id of CLAW_CHANNEL_IDS) out[id] = { ...EMPTY_CHANNEL_UI }
  return out
}

/** 最近拦截记录上限（面板只展示最近几条，不当作审计日志）。 */
const MAX_DROP_RECORDS = 20

interface ClawStoreState {
  channels: Record<ClawChannelId, ClawChannelUiState>
  hub: ClawHubStatus | null
  /** 渠道配置（含凭据；仅供设置页编辑，写入时回主进程校验字段白名单）。 */
  configs: ClawChannelConfig[]
  drops: ClawDropRecord[]
  initialized: boolean
  /** Claw Agent 状态（沙盒/工作区/审批模式/模型/记忆）。 */
  agentState: ClawAgentState | null

  /** 一次性接线：拉取初始状态并订阅主进程事件；返回取消函数。 */
  init: () => () => void
  refreshStatus: () => Promise<void>
  loadConfigs: () => Promise<void>
  loadAgentState: () => Promise<void>
  saveAgentState: (patch: Partial<ClawAgentState>) => Promise<void>
  setAgentState: (state: ClawAgentState | null) => void
  saveChannel: (config: ClawChannelConfig) => Promise<{ ok: boolean; error?: string }>
  setChannelEnabled: (id: ClawChannelId, enabled: boolean) => Promise<void>
  startLogin: (id: ClawChannelId) => Promise<void>
  submitVerifyCode: (id: ClawChannelId, code: string) => Promise<void>
  logout: (id: ClawChannelId) => Promise<void>
  sendText: (id: ClawChannelId, to: string, text: string, contextToken?: string, final?: boolean) => Promise<ClawSentEvent>
  clearNotice: (id: ClawChannelId) => void
  clearDrops: () => void
}

export const useClawStore = create<ClawStoreState>((set, get) => {
  const patchChannel = (id: ClawChannelId, patch: Partial<ClawChannelUiState>) => {
    set((s) => ({ channels: { ...s.channels, [id]: { ...s.channels[id], ...patch } } }))
  }

  return {
    channels: emptyChannelMap(),
    hub: null,
    configs: [],
    drops: [],
    initialized: false,
    agentState: null,

    init: () => {
      if (get().initialized) return () => {}
      set({ initialized: true })

      const off = window.electronAPI.onClawEvent((ev: ClawGatewayEvent) => {
        // 其他窗口保存了配置 / 拨了渠道开关：重新拉取，别让本窗口停在旧快照。
        // 主进程用这条事件替代「谁操作谁自己刷新」的局部更新。
        if (ev.event === 'configChanged') {
          // 拉取失败不改变本地可用性：下次刷新/事件还会再来一次。
          void get().refreshStatus().catch(() => {})
          void get().loadConfigs().catch(() => {})
          return
        }
        const id = ev.channel
        if (!id || !CLAW_CHANNEL_IDS.includes(id)) return
        switch (ev.event) {
          case 'status': {
            const state = ev.state
            const accountId = ev.accountId
            patchChannel(id, {
              state,
              ...(state === 'loggingIn'
                ? { scanned: false, needVerifyCode: false, verifyBlocked: false, notice: null }
                : {}),
              ...(state === 'connected'
                ? { qrUrl: null, scanned: false, needVerifyCode: false, verifyBlocked: false, notice: null, lastError: null }
                : {}),
            })
            // 面板头部的徽标与指标读 hub；只更新 channels 会让「在线渠道」停在旧值。
            set((s) =>
              s.hub
                ? {
                    hub: {
                      ...s.hub,
                      channels: s.hub.channels.map((c) =>
                        c.id === id ? { ...c, state, ...(accountId !== undefined ? { accountId } : {}) } : c,
                      ),
                    },
                  }
                : {},
            )
            break
          }
          case 'qr':
            patchChannel(id, { qrUrl: ev.qrcodeUrl, scanned: false, needVerifyCode: false, verifyBlocked: false })
            break
          case 'scanned':
            patchChannel(id, { scanned: true })
            break
          case 'needVerifyCode':
            patchChannel(id, { needVerifyCode: true })
            break
          case 'verifyBlocked':
            patchChannel(id, { needVerifyCode: false, verifyBlocked: true })
            break
          case 'loginFailed':
          case 'sessionExpired':
          case 'error':
            patchChannel(id, { notice: ev.message, lastError: ev.message, qrUrl: null, scanned: false, needVerifyCode: false })
            break
          case 'policyDrop':
            set((s) => ({
              drops: [{ channel: id, reason: ev.reason, from: ev.from, at: Date.now() }, ...s.drops].slice(0, MAX_DROP_RECORDS),
            }))
            break
          default:
            break
        }
      })

      void get().refreshStatus()
      void get().loadConfigs()

      return () => {
        off()
        set({ initialized: false })
      }
    },

    refreshStatus: async () => {
      const hub = await window.electronAPI.getClawStatus()
      if (!hub) return
      set((s) => {
        const channels = { ...s.channels }
        for (const status of hub.channels) {
          channels[status.id] = {
            ...channels[status.id],
            state: status.state,
            lastError: status.lastError ?? channels[status.id].lastError,
          }
        }
        return { hub, channels }
      })
    },

    loadConfigs: async () => {
      const configs = await window.electronAPI.getClawChannels()
      if (Array.isArray(configs)) set({ configs })
    },

    loadAgentState: async () => {
      const state = await window.electronAPI.getClawAgentState()
      set({ agentState: state })
    },

    saveAgentState: async (patch) => {
      const cur = get().agentState
      if (!cur) return
      const next: ClawAgentState = { ...cur, ...patch, updatedAt: Date.now() }
      set({ agentState: next })
      await window.electronAPI.saveClawAgentState(next)
    },

    setAgentState: (state) => set({ agentState: state }),

    saveChannel: async (config) => {
      const res = await window.electronAPI.saveClawChannel(config)
      await get().refreshStatus()
      await get().loadConfigs()
      return res ?? { ok: false, error: '保存失败' }
    },

    setChannelEnabled: async (id, enabled) => {
      set((s) => ({ configs: s.configs.map((c) => (c.id === id ? { ...c, enabled } : c)) }))
      await window.electronAPI.setClawChannelEnabled(id, enabled)
      await get().refreshStatus()
      await get().loadConfigs()
    },

    startLogin: async (id) => {
      patchChannel(id, { notice: null, verifyBlocked: false })
      await window.electronAPI.clawStartLogin(id)
    },

    submitVerifyCode: async (id, code) => {
      if (!code.trim()) return
      patchChannel(id, { needVerifyCode: false })
      await window.electronAPI.clawSubmitVerifyCode(id, code)
    },

    logout: async (id) => {
      await window.electronAPI.clawLogout(id)
      patchChannel(id, { qrUrl: null, scanned: false, needVerifyCode: false, verifyBlocked: false, notice: null })
    },

    sendText: (id, to, text, contextToken, final) =>
      window.electronAPI.clawSendText(id, to, text, undefined, contextToken, final),

    clearNotice: (id) => patchChannel(id, { notice: null }),

    clearDrops: () => set({ drops: [] }),
  }
})
