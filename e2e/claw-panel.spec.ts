import { test, expect } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'

/**
 * Claw 渠道接入面板的端到端验收。
 *
 * 替代原先的浏览器面板用例（那个面板已被 Claw 接入替换）：确认活动栏里是
 * Claw 图标而不是浏览器图标、点开后能看到五个渠道与接入控制区块、且渠道状态
 * 来自主进程（而不是前端写死的占位）。
 */
test.describe('Claw 渠道接入面板', () => {
  test('活动栏有 Claw 入口且图标不再是浏览器', async () => {
    const { app, userData } = await launchApp()
    try {
      const win = await app.firstWindow()
      await dismissOnboarding(win)
      const clawIcon = win.locator('button[title="Claw 渠道接入"], button[aria-label="Claw 渠道接入"]').first()
      await expect(clawIcon).toBeVisible({ timeout: 15_000 })
      // 浏览器入口已移除（agent 的 browser_* 工具仍在，只是不再占活动栏图标）
      await expect(win.locator('button[title="浏览器"], button[aria-label="浏览器"]')).toHaveCount(0)
    } finally {
      await app.close()
      void userData
    }
  })

  test('面板列出五个渠道，并展示接入控制与网关状态', async () => {
    const { app } = await launchApp()
    try {
      const win = await app.firstWindow()
      // 首启引导层是 fixed inset-0 的遮罩，不关掉会拦住一切点击（详见 helpers）
      await dismissOnboarding(win)
      const clawIcon = win.locator('button[title="Claw 渠道接入"], button[aria-label="Claw 渠道接入"]').first()
      await clawIcon.click()

      // 五个渠道都渲染出来（渠道目录来自 shared/claw.ts，这里验证它真的到了界面上）
      for (const label of ['微信', '企业微信', 'QQ', '飞书', 'Telegram']) {
        await expect(win.locator(`text=${label}`).first()).toBeVisible({ timeout: 10_000 })
      }
      // 接入控制区块与底部网关状态行
      await expect(win.locator('text=ACCESS CONTROL').first()).toBeVisible()
      await expect(win.locator('text=/Claw 网关/').first()).toBeVisible()
      // 状态徽章来自主进程（默认只有微信启用 → 其余显示「已停用」）
      await expect(win.locator('text=已停用').first()).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('渠道状态来自主进程：默认只有微信是启用态', async () => {
    const { app } = await launchApp()
    try {
      const win = await app.firstWindow()
      await dismissOnboarding(win)
      // 直接问主进程：面板上的状态与它必须一致（渠道目录、默认开关都来自主进程）
      const status = await win.evaluate(async () => {
        return (window as unknown as { electronAPI: { getClawStatus: () => Promise<unknown> } }).electronAPI.getClawStatus()
      })
      const channels = (status as { channels: Array<{ id: string; enabled: boolean }> }).channels
      expect(channels.map((c) => c.id)).toEqual(['wechat', 'wecom', 'qq', 'feishu', 'telegram'])
      expect(channels.find((c) => c.id === 'wechat')?.enabled).toBe(true)
      expect(channels.filter((c) => c.enabled)).toHaveLength(1)
    } finally {
      await app.close()
    }
  })
})
