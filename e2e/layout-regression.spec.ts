import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { APP_LAUNCH_ARGS } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Regression: clicking 新建对话 (or dragging) must not yank the whole layout up.
//
// Root cause that this guards against: the sidebar's vertical .resizer handle
// was rendering in-flow (its custom position:relative beat the absolute utility
// in the cascade), doubling the sidebar wrapper's scroll height (830 → 1660).
// The MainLayout content row therefore overflowed (scrollHeight > clientHeight),
// and the chat auto-scroll's scrollIntoView scrolled that hidden container
// (scrollTop ≈ 642), moving the sidebar/editor/chat up by ~642px. Pressing
// Ctrl+B "fixed" it visually by unmounting the overflowing sidebar.

function seedUserData(): { dir: string; project: string } {
  const realDb = path.join(os.homedir(), 'AppData', 'Roaming', 'ourcode-ide', 'data', 'ourcode.db')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ourcode-regression-'))
  const dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  if (fs.existsSync(realDb)) fs.copyFileSync(realDb, path.join(dataDir, 'ourcode.db'))
  const project = path.join(tmp, 'demo-project')
  fs.mkdirSync(project, { recursive: true })
  return { dir: tmp, project }
}

async function launchApp(userData: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [...APP_LAUNCH_ARGS],
    env: { ...process.env, OURCODE_USER_DATA: userData },
  })
  let win: Page | null = null
  for (let i = 0; i < 60 && !win; i++) {
    for (const p of app.windows()) {
      try {
        if (await p.evaluate(() => typeof (window as any).electronAPI !== 'undefined')) { win = p; break }
      } catch { /* closed mid-poll */ }
    }
    if (!win) await new Promise((r) => setTimeout(r, 500))
  }
  if (!win) throw new Error('main window not found')
  // The seeded userData has fresh localStorage → the first-run onboarding shows.
  // Seed the completion flag and reload so it never intercepts clicks.
  await win.evaluate(() => localStorage.setItem('hasCompletedOnboarding', 'true'))
  await win.reload()
  await win.waitForTimeout(2000)
  return { app, win }
}

/** Where the layout is, and whether anything is scrolled off. */
const layoutMetrics = (win: Page) => win.evaluate(() => {
  // Anchor on the sidebar's resize handle — the sidebar itself lost its old
  // `.bg-nova-sidebar` class in the Stitch redesign, and its resizer (with the
  // `absolute` position classes) is still a stable, unique handle.
  const sidebar = document.querySelector('.resizer.absolute')?.parentElement as HTMLElement | null // shrink-0 relative (width container)
  const contentRow = sidebar?.parentElement as HTMLElement | null // flex-1 min-h-0 flex gap-2 overflow-hidden
  return {
    sidebarTop: sidebar ? Math.round(sidebar.getBoundingClientRect().top) : null,
    wrapperClientH: sidebar?.clientHeight ?? null,
    wrapperScrollH: sidebar?.scrollHeight ?? null, // must equal clientH — a 2x here = in-flow resizer bug
    contentRowScrollTop: contentRow ? Math.round(contentRow.scrollTop) : null,
  }
})

async function ensureSidebarVisible(win: Page) {
  await win.keyboard.press('Control+b')
  await win.waitForTimeout(600)
  const vis = await win.evaluate(() => !!document.querySelector('.resizer.absolute'))
  if (!vis) { await win.keyboard.press('Control+b'); await win.waitForTimeout(600) }
  expect(await win.evaluate(() => !!document.querySelector('.resizer.absolute'))).toBe(true)
}

test('sidebar resizer is out-of-flow (no hidden overflow)', async () => {
  test.setTimeout(120000)
  const { dir, project } = seedUserData()
  const { app, win } = await launchApp(dir)
  await win.evaluate((p) => localStorage.setItem('recentProjects', JSON.stringify([p])), project)
  await win.reload()
  await win.waitForTimeout(1500)
  await ensureSidebarVisible(win)

  const m = await layoutMetrics(win)
  // The wrapper must not contain hidden overflow (was 2x client height before the fix)
  expect(m.wrapperClientH).not.toBeNull()
  expect(m.wrapperScrollH).toBe(m.wrapperClientH)
  expect(m.contentRowScrollTop).toBe(0)

  await app.close()
})

test('new chat does not scroll the layout', async () => {
  test.setTimeout(120000)
  const { dir, project } = seedUserData()
  const { app, win } = await launchApp(dir)
  await win.evaluate((p) => localStorage.setItem('recentProjects', JSON.stringify([p])), project)
  await win.reload()
  await win.waitForTimeout(1500)
  await ensureSidebarVisible(win)

  const before = await layoutMetrics(win)
  // The new-chat button is icon-only (label lives in its title attribute)
  await win.locator('button[title="新建对话"]').first().click()
  await win.waitForTimeout(800)

  const after = await layoutMetrics(win)
  // The whole UI must stay put (previously the content row scrolled ~642px up)
  expect(after.sidebarTop).toBe(before.sidebarTop)
  expect(after.contentRowScrollTop).toBe(0)

  await app.close()
})
