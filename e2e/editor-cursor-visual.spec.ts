import { test, expect, type Page } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'
import { mkdtemp, writeFile } from 'fs/promises'
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

test.describe('Light-mode editor deep diagnostic', () => {
  test('real file + real light theme: every cursor surface, caret, content', async () => {
    test.setTimeout(200000)
    const dir = await mkdtemp(join(tmpdir(), 'cursor-real-'))
    await writeFile(join(dir, 'demo.ts'), 'const answer = 42\nconsole.log(answer)\n', 'utf-8')

    // ── Launch 0: clean persisted project/session state ──
    const first = await launchApp()
    const app0 = first.app
    const win0 = await mainWindow(app0)
    await win0.evaluate(() => {
      localStorage.setItem('lastProjectState', JSON.stringify({ path: null, view: 'list' }))
      localStorage.removeItem('ourcode.editorSession.v1')
      ;(window as any).electronAPI.clearBackups()
    })
    await app0.close()
    await new Promise((r) => setTimeout(r, 500))

    // ── Launch 1: the real test (same profile as launch 0) ──
    const { app } = await launchApp({ userData: first.userData })
    const win = await mainWindow(app)

    await app.evaluate(({ dialog }, folder) => {
      ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    }, dir)
    await win.keyboard.press('Control+o')
    await expect(async () => {
      await win.keyboard.press('Control+o')
      await expect(win.locator(`text=${dir}`).first()).toBeVisible({ timeout: 4000 })
    }).toPass({ timeout: 25000 })
    await win.locator(`text=${dir}`).first().dblclick()
    await expect(win.locator('#file-tree-root >> text=demo.ts').first()).toBeVisible({ timeout: 8000 })
    await win.locator('#file-tree-root >> text=demo.ts').first().click()
    await win.waitForTimeout(1200)

    // Ensure light theme through the REAL settings UI (setTheme + savePreferences)
    await win.locator('button', { hasText: /文件|File/ }).first().click()
    await win.locator('button', { hasText: /偏好设置|Preferences/ }).first().click()
    const settingsDialog = win.locator('[role="dialog"]').first()
    await settingsDialog.locator('button', { hasText: /外观|Appearance/ }).first().click()
    const themeRow = settingsDialog.locator('div.flex.items-center.justify-between', { hasText: /界面主题|Interface Theme/ }).first()
    await expect(themeRow).toBeVisible({ timeout: 10000 })
    const sel = themeRow.locator('select')
    const current = await sel.inputValue()
    if (current !== 'light') await sel.selectOption({ label: '☀️ 浅色模式' })
    await win.waitForTimeout(600)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)

    // Focus the editor so the caret renders
    await win.evaluate(() => {
      const ed = (window as any).__monacoEditor
      const model = ed?.getModel()
      if (ed && model) {
        ed.setPosition({ lineNumber: 2, column: 5 })
        ed.focus()
      }
    })
    await win.waitForTimeout(400)

    const info = await win.evaluate(() => {
      const root = document.querySelector('.monaco-editor')
      const probes = ('.view-lines,.view-line,.lines-content,.view-overlays,.margin,.cursors-layer,.cursor,.monaco-editor-background,.overflow-guard,.editor-scrollable,inputarea').split(',')
      const cursors: Record<string, string | null> = {}
      for (const cls of probes) {
        const el = root?.querySelector(cls)
        if (el) cursors[cls] = getComputedStyle(el).cursor
      }
      const caret = root?.querySelector('.cursor')
      const caretCS = caret ? getComputedStyle(caret) : null
      const firstLine = root?.querySelector('.view-line span span')
      const firstToken = firstLine ? getComputedStyle(firstLine) : null
      return {
        htmlDark: document.documentElement.classList.contains('dark'),
        rootClass: root?.className ?? null,
        rootBg: root ? getComputedStyle(root).backgroundColor : null,
        viewLineCount: root?.querySelectorAll('.view-line').length ?? 0,
        cursors,
        caret: caretCS ? {
          visibility: caretCS.visibility,
          borderColor: caretCS.borderLeftColor,
          bg: caretCS.backgroundColor,
        } : null,
        firstTokenColor: firstToken ? firstToken.color : null,
      }
    })
    console.log('LIGHT-REAL:', JSON.stringify(info, null, 1))

    await win.screenshot({ path: join(__dirname, 'cursor-light-real.png') })
    await app.close()
  })
})
