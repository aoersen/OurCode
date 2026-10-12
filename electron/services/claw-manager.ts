/**
 * Claw 接入管理器：多渠道宿主 + 接入控制（主进程侧）。
 *
 * 一个 Claw Agent 可以被 5 个渠道接入，每个渠道一个网关子进程（ClawChannelHost）。
 * 本管理器负责：
 *  1. 渠道配置的读写（SQLite，凭据加密落盘）与默认值（含回调路径令牌）；
 *  2. 启停策略：总开关 + 每渠道开关，配置变更即重启该渠道进程；
 *  3. **接入控制强制**：入站事件在广播给渲染层（即进入 agent）之前，按该渠道
 *     的策略判定——黑名单/白名单、群聊必须 @、每联系人频率上限、免打扰时段。
 *     被拦截的消息不会到达 agent，并上报一条 policyDrop 事件供面板解释「为什么
 *     机器人没回」；
 *  4. 出站：sendText / 扫码登录 / 退出登录的按渠道转发。
 *
 * 为什么强制点放在主进程：渲染层的策略只是 UI 状态，可以被绕过或过期；而「谁能
 * 让这台机器上的 agent 干活」是安全边界，必须由唯一持有凭据与进程控制权的一方
 * 判定。渲染层拿到的策略与主进程用的是同一份（同一张表的同一行）。
 */
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import {
  CLAW_CHANNEL_IDS,
  DEFAULT_CLAW_POLICY,
  checkSenderAccess,
  clawChannelMeta,
  inQuietHours,
  isChannelConfigured,
  isClawChannelId,
  isRateLimited,
  normalizeAccessPolicy,
} from '../../shared/claw'
import type {
  ClawAccessPolicy,
  ClawChannelConfig,
  ClawChannelId,
  ClawChannelStatus,
  ClawGatewayEvent,
  ClawHubStatus,
  ClawSentEvent,
} from '../../shared/types'
import { ClawChannelHost } from './claw-channel'

/** 需要 SQLite 的部分抽成接口，便于单测替身。 */
export interface ClawStoreLike {
  getClawChannels(): ClawChannelConfig[]
  saveClawChannel(config: ClawChannelConfig): void
}

export interface ClawManagerOptions {
  store: ClawStoreLike
  /** 网关打包产物路径。 */
  gatewayPath: string
  /** 渠道状态目录根（每个渠道一个子目录）。 */
  stateRoot: string
  /** 事件出口（主进程广播给所有窗口）。 */
  broadcast: (event: ClawGatewayEvent) => void
  /** 主开关（用户偏好 clawEnabled）。 */
  enabled: () => boolean
  /** 诊断日志。 */
  log?: (message: string) => void
}

/** 拦截说明文案：面板与日志共用，避免「静默丢弃」无法解释。 */
export const DROP_REASONS: Record<string, { zh: string; en: string }> = {
  blocked: { zh: '发送者在黑名单里', en: 'Sender is on the blocklist' },
  not_allowed: { zh: '发送者不在白名单里', en: 'Sender is not on the allowlist' },
  need_mention: { zh: '群聊需要 @ 机器人才应答', en: 'Group messages must @ the bot' },
  rate_limited: { zh: '超过每分钟消息上限', en: 'Rate limit exceeded' },
  quiet_hours: { zh: '免打扰时段', en: 'Quiet hours' },
  channel_disabled: { zh: '渠道已停用', en: 'Channel disabled' },
}

export function dropReasonText(reason: string, locale: 'zh' | 'en' = 'zh'): string {
  const entry = DROP_REASONS[reason]
  if (!entry) return reason
  return locale === 'en' ? entry.en : entry.zh
}

/** 策略深比较（用于判断规范化后是否需要回写磁盘）。 */
function samePolicy(a: ClawAccessPolicy, b: ClawAccessPolicy): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 同一发件人同一原因的拦截提示最多每 5 秒上报一次，避免刷屏。 */
const DROP_NOTICE_INTERVAL_MS = 5_000

export class ClawManager extends EventEmitter {
  private readonly hosts = new Map<ClawChannelId, ClawChannelHost>()
  private readonly configs = new Map<ClawChannelId, ClawChannelConfig>()
  /** 每发件人的最近到达时间戳（接入控制的频率限制窗口）。 */
  private readonly recentBySender = new Map<string, number[]>()
  private readonly lastDropNotice = new Map<string, number>()

  constructor(private readonly opts: ClawManagerOptions) {
    super()
  }

  /** 读配置（缺失的按目录补默认值并落库）。返回是否有任何可启动渠道。 */
  load(): void {
    const saved = new Map<ClawChannelId, ClawChannelConfig>()
    for (const cfg of this.opts.store.getClawChannels()) {
      saved.set(cfg.id, cfg)
    }
    for (const id of CLAW_CHANNEL_IDS) {
      const existing = saved.get(id)
      const config: ClawChannelConfig = existing
        ? {
            ...existing,
            id,
            values: existing.values ?? {},
            policy: normalizeAccessPolicy(existing.policy),
            webhookToken: existing.webhookToken || this.newWebhookToken(),
          }
        : this.defaultConfig(id)
      this.configs.set(id, config)
      // 补齐 webhookToken / 规范化策略后回写，保证磁盘与内存一致。
      if (!existing || existing.webhookToken !== config.webhookToken || !samePolicy(existing.policy, config.policy)) {
        this.persist(config)
      }
    }
  }

  private newWebhookToken(): string {
    return randomBytes(16).toString('hex')
  }

  private defaultConfig(id: ClawChannelId): ClawChannelConfig {
    return {
      id,
      // 默认只开微信：它与升级前的行为一致（装好即可用）；其余渠道需要用户
      // 自己填凭据，配置齐全后由用户显式打开。
      enabled: id === 'wechat',
      values: {},
      policy: { ...DEFAULT_CLAW_POLICY, allowlist: [...DEFAULT_CLAW_POLICY.allowlist] },
      webhookToken: this.newWebhookToken(),
      updatedAt: Date.now(),
    }
  }

  private persist(config: ClawChannelConfig): void {
    try {
      this.opts.store.saveClawChannel(config)
    } catch (err) {
      this.log(`渠道配置保存失败（${config.id}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private log(message: string): void {
    this.opts.log?.(message)
  }

  getConfig(id: ClawChannelId): ClawChannelConfig {
    const cfg = this.configs.get(id)
    if (cfg) return cfg
    const fresh = this.defaultConfig(id)
    this.configs.set(id, fresh)
    return fresh
  }

  getStatus(): ClawHubStatus {
    const channels: ClawChannelStatus[] = CLAW_CHANNEL_IDS.map((id) => {
      const cfg = this.getConfig(id)
      const host = this.hosts.get(id)
      const runtime = host?.getStatus()
      return {
        id,
        state: runtime?.state ?? 'stopped',
        enabled: cfg.enabled,
        configured: isChannelConfigured(id, cfg.values),
        accountId: runtime?.accountId,
        lastError: runtime?.lastError,
        webhookUrl: clawChannelMeta(id).webhook ? this.webhookUrl(id) : null,
      }
    })
    return { channels }
  }

  /**
   * 完整回调地址：优先用用户填的 `webhookPublicBase`（有反向代理/内网穿透时本机
   * 地址不是公网地址），否则回退到网关实际监听的本地地址。
   */
  webhookUrl(id: ClawChannelId): string {
    const cfg = this.getConfig(id)
    const meta = clawChannelMeta(id)
    if (!meta.webhook) return ''
    const path = `/claw/${id}/${cfg.webhookToken}`
    const base = String(cfg.values.webhookPublicBase ?? '').trim().replace(/\/+$/, '')
    if (base) return `${base}${path}`
    const local = this.hosts.get(id)?.getStatus().webhookUrl
    return local ?? `http://<本机 IP>:${cfg.values.webhookPort || '（待启动）'}${path}`
  }

  /** 启动已启用且配置齐全的渠道（应用启动时调用；幂等）。 */
  startEnabled(): void {
    if (!this.opts.enabled()) return
    for (const id of CLAW_CHANNEL_IDS) {
      const cfg = this.getConfig(id)
      if (!cfg.enabled) continue
      if (!isChannelConfigured(id, cfg.values)) {
        this.log(`渠道 ${id} 已启用但凭据不全，跳过启动`)
        continue
      }
      this.host(id).start()
    }
  }

  private host(id: ClawChannelId): ClawChannelHost {
    const existing = this.hosts.get(id)
    if (existing) return existing
    const host = new ClawChannelHost({
      channel: id,
      gatewayPath: this.opts.gatewayPath,
      stateDir: join(this.opts.stateRoot, id),
    })
    host.on('gatewayEvent', (ev: ClawGatewayEvent) => this.handleGatewayEvent(ev))
    host.on('gatewayLog', (line: string) => this.log(`[${id}] ${line}`))
    this.hosts.set(id, host)
    return host
  }

  // ── 接入控制（安全边界：agent 之前）────────────────────────────────────
  /** 判定一条入站消息是否放行（策略部分，纯函数见模块底部 screenInbound）。 */
  private screenInbound(ev: Extract<ClawGatewayEvent, { event: 'inbound' }>): string | null {
    const cfg = this.getConfig(ev.channel)
    return screenInbound(ev, cfg.policy, Boolean(cfg.enabled) && this.opts.enabled(), new Date())
  }

  /** 频率限制有状态（窗口滑动），与纯判定分开，便于测试注入时间。 */
  private screenRate(ev: Extract<ClawGatewayEvent, { event: 'inbound' }>, now = Date.now()): string | null {
    const cfg = this.getConfig(ev.channel)
    const limit = cfg.policy.minuteLimit
    if (!limit) return null
    const key = `${ev.channel}:${ev.from || ev.replyTo || ''}`
    const history = (this.recentBySender.get(key) ?? []).filter((ts) => now - ts < 60_000)
    if (isRateLimited(history, limit, now)) {
      this.recentBySender.set(key, history)
      return 'rate_limited'
    }
    history.push(now)
    this.recentBySender.set(key, history)
    // 顺手清掉过期窗口，避免 Map 随联系人数量无限增长。
    if (this.recentBySender.size > 2_000) {
      for (const [k, list] of this.recentBySender) {
        if (list.every((ts) => now - ts >= 60_000)) this.recentBySender.delete(k)
      }
    }
    return null
  }

  /**
   * 网关事件入口（宿主实例绑定到它）。渲染层不该直接调用；测试用它驱动
   * 「接入控制 → 广播」这条链路。
   */
  handleGatewayEvent(ev: ClawGatewayEvent): void {
    if (ev.event === 'inbound') {
      const reason = this.screenInbound(ev) ?? this.screenRate(ev)
      if (reason) {
        this.notifyDrop(ev.channel, reason, ev.from || ev.replyTo || '')
        return
      }
    }
    this.opts.broadcast(ev)
  }

  private notifyDrop(channel: ClawChannelId, reason: string, from: string): void {
    const key = `${channel}:${from}:${reason}`
    const now = Date.now()
    const last = this.lastDropNotice.get(key) ?? 0
    if (now - last < DROP_NOTICE_INTERVAL_MS) return
    this.lastDropNotice.set(key, now)
    if (this.lastDropNotice.size > 1_000) {
      for (const [k, ts] of this.lastDropNotice) {
        if (now - ts > DROP_NOTICE_INTERVAL_MS) this.lastDropNotice.delete(k)
      }
    }
    this.log(`接入控制拦截（${channel}）：${reason} ← ${from}`)
    this.opts.broadcast({ event: 'policyDrop', channel, reason, from })
  }

  // ── 命令（渲染层 → 渠道进程）────────────────────────────────────────────
  /** 保存渠道配置：写库 + 投递给网关；启用状态或凭据变化会重启该渠道进程。 */
  saveChannel(input: ClawChannelConfig): { ok: boolean; error?: string } {
    if (!isClawChannelId(input?.id)) return { ok: false, error: '未知渠道' }
    const current = this.getConfig(input.id)
    const meta = clawChannelMeta(input.id)
    const values: Record<string, string> = {}
    // 只接受目录里声明过的字段：渲染层传入的多余键直接丢弃（凭据字段是白名单）。
    for (const field of meta.fields) {
      const raw = input.values?.[field.key]
      values[field.key] = raw === undefined || raw === null ? '' : String(raw)
    }
    const next: ClawChannelConfig = {
      id: input.id,
      enabled: Boolean(input.enabled),
      values,
      policy: normalizeAccessPolicy(input.policy),
      webhookToken: current.webhookToken || this.newWebhookToken(),
      updatedAt: Date.now(),
    }
    this.configs.set(input.id, next)
    this.persist(next)

    const configured = isChannelConfigured(next.id, next.values)
    const host = this.host(next.id)
    // 只有凭据/回调令牌变了才投递给网关（它会重启进程重连）。策略与开关的变化
    // 不经过网关——策略在主进程判定，开关由下面的 start/stop 处理；若这里无条件
    // setConfig，用户拖动「免打扰」开关也会把渠道连接打断重连。
    // 比较前把存量值也过一遍同一份字段白名单：旧版本/手改过的配置可能少了字段或
    // 顺序不同，不该因此被判成「凭据变了」而白重启一次。
    const normalizedCurrent: Record<string, string> = {}
    for (const field of meta.fields) {
      normalizedCurrent[field.key] = String(current.values?.[field.key] ?? '')
    }
    const credsChanged =
      JSON.stringify(normalizedCurrent) !== JSON.stringify(next.values) || current.webhookToken !== next.webhookToken
    if (credsChanged) host.setConfig({ values: next.values, webhookToken: next.webhookToken })
    if (next.enabled && configured && this.opts.enabled()) {
      host.start()
    } else if (!next.enabled) {
      void host.stop()
    }
    return { ok: true }
  }

  setChannelEnabled(id: ClawChannelId, enabled: boolean): { ok: boolean } {
    const current = this.getConfig(id)
    const next = { ...current, enabled, updatedAt: Date.now() }
    this.configs.set(id, next)
    this.persist(next)
    if (enabled && this.opts.enabled() && isChannelConfigured(id, next.values)) {
      this.host(id).start()
    } else if (!enabled) {
      void this.host(id).stop()
    }
    return { ok: true }
  }

  /** 总开关（设置里的「Claw 渠道接入」）：关掉即停所有渠道进程。 */
  async setMasterEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      this.startEnabled()
      return
    }
    await Promise.all([...this.hosts.values()].map((h) => h.stop()))
  }

  startLogin(id: ClawChannelId): { ok: boolean; error?: string } {
    const cfg = this.getConfig(id)
    if (!cfg.enabled) return { ok: false, error: '渠道未启用' }
    const host = this.host(id)
    host.start()
    return { ok: host.startLogin() }
  }

  submitVerifyCode(id: ClawChannelId, code: string): { ok: boolean } {
    return { ok: this.host(id).submitVerifyCode(code) }
  }

  logout(id: ClawChannelId): { ok: boolean } {
    return { ok: this.host(id).logout() }
  }

  async sendText(
    id: ClawChannelId,
    to: string,
    text: string,
    clientMsgId?: string,
    contextToken?: string,
  ): Promise<ClawSentEvent> {
    if (!isClawChannelId(id)) {
      return { event: 'sent', clientMsgId, ok: false, error: '未知渠道' }
    }
    return this.host(id).sendText(to, text, clientMsgId, contextToken)
  }

  /** 应用退出兜底。 */
  shutdownNow(): void {
    for (const host of this.hosts.values()) host.shutdownNow()
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.stop()))
  }
}

/**
 * 接入控制的策略判定（纯函数）。
 *
 * 顺序是有意的：先看渠道有没有开，再看「谁能说话」，再看群聊的 @ 门槛，最后才
 * 是免打扰。这样面板上的拒绝理由总是最贴近用户实际意图的那一条（例如同一个被
 * 拉黑的人，不会因为同时在免打扰时段而被报成「免打扰」）。
 */
export function screenInbound(
  ev: Extract<ClawGatewayEvent, { event: 'inbound' }>,
  policy: ClawAccessPolicy,
  channelActive: boolean,
  now: Date = new Date(),
): string | null {
  if (!channelActive) return 'channel_disabled'
  const senderId = ev.isGroup ? ev.replyTo || ev.from || '' : ev.from || ''
  const access = checkSenderAccess(policy, senderId, Boolean(ev.isGroup))
  if (!access.allowed) return access.reason ?? 'not_allowed'
  if (ev.isGroup && policy.groupRequireMention && ev.mentioned === false) return 'need_mention'
  if (inQuietHours(policy, now)) return 'quiet_hours'
  return null
}
