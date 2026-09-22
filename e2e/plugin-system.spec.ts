import { test, expect, type Page } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'

/**
 * Finds the main app window (not DevTools) the same way the branding test does —
 * DevTools auto-opens in dev mode and Playwright may surface it first.
 */
async function mainWindow(app: import('@playwright/test').ElectronApplication): Promise<Page> {
  let page: Page | null = null
  for (let i = 0; i < 40 && !page; i++) {
    for (const p of app.windows()) {
      try {
        if (await p.evaluate(() => typeof window.electronAPI !== 'undefined')) {
          page = p
          break
        }
      } catch {
        /* window closed mid-poll */
      }
    }
    if (!page) await new Promise((r) => setTimeout(r, 500))
  }
  if (!page) throw new Error('main window not found')
  await dismissOnboarding(page)
  return page
}

test.describe('Plugin System', () => {
  test('installs and activates a plugin over the RPC bridge (no DataCloneError)', async () => {
    const { app } = await launchApp()
    const window = await mainWindow(app)

    // Install flow asks for permission via window.confirm
    await window.evaluate(() => {
      window.confirm = () => true
    })

    // Plugin management moved into Settings: 设置 (gear) → 功能 tab → 插件（扩展）
    await window.locator('button[title="设置"]').first().click()
    await window.locator('button', { hasText: '功能' }).first().click()

    const pluginSection = window.locator('section', { hasText: '插件（扩展）' })

    // Switch to the "安装扩展" tab
    await pluginSection.locator('button', { hasText: '安装扩展' }).first().click()

    const manifest = JSON.stringify(
      {
        id: 'e2e-test-plugin',
        name: 'E2E Test Plugin',
        version: '1.0.0',
        description: 'Activation test',
        author: 'e2e',
        main: 'index.js',
        permissions: ['editor.read', 'ui.panel'],
      },
      null,
      2,
    )

    const textareas = pluginSection.locator('textarea')
    await textareas.nth(0).fill(manifest)
    await textareas.nth(1).fill(
      `api.editor.getActiveFile().then(() => { api.ui.registerPanel('p', 'P', () => '<b>hi</b>'); });`,
    )

    // Install (the submit button is the second "安装扩展" button)
    await pluginSection.locator('button', { hasText: '安装扩展' }).last().click()
    await expect(window.locator('text=E2E Test Plugin').first()).toBeVisible({ timeout: 5000 })

    // Enable it → the sandbox must send 'ready' back over the MessageChannel.
    // Before the RPC fix, activation threw DataCloneError and the badge showed
    // "错误" instead of "已启用" (the active badge label — 运行中 was renamed).
    await pluginSection.locator('button', { hasText: '启用' }).first().click()
    await expect(window.locator('text=已启用').first()).toBeVisible({ timeout: 8000 })

    await app.close()
  })
})
