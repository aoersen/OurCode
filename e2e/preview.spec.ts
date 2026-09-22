import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/** Robustly find the main app window (not DevTools), dismissing the first-run
 *  onboarding modal if it shows. */
async function mainWindow(app: ElectronApplication): Promise<Page> {
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

async function openProject(win: Page, app: ElectronApplication, dir: string) {
  await dismissOnboarding(win)
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, dir)
  await win.keyboard.press('Control+o')
  // Opening a folder may land in the tree view of the previously active
  // project — go back to the project list, then open the new folder's card
  // (recent projects render as div.group cards). Re-press Ctrl+O in the loop:
  // the first press can be lost while the window is still settling.
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
  await expect(win.locator('#file-tree-root >> text=index.html').first()).toBeVisible({ timeout: 8000 })
}

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('File preview views (html / markdown / image)', () => {
  test('html gets a live browser preview, markdown renders, image previews', async () => {
    test.setTimeout(180000)

    const dir = await mkdtemp(join(tmpdir(), 'preview-'))
    // Fresh userData so the app starts with an empty session/layout (the shared
    // default userData can carry a polluted editor session from other runs).
    const userData = await mkdtemp(join(tmpdir(), 'preview-ud-'))
    await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><h1 id="t">Hello Preview</h1></body></html>', 'utf-8')
    await writeFile(join(dir, 'README.md'), '# 预览标题\n\n**加粗** 内容\n\n![pic](pic.png)\n', 'utf-8')
    await writeFile(join(dir, 'pic.png'), TINY_PNG)

    let app: ElectronApplication | null = null
    try {
      app = (await launchApp({ userData })).app
      const win = await mainWindow(app)
      if (await win.locator('text=恢复未保存的更改').first().isVisible().catch(() => false)) {
        await win.mouse.click(10, 10)
        await win.waitForTimeout(300)
      }
      await win.evaluate(() => (window as any).electronAPI.clearBackups())
      await openProject(win, app, dir)

      // ── HTML: toolbar + embedded iframe over the local-file protocol ──
      await win.locator('#file-tree-root >> text=index.html').first().click()
      await expect(win.locator('[data-testid="preview-toolbar"]')).toBeVisible({ timeout: 8000 })
      const toolbar = win.locator('[data-testid="preview-toolbar"]')
      // HTML defaults straight to the preview, and offers no side-by-side
      await expect(toolbar.locator('button', { hasText: '编辑' })).toBeVisible()
      await expect(toolbar.locator('button', { hasText: '预览' })).toBeVisible()
      await expect(toolbar.locator('button', { hasText: '分屏' })).toHaveCount(0)
      const frame = win.locator('iframe[title="HTML Preview"]')
      await expect(frame).toBeVisible({ timeout: 8000 })
      const src = await frame.getAttribute('src')
      expect(src).toContain('ourcode-file://local/')
      expect(src).toContain('index.html')

      // Edit mode → Monaco only (preview unmounts); type a change, then switch
      // back to preview — the iframe reloads with the edited (live) content.
      await toolbar.locator('button', { hasText: '编辑' }).click()
      await win.waitForTimeout(500)
      await expect(frame).toHaveCount(0)
      await win.evaluate(() => {
        const ed = (window as any).__monacoEditor
        const model = ed?.getModel()
        if (ed && model) {
          const lastLine = model.getLineCount()
          ed.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) })
          ed.focus()
        }
      })
      await win.keyboard.press('End')
      await win.keyboard.type('<p>live</p>')
      await toolbar.locator('button', { hasText: '预览' }).click()
      await expect(frame).toBeVisible({ timeout: 8000 })
      // Fresh mount pushes the live (edited) content immediately → ?v= bumps
      await win.waitForTimeout(600)
      expect(await frame.getAttribute('src')).not.toContain('?v=0')

      // ── Markdown: rendered content + relative local image, split offered ──
      await win.locator('#file-tree-root >> text=README.md').first().click()
      await expect(win.locator('.markdown-body h1', { hasText: '预览标题' })).toBeVisible({ timeout: 8000 })
      await expect(win.locator('.markdown-body strong', { hasText: '加粗' })).toBeVisible()
      // Markdown keeps the side-by-side layout
      await expect(win.locator('[data-testid="preview-toolbar"] button', { hasText: '分屏' })).toBeVisible()
      const mdImg = win.locator('.markdown-body img[src^="ourcode-file:"]').first()
      await expect(mdImg).toBeVisible({ timeout: 8000 })
      expect(await mdImg.getAttribute('src')).toContain('pic.png')

      // ── Image: read-only preview (no editor, no toolbar) ──
      await win.locator('#file-tree-root >> text=pic.png').first().click()
      await expect(win.locator('img[src*="pic.png"]')).toBeVisible({ timeout: 8000 })
      await expect(win.locator('[data-testid="preview-toolbar"]')).toHaveCount(0)
    } finally {
      await app?.close().catch(() => {})
      await rm(dir, { recursive: true, force: true })
      await rm(userData, { recursive: true, force: true }).catch(() => {})
    }
  })
})
