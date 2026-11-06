/**
 * Shot the agent shell at 1440x900 without booting Electron.
 *
 *   node scripts/shot-shell.mjs [--port 5199]
 *
 * Requires the preview dev server:
 *   npx vite --config vite.config.preview.ts
 * Output: .tmp/shell-shots/*.png
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const portArg = process.argv.indexOf('--port')
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 5199

const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Users\\29486\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'

const OUT = '.tmp/shell-shots'
mkdirSync(OUT, { recursive: true })

const shots = [
  // 空会话：hero composer（居中偏上 + 快捷键提示）
  { name: 'shell-01-hero-empty', query: '?empty=1&artifact=none' },
  // 有内容：inline composer 贴底 + 状态气泡展开
  { name: 'shell-02-inline-running', query: '?bubble=expanded&artifact=plan' },
  { name: 'shell-03-inline-collapsed', query: '?bubble=collapsed&artifact=none' },
  { name: 'shell-04-browser', query: '?bubble=expanded&artifact=browser', click: '浏览器' },
  // 权限模式菜单（纯文字 + chevron 的浮层）
  { name: 'shell-05-mode-menu', query: '?bubble=expanded&artifact=plan', click: '手动确认' },
  // 运行中：主键变方形停止；有草稿时停止（幽灵）+ 发送（主）并存
  { name: 'shell-06-running-stop', query: '?running=1&artifact=none' },
  {
    name: 'shell-07-running-draft',
    query: '?running=1&artifact=none',
    type: '把停止放在左边，Enter 直接排队',
  },
]

const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', (err) => console.error('pageerror:', err.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('console:', msg.text().slice(0, 200))
})

for (const shot of shots) {
  await page.goto(`http://localhost:${port}/shell.html${shot.query}`, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  if (shot.click) {
    await page.getByRole('button', { name: shot.click, exact: true }).click()
    await page.waitForTimeout(500)
  }
  if (shot.type) {
    await page.locator('textarea[data-ai-input]').fill(shot.type)
    await page.waitForTimeout(300)
  }
  const path = `${OUT}/${shot.name}.png`
  await page.screenshot({ path })
  console.log('shot', path)
}

await browser.close()
