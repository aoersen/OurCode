import { test, expect, type Page } from '@playwright/test'
import { dismissOnboarding, dropUserData, launchApp } from './helpers'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

async function mainWindow(app: import('@playwright/test').ElectronApplication): Promise<Page> {
  let page: Page | null = null
  for (let i = 0; i < 40 && !page; i++) {
    for (const p of app.windows()) {
      try {
        if (await p.evaluate(() => typeof window.electronAPI !== 'undefined')) {
          page = p
          break
        }
      } catch { /* closed mid-poll */ }
    }
    if (!page) await new Promise((r) => setTimeout(r, 500))
  }
  if (!page) throw new Error('main window not found')
  await dismissOnboarding(page)
  return page
}

test.describe('Problems Panel', () => {
  test('shows TypeScript diagnostics and jumps to the problem location', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'problems-'))
    // A file with a guaranteed TS type error
    await writeFile(join(dir, 'broken.ts'), 'const x: number = "hello";\nconst ok = 1;\n', 'utf-8')

    const { app, userData } = await launchApp()
    const win = await mainWindow(app)
    try {
      // Open the folder (stubbed dialog on the main process)
      await app.evaluate(({ dialog }, folder) => {
        ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
      }, dir)
      // Open the folder via Ctrl+O (stubbed dialog). Ctrl+O opens the folder
      // into the PROJECT LIST (new Stitch flow) — the file tree only mounts
      // after double-clicking the project card.
      await expect(async () => {
        await win.keyboard.press('Control+o')
        await expect(win.locator(`text=${dir}`).first()).toBeVisible({ timeout: 4000 })
      }).toPass({ timeout: 25000 })
      await win.locator(`text=${dir}`).first().dblclick()
      await expect(win.locator('#file-tree-root >> text=broken.ts').first()).toBeVisible({ timeout: 8000 })

      // Open the broken file — the TS worker emits a marker
      await win.locator('#file-tree-root >> text=broken.ts').first().click()
      await win.waitForTimeout(1000)

      // Open the Problems panel (Ctrl+Shift+M) and wait for the TS diagnostic
      await win.keyboard.press('Control+Shift+m')
      await expect(win.locator('text=问题').first()).toBeVisible({ timeout: 3000 })
      await expect(
        win.locator('text=not assignable to type').first(),
      ).toBeVisible({ timeout: 15000 })

      // The status bar error count reflects the real marker (was hardcoded 0)
      const errorBtn = win.locator('button[title="打开问题面板"]').first()
      const errorText = await errorBtn.innerText()
      expect(errorText.trim()).toBe('1')

      // Clicking the problem jumps the editor to the offending line
      await win.locator('button', { hasText: 'not assignable to type' }).first().click()
      await win.waitForTimeout(800)
      const cursor = await win.evaluate(() => {
        const ed = (window as any).__monacoEditor
        return ed?.getPosition() || null
      })
      expect(cursor?.lineNumber).toBe(1)
    } finally {
      await app.close()
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      dropUserData(userData)
    }
  })
})
