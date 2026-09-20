import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 逐块接受/拒绝 AI 改动（checkpoint diff）在真实渲染进程里的接线验证。
 *
 * 行拼接数学由 src/__tests__/diffReview.test.ts 覆盖，这里验证的是只有 Monaco
 * 才有的部分：glyph margin 箭头是否真的挂上、点击后 diff 是否重算、文件是否真的
 * 落盘（未打开 / 已在编辑器中打开两条写回路径）。userData 用临时目录沙箱。
 */

const SEED_GROUP = {
  id: 'review-group-1',
  name: '演示配置组',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-demo',
  systemPrompt: '',
  defaultModel: 'gpt-4o',
  provider: 'openai',
  customHeaders: {},
  color: '#3b82f6',
}

// Two independent blocks, separated by untouched lines.
const SNAPSHOT = ['header', 'AAA-old', 'm1', 'm2', 'm3', 'ZZZ-old', 'footer'].join('\n')
const AI_EDIT = ['header', 'AAA-new', 'm1', 'm2', 'm3', 'ZZZ-new', 'footer'].join('\n')

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

/** Click the gutter arrow of the top-most change block. Arrow widgets are torn
 *  down and rebuilt on every diff recompute (rAF-coalesced), so a locator that
 *  was visible a microsecond ago can be gone by the time it is measured —
 *  measure and click inside one retried block instead of a sequence of waits. */
async function clickTopArrow(locator: Locator) {
  await expect(async () => {
    const visible = locator.filter({ visible: true })
    const boxes = await visible.evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect()
        return { top: rect.top, left: rect.left, width: rect.width }
      })
    )
    const order = boxes
      .map((box, index) => ({ ...box, index }))
      .filter((box) => box.width > 0)
      .sort((a, b) => a.top - b.top || a.left - b.left)
    expect(order.length, 'no laid-out gutter arrow yet').toBeGreaterThan(0)
    await visible.nth(order[0].index).click({ timeout: 3000 })
  }).toPass({ timeout: 30000 })
}

test('差异视图逐块接受/拒绝：写回文件、重算差异', async () => {
  test.setTimeout(180000)
  const userData = mkdtempSync(join(tmpdir(), 'diff-review-ud-'))
  // The main process only serves paths under a registered root, and the sandbox
  // userData is one of them — so the reviewed file lives inside it.
  mkdirSync(join(userData, 'project'), { recursive: true })
  const target = join(userData, 'project', 'reviewed.txt')
  writeFileSync(target, AI_EDIT)

  const { app, win } = await launchSandbox(userData)
  const disk = () => readFileSync(target, 'utf8')
  try {
    await win.getByText('开始新对话').first().click()
    await expect(win.locator('.chat-input-box')).toBeVisible({ timeout: 10000 })

    // Seed what an agent run would have left behind: a checkpoint holding the
    // pre-edit snapshot plus the message that names the touched file.
    await win.evaluate(
      async ({ path, original, configGroupId }) => {
        const api = (window as any).electronAPI
        const sessions = await api.getSessions()
        const base = sessions[0] || {
          id: 'review-session',
          title: 'review',
          configGroupId,
          model: 'gpt-4o',
          modelParams: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        const message = {
          id: 'review-msg',
          role: 'assistant',
          content: '',
          sortOrder: 0,
          contextFiles: [],
          tokenCount: 0,
          createdAt: Date.now(),
          toolCalls: [{ id: 'tc-1', name: 'edit_file', arguments: { path } }],
        }
        // The session has to exist before the checkpoint references it (FK).
        await api.saveSession({ ...base, messages: [message] })
        await api.checkpointCreate({
          id: 'review-cp',
          sessionId: base.id,
          createdAt: Date.now(),
          label: 'edit_file',
          messageId: message.id,
          files: [{ path, content: original, existed: true }],
        })
      },
      { path: target, original: SNAPSHOT, configGroupId: SEED_GROUP.id }
    )
    await win.reload()
    await win.waitForTimeout(2500)

    // 文件变更历史 → 查看变更 → the checkpoint diff opens in the editor area.
    await win.locator('[aria-label="文件变更历史"]').click()
    const row = win.locator('.file-row', { hasText: 'reviewed.txt' }).first()
    await expect(row).toBeVisible({ timeout: 10000 })
    await row.hover()
    await row.locator('button[title="查看差异"]').click()
    await expect(win.getByText('剩余 2 处改动')).toBeVisible({ timeout: 15000 })

    const reject = win.locator('button[title="拒绝此改动"]')
    const accept = win.locator('button[title="接受此改动"]')
    // One accept + one reject arrow per change block.
    await expect(reject).toHaveCount(2)
    await expect(accept).toHaveCount(2)

    // ── reject the first block while the file is NOT open in an editor ──
    await clickTopArrow(reject)
    await expect.poll(() => disk(), { timeout: 10000 }).toBe(
      ['header', 'AAA-old', 'm1', 'm2', 'm3', 'ZZZ-new', 'footer'].join('\n')
    )
    await expect(win.getByText('剩余 1 处改动')).toBeVisible({ timeout: 10000 })

    // ── accepting must not touch the file ──
    const beforeAccept = disk()
    await clickTopArrow(accept)
    await expect(win.getByText('所有改动已确认')).toBeVisible({ timeout: 10000 })
    expect(disk()).toBe(beforeAccept)

    // ── the same rejection with the file open: live model + clean buffer ──
    await row.click() // openFile — also closes the diff overlay
    await expect(win.locator('.monaco-editor').first()).toBeVisible()
    await row.hover()
    await row.locator('button[title="查看差异"]').click()
    // The checkpoint snapshot is untouched, so the diff is re-derived from it —
    // one block left, the one rejected above was already restored.
    await expect(reject).toHaveCount(1)
    await clickTopArrow(reject)
    await expect.poll(() => disk(), { timeout: 10000 }).toBe(SNAPSHOT)
    // Written back through the editor buffer, so the tab must not sit unsaved.
    await expect(win.locator('button.bg-yellow-500')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
