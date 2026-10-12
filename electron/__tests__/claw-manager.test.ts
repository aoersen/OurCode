import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClawManager, screenInbound } from '../services/claw-manager'
import { DEFAULT_CLAW_POLICY, type ClawAccessPolicy } from '../../shared/claw'
import type { ClawChannelConfig, ClawGatewayEvent } from '../../shared/types'

/**
 * ClawManager：渠道配置 + 接入控制强制。
 *
 * 不拉起任何子进程——这里测的是「配置怎么存、事件怎么判、什么该广播、什么必须
 * 被拦下」。进程生命周期另有 claw-channel / claw-gateway 两组冒烟覆盖。
 */
function makeStore(seed: ClawChannelConfig[] = []) {
  const rows = new Map(seed.map((c) => [c.id, c]))
  return {
    saved: [] as ClawChannelConfig[],
    getClawChannels: () => [...rows.values()],
    saveClawChannel(config: ClawChannelConfig) {
      rows.set(config.id, config)
      this.saved.push(config)
    },
  }
}

const inbound = (channel: ClawGatewayEvent['channel'], patch: Partial<Extract<ClawGatewayEvent, { event: 'inbound' }>> = {}) =>
  ({
    event: 'inbound' as const,
    channel,
    from: 'user-1',
    replyTo: 'user-1',
    isGroup: false,
    text: '你好',
    ...patch,
  })

describe('ClawManager', () => {
  let stateRoot: string
  let events: ClawGatewayEvent[]

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'claw-manager-'))
    events = []
  })

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true })
  })

  function makeManager(seed: ClawChannelConfig[] = [], masterEnabled = true) {
    const store = makeStore(seed)
    // 总开关是活的（用户在设置里随时改），因此这里也用一个可变的开关源
    const master = { on: masterEnabled }
    const manager = new ClawManager({
      store,
      gatewayPath: join(stateRoot, 'claw-gateway.mjs'),
      stateRoot,
      broadcast: (ev) => events.push(ev),
      enabled: () => master.on,
      log: () => {},
    })
    manager.load()
    return { manager, store, master }
  }

  function policyOf(id: ClawChannelConfig['id'], patch: Partial<ClawAccessPolicy>) {
    const cfg: ClawChannelConfig = {
      id,
      enabled: true,
      values: {},
      policy: { ...DEFAULT_CLAW_POLICY, allowlist: [], blocklist: [], ...patch },
      webhookToken: 'tok-1',
      updatedAt: 0,
    }
    return cfg
  }

  it('load：按目录补齐 5 个渠道，默认只开微信（升级前行为），并生成回调令牌', () => {
    const { manager, store } = makeManager()
    const status = manager.getStatus()
    expect(status.channels.map((c) => c.id)).toEqual(['wechat', 'wecom', 'qq', 'feishu', 'telegram'])

    const wechat = manager.getConfig('wechat')
    expect(wechat.enabled).toBe(true)
    expect(manager.getConfig('telegram').enabled).toBe(false)
    // 令牌持久化（固定后平台侧配置才不会每次重启失效）
    expect(wechat.webhookToken).toMatch(/^[0-9a-f]{32}$/)
    expect(store.saved.some((c) => c.id === 'wechat')).toBe(true)
  })

  it('getStatus：区分「未配置」与「已配置但没连上」', () => {
    const { manager } = makeManager([
      { ...policyOf('telegram', {}), values: { botToken: '123:abc' } },
      { ...policyOf('wecom', {}), values: { corpId: 'ww1' } },
    ])
    const byId = new Map(manager.getStatus().channels.map((c) => [c.id, c]))
    expect(byId.get('telegram')?.configured).toBe(true)
    expect(byId.get('wecom')?.configured).toBe(false)
    expect(byId.get('wechat')?.configured).toBe(true)
    // 回调地址只在需要回调的渠道上有值
    expect(byId.get('wecom')?.webhookUrl).toContain('/claw/wecom/tok-1')
    expect(byId.get('wechat')?.webhookUrl).toBeNull()
  })

  it('webhookUrl：填了对外前缀就用它拼（本机地址不是公网地址）', () => {
    const { manager } = makeManager([
      { ...policyOf('feishu', {}), values: { webhookPublicBase: 'https://claw.example.com/' } },
    ])
    expect(manager.webhookUrl('feishu')).toBe('https://claw.example.com/claw/feishu/tok-1')
  })

  it('saveChannel：只接受目录里声明的字段，策略被规范化', () => {
    const { manager } = makeManager()
    const tokenBefore = manager.getConfig('telegram').webhookToken
    const res = manager.saveChannel({
      id: 'telegram',
      enabled: false,
      values: { botToken: '  abc  ', 不该存在的字段: 'x' } as Record<string, string>,
      policy: { allowlist: ['a', ''], minuteLimit: 99_999 } as unknown as ClawAccessPolicy,
      webhookToken: 'attacker-supplied',
      updatedAt: 0,
    })
    expect(res.ok).toBe(true)
    const saved = manager.getConfig('telegram')
    expect(saved.values.botToken).toBe('  abc  ')
    expect(Object.keys(saved.values)).not.toContain('不该存在的字段')
    expect(saved.policy.minuteLimit).toBe(600)
    expect(saved.policy.allowlist).toEqual(['a'])
    // 令牌不接受渲染层传入（它决定回调地址，不能被改写）
    expect(saved.webhookToken).toBe(tokenBefore)
  })

  it('saveChannel：改策略不重启渠道，改凭据才投递（避免拖开关就断线）', () => {
    const { manager } = makeManager([
      { ...policyOf('telegram', {}), enabled: false, values: { botToken: 'old' } },
    ])
    // 用假的宿主观察 setConfig 调用：只有凭据变化才应该推给网关
    const calls: unknown[] = []
    const host = (manager as unknown as { host(id: string): { setConfig: (c: unknown) => void } }).host('telegram')
    const original = host.setConfig.bind(host)
    host.setConfig = (config: unknown) => {
      calls.push(config)
      original(config)
    }

    manager.saveChannel({ ...manager.getConfig('telegram'), policy: { ...manager.getConfig('telegram').policy, minuteLimit: 5 } })
    expect(calls).toHaveLength(0)

    manager.saveChannel({ ...manager.getConfig('telegram'), values: { botToken: 'new' } })
    expect(calls).toHaveLength(1)
  })

  it('saveChannel：未知渠道被拒绝', () => {
    const { manager } = makeManager()
    expect(manager.saveChannel({ id: 'discord' as never }).ok).toBe(false)
  })

  it('放行：白名单为空、非免打扰时段、私聊', () => {
    const { manager } = makeManager([policyOf('telegram', {})])
    manager.handleGatewayEvent(inbound('telegram'))
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('inbound')
  })

  it('拦截：黑名单命中 + 渠道已停用，都只上报 policyDrop', () => {
    const { manager } = makeManager([policyOf('telegram', { blocklist: ['user-1'] })])
    manager.handleGatewayEvent(inbound('telegram'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'policyDrop', channel: 'telegram', reason: 'blocked', from: 'user-1' })

    events.length = 0
    const { manager: m2 } = makeManager([{ ...policyOf('qq', {}), enabled: false }])
    m2.handleGatewayEvent(inbound('qq'))
    expect(events[0]).toMatchObject({ event: 'policyDrop', reason: 'channel_disabled' })
  })

  it('拦截：严格白名单下的私聊外人', () => {
    const { manager } = makeManager([policyOf('feishu', { allowlist: ['vip'], strictDirect: true })])
    manager.handleGatewayEvent(inbound('feishu', { from: 'stranger' }))
    expect(events[0]).toMatchObject({ event: 'policyDrop', reason: 'not_allowed' })
  })

  it('拦截：群聊未 @ 机器人（mentioned=false 且要求 @）', () => {
    const { manager } = makeManager([policyOf('qq', { groupRequireMention: true })])
    manager.handleGatewayEvent(inbound('qq', { isGroup: true, replyTo: 'group:g1', from: 'member-1', mentioned: false }))
    expect(events[0]).toMatchObject({ event: 'policyDrop', reason: 'need_mention' })

    events.length = 0
    manager.handleGatewayEvent(inbound('qq', { isGroup: true, replyTo: 'group:g1', from: 'member-1', mentioned: true }))
    expect(events[0].event).toBe('inbound')
  })

  it('拦截：免打扰时段（判定用注入的当前时间）', () => {
    const cfg = policyOf('wechat', {})
    cfg.policy.quietHours = { enabled: true, from: '00:00', to: '23:59' }
    const { manager } = makeManager([cfg])
    manager.handleGatewayEvent(inbound('wechat'))
    expect(events[0]).toMatchObject({ event: 'policyDrop', reason: 'quiet_hours' })
  })

  it('拦截：超过每分钟上限后开始丢弃（同一发件人）', () => {
    const { manager } = makeManager([policyOf('wecom', { minuteLimit: 2 })])
    const ev = inbound('wecom', { from: 'user-9' })
    manager.handleGatewayEvent(ev)
    manager.handleGatewayEvent(ev)
    manager.handleGatewayEvent(ev)
    expect(events.filter((e) => e.event === 'inbound')).toHaveLength(2)
    expect(events.filter((e) => e.event === 'policyDrop')).toHaveLength(1)
    expect(events.find((e) => e.event === 'policyDrop')).toMatchObject({ reason: 'rate_limited' })
  })

  it('总开关关闭时所有渠道都拦下（并给出 channel_disabled）', () => {
    const { manager } = makeManager([policyOf('telegram', {})], false)
    manager.handleGatewayEvent(inbound('telegram'))
    expect(events[0]).toMatchObject({ event: 'policyDrop', reason: 'channel_disabled' })
  })

  it('非入站事件（状态/回执）直接广播，不经过接入控制', () => {
    const { manager } = makeManager()
    manager.handleGatewayEvent({ event: 'status', channel: 'telegram', state: 'connected' })
    manager.handleGatewayEvent({ event: 'sent', channel: 'telegram', clientMsgId: 'c1', ok: true })
    expect(events.map((e) => e.event)).toEqual(['status', 'sent'])
  })

  it('总开关只启停进程，不改各渠道自己的开关（关一次不该抹掉用户的渠道选择）', async () => {
    const { manager, master } = makeManager([], false)
    // 主开关关着：渠道自己的开关保持原样（微信默认开），进程没起来
    expect(manager.getConfig('wechat').enabled).toBe(true)
    expect(manager.getStatus().channels.find((c) => c.id === 'wechat')?.state).toBe('stopped')

    master.on = true
    await manager.setMasterEnabled(true)
    const wechat = manager.getStatus().channels.find((c) => c.id === 'wechat')
    // 已启用且配置齐全 → 尝试启动；网关文件不存在时报错，而不是假装已连接
    expect(wechat?.enabled).toBe(true)
    expect(wechat?.lastError ?? '').toContain('网关文件缺失')
    // 未启用的渠道不受总开关影响
    expect(manager.getStatus().channels.find((c) => c.id === 'telegram')?.state).toBe('stopped')

    await manager.setMasterEnabled(false)
    expect(manager.getStatus().channels.find((c) => c.id === 'wechat')?.state).toBe('stopped')
  })

  it('setChannelEnabled：开启但缺凭据不启动（状态里能看到未配置）', () => {
    const { manager } = makeManager()
    manager.setChannelEnabled('telegram', true)
    const status = manager.getStatus().channels.find((c) => c.id === 'telegram')
    expect(status?.enabled).toBe(true)
    expect(status?.configured).toBe(false)
    // 没凭据就不该有进程起来（state 停在 stopped，而不是假装的 connected）
    expect(status?.state).toBe('stopped')
  })
})

describe('screenInbound（纯判定）', () => {
  const base = { ...DEFAULT_CLAW_POLICY, allowlist: [], blocklist: [] } as ClawAccessPolicy

  it('判定顺序：渠道停用 > 黑名单 > @ 门槛 > 免打扰', () => {
    // 群消息按群 id 判黑白名单
    const ev = inbound('wechat', { isGroup: true, replyTo: 'g1', from: 'u1', mentioned: false })
    const strict = { ...base, blocklist: ['g1'], quietHours: { enabled: true, from: '00:00', to: '23:59' } }
    // 渠道停用最先返回
    expect(screenInbound(ev, strict, false)).toBe('channel_disabled')
    // 其次黑名单（比免打扰更贴近用户意图）
    expect(screenInbound(ev, strict, true)).toBe('blocked')
    // 移除黑名单后轮到 @ 门槛，而不是免打扰
    expect(screenInbound(ev, { ...strict, blocklist: [] }, true)).toBe('need_mention')
    // 最后才是免打扰
    expect(screenInbound({ ...ev, mentioned: true }, { ...strict, blocklist: [] }, true)).toBe('quiet_hours')
    // 全部满足 = 放行
    expect(screenInbound({ ...ev, mentioned: true }, base, true)).toBeNull()
  })

  it('群聊按群 id 判黑白名单（群维度的接入控制）', () => {
    const ev = inbound('qq', { isGroup: true, replyTo: 'group:g1', from: 'member-1', mentioned: true })
    expect(screenInbound(ev, { ...base, blocklist: ['group:g1'] }, true)).toBe('blocked')
    expect(screenInbound(ev, { ...base, blocklist: ['member-1'] }, true)).toBeNull()
  })

  it('未标注 mentioned 的群消息不因缺字段被拦（适配器没给信息时不误杀）', () => {
    const ev = { ...inbound('wechat', { isGroup: true, replyTo: 'g1' }), mentioned: undefined }
    expect(screenInbound(ev, base, true)).toBeNull()
  })
})
