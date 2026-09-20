import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 提交按钮的暂存语义 —— 只提交「已暂存」的那一组文件。
 *
 * 过去 handleCommit 先 `git add -A` 再 commit，等于把用户刚在面板里取消暂存的
 * 文件、以及工作区里任何未跟踪文件一起塞进提交。这里用真 git 仓库 + 真渲染进程
 * 锁住它：提交后 HEAD 里有 staged.txt，没有 untracked.txt，也没有 unstaged.txt
 * 的改动。顺带证明 git:exec 新增的子命令白名单没有打断面板自己用到的命令
 * （rev-parse / status / add / reset / commit / log）。
 */

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

async function seedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ourcode-git-'))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'OurCode E2E',
    GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
    GIT_COMMITTER_NAME: 'OurCode E2E',
    GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
  }
  const run = (args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', env })
  run(['init', '-b', 'main'])
  await writeFile(join(dir, 'base.txt'), 'base\n')
  await writeFile(join(dir, 'unstaged.txt'), 'v1\n')
  await writeFile(join(dir, 'staged.txt'), 'todo\n')
  run(['add', 'base.txt', 'unstaged.txt', 'staged.txt'])
  run(['commit', '-m', 'seed'])
  // Now: staged.txt is staged, unstaged.txt is modified-but-unstaged,
  // and keep.txt is brand new (untracked).
  await writeFile(join(dir, 'staged.txt'), 'done\n')
  await writeFile(join(dir, 'unstaged.txt'), 'v2\n')
  await writeFile(join(dir, 'keep.txt'), 'do not commit me\n')
  run(['add', 'staged.txt'])
  return dir
}

async function launchSandbox(): Promise<{ app: ElectronApplication; win: Page; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'ourcode-git-user-'))
  const app = await electron.launch({
    args: [join(__dirname, '../dist-electron/main.js')],
    env: { ...process.env, OURCODE_USER_DATA: userData },
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
  await win.evaluate(() => localStorage.setItem('hasCompletedOnboarding', 'true'))
  await win.reload()
  await win.waitForTimeout(1500)
  return { app, win, userData }
}

async function openProject(win: Page, app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, dir)
  const projName = dir.split(/[/\\]/).pop() || ''
  await expect(async () => {
    await win.keyboard.press('Control+o')
    await win.waitForTimeout(700)
    const backBtn = win.locator('button:has-text("项目列表")').first()
    if (await backBtn.isVisible().catch(() => false)) {
      await backBtn.click()
      await win.waitForTimeout(400)
    }
    await expect(win.locator(`div.group:has-text("${projName}")`).first()).toBeVisible({ timeout: 4000 })
  }).toPass({ timeout: 30000 })
  await win.locator(`div.group:has-text("${projName}")`).first().dblclick()
  await expect(win.locator('#file-tree-root >> text=base.txt').first()).toBeVisible({ timeout: 10000 })
}

test('commits only the staged set — no implicit add -A', async () => {
  test.setTimeout(180000)
  const repo = await seedRepo()
  const { app, win, userData } = await launchSandbox()
  try {
    await openProject(win, app, repo)

    const gitIcon = win.locator('button[title="代码管理"]').first()
    await expect(gitIcon).toBeVisible({ timeout: 8000 })
    await gitIcon.click()

    // The panel must show staged.txt under 已暂存 and keep.txt under 未跟踪 —
    // i.e. porcelain parsing still works after the conflict-aware rewrite.
    await expect(win.locator('text=已暂存')).toBeVisible({ timeout: 8000 })
    await expect(win.locator('text=未跟踪')).toBeVisible({ timeout: 4000 })

    await win.locator('textarea').first().fill('feat: e2e staged only')
    await win.locator('button', { hasText: '提交' }).first().click()

    await expect(async () => {
      const subject = git(repo, ['log', '-1', '--format=%s'])
      expect(subject.trim()).toBe('feat: e2e staged only')
    }).toPass({ timeout: 20000 })

    const committedFiles = git(repo, ['show', '--name-only', '--format=', 'HEAD'])
      .split('\n')
      .filter(Boolean)
    expect(committedFiles).toContain('staged.txt')
    expect(committedFiles).not.toContain('keep.txt')
    expect(committedFiles).not.toContain('unstaged.txt')

    // The worktree is untouched: unstaged edit and untracked file are still there.
    const porcelain = git(repo, ['status', '--porcelain=v1'])
    expect(porcelain).toContain('?? keep.txt')
    expect(porcelain).toMatch(/^.M unstaged\.txt/)
  } finally {
    await app.close().catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
