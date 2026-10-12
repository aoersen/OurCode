import { describe, it, expect, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'

import { createWebhookServer } from '../claw-gateway/webhook.mjs'
import { processWecomCallback, parseWecomMessageXml } from '../claw-gateway/adapters/wecom.mjs'
import { processFeishuCallback, normalizeFeishuText, parseFeishuMessage } from '../claw-gateway/adapters/feishu.mjs'
import { parseQqMessage } from '../claw-gateway/adapters/qq.mjs'
import { encryptFeishu, encryptWechatAes, wechatSignature } from '../claw-gateway/crypto.mjs'

/**
 * 回调链路（企业微信 / 飞书 / QQ）的离线集成测试。
 *
 * 这些渠道的入站消息只能靠平台 POST 到回调地址——「是不是平台发的、内容有没有被
 * 改过」全靠这一层的验签与解密。测试不是「跑通就行」，而是把每条拒绝路径也钉住：
 * 错签名、错令牌、错密钥、被篡改的密文都必须被挡下。
 */

const servers: Array<{ stop: () => Promise<void> }> = []
const NL = String.fromCharCode(10)

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
})

function makeAesKey(): string {
  return randomBytes(32).toString('base64').replace(/=+$/, '').slice(0, 43)
}

async function startServer(channel: string, token: string, handler: (req: unknown) => unknown) {
  const server = createWebhookServer({ channel, token, handler, log: () => {} })
  const bound = await server.start(0, '127.0.0.1')
  servers.push(server)
  return { server, base: `http://127.0.0.1:${bound.port}`, path: bound.path }
}

describe('webhook 回调服务器', () => {
  it('只认自己的路径：渠道或令牌不对一律 404（不进入解析逻辑）', async () => {
    const { base, path } = await startServer('wecom', 'tok-a', () => ({ status: 200, body: 'ok' }))
    const ok = await fetch(`${base}${path}`, { method: 'POST', body: 'x' })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('ok')

    expect((await fetch(`${base}/claw/wecom/wrong-token`, { method: 'POST', body: 'x' })).status).toBe(404)
    expect((await fetch(`${base}/claw/feishu/tok-a`, { method: 'POST', body: 'x' })).status).toBe(404)
    expect((await fetch(`${base}/`, { method: 'POST', body: 'x' })).status).toBe(404)
  })

  it('把原始字节与查询串交给 handler（验签必须基于原始 body）', async () => {
    const seen: Array<{ raw: string; sig: string | null; method: string }> = []
    const { base, path } = await startServer('feishu', 'tok-b', (req: unknown) => {
      const r = req as { rawBody: Buffer; query: URLSearchParams; method: string }
      seen.push({ raw: r.rawBody.toString('utf8'), sig: r.query.get('sig'), method: r.method })
      return { status: 200, body: '{}', contentType: 'application/json' }
    })
    await fetch(`${base}${path}?sig=abc`, { method: 'POST', body: '{"a":1}' })
    expect(seen).toEqual([{ raw: '{"a":1}', sig: 'abc', method: 'POST' }])
  })

  it('handler 抛错时回 500（让平台重投，不伪装成功）', async () => {
    const { base, path } = await startServer('qq', 'tok-c', () => {
      throw new Error('boom')
    })
    expect((await fetch(`${base}${path}`, { method: 'POST', body: 'x' })).status).toBe(500)
  })

  it('GET 也走同一路由（企业微信 echostr 握手）', async () => {
    const { base, path } = await startServer('wecom', 'tok-d', (req: unknown) => {
      const r = req as { method: string; query: URLSearchParams }
      return { status: 200, body: `${r.method}:${r.query.get('echostr')}` }
    })
    const res = await fetch(`${base}${path}?echostr=hello`)
    expect(await res.text()).toBe('GET:hello')
  })
})

describe('企业微信回调处理', () => {
  const aesKey = makeAesKey()
  const token = 'cb-token'
  const corpId = 'ww-test'

  function wecomXml(content: string, from = 'zhangwei'): string {
    return `<xml>${NL}<ToUserName><![CDATA[${corpId}]]></ToUserName>${NL}<FromUserName><![CDATA[${from}]]></FromUserName>${NL}<CreateTime>1700000000</CreateTime>${NL}<MsgType><![CDATA[text]]></MsgType>${NL}<Content><![CDATA[${content}]]></Content>${NL}<MsgId>1001</MsgId>${NL}<AgentID>1000002</AgentID>${NL}</xml>`
  }

  function signedPost(plainXml: string, { sign = true, key = aesKey, receiveId = corpId } = {}) {
    const encrypt = encryptWechatAes({ encodingAesKey: key, plain: plainXml, receiveId })
    const rawBody = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID>1000002</AgentID></xml>`
    const timestamp = '1700000000'
    const nonce = 'n1'
    const signature = sign
      ? wechatSignature([token, timestamp, nonce, encrypt])
      : wechatSignature(['wrong-token', timestamp, nonce, encrypt])
    const query = new URLSearchParams({ msg_signature: signature, timestamp, nonce })
    return { method: 'POST', query, rawBody }
  }

  it('合法签名 + 正确密钥 → 解析出文本入站消息，并回空 200', () => {
    const result = processWecomCallback(signedPost(wecomXml('你好，Claw')), {
      callbackToken: token,
      encodingAesKey: aesKey,
      corpId,
    })
    expect(result.reply).toEqual({ status: 200, body: '' })
    expect(result.inbound).toMatchObject({
      event: 'inbound',
      from: 'zhangwei',
      replyTo: 'zhangwei',
      isGroup: false,
      text: '你好，Claw',
      msgId: '1001',
    })
  })

  it('签名不对 → 401 且不解析消息', () => {
    const result = processWecomCallback(signedPost(wecomXml('恶意消息'), { sign: false }), {
      callbackToken: token,
      encodingAesKey: aesKey,
      corpId,
    })
    expect(result.reply.status).toBe(401)
    expect(result.inbound).toBeUndefined()
  })

  it('签名合法但密钥不对 → 400（解密失败不静默）', () => {
    const other = makeAesKey()
    // 用另一把密钥加密，但签名是按我们已知的 token 算的（模拟「伪造者知道 URL 但没密钥」）
    const encrypt = encryptWechatAes({ encodingAesKey: other, plain: wecomXml('x'), receiveId: corpId })
    const timestamp = '1700000000'
    const nonce = 'n1'
    const query = new URLSearchParams({
      msg_signature: wechatSignature([token, timestamp, nonce, encrypt]),
      timestamp,
      nonce,
    })
    const result = processWecomCallback(
      { method: 'POST', query, rawBody: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>` },
      { callbackToken: token, encodingAesKey: aesKey, corpId },
    )
    expect(result.reply.status).toBe(400)
    expect(result.inbound).toBeUndefined()
  })

  it('未配置 Token 时不校验签名但放行（仅本机调试路径）', () => {
    const result = processWecomCallback(signedPost(wecomXml('x'), { sign: false }), {
      callbackToken: '',
      encodingAesKey: aesKey,
      corpId,
    })
    expect(result.reply.status).toBe(200)
    expect(result.inbound?.text).toBe('x')
  })

  it('GET echostr 握手：验签后回明文', () => {
    const echostr = encryptWechatAes({ encodingAesKey: aesKey, plain: 'echo-123', receiveId: corpId })
    const timestamp = '1700000000'
    const nonce = 'n2'
    const query = new URLSearchParams({
      msg_signature: wechatSignature([token, timestamp, nonce, echostr]),
      timestamp,
      nonce,
      echostr,
    })
    const result = processWecomCallback({ method: 'GET', query, rawBody: '' }, {
      callbackToken: token,
      encodingAesKey: aesKey,
      corpId,
    })
    expect(result).toMatchObject({ reply: { status: 200, body: 'echo-123' } })
    expect(result.inbound).toBeUndefined()
  })

  it('非文本消息：200 但不产生入站（不静默失败，有日志）', () => {
    const logs: string[] = []
    const xml = `<xml><MsgType><![CDATA[image]]></MsgType><FromUserName><![CDATA[u]]></FromUserName><Content><![CDATA[]]></Content></xml>`
    expect(parseWecomMessageXml(xml, (m: string) => logs.push(m))).toBeNull()
    expect(logs.join(' ')).toContain('忽略非文本消息')

    const result = processWecomCallback(signedPost(xml), { callbackToken: token, encodingAesKey: aesKey, corpId })
    expect(result.reply.status).toBe(200)
    expect(result.inbound).toBeUndefined()
  })

  it('缺 Encrypt 字段直接 400', () => {
    const query = new URLSearchParams({ msg_signature: 'x', timestamp: '1', nonce: '2' })
    expect(processWecomCallback({ method: 'POST', query, rawBody: '<xml></xml>' }, { callbackToken: token, encodingAesKey: aesKey, corpId }).reply.status).toBe(400)
  })
})

describe('飞书回调处理', () => {
  it('url_verification：原样回 challenge（明文）', () => {
    const result = processFeishuCallback(
      { method: 'POST', rawBody: JSON.stringify({ type: 'url_verification', challenge: 'ch-1', token: 'v-token' }) },
      { encryptKey: '', verificationToken: 'v-token' },
    )
    expect(result.reply).toMatchObject({ status: 200, contentType: 'application/json' })
    expect(JSON.parse(String(result.reply.body))).toEqual({ challenge: 'ch-1' })
  })

  it('url_verification：Verification Token 不符 → 401', () => {
    const result = processFeishuCallback(
      { method: 'POST', rawBody: JSON.stringify({ type: 'url_verification', challenge: 'ch-1', token: 'attacker' }) },
      { encryptKey: '', verificationToken: 'v-token' },
    )
    expect(result.reply.status).toBe(401)
  })

  it('开启事件加密后：解密 → 校验 token → 解析消息', () => {
    const inner = JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'v-token' },
      event: {
        sender: { sender_id: { open_id: 'ou_user' } },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_chat',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 帮我看看构建' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claw' }],
        },
      },
    })
    const encrypt = encryptFeishu({ encryptKey: 'ek-1', plain: inner })
    const result = processFeishuCallback(
      { method: 'POST', rawBody: JSON.stringify({ encrypt }) },
      { encryptKey: 'ek-1', verificationToken: 'v-token' },
    )
    expect(result.reply.status).toBe(200)
    expect(result.inbound).toMatchObject({
      event: 'inbound',
      from: 'ou_user',
      replyTo: 'oc_chat',
      isGroup: true,
      msgId: 'om_1',
    })
    // 群消息里的 @占位符被剥掉，并标记为「已提及」
    expect(result.inbound?.text).toBe('帮我看看构建')
    expect(result.inbound?.mentioned).toBe(true)
  })

  it('收到加密报文但没配 Encrypt Key → 400（不猜测明文）', () => {
    const result = processFeishuCallback(
      { method: 'POST', rawBody: JSON.stringify({ encrypt: 'AAAA' }) },
      { encryptKey: '', verificationToken: '' },
    )
    expect(result.reply.status).toBe(400)
  })

  it('事件 token 不符 → 401（别人的应用推不进来）', () => {
    const result = processFeishuCallback(
      {
        method: 'POST',
        rawBody: JSON.stringify({
          schema: '2.0',
          header: { event_type: 'im.message.receive_v1', token: 'someone-else' },
          event: {},
        }),
      },
      { encryptKey: '', verificationToken: 'v-token' },
    )
    expect(result.reply.status).toBe(401)
    expect(result.inbound).toBeUndefined()
  })

  it('非文本消息与非 JSON 报文都被安全拒绝', () => {
    expect(
      parseFeishuMessage({ message_type: 'image', content: '{}' }, {}, '', () => {}),
    ).toBeNull()
    expect(processFeishuCallback({ method: 'POST', rawBody: 'not json' }, { encryptKey: '', verificationToken: '' }).reply.status).toBe(400)
  })

  it('@ 提及归一化：有 @ 但拿不到机器人 open_id 时按「已提及」处理', () => {
    const { text, mentioned } = normalizeFeishuText('@_user_1 在吗', [{ key: '@_user_1', id: { open_id: 'ou_x' } }], '')
    expect(text).toBe('在吗')
    expect(mentioned).toBe(true)
    // 提到的是别人 → 不算提及机器人
    expect(normalizeFeishuText('@_user_1 hi', [{ key: '@_user_1', id: { open_id: 'ou_other' } }], 'ou_bot').mentioned).toBe(false)
  })
})

describe('QQ 回调载荷解析', () => {
  it('群 @ 消息：replyTo 编码群 id，标记已提及', () => {
    const inbound = parseQqMessage('GROUP_AT_MESSAGE_CREATE', {
      id: 'msg-1',
      content: '  帮我跑一下测试',
      group_openid: 'g-1',
      author: { member_openid: 'u-1' },
      timestamp: '2026-01-01T00:00:00Z',
    })
    expect(inbound).toMatchObject({
      event: 'inbound',
      from: 'u-1',
      replyTo: 'group:g-1',
      isGroup: true,
      text: '帮我跑一下测试',
      contextToken: 'msg-1',
      mentioned: true,
    })
  })

  it('单聊消息：replyTo 编码用户 openid', () => {
    const inbound = parseQqMessage('C2C_MESSAGE_CREATE', {
      id: 'msg-2',
      content: 'hi',
      author: { user_openid: 'u-2' },
    })
    expect(inbound).toMatchObject({ replyTo: 'user:u-2', isGroup: false, from: 'u-2' })
    expect((inbound as { mentioned?: boolean }).mentioned).toBeUndefined()
  })

  it('空内容 / 未知事件 / 缺 id 一律不产生入站', () => {
    expect(parseQqMessage('C2C_MESSAGE_CREATE', { id: 'm', content: '   ', author: { user_openid: 'u' } })).toBeNull()
    expect(parseQqMessage('AT_MESSAGE_CREATE', { id: 'm', content: 'x' })).toBeNull()
    expect(parseQqMessage('C2C_MESSAGE_CREATE', { id: 'm', content: 'x', author: {} })).toBeNull()
    expect(parseQqMessage('GROUP_AT_MESSAGE_CREATE', { id: 'm', content: 'x', author: { member_openid: 'u' } })).toBeNull()
  })
})
