import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 图片附件（视觉输入）在真实渲染进程里的接线验证：FileReader/canvas 解码只有
 * 在浏览器环境才跑得通，Node 单测覆盖不到。userData 用临时目录沙箱，不碰真实数据。
 */

// 1×1 PNG — small enough to skip the downscale branch (which needs a real
// screenshot and is covered by the pure logic in utils/imageAttach.ts).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const SEED_GROUP = {
  id: 'vis-group-1',
  name: '演示配置组',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-demo',
  systemPrompt: '',
  defaultModel: 'gpt-4o',
  provider: 'openai',
  customHeaders: {},
  color: '#3b82f6',
}

async function launchSandbox(dir: string): Promise<{ app: Awaited<ReturnType<typeof electron.launch>>; win: Page }> {
  const app = await electron.launch({
    args: [join(__dirname, '../dist-electron/main.js')],
    env: { ...process.env, OURCODE_USER_DATA: dir },
  })
  let win: Page | null = null
  for (let i = 0; i < 40 && !win; i++) {
    for (const p of app.windows()) {
      try {
        if (await p.evaluate(() => typeof (window as any).electronAPI !== 'undefined')) {
          win = p
          break
        }
      } catch { /* closed mid-poll */ }
    }
    if (!win) await new Promise((r) => setTimeout(r, 500))
  }
  if (!win) {
    await app.close()
    throw new Error('main window not found')
  }
  await win.evaluate((group) => {
    localStorage.setItem('hasCompletedOnboarding', 'true')
    void (window as any).electronAPI.saveConfigGroup(group)
  }, SEED_GROUP)
  await win.reload()
  await win.waitForTimeout(2000)
  return { app, win }
}

test('图片附件：选择 → 缩略图 → 移除 → 发送并落库', async () => {
  test.setTimeout(120000)
  const userData = mkdtempSync(join(tmpdir(), 'image-attach-ud-'))
  const shotDir = mkdtempSync(join(tmpdir(), 'image-attach-files-'))
  const a = join(shotDir, 'shot-a.png')
  const b = join(shotDir, 'shot-b.png')
  const txt = join(shotDir, 'notes.txt')
  writeFileSync(a, PNG_1PX)
  writeFileSync(b, PNG_1PX)
  writeFileSync(txt, 'not an image')

  const { app, win } = await launchSandbox(userData)
  try {
    // Fresh userData → the welcome screen stands in for the composer.
    await win.getByText('开始新对话').first().click()
    await expect(win.locator('.chat-input-box')).toBeVisible({ timeout: 10000 })

    const imageInput = win.locator('input[type=file][accept*="image"]').first()
    await expect(imageInput).toHaveCount(1)

    const thumb = (name: string) => win.locator(`img[alt="${name}"]`)

    await imageInput.setInputFiles([a, b])
    await expect(thumb('shot-a.png')).toBeVisible()
    await expect(thumb('shot-b.png')).toBeVisible()
    // Downscaled/re-encoded payloads render as data URLs, never blob: or file:.
    expect(await thumb('shot-a.png').getAttribute('src')).toMatch(/^data:image\/png;base64,/)

    // A non-image sneaking in through the input must not become an image part.
    await imageInput.setInputFiles([txt])
    await expect(thumb('notes.txt')).toHaveCount(0)

    // Oversized screenshot → downscaled + re-encoded, so the request stays small
    // and the media type follows what the canvas actually produced (JPEG).
    await win.evaluate(() =>
      (async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 2200
        canvas.height = 1600
        const ctx = canvas.getContext('2d')!
        const grad = ctx.createLinearGradient(0, 0, 2200, 1600)
        grad.addColorStop(0, '#1f6feb')
        grad.addColorStop(1, '#f85149')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, 2200, 1600)
        for (let i = 0; i < 4000; i++) {
          ctx.fillStyle = `rgb(${(i * 7) % 255},${(i * 13) % 255},${(i * 29) % 255})`
          ctx.fillRect((i * 37) % 2200, (i * 91) % 1600, 3, 3)
        }
        const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))
        const dt = new DataTransfer()
        dt.items.add(new File([blob], 'big.png', { type: 'image/png' }))
        const input = document.querySelector('input[type=file][accept*="image"]') as HTMLInputElement
        input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })()
    )
    await expect(thumb('big.png')).toBeVisible()
    const big = await thumb('big.png').evaluate((el: HTMLImageElement) => ({
      prefix: el.src.slice(0, 24),
      width: el.naturalWidth,
      height: el.naturalHeight,
    }))
    expect(big.prefix).toMatch(/^data:image\/jpeg;base64,/)
    expect(Math.max(big.width, big.height)).toBe(1568)

    // Image-only send: the textarea is empty, yet the message is sendable.
    const send = win.locator('.chat-input-box button', { hasText: /^发送$/ })
    await expect(send).toBeEnabled()

    // The toolbar image button opens a chooser bound to the image input (the
    // second button used to be a duplicate of the file button). When the native
    // dialog can't be intercepted this asserts nothing — the onChange path above
    // already covers the input itself.
    const chooserPromise = win.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null)
    await win.locator('button[title^="添加图片"]').click()
    const chooser = await chooserPromise
    if (chooser) expect(chooser.isMultiple()).toBe(true)

    // Removing an attachment drops its thumbnail (the × is group-hover only).
    const holderB = win.locator('div.group:has(img[alt="shot-b.png"])')
    await holderB.hover()
    await holderB.locator('button[title="移除图片"]').click()
    await expect(thumb('shot-b.png')).toHaveCount(0)
    await expect(thumb('shot-a.png')).toBeVisible()

    // Send it. The demo key is invalid, so the run fails — the user message and
    // its attachment are already durable by then, which is what we check below.
    await win.locator('textarea[data-ai-input]').fill('这张图里有什么')
    await win.locator('.chat-input-box button', { hasText: /^发送$/ }).click()
    // The composer's copy is gone; what remains is the bubble's rendering.
    await expect(thumb('shot-a.png')).toHaveCount(1)

    const readAttachments = () =>
      win.evaluate(async () => {
        const sessions = await (window as any).electronAPI.getSessions()
        const msgs = sessions.flatMap((s: any) => s.messages || [])
        return msgs.find((m: any) => m.attachments?.length)?.attachments ?? null
      })

    // What actually reached SQLite: a clean media type (the ";base64" suffix
    // leak was the bug that made every vision request fail) and raw base64.
    await expect.poll(readAttachments, { timeout: 20000, message: 'attachment never became durable' }).not.toBeNull()
    const saved = await readAttachments()
    expect(saved).toHaveLength(2)
    expect(saved[0]).toMatchObject({ name: 'shot-a.png', mimeType: 'image/png' })
    expect(saved[1]).toMatchObject({ name: 'big.png', mimeType: 'image/jpeg' })
    expect(saved[0].dataBase64.startsWith('data:')).toBe(false)

    // Later saves in the same run (the renderer strips base64 once it is
    // durable) must not blank the stored copy.
    await win.waitForTimeout(3000)
    expect(await readAttachments()).toHaveLength(2)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(shotDir, { recursive: true, force: true })
  }
})
