import { test, expect, type Page } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/** Launch with a throwaway userData — the shared default userData restores
 *  stale tabs (same basenames like a.ts) that skew tab-count assertions. */
async function launchFreshApp(): Promise<{ app: import('@playwright/test').ElectronApplication; userData: string }> {
  return launchApp()
}

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

async function openProjectFile(win: Page, app: import('@playwright/test').ElectronApplication, dir: string, fileName: string): Promise<void> {
  await dismissOnboarding(win)
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, dir)
  await win.keyboard.press('Control+o')
  // Opening a folder may land in the tree view of the previously active
  // project — go back to the project list, then open the new folder's card.
  await expect(async () => {
    await win.keyboard.press('Control+o')
    await win.waitForTimeout(600)
    const backBtn = win.locator('button:has-text("项目列表")').first()
    if (await backBtn.isVisible().catch(() => false)) {
      await backBtn.click()
      await win.waitForTimeout(400)
    }
    const projName = dir.split(/[/\\]/).pop() || ''
    await expect(win.locator(`div.group:has-text("${projName}")`).first()).toBeVisible({ timeout: 4000 })
  }).toPass({ timeout: 25000 })
  await dismissOnboarding(win)
  await win.locator(`div.group:has-text("${dir.split(/[/\\]/).pop()}")`).first().dblclick()
  await expect(win.locator(`#file-tree-root >> text=${fileName}`).first()).toBeVisible({ timeout: 8000 })
  await win.locator(`#file-tree-root >> text=${fileName}`).first().click()
  await win.waitForTimeout(1000)
}

async function appendToEditor(win: Page, text: string): Promise<void> {
  await win.evaluate(() => {
    const ed = (window as any).__monacoEditor
    const model = ed?.getModel()
    if (ed && model) {
      const lastLine = model.getLineCount()
      ed.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) })
      ed.focus()
    }
  })
  await win.keyboard.type(text)
  await win.waitForTimeout(300)
}

/** The tab bar entry for `fileName` (a rounded-full tab div). */
const tabFor = (win: Page, fileName: string) => win.locator('div.rounded-full', { hasText: fileName }).last()
/** The ✕ close button of a tab (the last button inside the tab div). */
const closeBtnOf = (tab: ReturnType<typeof tabFor>) => tab.locator('button').last()
/** The Save / Don't Save / Cancel prompt. */
const prompt = (win: Page) => win.locator('[role="dialog"]:has-text("未保存的更改")').first()

async function dismissRestoreModal(win: Page): Promise<void> {
  if (await win.locator('text=恢复未保存的更改').first().isVisible().catch(() => false)) {
    await win.mouse.click(10, 10)
    await win.waitForTimeout(300)
  }
  await win.evaluate(() => (window as any).electronAPI.clearBackups())
}

test.describe('Unsaved-close flow (no autosave)', () => {
  test('dirty tab close offers Save / Don\'t Save / Cancel', async () => {
    test.setTimeout(150000)
    const dir = await mkdtemp(join(tmpdir(), 'unsaved-close-'))
    await writeFile(join(dir, 'a.ts'), 'line one\n', 'utf-8')

    const { app, userData } = await launchFreshApp()
    try {
      const win = await mainWindow(app)
      await dismissRestoreModal(win)
      await openProjectFile(win, app, dir, 'a.ts')
      await appendToEditor(win, ' EDITED')

      // Autosave must be gone: after a beat, disk still has the original text
      await win.waitForTimeout(2500)
      expect(await readFile(join(dir, 'a.ts'), 'utf-8')).toBe('line one\n')

      // Close the tab → Save / Don't Save / Cancel dialog appears
      await closeBtnOf(tabFor(win, 'a.ts')).click()
      await expect(prompt(win)).toBeVisible({ timeout: 5000 })
      // Exact match — '保存' also appears inside '不保存，关闭'
      await expect(prompt(win).getByRole('button', { name: '保存', exact: true })).toBeVisible()

      // Cancel → tab stays open, content intact
      await prompt(win).locator('button', { hasText: '取消' }).click()
      await expect(tabFor(win, 'a.ts')).toBeVisible()
      const modelText = await win.evaluate(() => (window as any).__monacoEditor?.getModel()?.getValue() ?? '')
      expect(modelText).toContain('EDITED')

      // Don't Save → closes, disk unchanged
      await closeBtnOf(tabFor(win, 'a.ts')).click()
      await expect(prompt(win)).toBeVisible({ timeout: 5000 })
      await prompt(win).locator('button', { hasText: /不保存/ }).click()
      await expect(tabFor(win, 'a.ts')).toHaveCount(0, { timeout: 5000 })
      expect(await readFile(join(dir, 'a.ts'), 'utf-8')).toBe('line one\n')
    } finally {
      await app.close().catch(() => {})
      await rm(userData, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('dirty tab close Save writes to disk then closes', async () => {
    test.setTimeout(150000)
    const dir = await mkdtemp(join(tmpdir(), 'unsaved-save-'))
    await writeFile(join(dir, 'b.ts'), 'hello', 'utf-8')

    const { app, userData } = await launchFreshApp()
    try {
      const win = await mainWindow(app)
      await dismissRestoreModal(win)
      await openProjectFile(win, app, dir, 'b.ts')
      await appendToEditor(win, ' world')

      await closeBtnOf(tabFor(win, 'b.ts')).click()
      await expect(prompt(win)).toBeVisible({ timeout: 5000 })
      await prompt(win).getByRole('button', { name: '保存', exact: true }).click()

      await expect(tabFor(win, 'b.ts')).toHaveCount(0, { timeout: 5000 })
      // The typed text must reach disk (a trailing newline may be appended on
      // save — assert containment, not byte-exact equality).
      expect(await readFile(join(dir, 'b.ts'), 'utf-8')).toContain('hello world')
    } finally {
      await app.close().catch(() => {})
      await rm(userData, { recursive: true, force: true }).catch(() => {})
    }
  })
})
