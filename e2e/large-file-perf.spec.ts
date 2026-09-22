/**
 * Manual performance harness for large files (e.g. an 800 MB SQL dump).
 *
 * Not part of the default test run — it needs a real large file and takes
 * minutes. Run it with:
 *
 *   npm run build
 *   LARGE_FILE="C:/path/to/huge.sql" npx playwright test large-file-perf
 *
 * Measures: open/load time, real keypress latency at the end of the file, and
 * UI responsiveness while the fully-loaded model is in memory.
 */
import { test, expect } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'
import type { Page } from '@playwright/test'
import path from 'path'

const LARGE_FILE = process.env.LARGE_FILE

test.skip(!LARGE_FILE, 'set LARGE_FILE (e.g. an 800 MB SQL dump) to run the large-file perf harness')

test('large file: open time, keypress latency and responsiveness', async () => {
  // Atomic load of a multi-hundred-MB file plus the 30 s responsiveness poll
  // far exceeds the default 30 s timeout.
  test.setTimeout(6 * 60 * 1000)

  const filePath = LARGE_FILE!
  const folder = path.dirname(filePath)
  const fileName = path.basename(filePath)

  const { app } = await launchApp()

  // Let the main window come up, then point the open-folder dialog at `folder`
  // so Ctrl+O below opens the right directory.
  await new Promise((r) => setTimeout(r, 1500))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, folder)

  let page: Page | null = null
  for (let i = 0; i < 40 && !page; i++) {
    for (const p of app.windows()) {
      try {
        if (await p.evaluate(() => typeof window.electronAPI !== 'undefined')) {
          page = p
          break
        }
      } catch {
        // window closed between iterations
      }
    }
    if (!page) await new Promise((r) => setTimeout(r, 500))
  }
  if (!page) throw new Error('main window not found')
  await dismissOnboarding(page)

  page.on('crash', () => console.log('!! RENDERER CRASHED'))
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))

  // Open the folder (Ctrl+O), wait for the file tree, auto-accept the "large
  // file" confirmation, then click the target file in the tree.
  await page.keyboard.press('Control+O')
  await page
    .waitForFunction(() => document.getElementById('file-tree-root')?.getAttribute('data-root-path'), null, {
      timeout: 15000,
    })
    .catch(() => {})
  await page.evaluate(() => {
    window.confirm = () => true
  })

  const t0 = Date.now()
  await page.evaluate((file) => {
    const el = Array.from(document.querySelectorAll('#file-tree-root *')).find(
      (n) => n.children.length === 0 && n.textContent && n.textContent.trim() === file,
    )
    ;(el as HTMLElement | undefined)?.click()
  }, fileName)

  // The model stays empty while chunks stream in (atomic load — VS Code style),
  // so "first non-empty length" is the moment the file finished loading.
  let loadedLen = 0
  for (let i = 0; i < 240 && loadedLen === 0; i++) {
    loadedLen = await page.evaluate(() => (window as any).__monacoEditor?.getModel()?.getValueLength() ?? 0)
    if (loadedLen === 0) await new Promise((r) => setTimeout(r, 1000))
  }
  const loadSecs = (Date.now() - t0) / 1000
  console.log(`loaded at ${loadSecs.toFixed(1)}s, model chars: ${loadedLen}`)
  expect(loadedLen).toBeGreaterThan(0)

  // Real keyboard input at the end of the file: measure keypress latency.
  const pre = await page.evaluate(() => {
    const ed = (window as any).__monacoEditor
    const m = ed.getModel()
    const end = m.getPositionAt(m.getValueLength() - 1)
    ed.setPosition(end)
    ed.focus()
    return m.getValueLength()
  })
  const t1 = Date.now()
  await page.keyboard.press('x')
  const keyMs = Date.now() - t1
  const after = await page.evaluate(() => (window as any).__monacoEditor.getModel().getValueLength())
  console.log(`pre len: ${pre} | real keypress latency: ${keyMs}ms | len after: ${after} | typed: ${after - pre}`)
  expect(after - pre).toBe(1)

  // Responsiveness over the next 30 s (round-trip should stay in single-digit ms).
  const trips: number[] = []
  for (let i = 0; i < 10; i++) {
    const t2 = Date.now()
    await page.evaluate(() => 1 + 1)
    trips.push(Date.now() - t2)
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log(`response trips over 30s (ms): ${trips.join(', ')}`)

  await app.close().catch(() => {})
})
