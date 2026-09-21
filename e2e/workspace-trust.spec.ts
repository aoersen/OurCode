import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'

/**
 * The workspace-trust boundary, exercised against the real main process.
 *
 * What matters here is that the gate lives in main: a renderer (or an agent
 * driving one) must not be able to name a folder and get access to it, while
 * the app's own data directory stays usable. The native confirmation dialog is
 * OS chrome Playwright can't reach, so the granting path is covered by the
 * unit tests instead.
 */

async function launchApp(userData: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [path.join(__dirname, '../dist-electron/main.js')],
    env: { ...process.env, OURCODE_USER_DATA: userData },
  })
  let win: Page | null = null
  for (let i = 0; i < 60 && !win; i++) {
    for (const p of app.windows()) {
      try {
        if (await p.evaluate(() => typeof (window as any).electronAPI !== 'undefined')) { win = p; break }
      } catch { /* closed mid-poll */ }
    }
    if (!win) await new Promise((r) => setTimeout(r, 500))
  }
  if (!win) throw new Error('main window not found')
  await win.evaluate(() => localStorage.setItem('hasCompletedOnboarding', 'true'))
  await win.reload()
  await win.waitForTimeout(1500)
  return { app, win }
}

test('an untrusted folder is unreachable, the app data dir is not', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ourcode-trust-e2e-'))
  const victimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ourcode-trust-victim-'))
  const outside = path.join(victimRoot, 'workspace')
  const secretFile = path.join(outside, 'secret.txt')
  const skillsDir = path.join(userData, 'skills')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(secretFile, 'do not read me\n', 'utf-8')

  const { app, win } = await launchApp(userData)
  try {
    const result = await win.evaluate(async (paths: {
      outside: string; secretFile: string; userData: string; skillsDir: string
    }) => {
      const e = (window as any).electronAPI
      const out: Record<string, unknown> = {}
      out.authorize = await e.authorize(paths.outside)
      out.watch = await e.watch(paths.outside)
      out.trustStatus = await e.trustStatus(paths.outside)
      out.appOwnedAuthorize = await e.authorize(paths.userData)
      out.appOwnedStat = !!(await e.stat(paths.userData))
      out.skillsDir = Array.isArray(await e.listDir(paths.skillsDir))
      try {
        out.read = await e.readFile(paths.secretFile)
      } catch (err: any) {
        out.read = String(err?.message || err)
      }
      return out
    }, { outside, secretFile, userData, skillsDir })

    expect(result).toMatchObject({
      authorize: false,
      watch: { ok: false, untrusted: true },
      trustStatus: { trusted: false },
      appOwnedAuthorize: true,
      appOwnedStat: true,
      skillsDir: true,
    })
    expect(String(result.read)).toContain('路径不在允许范围内')
  } finally {
    await app.close()
    fs.rmSync(userData, { recursive: true, force: true })
    fs.rmSync(victimRoot, { recursive: true, force: true })
  }
})
