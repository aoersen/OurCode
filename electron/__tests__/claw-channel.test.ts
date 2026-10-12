import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

import { ClawChannelHost } from '../services/claw-channel'

const mocks = vi.hoisted(() => {
  return { spawn: vi.fn() }
})

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}))

function makeFakeChild() {
  const child = new EventEmitter() as unknown as {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  return child
}

describe('ClawChannelHost', () => {
  let stateDir: string
  let gatewayPath: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'wechat-channel-test-'))
    gatewayPath = join(stateDir, 'gateway.mjs')
    vi.clearAllMocks()
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('start：网关文件缺失时上报 error 事件且不 spawn', () => {
    const channel = new ClawChannelHost({ channel: 'wechat', gatewayPath, stateDir })
    const events: unknown[] = []
    channel.on('gatewayEvent', (ev: unknown) => events.push(ev))
    channel.start()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect((events[0] as { event: string }).event).toBe('error')
    expect((events[0] as { channel: string }).channel).toBe('wechat')
    expect(channel.getStatus().state).toBe('stopped')
  })

  it('start：以 ELECTRON_RUN_AS_NODE 与状态目录拉起网关', () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const channel = new ClawChannelHost({ channel: 'wechat', gatewayPath, stateDir })
    channel.start()

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const [execPath, args, opts] = mocks.spawn.mock.calls[0] as [string, string[], { env: Record<string, string | undefined> }]
    expect(execPath).toBe(process.execPath)
    expect(args).toEqual([gatewayPath])
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(opts.env.OPENCLAW_STATE_DIR).toBe(stateDir)
  })

  it('start：写入渠道配置并发送 start 命令（凭据不经命令行传递）', () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const host = new ClawChannelHost({ channel: 'feishu', gatewayPath, stateDir })
    host.setConfig({ values: { appId: 'cli_x' }, webhookToken: 'tok-1' })
    host.start()

    const [, , opts] = mocks.spawn.mock.calls[0] as [string, string[], { env: Record<string, string | undefined> }]
    expect(opts.env.CLAW_CHANNEL).toBe('feishu')
    expect(opts.env.CLAW_CONFIG).toBe(join(stateDir, 'config.json'))
    // 配置落在磁盘上，进程列表里看不到凭据
    const written = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')) as {
      values: Record<string, string>
      webhookToken: string
    }
    expect(written.values.appId).toBe('cli_x')
    expect(written.webhookToken).toBe('tok-1')
    expect(String(child.stdin.read())).toContain('"cmd":"start"')
  })

  it('setConfig：运行中改配置会重启进程（渠道连接必须重连才生效）', async () => {
    const children: Array<ReturnType<typeof makeFakeChild>> = []
    mocks.spawn.mockImplementation(() => {
      const c = makeFakeChild()
      children.push(c)
      return c
    })
    writeFileSync(gatewayPath, '')
    const host = new ClawChannelHost({ channel: 'telegram', gatewayPath, stateDir })
    host.start()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    host.setConfig({ values: { botToken: 'new' }, webhookToken: 'tok-2' })
    // 旧进程先收 shutdown（保存新配置后重连，而不是热改内存）
    await vi.waitFor(() => {
      const cmds = String(children[0].stdin.read() ?? '')
      expect(cmds).toContain('"cmd":"shutdown"')
    })
    // 假网关“退出”，宿主随即用新配置拉起新进程
    children[0].emit('exit', 0)
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2))
    const written = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')) as { values: Record<string, string> }
    expect(written.values.botToken).toBe('new')
    await host.stop()
  })

  it('gatewayEvent：子进程 stdout 的 NDJSON 行被解析并原样转发', async () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const channel = new ClawChannelHost({ channel: 'wechat', gatewayPath, stateDir })
    const events: unknown[] = []
    channel.on('gatewayEvent', (ev: unknown) => events.push(ev))
    channel.start()

    child.stdout.write(JSON.stringify({ event: 'status', state: 'idle' }) + '\n')
    child.stdout.write(JSON.stringify({ event: 'qr', qrcodeUrl: 'https://example.com/qr' }) + '\n')
    child.stdout.write('not-json\n')

    await vi.waitFor(() => expect(events).toHaveLength(2))
    // 宿主在事件上补 channel 字段（处理器按渠道实例化，网关自己写不写都不影响）
    expect(events[0]).toEqual({ event: 'status', channel: 'wechat', state: 'idle' })
    expect(events[1]).toEqual({ event: 'qr', channel: 'wechat', qrcodeUrl: 'https://example.com/qr' })
    expect(channel.getStatus().state).toBe('idle')
  })

  it('sendText：等待网关 sent 回执并 resolve', async () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const channel = new ClawChannelHost({ channel: 'wechat', gatewayPath, stateDir })
    channel.start()

    const pending = channel.sendText('wx-user-1', '你好', undefined, 'ctx-1')
    // 网关应收到命令（首行是 start，末行才是这次 sendText）
    await vi.waitFor(() => expect(child.stdin.readableLength).toBeGreaterThan(0))
    const lines = String(child.stdin.read()).split('\n').filter(Boolean)
    const sent = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
    expect(sent.cmd).toBe('sendText')
    expect(sent.to).toBe('wx-user-1')
    // 回执令牌随发送带上（QQ 的被动回复依赖它）
    expect(sent.contextToken).toBe('ctx-1')
    expect(sent.clientMsgId).toBeTypeOf('string')

    child.stdout.write(JSON.stringify({ event: 'sent', clientMsgId: sent.clientMsgId, ok: true, messageId: 'm-1' }) + '\n')
    const res = await pending
    expect(res.ok).toBe(true)
    expect(res.messageId).toBe('m-1')
  })

  it('sendText：网关未运行时立即以失败回执 resolve', async () => {
    const channel = new ClawChannelHost({ channel: 'wechat', gatewayPath, stateDir })
    const res = await channel.sendText('wx-user-1', '你好')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未运行')
  })

  it('exit：子进程退出时待确认发送失败（非主动停止会安排自动重启）', async () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const channel = new ClawChannelHost({ channel: 'wechat', gatewayPath, stateDir })
    const exits: unknown[] = []
    channel.on('exit', (code: unknown) => exits.push(code))
    channel.start()

    const pending = channel.sendText('wx-user-1', '你好')
    child.emit('exit', 1)

    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.error).toContain('网关已退出')
    expect(exits).toEqual([1])
    await channel.stop() // 取消挂起的重启定时器，避免影响其他用例
  })

  it('exit：崩溃自动重启（最多 3 次），超过上限上报错误并停止', async () => {
    vi.useFakeTimers()
    try {
      writeFileSync(gatewayPath, '')
      let lastChild: ReturnType<typeof makeFakeChild> | null = null
      mocks.spawn.mockImplementation(() => {
        lastChild = makeFakeChild()
        return lastChild
      })

      const channel = new ClawChannelHost({ channel: 'wechat', gatewayPath, stateDir })
      const events: unknown[] = []
      channel.on('gatewayEvent', (ev: unknown) => events.push(ev))
      channel.start()
      expect(mocks.spawn).toHaveBeenCalledTimes(1)

      const crash = () => lastChild!.emit('exit', 1)
      crash()
      await vi.advanceTimersByTimeAsync(3_100)
      crash()
      await vi.advanceTimersByTimeAsync(3_100)
      crash()
      await vi.advanceTimersByTimeAsync(3_100) // 第 3 次重启
      crash() // 超过上限

      expect(mocks.spawn).toHaveBeenCalledTimes(4) // 初始 + 3 次重启
      const errors = events.filter((e) => (e as { event: string }).event === 'error')
      expect(errors).toHaveLength(1)
      expect((errors[0] as { message: string }).message).toContain('多次崩溃')
      expect(channel.getStatus().state).toBe('stopped')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop：先发 shutdown，网关超时未退出则强杀；重复调用安全', async () => {
    vi.useFakeTimers()
    try {
      const child = makeFakeChild()
      mocks.spawn.mockReturnValue(child)

      writeFileSync(gatewayPath, '')
      const channel = new ClawChannelHost({ channel: 'wechat', gatewayPath, stateDir })
      channel.start()
      const stopPromise = channel.stop()
      // 网关对 shutdown 无响应（不退出）→ 走 3 秒超时强杀路径
      await vi.advanceTimersByTimeAsync(3_100)
      await stopPromise
      expect(child.kill).toHaveBeenCalled()
      await channel.stop() // 幂等：无子进程时直接置 stopped
      expect(channel.getStatus().state).toBe('stopped')
    } finally {
      vi.useRealTimers()
    }
  })
})
