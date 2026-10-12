import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Claw 网关产物冒烟（离线）：验证捆绑后的 claw-gateway.mjs 按 CLAW_CHANNEL
 * 选适配器、NDJSON 传输正常、命令分发正确、shutdown 干净退出。
 *
 * 不访问网络：只驱动「无凭据/缺凭据」的分支——真连平台需要用户自己的凭据，
 * 那是联调的事（渠道目录里标了 beta/stable 就是这个意思）。
 * 产物由 `npm run build:claw-gateway` 生成；未构建时跳过。
 */
const gatewayPath = join(__dirname, '..', '..', 'out', 'claw-gateway', 'claw-gateway.mjs')

function runGateway(
  channel: string,
  commands: string[],
  timeoutMs = 10_000,
): Promise<{ events: Array<Record<string, unknown>>; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const stateDir = mkdtempSync(join(tmpdir(), `claw-gw-${channel}-`))
    const configPath = join(stateDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ values: {}, webhookToken: 'test-token' }))
    const child = spawn(process.execPath, [gatewayPath], {
      env: {
        ...process.env,
        CLAW_CHANNEL: channel,
        CLAW_CONFIG: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const events: Array<Record<string, unknown>> = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('gateway smoke timeout'))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      out += d
      let idx: number
      while ((idx = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, idx).trim()
        out = out.slice(idx + 1)
        if (!line) continue
        try {
          events.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // 非 JSON 行忽略（与宿主一致）
        }
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ events, stderr: err, exitCode: code })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    for (const cmd of commands) child.stdin.write(JSON.stringify(cmd) + '\n')
  })
}

describe.skipIf(!existsSync(gatewayPath))('claw-gateway 冒烟（离线）', () => {
  it('未指定渠道时上报 error 并以非零码退出', async () => {
    const { events, exitCode } = await runGateway('', [{ cmd: 'start' }])
    expect(events.some((e) => e.event === 'error')).toBe(true)
    expect(exitCode).toBe(1)
  })

  it('未知渠道同样拒绝启动', async () => {
    const { events, exitCode } = await runGateway('discord', [{ cmd: 'start' }])
    expect(String(events.find((e) => e.event === 'error')?.message ?? '')).toContain('未知渠道')
    expect(exitCode).toBe(1)
  })

  it('微信：无凭据时启动即 idle，未知命令上报 error，shutdown 干净退出', async () => {
    const { events, exitCode } = await runGateway('wechat', [
      { cmd: 'start' },
      { cmd: 'noSuchCommand' },
      { cmd: 'shutdown' },
    ])
    expect(events.some((e) => e.event === 'status' && e.state === 'idle')).toBe(true)
    expect(events.some((e) => e.event === 'error')).toBe(true)
    expect(events.some((e) => e.event === 'status' && e.state === 'stopped')).toBe(true)
    expect(exitCode).toBe(0)
  })

  it('事件都带 channel 字段（主进程按它路由）', async () => {
    const { events } = await runGateway('wechat', [{ cmd: 'start' }, { cmd: 'shutdown' }])
    const withChannel = events.filter((e) => e.channel === 'wechat')
    expect(withChannel.length).toBeGreaterThan(0)
    expect(events.every((e) => e.channel === 'wechat')).toBe(true)
  })

  it.each(['wecom', 'qq', 'feishu'])('%s：缺少必填凭据时明确报错且不静默', async (channel) => {
    const { events } = await runGateway(channel, [{ cmd: 'start' }, { cmd: 'shutdown' }])
    const failure = events.find((e) => e.event === 'loginFailed')
    expect(failure).toBeTruthy()
    expect(String(failure?.message ?? '')).toMatch(/缺少|无效/)
  })
})
