/* Full-page screenshot of the comparison index. */
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(path.join(here, 'index.html')).href, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(here, 'shots', 'index.png'), fullPage: true })
console.log('index.png rendered')
await browser.close()
