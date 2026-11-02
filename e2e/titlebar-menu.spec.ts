import { test, expect, type Page } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'

// Regression: 顶部菜单栏（文件/编辑/…）的下拉面板必须永远压在所有面板之上。
//
// 原实现把面板渲染在标题栏内部（absolute + z-[100]）。它因此受标题栏所在的
// 层叠/裁剪边界约束：后绘制的兄弟面板（侧栏项目列表、聊天面板、终端 z-6、
// 办公室覆盖层 z-10）以及任何 overflow-hidden / backdrop-filter 祖先都能盖住
// 或裁掉它 —— 用户看到的表现就是"点了文件，下拉不见/被遮住"。
//
// 现在面板通过 portal 挂到 <body>，position:fixed，z-index 1000，因此这些用例
// 断言的是结构不变量（portalled + fixed + 顶级 z + 每行 hit-test 命中自己），
// 而不只是"看得见"。

const FILE_MENU = '文件'
const HELP_MENU = '帮助'
const NEW_FILE = '新建文件'
const UNDO = '撤销'

async function openMenu(win: Page, label: string): Promise<void> {
  await win.locator('[role="menubar"] button', { hasText: label }).first().click()
  await expect(win.locator('[data-titlebar-menu]')).toBeVisible({ timeout: 4000 })
}

test.describe('title bar dropdown layering', () => {
  test('dropdown is portalled, fixed and never covered by panels', async () => {
    test.setTimeout(120000)
    const { app, userData } = await launchApp()
    try {
      const win = await app.firstWindow()
      await win.waitForTimeout(3000)
      await dismissOnboarding(win)

      // Open the terminal panel first — it is the panel that used to sit above
      // the menu (relative z-[6]).
      await win.keyboard.press('Control+j')
      await win.waitForTimeout(1200)

      await openMenu(win, FILE_MENU)

      const layout = await win.evaluate(() => {
        const menu = document.querySelector('[data-titlebar-menu]') as HTMLElement
        const styles = getComputedStyle(menu)
        const anchor = document.querySelectorAll('[role="menubar"] button')[0].getBoundingClientRect()
        const rect = menu.getBoundingClientRect()
        const rows = [...menu.querySelectorAll('button[role="menuitem"]')] as HTMLElement[]
        const covered = rows.filter((row) => {
          const r = row.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + Math.min(30, r.width / 2), r.top + r.height / 2)
          return !hit || !menu.contains(hit)
        })
        return {
          portalled: menu.parentElement === document.body,
          position: styles.position,
          zIndex: Number(styles.zIndex),
          overflowY: styles.overflowY,
          menuRect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width },
          anchor: { bottom: anchor.bottom, left: anchor.left },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          coveredRows: covered.length,
          rowCount: rows.length,
        }
      })

      expect(layout.portalled).toBe(true)
      expect(layout.position).toBe('fixed')
      expect(layout.zIndex).toBeGreaterThanOrEqual(1000)
      expect(layout.overflowY).toBe('auto')
      expect(layout.rowCount).toBeGreaterThan(0)
      // Every row must be hit-testable at its own coordinates.
      expect(layout.coveredRows).toBe(0)
      // Anchored right below its button, inside the viewport.
      expect(layout.menuRect.top).toBeGreaterThanOrEqual(layout.anchor.bottom)
      expect(layout.menuRect.top - layout.anchor.bottom).toBeLessThanOrEqual(12)
      expect(Math.abs(layout.menuRect.left - layout.anchor.left)).toBeLessThanOrEqual(2)
      expect(layout.menuRect.bottom).toBeLessThanOrEqual(layout.viewport.height)
      expect(layout.menuRect.right).toBeLessThanOrEqual(layout.viewport.width)

      // Choosing an item runs the action AND closes the panel.
      await win.locator('[data-titlebar-menu] button[role="menuitem"]', { hasText: NEW_FILE }).first().click()
      await expect(win.locator('[data-titlebar-menu]')).toHaveCount(0)
      await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 8000 })

      // Outside click closes; so does Escape.
      await openMenu(win, FILE_MENU)
      await win.mouse.click(Math.round(layout.viewport.width / 2), Math.round(layout.viewport.height / 2))
      await expect(win.locator('[data-titlebar-menu]')).toHaveCount(0)

      await openMenu(win, FILE_MENU)
      await win.keyboard.press('Escape')
      await expect(win.locator('[data-titlebar-menu]')).toHaveCount(0)

      // Hovering a neighbouring menu swaps the panel in place.
      await openMenu(win, FILE_MENU)
      await win.locator('[role="menubar"] button').nth(1).hover()
      await expect(win.locator('[data-titlebar-menu]')).toContainText(UNDO)
    } finally {
      await app.close().catch(() => {})
      void userData
    }
  })

  test('dropdown stays inside a short window and scrolls instead of clipping', async () => {
    test.setTimeout(120000)
    const { app } = await launchApp()
    try {
      const win = await app.firstWindow()
      await win.waitForTimeout(3000)
      await dismissOnboarding(win)

      // A short window is where an inline absolute panel used to fall out of the
      // window (and read as "被遮挡").
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setSize(780, 420)
      })
      await win.waitForTimeout(800)

      await openMenu(win, HELP_MENU)

      const box = await win.evaluate(() => {
        const menu = document.querySelector('[data-titlebar-menu]') as HTMLElement
        const rect = menu.getBoundingClientRect()
        const rows = [...menu.querySelectorAll('button[role="menuitem"]')] as HTMLElement[]
        const last = rows[rows.length - 1].getBoundingClientRect()
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          maxHeight: getComputedStyle(menu).maxHeight,
          scrollable: menu.scrollHeight > menu.clientHeight,
          lastRowBottom: last.bottom,
        }
      })

      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(box.viewport.width)
      expect(box.bottom).toBeLessThanOrEqual(box.viewport.height)
      expect(box.maxHeight).not.toBe('none')
      // Either the last row fits, or the panel scrolls to reach it.
      expect(box.lastRowBottom <= box.viewport.height || box.scrollable).toBe(true)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
