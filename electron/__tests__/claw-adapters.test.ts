import { describe, it, expect } from 'vitest'

import { parseWecomFrame } from '../claw-gateway/adapters/wecom.mjs'
import { parseFeishuMessage } from '../claw-gateway/adapters/feishu.mjs'
import { parseTelegramContext } from '../claw-gateway/adapters/telegram.mjs'
import { buildHeartbeat, buildIdentify, buildResume, parseQqGatewayEvent } from '../claw-gateway/adapters/qq.mjs'
import { CLAW_CHANNELS, isChannelConfigured } from '../../shared/claw'

/**
 * 渠道适配器的「平台消息 → Claw 入站事件」映射（离线单测）。
 *
 * 连接、重连、去重、加密全部交给官方 SDK / 平台长连接，因此这里只测我们自己写
 * 的那一层：字段映射、会话键（replyTo）、@ 提及判定、以及 QQ 的网关帧构造。
 * 这是接入控制拿到的唯一输入，映射错了就会「认错人 / 判错群」。
 */
describe('企业微信（@wecom/aibot-node-sdk 帧）', () => {
  const frame = (body: Record<string, unknown>) => ({
    headers: { req_id: 'req-1' },
    body: { msgtype: 'text', text: { content: '帮我看下构建' }, chatid: 'wr_chat', from: { userid: 'zhangwei', name: '张伟' }, msgid: 'm1', create_time: 1700000000, ...body },
  })

  it('单聊文本 → inbound（replyTo 用 chatid，回执令牌用 req_id）', () => {
    const inbound = parseWecomFrame(frame({}))
    expect(inbound).toMatchObject({
      event: 'inbound',
      from: 'zhangwei',
      fromName: '张伟',
      replyTo: 'wr_chat',
      isGroup: false,
      text: '帮我看下构建',
      msgId: 'm1',
      contextToken: 'req-1',
    })
    expect(inbound.ts).toBe(1700000000 * 1000)
    // 单聊不标 mentioned（接入控制只在群里看它）
    expect(inbound.mentioned).toBeUndefined()
  })

  it('群消息视为已提及（机器人只推发给它的消息）', () => {
    const inbound = parseWecomFrame(frame({ chattype: 'group' }))
    expect(inbound.isGroup).toBe(true)
    expect(inbound.mentioned).toBe(true)
  })

  it('非文本 / 空文本不产出入站事件', () => {
    expect(parseWecomFrame(frame({ text: { content: '   ' } }))).toBeNull()
    expect(parseWecomFrame({ headers: {}, body: { msgtype: 'image', image: { url: 'x' } } })).toBeNull()
    expect(parseWecomFrame(undefined)).toBeNull()
  })
})

describe('飞书（createLarkChannel 规范化消息）', () => {
  const msg = (patch: Record<string, unknown> = {}) => ({
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: '张伟',
    content: '部署到测试环境',
    mentionedBot: false,
    createTime: 1700000000000,
    ...patch,
  })

  it('单聊文本 → inbound', () => {
    expect(parseFeishuMessage(msg())).toMatchObject({
      event: 'inbound',
      from: 'ou_user',
      fromName: '张伟',
      replyTo: 'oc_chat',
      isGroup: false,
      text: '部署到测试环境',
      contextToken: 'om_1',
    })
  })

  it('群聊带上 mentionedBot（供「群聊需 @」判定）', () => {
    expect(parseFeishuMessage(msg({ chatType: 'group', mentionedBot: true })).mentioned).toBe(true)
    expect(parseFeishuMessage(msg({ chatType: 'group', mentionedBot: false })).mentioned).toBe(false)
    // 话题群也算群
    expect(parseFeishuMessage(msg({ chatType: 'topic' })).isGroup).toBe(true)
  })

  it('空内容不产出（图片/文件等非文本由 SDK 归一到空字符串）', () => {
    expect(parseFeishuMessage(msg({ content: '  ' }))).toBeNull()
    expect(parseFeishuMessage(undefined)).toBeNull()
  })
})

describe('Telegram（grammY 上下文）', () => {
  const ctx = (patch: Record<string, unknown> = {}) => ({
    message: {
      message_id: 42,
      date: 1700000000,
      text: '你好 Claw',
      chat: { id: 1001, type: 'private' },
      from: { id: 77, first_name: '张伟', last_name: 'Z', username: 'zw' },
      ...patch,
    },
  })

  it('私聊文本 → inbound（replyTo 用 chat.id）', () => {
    expect(parseTelegramContext(ctx())).toMatchObject({
      event: 'inbound',
      from: '77',
      fromName: '张伟 Z',
      replyTo: '1001',
      isGroup: false,
      text: '你好 Claw',
      contextToken: '42',
    })
  })

  it('群与超级群标为群消息（privacy mode 下能收到即视为提及）', () => {
    for (const type of ['group', 'supergroup']) {
      const inbound = parseTelegramContext(ctx({ chat: { id: -1002, type } }))
      expect(inbound.isGroup).toBe(true)
      expect(inbound.mentioned).toBe(true)
    }
  })

  it('没有 first/last name 时回退 username；空文本/非消息更新不产出', () => {
    const inbound = parseTelegramContext(ctx({ from: { id: 77, username: 'zw' } }))
    expect(inbound.fromName).toBe('zw')
    expect(parseTelegramContext(ctx({ text: '   ' }))).toBeNull()
    expect(parseTelegramContext({ edited_message: { text: 'x' } })).toBeNull()
  })
})

describe('QQ（官方 WebSocket 网关）', () => {
  it('鉴权帧带 intents 与 QQBot 前缀 token（平台约定）', () => {
    const identify = buildIdentify('tok-1')
    expect(identify.op).toBe(2)
    expect(identify.d.token).toBe('QQBot tok-1')
    // 只订阅群与单聊消息
    expect(identify.d.intents).toBe(1 << 25)
    expect(identify.d.shard).toEqual([0, 1])
  })

  it('会话恢复帧带 session_id 与最后序号（断线不漏消息）', () => {
    expect(buildResume('tok-1', 'sess-9', 88)).toEqual({ op: 6, d: { token: 'QQBot tok-1', session_id: 'sess-9', seq: 88 } })
  })

  it('心跳帧 op=1，序号可为空', () => {
    expect(buildHeartbeat(null)).toEqual({ op: 1, d: null })
    expect(buildHeartbeat(12)).toEqual({ op: 1, d: 12 })
  })

  it('群 @ 消息 → replyTo 编码群 id 且标为已提及', () => {
    const inbound = parseQqGatewayEvent('GROUP_AT_MESSAGE_CREATE', {
      id: 'msg-1',
      content: '  跑一下测试',
      group_openid: 'g-1',
      author: { member_openid: 'u-1' },
      timestamp: '2026-01-01T00:00:00Z',
    })
    expect(inbound).toMatchObject({
      event: 'inbound',
      from: 'u-1',
      replyTo: 'group:g-1',
      isGroup: true,
      text: '跑一下测试',
      contextToken: 'msg-1',
      mentioned: true,
    })
  })

  it('单聊消息 → replyTo 编码用户 openid', () => {
    expect(parseQqGatewayEvent('C2C_MESSAGE_CREATE', { id: 'm2', content: 'hi', author: { user_openid: 'u-2' } })).toMatchObject({
      replyTo: 'user:u-2',
      isGroup: false,
      from: 'u-2',
    })
  })

  it('空内容 / 无关事件 / 缺 id 一律不产出', () => {
    expect(parseQqGatewayEvent('C2C_MESSAGE_CREATE', { id: 'm', content: '  ', author: { user_openid: 'u' } })).toBeNull()
    expect(parseQqGatewayEvent('AT_MESSAGE_CREATE', { id: 'm', content: 'x' })).toBeNull()
    expect(parseQqGatewayEvent('C2C_MESSAGE_CREATE', { id: 'm', content: 'x', author: {} })).toBeNull()
    expect(parseQqGatewayEvent('GROUP_AT_MESSAGE_CREATE', { id: 'm', content: 'x', author: { member_openid: 'u' } })).toBeNull()
  })
})

describe('渠道目录与凭据门槛（长连接契约）', () => {
  it('每个渠道的接入方式都是长连接，没有任何回调/加密字段', () => {
    for (const meta of CLAW_CHANNELS) {
      expect(meta.loginMode === 'qr' || meta.loginMode === 'credentials').toBe(true)
      const keys = meta.fields.map((f) => f.key.toLowerCase())
      for (const forbidden of ['webhook', 'webhookport', 'callback', 'callbacktoken', 'encodingaeskey', 'encryptkey', 'verificationtoken', 'privatekeyseed', 'publickey', 'port', 'proxy']) {
        expect(keys.some((k) => k.includes(forbidden))).toBe(false)
      }
    }
  })

  it('凭据数量：每个渠道最多 2 个必填 + 1 个可选开关', () => {
    for (const meta of CLAW_CHANNELS) {
      expect(meta.fields.filter((f) => f.required).length).toBeLessThanOrEqual(2)
      expect(meta.fields.length).toBeLessThanOrEqual(3)
    }
  })

  it('每个渠道都能用「用户手上真实拿得到的东西」判定是否配好', () => {
    expect(isChannelConfigured('wechat', {})).toBe(true) // 扫码，无需凭据
    expect(isChannelConfigured('wecom', { botId: 'b' })).toBe(false)
    expect(isChannelConfigured('wecom', { botId: 'b', secret: 's' })).toBe(true)
    expect(isChannelConfigured('feishu', { appId: 'a' })).toBe(false)
    expect(isChannelConfigured('feishu', { appId: 'a', appSecret: 's' })).toBe(true)
    expect(isChannelConfigured('qq', { appId: 'a', appSecret: 's' })).toBe(true)
    expect(isChannelConfigured('telegram', { botToken: 't' })).toBe(true)
  })
})
