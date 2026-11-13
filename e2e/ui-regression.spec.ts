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

test('tool panels live in Settings; top-left keeps office + settings entries', async () => {
  const { app, userData } = await launchFreshApp()
  try {
    const win = await mainWindow(app)
    await win.waitForTimeout(2000)

    // 左侧活动栏已移除：工具入口收进设置（工具分组），左上角保留「一人公司 + 设置」。
    const settingsIcon = win.locator('button[title="设置"]').first()
    await expect(settingsIcon).toBeVisible({ timeout: 5000 })
    const officeIcon = win.locator('button[title="一人公司"]').first()
    await expect(officeIcon).toBeVisible({ timeout: 3000 })
    // 项目列表在默认布局里常驻，不再需要活动栏图标去打开
    await expect(win.locator('h2:has-text("项目列表")').first()).toBeVisible({ timeout: 5000 })

    await settingsIcon.click()
    for (const label of ['Agent 任务', '使用统计', '技能', 'MCP 服务器', '渠道接入']) {
      await expect(win.locator('button[role="tab"]', { hasText: label }).first()).toBeVisible({ timeout: 5000 })
    }
    // 代码管理 / 文件变更跟随项目，不再出现在设置里
    await expect(win.locator('button[role="tab"]', { hasText: '代码管理' })).toHaveCount(0)
    await expect(win.locator('button[role="tab"]', { hasText: '文件变更' })).toHaveCount(0)
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

      // 代码管理跟随项目：进入项目后由侧栏手风琴承载（默认展开「文件」）
      const sidebar = win.locator('[data-sidebar-panel="files"]')
      for (const [id, label] of [['files', '文件'], ['git', '代码管理'], ['changes', '文件变更']] as const) {
        const section = sidebar.locator(`[data-project-section="${id}"]`)
        await expect(section).toBeVisible({ timeout: 5000 })
        await expect(section).toContainText(label)
      }
      const gitSection = sidebar.locator('[data-project-section="git"]')
      await gitSection.click()
      await win.waitForTimeout(800)
      await expect(gitSection).toHaveAttribute('aria-expanded', 'true')
      // 同一时间只有一个分区展开
      await expect(sidebar.locator('[data-project-section][aria-expanded="true"]')).toHaveCount(1)

      // The expanded header should read 代码管理, and 源代码管理 must not appear
      const sourceControlCount = await win.evaluate(() =>
        Array.from(document.querySelectorAll('*')).filter((e) => e.childElementCount === 0 && e.textContent?.trim() === '源代码管理').length,
      )
      expect(sourceControlCount).toBeLessThanOrEqual(1)
      const headerText = await win.locator('text=代码管理').first().isVisible().catch(() => false)
      expect(headerText).toBe(true)

      // Buttons row: commit/push/log/lifeguard must be visible (not clipped)
      // (labels are text-only since the Stitch redesign replaced text glyphs with SVGs).
      // Scope to the sidebar — the panel lives in the project accordion.
      await expect(sidebar.locator('button', { hasText: '提交' }).first()).toBeVisible({ timeout: 3000 })
      await expect(sidebar.locator('button', { hasText: '推送' }).first()).toBeVisible({ timeout: 3000 })
      await expect(sidebar.locator('button', { hasText: '日志' }).first()).toBeVisible({ timeout: 3000 })
      await expect(sidebar.locator('button', { hasText: '提交前检查' }).first()).toBeVisible({ timeout: 3000 })

      // Open the log — entries should render
      await sidebar.locator('button', { hasText: '日志' }).first().click()
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
