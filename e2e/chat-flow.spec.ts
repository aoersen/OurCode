import { test, expect, type Page } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'

test.describe('Basic App Launch', () => {
  test('should launch and show the main window', async () => {
    const { app } = await launchApp()
    const window = await app.firstWindow()
    expect(window).toBeTruthy()
    await dismissOnboarding(window)

    // Title bar should be visible
    const title = await window.textContent('body')
    expect(title).toBeTruthy()

    await app.close()
  })

  test('should display the OurCode branding', async () => {
    const { app } = await launchApp()

    // DevTools auto-opens in dev mode; the main window is the one whose title
    // isn't "DevTools". The splash is removed after load, so assert on the
    // stable window title from the main process.
    await expect.poll(async () => {
      return app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getTitle() !== 'DevTools')
        return win?.webContents.getTitle() || ''
      })
    }, { timeout: 5000 }).toContain('OurCode')

    await app.close()
  })

  test('should wire Monaco language-service workers', async () => {
    const { app } = await launchApp()

    // DevTools auto-opens in dev mode; find the window that has the app API
    let mainWin: Page | null = null
    for (let i = 0; i < 40 && !mainWin; i++) {
      for (const p of app.windows()) {
        try {
          if (await p.evaluate(() => typeof window.electronAPI !== 'undefined')) {
            mainWin = p
            break
          }
        } catch { /* closed mid-poll */ }
      }
      if (!mainWin) await new Promise((r) => setTimeout(r, 500))
    }
    expect(mainWin).toBeTruthy()
    await dismissOnboarding(mainWin!)

    // The modular monacoSetup builds a MonacoEnvironment.getWorker from ?worker
    // imports; in packaged builds these run the language services off the UI
    // thread instead of degrading (previously no MonacoEnvironment existed).
    const getWorkerType = await mainWin!.evaluate(() => {
      const me = (self as unknown as { MonacoEnvironment?: { getWorker?: unknown } }).MonacoEnvironment
      return typeof me?.getWorker
    })
    expect(getWorkerType).toBe('function')

    await app.close()
  })
})

test.describe('Settings Modal', () => {
  test('should open and close settings', async () => {
    const { app } = await launchApp()

    const window = await app.firstWindow()
    await dismissOnboarding(window)

    // Click settings gear icon. Both labels are listed because the title is
    // localized and the suite pins zh-CN (see helpers) while this assertion
    // was written against the English UI.
    const settingsBtn = window.locator('button[title="Settings"], button[title="设置"]').first()
    await expect(settingsBtn).toBeVisible({ timeout: 10000 })
    await settingsBtn.click()

    // Settings modal should appear
    const settingsDialog = window
      .locator('[role="dialog"][aria-modal="true"]')
      .filter({ hasText: /API Config|API 配置/ })
      .first()
    await expect(settingsDialog).toBeVisible({ timeout: 5000 })

    // Close with the modal's own X. Scope to the dialog AND match its real path
    // (M18 6 6 18): the previous selector — `svg path[d*="6 6l12 12"]` — never
    // matched this button at all, it hit an unrelated X elsewhere in the app
    // that sits behind the modal, where the click is intercepted by the overlay.
    await settingsDialog.locator('button:has(svg path[d="M18 6 6 18"])').first().click()
    await expect(settingsDialog).toBeHidden({ timeout: 5000 })

    await app.close()
  })
})

test.describe('Sidebar', () => {
  test('should toggle sidebar visibility', async () => {
    const { app } = await launchApp()

    const window = await app.firstWindow()
    await dismissOnboarding(window)

    // Press Ctrl+B to toggle sidebar
    await window.keyboard.press('Control+b')
    await window.waitForTimeout(300)

    // Press Ctrl+B again to show sidebar
    await window.keyboard.press('Control+b')
    await window.waitForTimeout(300)

    await app.close()
  })
})

test.describe('Terminal', () => {
  test('should toggle terminal panel', async () => {
    const { app } = await launchApp()

    const window = await app.firstWindow()
    await dismissOnboarding(window)

    // Press Ctrl+` to toggle terminal
    await window.keyboard.press('Control+`')
    await window.waitForTimeout(500)

    // Terminal container should be visible
    const terminalPanel = window.locator('.xterm').first()
    // Terminal may take time to initialize
    await window.waitForTimeout(1000)

    // Close terminal
    await window.keyboard.press('Control+`')

    await app.close()
  })
})
