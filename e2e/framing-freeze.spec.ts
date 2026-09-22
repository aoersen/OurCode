import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { dismissOnboarding, launchApp, seedApiConfig } from './helpers'

/**
 * 取景冻结回归守卫：主窗口底部「一人公司」入口打开独立办公室窗口 → 记录 8 个工位
 * 标签在画布中的 NDC → 拖动上下分割条 → 再记录 → 对比 NDC 是否不变（验证取景已
 * 冻结，拖动不改变构图）。
 *
 * 注意场景面板不是默认 tab（OfficeView 默认落在看板），激活前其祖先带
 * display:none —— 见 activateSceneTab。
 */

/** 切到「场景」tab，并等画布拿到真实尺寸。 */
async function activateSceneTab(page: Page): Promise<void> {
  // 没有活动会话时 OfficeChatPane 用 h-full 撑满中央列，把场景/工作台那一行压成
  // 0 高度——tab 条还在 DOM 里但被遮住、点不到。种入配置后办公室窗口会自建会话，
  // 这里等工作台拿到高度（2px → 数百 px）确认布局已恢复。
  await expect
    .poll(async () => (await page.locator('[data-testid="office-workbench"]').boundingBox())?.height ?? 0, {
      timeout: 30000,
    })
    .toBeGreaterThan(0)
  // Tab 内容是常驻挂载、用 display 切换的（避免 3D 场景反复初始化），所以非激活时
  // canvas 已在 DOM 里——toHaveCount 数得到，boundingBox() 却返回 null。不先切 tab
  // 就取坐标，会在 canvas!.x 上抛 TypeError。
  await page
    .locator('#office3d-root button:text-is("场景"), #office3d-root button:text-is("Scene")')
    .first()
    .click()
  // 取景由 OfficeScene 的 ResizeObserver 在容器拿到真实尺寸（clientWidth/Height > 0）
  // 后才确定，所以这里等画布真的有宽度，而不是靠固定等待。
  await expect
    .poll(
      async () => (await page.locator('#office3d-root .office3d-stage canvas').boundingBox())?.width ?? 0,
      { timeout: 15000 },
    )
    .toBeGreaterThan(0)
}

async function mainWindow(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined
  await expect
    .poll(async () => {
      const pages = app.windows()
      for (const p of pages) {
        const win = await app.browserWindow(p).catch(() => null)
        if (!win) continue
        const title: string = await win.evaluate((w) => w.getTitle()).catch(() => '')
        if (/OurCode/i.test(title)) { page = p; return true }
      }
      return false
    }, { timeout: 20000 })
    .toBe(true)
  // 种入一个 API 配置：办公室窗口据此自动建会话，场景面板才会有布局高度。
  await seedApiConfig(page!)
  return page!
}

async function openOfficeWindow(app: ElectronApplication, main: Page): Promise<Page> {
  const officeBtn = main.locator('button[aria-label*="一人公司"], button[aria-label*="One-Person"], button[aria-label*="办公室"], button[aria-label*="Office"]').first()
  await officeBtn.click()
  let office: Page | undefined
  await expect
    .poll(async () => {
      office = app.windows().find((p) => p !== main)
      return office ? true : false
    }, { timeout: 20000 })
    .toBe(true)
  await expect(office!.locator('#office3d-root')).toBeVisible({ timeout: 15000 })
  // 办公室窗口与主窗口共用同一个 localStorage（主窗口关弹窗时引导标记已写入），
  // 这里通常立刻返回；保留是为了兜底——弹窗的 z-[300] 遮罩会吞掉所有点击。
  await dismissOnboarding(office!)
  return office!
}

test('verify camera framing is frozen on drag', async () => {
  // 两次 Electron 启动 + 办公室窗口 + 3D 场景取景，远超默认的 30s。
  test.setTimeout(150000)
  const { app } = await launchApp()
  const main = await mainWindow(app)
  const page = await openOfficeWindow(app, main)

  await expect(page.locator('#office3d-root canvas')).toHaveCount(1, { timeout: 15000 })
  await expect(page.locator('.office3d-tag')).toHaveCount(8, { timeout: 10000 })
  await activateSceneTab(page)
  // handleResize 的防抖重取景窗口是 220ms，多等一会儿让首批帧稳定。
  await page.waitForTimeout(1500)

  const readNDC = async () => {
    const canvas = await page.locator('#office3d-root .office3d-stage canvas').boundingBox()
    if (!canvas) throw new Error('office3d canvas has no box — is the 场景 tab active?')
    const tags = await page.locator('.office3d-tag').evaluateAll((els) =>
      els
        // 头部投影跑出画布的工位会被置为 display:none，其 rect 全为 0——留着会算出
        // 一对毫无意义的 NDC（上一版就是这样把 5/8 号算成 -1.73,1.92 的）。
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect()
          return { id: (el as HTMLElement).dataset.agent, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
        }),
    )
    return {
      canvas,
      tags: tags.map((t) => ({
        id: t.id,
        ndcX: ((t.cx - canvas.x) / canvas.width) * 2 - 1,
        ndcY: -(((t.cy - canvas.y) / canvas.height) * 2 - 1),
      })),
    }
  }

  const before = await readNDC()
  console.log('BEFORE canvas:', JSON.stringify(before.canvas))
  console.log('BEFORE ndc:', JSON.stringify(before.tags.map((t) => `${t.id}:${t.ndcX.toFixed(3)},${t.ndcY.toFixed(3)}`)))

  // 拖动上下分割条（场景/工作台之间）→ 场景变高、宽高比变化。
  //
  // 两个坑（都是这版之前没踩到过的：原 spec 总是在更早的 canvas!.x 上崩溃，拖动段从未真正跑过）：
  // 1. 分割条只有 1px 高，Playwright 默认点它的中心 (y + 0.5)，而那个像素属于下方的
  //    工作台，会被判为「被遮挡」并一直重试。命中测试证实只有紧贴上沿的那一行是它自己，
  //    所以用原始鼠标事件压在上沿——mousedown 落到分割条上，拖拽才会真正开始。
  // 2. 拖动量必须留在 OfficeScene.handleResize 的重取景阈值内：宽高比相对冻结点漂移
  //    超过 20% 时它会**故意**重新取景（保证任何窗口形状下场景都完整）。拖 90px 在
  //    这个面板高度下约等于 40% 漂移，测的就变成「重新取景」而不是「取景冻结」了。
  //    这里按容器高度取 10%，对应约 10% 的宽高比漂移。
  const stage = await page.locator('#office3d-root .office3d-stage').boundingBox()
  if (!stage) throw new Error('office3d stage has no box — is the 场景 tab active?')
  const drag = Math.max(8, Math.round(stage.height * 0.1))

  const resizer = page.locator('#office3d-root .cursor-row-resize').first()
  const rb = await resizer.boundingBox()
  if (!rb) throw new Error('scene resizer has no box — is the top pane collapsed?')
  const rx = rb.x + rb.width / 2
  await page.mouse.move(rx, rb.y)
  await page.mouse.down()
  await page.mouse.move(rx, rb.y + drag, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(1500)

  // 拖拽必须真的生效——否则下面的 NDC 断言会因为「画面压根没变」而假过。
  const rbAfter = await resizer.boundingBox()
  console.log('RESIZER y:', rb.y, '→', rbAfter?.y, '(drag', drag, 'px)')
  expect(rbAfter!.y).toBeGreaterThan(rb.y + drag * 0.5)

  const after = await readNDC()
  console.log('AFTER canvas:', JSON.stringify(after.canvas))
  console.log('AFTER ndc:', JSON.stringify(after.tags.map((t) => `${t.id}:${t.ndcX.toFixed(3)},${t.ndcY.toFixed(3)}`)))

  // 取景冻结 → 两次都可见的标签，其 NDC 应基本不变（允许 ±0.025 容差，含拖动过渡帧）
  const shared = before.tags.filter((t) => after.tags.some((a) => a.id === t.id))
  console.log('SHARED TAGS:', shared.length, 'of', before.tags.length, '/', after.tags.length)
  expect(shared.length).toBeGreaterThanOrEqual(6)
  const maxDelta = Math.max(
    ...shared.map((t) => {
      const a = after.tags.find((x) => x.id === t.id)!
      return Math.max(Math.abs(a.ndcX - t.ndcX), Math.abs(a.ndcY - t.ndcY))
    }),
  )
  console.log('MAX NDC DELTA:', maxDelta.toFixed(4))
  expect(maxDelta).toBeLessThan(0.025)

  await page.screenshot({ path: 'test-results/office-view-frozen.png' })
  await app.close()
})
