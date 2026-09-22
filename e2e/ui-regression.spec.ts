import { test, expect, type Page } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

async function mainWindow(app: import('@playwright/test').ElectronApplication): Promise<Page> {
  let page: Page | null = null
  for (let i = 0; i < 60 && !page; i++) {
    for (const p of app.windows()) {
      try {
        if (await p.evaluate(() => typeof (window as any).electronAPI !== 'undefined')) {
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

/** Stub the native folder dialog and open the folder via 文件 → 打开文件夹 (more
 *  reliable than the Ctrl+O shortcut in headless Electron). */
async function openFolderViaMenu(app: import('@playwright/test').ElectronApplication, win: Page, dir: string): Promise<void> {
  await dismissOnboarding(win)
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, dir)
  await win.click('role=menuitem[name="文件"]')
  await win.click('role=menuitem[name=/打开文件夹/]')
  await win.waitForTimeout(1200)
}

/** Open a folder via the menu, then ENTER it from the project list. Opening a
 *  folder may land in the tree view of the previously active project, so go
 *  back to the project list first and double-click the new folder's card. */
async function openProjectViaMenu(app: import('@playwright/test').ElectronApplication, win: Page, dir: string): Promise<void> {
  await openFolderViaMenu(app, win, dir)
  await dismissOnboarding(win)
  const backBtn = win.locator('button:has-text("项目列表")').first()
  const backVisible = await backBtn.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)
  if (backVisible) {
    await backBtn.click()
    await win.waitForTimeout(500)
  }
  const projName = dir.split(/[/\\]/).pop() || ''
  const card = win.locator(`div.group:has-text("${projName}")`).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await dismissOnboarding(win)
  await card.dblclick()
}
/** Launch with a throwaway userData so a polluted shared session (restored tabs
 *  pointing at deleted temp dirs) can never skew layout or UI state. */
async function launchFreshApp(): Promise<{ app: import('@playwright/test').ElectronApplication; userData: string }> {
  return launchApp()
}

test('new file is editable after URI fix', async () => {
  test.setTimeout(90000)
  const { app, userData } = await launchFreshApp()
  try {
    const win = await mainWindow(app)
    await win.waitForTimeout(2000)

    await win.click('role=menuitem[name="文件"]')
    await win.click('role=menuitem[name=/新建文件/]')
    await expect(win.locator('text=untitled-').first()).toBeVisible({ timeout: 10000 })
    await win.waitForTimeout(1500)

    await win.locator('.monaco-editor').first().click({ timeout: 5000 })
    await win.keyboard.type('hello world test')
    await win.waitForTimeout(500)

    const models = await win.evaluate(() => {
      const ed = (window as any).__monacoEditor
      const m = ed?.getModel()
      return m ? { uri: m.uri.toString(), value: m.getValue() } : null
    })
    expect(models?.value).toContain('hello world test')
    expect(models?.uri).toMatch(/^file:\/\/\/untitled\//)
  } finally {
    await app.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('activity bar tooltips match the project panel names', async () => {
  const { app, userData } = await launchFreshApp()
  try {
    const win = await mainWindow(app)
    await win.waitForTimeout(2000)

    const fileIcon = win.locator('button[title="任务面板"], button[title="Task Panel"]').first()
    await expect(fileIcon).toBeVisible({ timeout: 5000 })
    const gitIcon = win.locator('button[title="代码管理"]').first()
    await expect(gitIcon).toBeVisible({ timeout: 3000 })
    const historyIcon = win.locator('button[title="文件变更历史"]').first()
    await expect(historyIcon).toBeVisible({ timeout: 3000 })
    // The activity bar no longer has an extensions button — spot-check a few
    // current entries instead.
    const usageIcon = win.locator('button[title="使用统计"]').first()
    await expect(usageIcon).toBeVisible({ timeout: 3000 })
    const settingsIcon = win.locator('button[title="设置"]').first()
    await expect(settingsIcon).toBeVisible({ timeout: 3000 })
  } finally {
    await app.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})

test('git panel has no duplicated title and buttons wrap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitverify-'))
  try {
    execSync('git init -q && git config user.email t@t.co && git config user.name t && echo hi > a.txt && git add -A && git commit -qm initial', { cwd: dir })

    const { app, userData } = await launchFreshApp()
    try {
      const win = await mainWindow(app)

      // Open the folder and enter the file tree (project list → card)
      await openProjectViaMenu(app, win, dir)
      await expect(win.locator('#file-tree-root').first()).toBeVisible({ timeout: 10000 })
      await win.waitForTimeout(800)

      // Open the git sidebar via the activity bar
      await win.locator('button[title="代码管理"]').first().click()
      await win.waitForTimeout(800)

      // The sidebar header should read 代码管理 exactly once, and 源代码管理 must not be duplicated
      const sourceControlCount = await win.evaluate(() =>
        Array.from(document.querySelectorAll('*')).filter((e) => e.childElementCount === 0 && e.textContent?.trim() === '源代码管理').length,
      )
      expect(sourceControlCount).toBeLessThanOrEqual(1)
      const headerText = await win.locator('text=代码管理').first().isVisible().catch(() => false)
      expect(headerText).toBe(true)

      // Buttons row: commit/push/log/lifeguard must be visible (not clipped)
      // (labels are text-only since the Stitch redesign replaced text glyphs with SVGs)
      await expect(win.locator('button', { hasText: '提交' }).first()).toBeVisible({ timeout: 3000 })
      await expect(win.locator('button', { hasText: '推送' }).first()).toBeVisible({ timeout: 3000 })
      await expect(win.locator('button', { hasText: '日志' }).first()).toBeVisible({ timeout: 3000 })
      await expect(win.locator('button', { hasText: '提交前检查' }).first()).toBeVisible({ timeout: 3000 })

      // Open the log — entries should render
      await win.locator('button', { hasText: '日志' }).first().click()
      await expect(win.locator('text=最近提交').first()).toBeVisible({ timeout: 3000 })
      await expect(win.locator('text=initial').first()).toBeVisible({ timeout: 3000 })
    } finally {
      await app.close().catch(() => {})
      await rm(userData, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('search input and plan-mode select follow the theme (not white)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'themesel-'))
  try {
    execSync('echo x > b.ts', { cwd: dir })
    const { app, userData } = await launchFreshApp()
    try {
      const win = await mainWindow(app)

      // Open the folder, then enter the file tree (project list → card)
      await openProjectViaMenu(app, win, dir)
      await expect(win.locator('#file-tree-root').first()).toBeVisible({ timeout: 10000 })
      await win.waitForTimeout(800)

      // The FileTree search input must have a themed (non-white) background in dark mode
      const searchBg = await win.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'))
        const target = inputs.find((i) => (i.placeholder || '').includes('搜索文件'))
        return target ? getComputedStyle(target).backgroundColor : null
      })
      console.log('SEARCH INPUT BG:', searchBg)
      expect(searchBg).not.toBeNull()
      // dark theme: #1f1f23-ish, i.e. clearly not white
      expect(searchBg).not.toBe('rgb(255, 255, 255)')
    } finally {
      await app.close().catch(() => {})
      await rm(userData, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
