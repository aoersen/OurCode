import { test, expect, type Page } from '@playwright/test'
import { dismissOnboarding, dropUserData, launchApp } from './helpers'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/** Robustly find the main app window (not DevTools). */
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

/** Open the folder into the project list and enter it (Ctrl+O → dblclick card). */
async function openProject(win: Page, app: import('@playwright/test').ElectronApplication, dir: string) {
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, dir)
  await win.keyboard.press('Control+o')
  await win.waitForTimeout(1500)
  const projName = dir.split(/[/\\]/).pop() || ''
  const card = win.locator(`div.group:has-text("${projName}")`).first()
  await expect(card).toBeVisible({ timeout: 8000 })
  await card.dblclick()
}

test.describe('FileTree restore-expanded', () => {
  test('previously expanded folder shows children after relaunch', async () => {
    test.setTimeout(150000)

    const dir = await mkdtemp(join(tmpdir(), 'tree2-'))
    await mkdir(join(dir, 'folder1'), { recursive: true })
    await writeFile(join(dir, 'folder1', 'a.ts'), 'aaa', 'utf-8')
    await writeFile(join(dir, 'folder1', 'b.ts'), 'bbb', 'utf-8')

    let userData: string | undefined
    try {
      // ── Launch #1: expand folder1 so its state persists to localStorage ──
      const first = await launchApp()
      userData = first.userData
      const app1 = first.app
      const win1 = await mainWindow(app1)
      if (await win1.locator('text=恢复未保存的更改').first().isVisible().catch(() => false)) {
        await win1.mouse.click(10, 10)
        await win1.waitForTimeout(300)
      }
      await win1.evaluate(() => (window as any).electronAPI.clearBackups())
      await openProject(win1, app1, dir)
      await expect(win1.locator('#file-tree-root >> text=folder1').first()).toBeVisible({ timeout: 8000 })
      await win1.locator('#file-tree-root >> text=folder1').first().click()
      await expect(win1.locator('#file-tree-root >> text=a.ts').first()).toBeVisible({ timeout: 8000 })
      // Let the expanded state persist (debounced localStorage write)
      await win1.waitForTimeout(1000)
      await app1.close()

      // ── Launch #2: same profile, so the app restores last project + expanded state ──
      const { app: app2 } = await launchApp({ userData: userData! })
      const win2 = await mainWindow(app2)
      if (await win2.locator('text=恢复未保存的更改').first().isVisible().catch(() => false)) {
        await win2.mouse.click(10, 10)
        await win2.waitForTimeout(300)
      }
      // Open the sidebar (starts hidden) — the files tab reveals the tree.
      // 第一个活动栏图标的 tooltip 已改为「任务面板」（办公室改造的重命名）。
      const explorer = win2.locator('button[title="任务面板"], button[title="Task Panel"], button[title="项目列表"], button[title="Project List"]').first()
      await explorer.click()
      await win2.waitForTimeout(500)
      // Poll for the tree to appear (restoreLastProject may take a moment)
      let sawTree = false
      for (let i = 0; i < 30; i++) {
        await win2.waitForTimeout(500)
        if (await win2.locator('#file-tree-root').first().isVisible().catch(() => false)) { sawTree = true; break }
      }
      console.log('sawTree:', sawTree)
      const diag = await win2.evaluate((root) => {
        const el = document.getElementById('file-tree-root')
        return {
          innerText: el ? el.innerText : '(no tree root)',
          expandedKey: localStorage.getItem('fileTreeExpanded:' + root),
        }
      }, dir)
      console.log('DIAG2:', JSON.stringify(diag, null, 2))
      const body2 = await win2.evaluate(() => document.body.innerText.slice(0, 800))
      console.log('BODY2:\n', JSON.stringify(body2))
      const a = await win2.locator('#file-tree-root >> text=a.ts').first().isVisible().catch(() => false)
      const b = await win2.locator('#file-tree-root >> text=b.ts').first().isVisible().catch(() => false)
      const folderExpanded = await win2.locator('#file-tree-root >> text=folder1').first().isVisible().catch(() => false)
      console.log('RESULT folder1 visible:', folderExpanded, 'a.ts visible:', a, 'b.ts visible:', b)
      expect(folderExpanded).toBe(true)
      expect(a || b).toBe(true)
      await app2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
      if (userData) dropUserData(userData)
    }
  })
})
