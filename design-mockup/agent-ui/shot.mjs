/* Render agent-ui mockups to 1440x900 PNGs. */
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const outDir = path.join(dir, 'shots')
fs.mkdirSync(outDir, { recursive: true })

const args = process.argv.slice(2)
const files = args.length
  ? args.map((f) => path.resolve(f))
  : fs.readdirSync(dir)
      .filter((f) => /^v\d+.*\.html$/.test(f))
      .sort()
      .map((f) => path.join(dir, f))

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })

for (const file of files) {
  const name = path.basename(file, '.html')
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(450)
  const out = path.join(outDir, `${name}.png`)
  await page.screenshot({ path: out })
  const overflow = await page.evaluate(() => {
    const b = document.body
    return {
      scrollW: b.scrollWidth,
      clientW: b.clientWidth,
      scrollH: b.scrollHeight,
      clientH: b.clientHeight,
    }
  })
  console.log(`${name}: ${out} ${JSON.stringify(overflow)}`)
}

await browser.close()
