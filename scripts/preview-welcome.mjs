// 用法：先 npx vite --config vite.config.preview.ts，再 node scripts/preview-welcome.mjs
import { chromium } from '@playwright/test'

const shots = [
  { url: 'http://localhost:5199/?state=normal', out: '.tmp/welcome-preview-normal.png' },
  { url: 'http://localhost:5199/?state=firstrun', out: '.tmp/welcome-preview-firstrun.png' },
  { url: 'http://localhost:5199/?state=normal&theme=dark', out: '.tmp/welcome-preview-dark.png' },
]

const browser = await chromium.launch({
  executablePath: 'C:/Users/29486/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
for (const shot of shots) {
  await page.goto(shot.url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.screenshot({ path: shot.out })
  console.log('saved', shot.out)
}
await browser.close()
