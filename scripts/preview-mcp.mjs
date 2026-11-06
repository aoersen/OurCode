// 用法：先 npx vite --config vite.config.preview.ts，再 node scripts/preview-mcp.mjs
import { chromium } from '@playwright/test'

const shots = [
  { out: '.stitch/designs/mcp-assign-v2-follow.png' },
  { role: 'UI 研发', out: '.stitch/designs/mcp-assign-v2-custom.png' },
  // 脏状态：勾一个还没选的服务器 → 头部出现「有未保存改动」、保存按钮可点
  { role: 'UI 研发', clickText: 'git', out: '.stitch/designs/mcp-assign-v2-dirty.png' },
]

const browser = await chromium.launch({
  executablePath: 'C:/Users/29486/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
})
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
await page.goto('http://localhost:5199/mcp.html', { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

for (const shot of shots) {
  if (shot.role) {
    await page.getByRole('button', { name: new RegExp(shot.role) }).first().click()
    await page.waitForTimeout(300)
  }
  if (shot.clickText) {
    await page.getByText(shot.clickText, { exact: true }).first().click()
    await page.waitForTimeout(200)
  }
  await page.screenshot({ path: shot.out })
  console.log('saved', shot.out)
}
await browser.close()
