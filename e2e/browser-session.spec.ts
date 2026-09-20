import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type AddressInfo } from 'net'
import http from 'http'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 内置浏览器会话的端到端验证。
 *
 * 单测（src/__tests__/browserSession.test.ts）覆盖的是纯函数（URL 规整、控制台
 * 渲染、注入脚本）；这里验证只有真 Electron 才有的部分：隐藏窗口是否真能加载页
 * 面、页面 console/未捕获异常是否被主进程捕获并推到渲染层、capturePage 是否出图，
 * 以及导航拦截没有把应用自己拦坏。userData 走临时目录沙箱。
 */

const PAGE_HTML = `<!doctype html><html><head><title>OurCode E2E Page</title></head>
<body><h1>ready</h1><button id="go">go</button>
<script>
  console.log('e2e-console-ready');
  console.warn('e2e-warning-here');
  setTimeout(() => { throw new Error('e2e-boom'); }, 200);
</script></body></html>`

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function launchSandbox(): Promise<{ app: ElectronApplication; win: Page; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'ourcode-browser-'))
  const app = await electron.launch({
    args: [join(__dirname, '../dist-electron/main.js')],
    env: { ...process.env, OURCODE_USER_DATA: userData },
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
  await win.evaluate(() => localStorage.setItem('hasCompletedOnboarding', 'true'))
  await win.reload()
  await win.waitForTimeout(1500)
  return { app, win, userData }
}

async function openBrowserPanel(win: Page): Promise<void> {
  const icon = win.locator('button[title="浏览器"], button[aria-label="浏览器"], button[title="Browser"]').first()
  await expect(icon).toBeVisible({ timeout: 10_000 })
  await icon.click()
  await expect(win.locator('[data-browser-address="true"]')).toBeVisible({ timeout: 5000 })
}

test('navigates, captures console output and screenshots a real page', async () => {
  const { url: pageUrl, close: closeServer } = await startServer()
  const { app, win, userData } = await launchSandbox()
  try {
    await openBrowserPanel(win)
    const address = win.locator('[data-browser-address="true"]')
    await address.fill(pageUrl)
    await address.press('Enter')

    // The panel mirrors the main-process buffer: a log line, a warning line and
    // the uncaught error — that error is the whole point (it is what the agent
    // could not see before this existed).
    await expect(win.getByText('e2e-console-ready')).toBeVisible({ timeout: 15_000 })
    await expect(win.getByText('e2e-warning-here')).toBeVisible({ timeout: 10_000 })
    await expect(win.getByText(/e2e-boom/)).toBeVisible({ timeout: 10_000 })

    // Page title flows back through page-title-updated → state → panel header.
    await expect(win.getByText('OurCode E2E Page')).toBeVisible({ timeout: 10_000 })

    await win.locator('button', { hasText: '截图' }).first().click()
    const shot = win.locator('img[src^="data:image/png"]').first()
    await expect(shot).toBeVisible({ timeout: 15_000 })
    // A real frame, not an empty data URL — hidden windows must still paint.
    const size = await shot.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight }))
    expect(size.w).toBeGreaterThan(200)
    expect(size.h).toBeGreaterThan(200)

    // Back/forward + reload wiring.
    await win.locator('button[title="刷新"]').first().click()
    await expect(win.getByText('e2e-console-ready')).toHaveCount(2, { timeout: 15_000 })
  } finally {
    await app.close().catch(() => {})
    await closeServer()
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('refuses to load anything that is not http(s)', async () => {
  const { app, win, userData } = await launchSandbox()
  try {
    await openBrowserPanel(win)
    const address = win.locator('[data-browser-address="true"]')
    // A file URL would read the workspace into a page context; the app's own
    // preview scheme is equally off-limits inside the browser session.
    await address.fill('file:///etc/hosts')
    await address.press('Enter')
    await expect(win.getByText(/只允许 http\/https/)).toBeVisible({ timeout: 8000 })
  } finally {
    await app.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
