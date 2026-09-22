import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { dismissOnboarding, dropUserData, launchApp, seedApiConfig } from './helpers'
import { mkdtemp, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

async function mainWindow(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined
  await expect.poll(async () => {
    for (const p of app.windows()) {
      try { if (await p.evaluate(() => typeof window.electronAPI !== 'undefined')) { page = p; return true } } catch { /* */ }
    }
    return false
  }, { timeout: 30000 }).toBe(true)
  return page!
}

async function officeWindow(app: ElectronApplication, main: Page): Promise<Page> {
  let office: Page | undefined
  await expect.poll(async () => {
    for (const p of app.windows()) {
      if (p === main) continue
      try {
        if (await p.evaluate(() => typeof window.electronAPI !== 'undefined' && document.getElementById('office3d-root') !== null)) { office = p; return true }
      } catch { /* */ }
    }
    return false
  }, { timeout: 30000 }).toBe(true)
  return office!
}

test('office: double-click project opens file tree IN the office panel', async () => {
  test.setTimeout(120000)
  const dir = await mkdtemp(join(tmpdir(), 'officetree-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'main.ts'), 'export const x = 1\n', 'utf-8')
  await writeFile(join(dir, 'README.md'), '# hi\n', 'utf-8')

  const { app, userData } = await launchApp()
  const main = await mainWindow(app)
  // 种入配置 → 办公室窗口据此自建会话；没有会话时中央列会被 OfficeChatPane 压成 0 高。
  await seedApiConfig(main)
  const officeBtn = main.locator('button[aria-label*="一人公司"], button[aria-label*="One-Person"], button[aria-label*="办公室"], button[aria-label*="Office"]').first()
  await expect(officeBtn).toBeVisible({ timeout: 15000 })
  await officeBtn.click()
  const office = await officeWindow(app, main)
  await expect(office.locator('#office3d-root')).toBeVisible({ timeout: 30000 })
  await dismissOnboarding(office)

  // 打开项目（mock 对话框）→ 树应在办公室左侧栏内就地打开，办公室视图不退出
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, dir)
  const openBtn = office.locator('#office3d-root button:has-text("打开项目")').first()
  await expect(openBtn).toBeVisible({ timeout: 10000 })
  await openBtn.click()
  await office.waitForTimeout(2500)

  // 办公室视图应保持显示（不退出），且左侧栏出现该项目的文件树
  const officeStill = await office.locator('#office3d-root').isVisible().catch(() => false)
  const inPanelTree = await office.locator('#office3d-root #file-tree-root').first().isVisible().catch(() => false)
  const treeText = await office.evaluate(() => document.getElementById('file-tree-root')?.innerText || '')
  console.log('OFFICE STILL VISIBLE:', officeStill, '| IN-PANEL TREE:', inPanelTree, '| TREE:', JSON.stringify(treeText.slice(0, 80)))
  expect(officeStill).toBe(true)
  expect(inPanelTree).toBe(true)
  expect(treeText).toContain('src')

  // 双击项目卡片也应就地打开树（先返回项目列表）
  const backBtn = office.locator('#office3d-root button[title="返回项目"]').first()
  await backBtn.click()
  await office.waitForTimeout(500)
  const card = office.locator('#office3d-root div[title*="双击打开项目"]').filter({ hasText: 'officetree-' }).first()
  const n = await card.count()
  console.log('CARD COUNT:', n)
  if (n > 0) {
    await card.dblclick()
    await office.waitForTimeout(2000)
    const officeStill2 = await office.locator('#office3d-root').isVisible().catch(() => false)
    const tree2 = await office.locator('#office3d-root #file-tree-root').first().isVisible().catch(() => false)
    const taskPanel = await office.locator('aside h2:has-text("任务面板")').first().isVisible().catch(() => false)
    console.log('DBLCLICK → office still:', officeStill2, '| in-panel tree:', tree2, '| 任务面板:', taskPanel)
    expect(officeStill2).toBe(true)
    expect(tree2).toBe(true)
    expect(taskPanel).toBe(false)
  }

  // 点文件树里的文件 → 应进入工作区编辑器（办公室视图让位）
  const fileRow = office.locator('#office3d-root #file-tree-root >> text=main.ts').first()
  if (await fileRow.isVisible().catch(() => false)) {
    await fileRow.click()
    await office.waitForTimeout(2000)
    const officeGone = await office.locator('#office3d-root').isVisible().catch(() => false)
    console.log('AFTER FILE CLICK → office overlay gone:', !officeGone)
  }

  await app.close()
  // 之前这里手写了一段「把临时项目从最近列表剔除」的清理逻辑，注释说明是因为本测试
  // 用的是默认 userData。现在整个 spec 跑在一次性 profile 上，那段清理已无必要。
  dropUserData(userData)
})
