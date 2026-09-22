import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { APP_LAUNCH_ARGS } from './helpers'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * agent ↔ 集成终端打通：助手用 run_command(background=true) 起的进程是真的
 * node-pty 会话，跑在主进程里，被终端面板 attach 成一个标签。
 *
 * 这里从渲染进程直接调用 electronAPI 的那几个通道（term:runAgent / output /
 * kill / list / attach）——工具层（helpers.runCommandBackground 等）只是它们的
 * 薄封装，纯文本处理由 src/__tests__/terminalRuns.test.ts 覆盖。真正必须在真
 * Electron 里验的是：pty 确实跑起来并产出可读取的输出、用户自己的终端不会被
 * stop_terminal 杀掉、以及终端面板能把这个会话 attach 出来给人看。
 */

const SEED_GROUP = {
  id: 'agent-term-group',
  name: '演示配置组',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-demo',
  systemPrompt: '',
  defaultModel: 'gpt-4o',
  provider: 'openai',
  customHeaders: {},
  color: '#3b82f6',
}

const SECRET = 'leaked-from-parent-env'

/** Reading a variable that must have been scrubbed: both shells expand ${…},
 *  but PowerShell needs the `env:` scope prefix to see environment variables. */
const SECRET_PROBE =
  process.platform === 'win32'
    ? 'echo "MARKER-${env:E2E_TEST_API_KEY}-END"'
    : 'echo "MARKER-${E2E_TEST_API_KEY}-END"'

async function launchSandbox(dir: string): Promise<{ app: Awaited<ReturnType<typeof electron.launch>>; win: Page }> {
  const app = await electron.launch({
    args: [...APP_LAUNCH_ARGS],
    env: {
      ...process.env,
      OURCODE_USER_DATA: dir,
      // Credential-shaped name: scrubbedSpawnEnv() must strip it before the
      // pty starts, so a command the assistant runs cannot read it back.
      E2E_TEST_API_KEY: SECRET,
    },
  })
  let win: Page | null = null
  for (let i = 0; i < 40 && !win; i++) {
    for (const p of app.windows()) {
      try {
        if (await p.evaluate(() => typeof (window as any).electronAPI !== 'undefined')) {
          win = p
          break
        }
      } catch { /* closed mid-poll */ }
    }
    if (!win) await new Promise((r) => setTimeout(r, 500))
  }
  if (!win) {
    await app.close()
    throw new Error('main window not found')
  }
  await win.evaluate((group) => {
    localStorage.setItem('hasCompletedOnboarding', 'true')
    void (window as any).electronAPI.saveConfigGroup(group)
  }, SEED_GROUP)
  await win.reload()
  await win.waitForTimeout(2000)
  return { app, win }
}

test('AI 后台命令跑在集成终端的 pty 里：可读输出、可停止、可 attach', async () => {
  test.setTimeout(180000)
  const userData = mkdtempSync(join(tmpdir(), 'agent-terminal-ud-'))
  const { app, win } = await launchSandbox(userData)

  const outputOf = (id: string, tail?: number) =>
    win.evaluate(([a, t]) => (window as any).electronAPI.termOutput(a, t), [id, tail] as const)

  try {
    // ① start a command that exits on its own — the credential probe
    const probeId = 'agent-e2e-probe'
    await win.evaluate(([id, command]) => (window as any).electronAPI.termRunAgent(id, command), [probeId, SECRET_PROBE] as const)

    // The shell really ran (so "no secret" below is a scrub result, not a
    // command that silently failed), and nothing credential-shaped leaked.
    await expect
      .poll(async () => (await outputOf(probeId))?.output ?? '', { timeout: 30000 })
      .toContain('MARKER--END')
    const probeOut = (await outputOf(probeId)).output
    expect(probeOut).not.toContain(SECRET)

    // ② a process that keeps running: read it, then stop it
    const loopId = 'agent-e2e-loop'
    const tickCommand = process.platform === 'win32'
      ? 'while ($true) { Write-Output E2E-TICK; Start-Sleep -Milliseconds 300 }'
      : 'while true; do echo E2E-TICK; sleep 0.3; done'
    await win.evaluate(([id, command]) => (window as any).electronAPI.termRunAgent(id, command), [loopId, tickCommand] as const)
    await expect
      .poll(async () => (await outputOf(loopId))?.output ?? '', { timeout: 30000 })
      .toContain('E2E-TICK')
    expect((await outputOf(loopId)).running).toBe(true)

    // ③ the session list is the main process's — both runs show up in start order,
    //    and the finished one reports an exit code (the shell exits a moment
    //    after its output lands, so wait for that rather than assume it)
    await expect
      .poll(async () => {
        const runs = await win.evaluate(() => (window as any).electronAPI.termList())
        const probe = runs.find((r: { id: string }) => r.id === probeId)
        return probe && !probe.running && typeof probe.exitCode === 'number' ? 'exited' : 'running'
      }, { timeout: 30000 })
      .toBe('exited')
    const listed = await win.evaluate(() => (window as any).electronAPI.termList())
    expect(listed.map((r: { id: string }) => r.id)).toEqual([probeId, loopId])
    expect(listed[1].running).toBe(true)

    // ④ a terminal tab the user opened themselves must not be killable
    const userId = 'term-user-e2e'
    await win.evaluate((id) => (window as any).electronAPI.termCreate(id), userId)
    expect(await win.evaluate((id) => (window as any).electronAPI.termKill(id), userId)).toBe(false)
    expect(await win.evaluate((id) => (window as any).electronAPI.termAttach(id), userId)).toBeNull()
    // …and its scrollback is not readable either (users type secrets in there)
    expect(await outputOf(userId)).toBeNull()

    // ⑤ stop_terminal semantics: killing an agent run works and is final
    expect(await win.evaluate((id) => (window as any).electronAPI.termKill(id), loopId)).toBe(true)
    await expect
      .poll(async () => (await outputOf(loopId))?.running, { timeout: 15000 })
      .toBe(false)

    // ⑥ 打通的可见部分：打开终端面板 → 每个后台会话一个可 attach 的标签，
    //    attach 时重放已经产出的输出（进程结束后再打开也看得到历史）。
    await win.locator('body').press('Control+`')
    const panel = win.locator('.xterm')
    await expect(panel.first()).toBeVisible({ timeout: 15000 })
    const agentTab = win.getByText(/^AI: echo "MARKER/).first()
    await expect(agentTab).toBeVisible({ timeout: 15000 })
    await agentTab.click()
    await expect
      .poll(async () => await win.evaluate(() => document.body.innerText.includes('MARKER--END')), { timeout: 15000 })
      .toBe(true)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
