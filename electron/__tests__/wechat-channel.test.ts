import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

import { WechatChannel } from '../services/wechat-channel'

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

describe('WechatChannel', () => {
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
    const channel = new WechatChannel({ gatewayPath, stateDir })
    const events: unknown[] = []
    channel.on('gatewayEvent', (ev: unknown) => events.push(ev))
    channel.start()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect((events[0] as { event: string }).event).toBe('error')
    expect(channel.getStatus().state).toBe('stopped')
  })

  it('start：以 ELECTRON_RUN_AS_NODE 与状态目录拉起网关', () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const channel = new WechatChannel({ gatewayPath, stateDir })
    channel.start()

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const [execPath, args, opts] = mocks.spawn.mock.calls[0] as [string, string[], { env: Record<string, string | undefined> }]
    expect(execPath).toBe(process.execPath)
    expect(args).toEqual([gatewayPath])
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(opts.env.OPENCLAW_STATE_DIR).toBe(stateDir)
  })

  it('gatewayEvent：子进程 stdout 的 NDJSON 行被解析并原样转发', async () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const channel = new WechatChannel({ gatewayPath, stateDir })
    const events: unknown[] = []
    channel.on('gatewayEvent', (ev: unknown) => events.push(ev))
    channel.start()

    child.stdout.write(JSON.stringify({ event: 'status', state: 'idle' }) + '\n')
    child.stdout.write(JSON.stringify({ event: 'qr', qrcodeUrl: 'https://example.com/qr' }) + '\n')
    child.stdout.write('not-json\n')

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[0]).toEqual({ event: 'status', state: 'idle' })
    expect(events[1]).toEqual({ event: 'qr', qrcodeUrl: 'https://example.com/qr' })
    expect(channel.getStatus().state).toBe('idle')
  })

  it('sendText：等待网关 sent 回执并 resolve', async () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const channel = new WechatChannel({ gatewayPath, stateDir })
    channel.start()

    const pending = channel.sendText('wx-user-1', '你好')
    // 网关应收到命令
    await vi.waitFor(() => expect(child.stdin.readableLength).toBeGreaterThan(0))
    const sent = JSON.parse(String(child.stdin.read()) as string)
    expect(sent.cmd).toBe('sendText')
    expect(sent.to).toBe('wx-user-1')
    expect(sent.clientMsgId).toBeTypeOf('string')

    child.stdout.write(JSON.stringify({ event: 'sent', clientMsgId: sent.clientMsgId, ok: true, messageId: 'm-1' }) + '\n')
    const res = await pending
    expect(res.ok).toBe(true)
    expect(res.messageId).toBe('m-1')
  })

  it('sendText：网关未运行时立即以失败回执 resolve', async () => {
    const channel = new WechatChannel({ gatewayPath, stateDir })
    const res = await channel.sendText('wx-user-1', '你好')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未运行')
  })

  it('exit：子进程退出时待确认发送失败（非主动停止会安排自动重启）', async () => {
    const child = makeFakeChild()
    mocks.spawn.mockReturnValue(child)

    writeFileSync(gatewayPath, '')
    const channel = new WechatChannel({ gatewayPath, stateDir })
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

      const channel = new WechatChannel({ gatewayPath, stateDir })
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
      const channel = new WechatChannel({ gatewayPath, stateDir })
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
