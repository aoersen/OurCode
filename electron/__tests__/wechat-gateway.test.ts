import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 网关产物冒烟（离线）：验证捆绑后的 wechat-gateway.mjs 能被拉起、NDJSON
 * 传输正常、未知命令上报 error、shutdown 干净退出。不访问网络。
 * 产物由 `npm run build:wechat-gateway` 生成；未构建时跳过。
 */
const gatewayPath = join(__dirname, '..', '..', 'out', 'wechat-gateway', 'wechat-gateway.mjs')

function runGateway(commands: string[], timeoutMs = 10_000): Promise<{ events: unknown[]; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gatewayPath], {
      env: { ...process.env, OPENCLAW_STATE_DIR: join(tmpdir(), `wx-gw-test-${Date.now()}`) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const events: unknown[] = []
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
          events.push(JSON.parse(line))
        } catch {
          // ignore
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

describe.skipIf(!existsSync(gatewayPath))('wechat-gateway 冒烟（离线）', () => {
  it('未知命令上报 error，shutdown 后干净退出', async () => {
    const { events, exitCode } = await runGateway([{ cmd: 'noSuchCommand' }, { cmd: 'shutdown' }])
    const statuses = events.filter((e) => (e as { event: string }).event === 'status')
    expect(statuses).toContainEqual({ event: 'status', state: 'stopped' })
    expect(events.some((e) => (e as { event: string }).event === 'error')).toBe(true)
    expect(exitCode).toBe(0)
  })

  it('启动即上报 idle（无本地凭据时）', async () => {
    const { events } = await runGateway([{ cmd: 'shutdown' }])
    expect(events).toContainEqual({ event: 'status', state: 'idle' })
  })
})
